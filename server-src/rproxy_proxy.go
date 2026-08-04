package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---- 日志管理器 ----

type logEntry struct {
	Time  string `json:"time"`
	Level string `json:"level"`
	Msg   string `json:"msg"`
}

type logManager struct {
	mu      sync.RWMutex
	log     []logEntry
	max     int
	logFile *os.File
	logPath string
}

func newLogManager(max int) *logManager {
	return &logManager{log: make([]logEntry, 0, max), max: max}
}

// SetLogFile 设置日志文件，之后所有 add() 调用会同时写入文件
func (lm *logManager) SetLogFile(logDir string) error {
	lm.mu.Lock()
	defer lm.mu.Unlock()

	if lm.logFile != nil {
		lm.logFile.Close()
		lm.logFile = nil
	}

	if logDir == "" {
		return nil
	}
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return fmt.Errorf("创建日志目录失败: %v", err)
	}
	lm.logPath = filepath.Join(logDir, "rproxy.log")
	f, err := os.OpenFile(lm.logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("打开日志文件失败: %v", err)
	}
	lm.logFile = f
	return nil
}

func (lm *logManager) add(level, msg string) {
	entry := logEntry{Time: time.Now().Format("2006-01-02 15:04:05"), Level: level, Msg: msg}
	lm.mu.Lock()
	defer lm.mu.Unlock()
	lm.log = append(lm.log, entry)
	if len(lm.log) > lm.max {
		lm.log = lm.log[1:]
	}

	// 同步写入文件日志（用于排查 bug）
	if lm.logFile != nil {
		line := fmt.Sprintf("[%s] [%s] %s\n", entry.Time, level, msg)
		lm.logFile.WriteString(line)
		lm.logFile.Sync() // 立即刷盘，确保崩溃前日志不丢失
	}
}

func (lm *logManager) getAll(limit int) []logEntry {
	lm.mu.RLock()
	defer lm.mu.RUnlock()
	count := len(lm.log)
	if limit > 0 && limit < count {
		count = limit
	}
	start := len(lm.log) - count
	if start < 0 {
		start = 0
	}
	result := make([]logEntry, count)
	copy(result, lm.log[start:])
	return result
}

// clear 清空内存日志（新一轮启动时调用，避免旧日志干扰）
func (lm *logManager) clear() {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	lm.log = make([]logEntry, 0, lm.max)
}

// ---- 反向代理核心 ----

type reverseProxy struct {
	config    ProxyConfig
	server    *http.Server
	tlsConfig *tls.Config
	listener  net.Listener
	logger    *logManager
	running   bool
	mu        sync.RWMutex
	startedAt time.Time
}

func newReverseProxy(cfg ProxyConfig, logger *logManager) *reverseProxy {
	return &reverseProxy{
		config: cfg,
		logger: logger,
	}
}

// Start 启动反向代理
// 监听指定端口，仅提供 HTTPS 访问（明文 HTTP 连接直接关闭，不重定向）
func (rp *reverseProxy) Start(domain string, port int, backendAddr, certPath, keyPath string) error {
	// 新一轮启动时清空旧日志
	rp.logger.clear()
	rp.logger.add("INFO", "========== 开始启动反代 ==========")
	rp.logger.add("INFO", fmt.Sprintf("参数: domain=%s, port=%d, backend=%s", domain, port, backendAddr))
	rp.logger.add("INFO", fmt.Sprintf("证书路径: cert=%s, key=%s", certPath, keyPath))

	rp.mu.Lock()
	if rp.running {
		rp.mu.Unlock()
		rp.logger.add("WARN", "反代已在运行中，拒绝重复启动")
		return fmt.Errorf("proxy already running")
	}
	rp.mu.Unlock()

	// 解析后端地址
	backendURL, err := url.Parse(backendAddr)
	if err != nil {
		return fmt.Errorf("invalid backend url: %v", err)
	}
	if backendURL.Scheme == "" {
		rp.logger.add("ERROR", fmt.Sprintf("后端地址缺少协议: %q", backendAddr))
		return fmt.Errorf("backend url 缺少协议前缀: %q", backendAddr)
	}

	// 创建反向代理
	proxy := httputil.NewSingleHostReverseProxy(backendURL)
	proxy.FlushInterval = 100 * time.Millisecond
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		rp.logger.add("ERROR", fmt.Sprintf("代理失败: %s %s -> %v", r.Method, r.URL.Path, err))
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("后端服务暂时不可用，请稍后重试"))
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		// 移除后端返回的 HSTS 头，避免和外层 TLS 冲突
		resp.Header.Del("Strict-Transport-Security")
		ct := resp.Header.Get("Content-Type")
		ct = strings.TrimSpace(strings.ToLower(strings.Split(ct, ";")[0]))
		if isStaticContentType(ct) {
			resp.Header.Set("Cache-Control", "public, max-age=86400")
		}
		return nil
	}

	// 预加载证书（支持证书链）
	tlsCert, err := LoadCertificateChain(certPath, keyPath)
	if err != nil {
		rp.logger.add("ERROR", fmt.Sprintf("证书加载失败: %v (cert=%s, key=%s)", err, certPath, keyPath))
		return fmt.Errorf("load cert failed: %v", err)
	}
	rp.logger.add("INFO", fmt.Sprintf("证书加载成功（含 %d 个证书）: %s", len(tlsCert.Certificate), domain))

	// 打印证书详情
	if len(tlsCert.Certificate) > 0 {
		x509Cert, parseErr := x509.ParseCertificate(tlsCert.Certificate[0])
		if parseErr == nil {
			rp.logger.add("INFO", fmt.Sprintf("证书详情: %s, 有效期至 %s, 颁发给 CN=%s",
				domain,
				x509Cert.NotAfter.Format("2006-01-02 15:04:05"),
				x509Cert.Subject.CommonName))
		} else {
			rp.logger.add("WARN", fmt.Sprintf("证书解析失败: %v", parseErr))
		}
	}

	// 构建 TLS 配置（简洁版，让 Go 标准库自动处理 SNI）
	rp.tlsConfig = &tls.Config{
		Certificates: []tls.Certificate{*tlsCert},
		MinVersion:   tls.VersionTLS12,
		// ALPN 协议协商：浏览器必须要 ALPN，否则报 SSL_PROTOCOL_ERROR
		// 只协商 http/1.1（避免 h2 的复杂处理）
		NextProtos: []string{"http/1.1"},
	}

	// 自定义 mux：公网入口只转发业务流量，管理面板/API 不暴露到公网
	// （管理面板仅经统一网关/内网 :5553 访问）
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 公网入口禁止访问管理面板与 API
		if strings.HasPrefix(r.URL.Path, "/gateway") {
			http.NotFound(w, r)
			return
		}

		// 传递真实客户端 IP 到后端
		clientIP, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			clientIP = r.RemoteAddr
		}
		if clientIP != "" {
			r.Header.Set("X-Real-IP", clientIP)
			if prior := r.Header.Get("X-Forwarded-For"); prior != "" {
				r.Header.Set("X-Forwarded-For", prior+", "+clientIP)
			} else {
				r.Header.Set("X-Forwarded-For", clientIP)
			}
		}

		proxy.ServeHTTP(w, r)
	})

	rp.server = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	// 监听 TCP 端口（IPv4 + IPv6 双栈，避免纯 IPv4 网络无法访问）
	addr := fmt.Sprintf(":%d", port)
	tcpLn, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen failed: %v", err)
	}

	// 使用 TLS 嗅探 listener：同端口支持 HTTPS + HTTP（HTTP 自动 301 到 HTTPS）
	rp.listener = newSniffListener(tcpLn, rp.tlsConfig)

	rp.mu.Lock()
	rp.running = true
	rp.startedAt = time.Now()
	rp.config.Domain = domain
	rp.config.Port = port
	rp.config.BackendAddr = backendAddr
	rp.config.CertPath = certPath
	rp.config.KeyPath = keyPath
	rp.mu.Unlock()

	rp.logger.add("INFO", fmt.Sprintf("反向代理已启动: https://%s:%d", domain, port))
	rp.logger.add("INFO", fmt.Sprintf("后端地址: %s", backendAddr))
	rp.logger.add("INFO", "仅 HTTPS 访问（明文 HTTP 连接将被关闭）")
	rp.logger.add("INFO", "========== 反代启动完成 ==========")

	go func() {
		rp.logger.add("INFO", "反代 goroutine 开始监听...")
		err := rp.server.Serve(rp.listener)
		if err != nil && err != http.ErrServerClosed {
			rp.logger.add("ERROR", fmt.Sprintf("serve 异常退出: %v", err))
			log.Printf("反代 serve 异常退出: %v", err)
		} else {
			rp.logger.add("INFO", "反代 serve 正常退出")
		}
		rp.mu.Lock()
		rp.running = false
		rp.mu.Unlock()
	}()

	return nil
}

func (rp *reverseProxy) Stop() error {
	rp.logger.add("INFO", "========== 开始停止反代 ==========")

	rp.mu.Lock()
	if !rp.running {
		rp.mu.Unlock()
		rp.logger.add("INFO", "反代未在运行，跳过停止")
		return nil
	}
	rp.running = false
	rp.mu.Unlock()

	var stopErr error
	if rp.listener != nil {
		rp.logger.add("INFO", "关闭监听器...")
		if err := rp.listener.Close(); err != nil {
			stopErr = err
			rp.logger.add("WARN", fmt.Sprintf("关闭监听器异常: %v", err))
		}
	}
	if rp.server != nil {
		rp.logger.add("INFO", "关闭 HTTP Server...")
		if err := rp.server.Close(); err != nil {
			rp.logger.add("WARN", fmt.Sprintf("关闭 Server 异常: %v", err))
		}
	}
	rp.logger.add("INFO", "反向代理已停止")
	rp.logger.add("INFO", "========== 反代停止完成 ==========")
	return stopErr
}

func (rp *reverseProxy) IsRunning() bool {
	rp.mu.RLock()
	defer rp.mu.RUnlock()
	return rp.running
}

func (rp *reverseProxy) GetStatus() map[string]interface{} {
	rp.mu.RLock()
	defer rp.mu.RUnlock()
	status := map[string]interface{}{
		"running":     rp.running,
		"domain":      rp.config.Domain,
		"port":        rp.config.Port,
		"backendAddr": rp.config.BackendAddr,
		"startedAt":   "",
	}
	if !rp.startedAt.IsZero() {
		status["startedAt"] = rp.startedAt.Format("2006-01-02 15:04:05")
	}
	return status
}

// ---- 证书链加载 ----

// LoadCertificateChain 加载证书链（支持 fullchain）
// 直接使用 Go 标准库的 tls.X509KeyPair，它会保持文件中的证书顺序
// （fullchain.crt 的标准格式就是：叶子证书在前，中间证书在后）
func LoadCertificateChain(certPath, keyPath string) (*tls.Certificate, error) {
	certData, err := os.ReadFile(certPath)
	if err != nil {
		return nil, fmt.Errorf("读取证书失败: %v", err)
	}
	keyData, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("读取私钥失败: %v", err)
	}
	cert, err := tls.X509KeyPair(certData, keyData)
	if err != nil {
		return nil, fmt.Errorf("加载证书失败: %v", err)
	}
	if len(cert.Certificate) == 0 {
		return nil, fmt.Errorf("证书链为空")
	}
	// 设置 Leaf（Go TLS 库需要，用于 SNI 匹配和证书信息展示）
	cert.Leaf, _ = x509.ParseCertificate(cert.Certificate[0])
	return &cert, nil
}

// ---- 工具函数 ----

var gzipContentTypes = map[string]bool{
	"text/html": true, "text/plain": true, "text/css": true,
	"text/javascript": true, "application/javascript": true,
	"application/json": true, "application/xml": true, "text/xml": true,
	"image/svg+xml": true,
}

func isStaticContentType(ct string) bool {
	switch ct {
	case "text/css", "text/javascript", "application/javascript",
		"image/png", "image/jpeg", "image/gif", "image/svg+xml",
		"font/woff", "font/woff2", "application/font-woff":
		return true
	}
	return false
}

// 保留 copyResponse 以兼容旧代码（如果还有调用）
func copyResponse(dst io.Writer, src io.Reader) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
