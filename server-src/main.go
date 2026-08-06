package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"fn_qycs/handler"
	"fn_qycs/service"
	"fn_qycs/store"
)

//go:embed static/*
var staticFiles embed.FS

// 应用版本号，构建时通过 -ldflags "-X main.appVersion=$version" 注入
var appVersion = "dev"

// 首页模板缓存
var indexTmpl *template.Template

func main() {
	// ====== 初始化文件日志 ======
	logDir := LogDir()
	os.MkdirAll(logDir, 0755)
	initMainLogger(logDir)

	mainLogger("INFO", "========== 千盈传送 启动 ==========")
	mainLogger("INFO", fmt.Sprintf("日志目录: %s", logDir))
	mainLogger("INFO", fmt.Sprintf("数据目录: %s", DataDir()))

	mux := http.NewServeMux()

	// WebSocket 路由
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handler.GetWSHandler().HandleWebSocket(w, r)
	})

	// API 路由
	mux.HandleFunc("/api/create-task", handler.GetUploadHandler().CreateTask)
	mux.HandleFunc("/api/upload", handler.GetUploadHandler().HandleUpload)
	mux.HandleFunc("/api/upload-complete", handler.GetUploadHandler().HandleUploadComplete)
	mux.HandleFunc("/api/task/", handler.GetUploadHandler().GetTask)
	mux.HandleFunc("/api/cancel-task", handler.GetUploadHandler().CancelTask)

	// 公网 WebRTC ICE 服务器列表（v2.0.1 房间系统需要）
	mux.HandleFunc("/api/ice-servers", handler.HandleIceServers)

	// 传送设置 API
	mux.HandleFunc("/api/settings", handler.HandleSettings)
	mux.HandleFunc("/api/max-file-size", handler.HandleMaxFileSize)

	// 文件下载路由
	mux.HandleFunc("/download/", handler.GetDownloadHandler().HandleDownload)

	// 调试接口
	mux.HandleFunc("/api/debug/devices", handleDebugDevices)

	// === 反代管理面板（单进程内嵌，无需子进程）===
	backend := fmt.Sprintf("http://127.0.0.1:%s", getBackendPort())
	initGateway(backend)

	// 解析首页模板（缓存以支持版本号动态注入）
	if tmpl, err := template.ParseFS(staticFiles, "static/index.html"); err != nil {
		mainLogger("ERROR", fmt.Sprintf("首页模板解析失败: %v", err))
	} else {
		indexTmpl = tmpl
	}

	// 反代日志持久化到文件
	if err := gatewayLogger.SetLogFile(logDir); err != nil {
		mainLogger("WARN", fmt.Sprintf("反代日志文件设置失败: %v", err))
	} else {
		mainLogger("INFO", fmt.Sprintf("反代日志文件: %s/rproxy.log", logDir))
	}

	// 反代面板
	mux.HandleFunc("/gateway", handleGatewayPage)
	mux.HandleFunc("/gateway/api/status", apiStatus)
	mux.HandleFunc("/gateway/api/certs", apiCerts)
	mux.HandleFunc("/gateway/api/logs", apiLogs)
	mux.HandleFunc("/gateway/api/check-port", apiCheckPort)
	mux.HandleFunc("/gateway/api/settings", handler.HandleSettings)
	mux.HandleFunc("/gateway/api/max-file-size", handler.HandleMaxFileSize)
	mux.HandleFunc("/gateway/api/start", apiStart)
	mux.HandleFunc("/gateway/api/stop", apiStop)
	mux.HandleFunc("/gateway/static/css/gateway.css", handleGatewayCSS)

	// 静态文件（传输页面）
	mux.HandleFunc("/", serveIndex)

	// 端口
	port := os.Getenv("PORT")
	if port == "" {
		port = "5553"
	}
	addr := ":" + port

	server := &http.Server{Handler: tcpGatewayGuard(mux)}

	// TCP 监听
	tcpListener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("TCP 监听失败: %v", err)
	}

	mainLogger("INFO", fmt.Sprintf("TCP 监听: %s", addr))
	log.Printf("千盈传送 启动中... 端口 %s", port)

	// Unix Socket 监听（飞牛统一网关）
	go startUnixSocket(http.StripPrefix("/app/fn_qycs", mux))

	// 启动 TCP 服务
	go func() {
		if err := server.Serve(tcpListener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("服务器启动失败: %v", err)
		}
	}()

	// 自动恢复：读取持久化配置，启动反代
	go autoRecover()

	mainLogger("INFO", fmt.Sprintf("=== 启动成功! 端口 %s ===", port))
	log.Printf("=== 启动成功! 访问 http://localhost:%s ===", port)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	mainLogger("INFO", "========== 收到终止信号，准备关闭 ==========")

	// 停止反代
	if gatewayProxy != nil && gatewayProxy.IsRunning() {
		mainLogger("INFO", "停止反代...")
		if err := gatewayProxy.Stop(); err != nil {
			mainLogger("WARN", fmt.Sprintf("停止反代失败: %v", err))
		}
	}

	mainLogger("INFO", "关闭 TCP 服务...")
	log.Println("正在关闭...")
	server.Close()

	store.Close()
	mainLogger("INFO", "数据库已关闭")

	mainLogger("INFO", "========== 千盈传送 已关闭 ==========")
}

// autoRecover 读取持久化配置，自动启动反代
func autoRecover() {
	time.Sleep(1 * time.Second)
	cfg := LoadConfig()
	if cfg == nil || cfg.Port == 0 {
		return
	}
	needSave := false

	// 修复：旧配置可能没有保存 backend_addr，回退到默认后端
	if cfg.BackendAddr == "" {
		cfg.BackendAddr = gatewayBackend
		needSave = true
		gatewayLogger.add("WARN", fmt.Sprintf("旧配置缺少后端地址，已回退到: %s", gatewayBackend))
	}

	cert := gatewayCerts.GetCertByDomain(cfg.Domain)
	if cert == nil {
		gatewayLogger.add("WARN", fmt.Sprintf("自动恢复失败：未找到域名 %s 的证书", cfg.Domain))
		return
	}

	if err := gatewayProxy.Start(cfg.Domain, cfg.Port, cfg.BackendAddr, cert.CertPath, cert.KeyPath); err != nil {
		gatewayLogger.add("ERROR", fmt.Sprintf("自动恢复失败：%v", err))
		return
	}

	gatewayLogger.add("INFO", fmt.Sprintf("已从配置自动启动反代: %s:%d -> %s", cfg.Domain, cfg.Port, cfg.BackendAddr))

	// 修复后的配置写回磁盘，避免下次重启再告警
	if needSave {
		cfg.CertPath = cert.CertPath
		cfg.KeyPath = cert.KeyPath
		if err := SaveConfig(cfg); err != nil {
			gatewayLogger.add("WARN", fmt.Sprintf("保存修复后的配置失败: %v", err))
		} else {
			gatewayLogger.add("INFO", "配置已修复并保存，下次启动不再告警")
		}
	}
}

// ---- Unix Socket（飞牛统一网关）----

func startUnixSocket(handler http.Handler) {
	var sockPaths []string
	if sockPath := os.Getenv("GATEWAY_SOCKET"); sockPath != "" {
		sockPaths = append(sockPaths, sockPath)
	}
	if extraPath := os.Getenv("EXTRA_SOCKET_PATH"); extraPath != "" {
		found := false
		for _, p := range sockPaths {
			if p == extraPath {
				found = true
				break
			}
		}
		if !found {
			sockPaths = append(sockPaths, extraPath)
		}
	}
	if len(sockPaths) == 0 {
		sockPaths = []string{"/var/apps/fn_qycs/target/app.sock"}
	}
	for _, sockPath := range sockPaths {
		go createSocketListener(sockPath, handler)
	}
}

func createSocketListener(sockPath string, handler http.Handler) {
	sockDir := filepath.Dir(sockPath)
	if err := os.MkdirAll(sockDir, 0755); err != nil {
		log.Printf("Socket 目录创建失败 %s: %v", sockDir, err)
		return
	}
	os.Remove(sockPath)
	listener, err := net.Listen("unix", sockPath)
	if err != nil {
		log.Printf("Unix Socket 创建失败 %s: %v", sockPath, err)
		return
	}
	defer listener.Close()
	os.Chmod(sockPath, 0666)
	log.Printf("统一网关 socket: %s", sockPath)
	srv := &http.Server{Handler: handler}
	if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Printf("Unix Socket 服务错误 %s: %v", sockPath, err)
	}
}

// ---- 静态文件服务 ----

// tcpGatewayGuard 拦截 TCP 端口对 /gateway 管理面板的访问，
// 确保 gateway 仅能通过飞牛统一网关（Unix Socket）访问。
// 设置环境变量 GATEWAY_ALLOW_TCP=1 可临时开放 TCP 访问（调试用）。
func tcpGatewayGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/gateway") && os.Getenv("GATEWAY_ALLOW_TCP") != "1" {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// 传输页面根
	if path == "/" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if indexTmpl != nil {
			var buf bytes.Buffer
			data := map[string]string{
				"version": appVersion,
			}
			if err := indexTmpl.Execute(&buf, data); err == nil {
				w.Write(buf.Bytes())
				return
			}
			mainLogger("WARN", "首页模板渲染失败，回退原始HTML")
		}
		data, err := staticFiles.ReadFile("static/index.html")
		if err != nil {
			http.ServeFile(w, r, "static/index.html")
			return
		}
		w.Write(data)
		return
	}

	// favicon
	if path == "/favicon.ico" {
		data, err := staticFiles.ReadFile("static/favicon.ico")
		if err == nil {
			w.Header().Set("Content-Type", "image/x-icon")
			w.Write(data)
			return
		}
		http.NotFound(w, r)
		return
	}

	// 反代 CSS（统一网关路径 /app/fn_qycs/gateway -> strip 后是 /gateway/static/css/gateway.css）
	if path == "/gateway/static/css/gateway.css" {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(gatewayCssData)
		return
	}

	// 传输静态文件（去掉前缀 static/）
	if strings.HasPrefix(path, "/static/") {
		filePath := path[1:] // 去掉 leading /
		contentType := getContentType(filePath)
		data, err := staticFiles.ReadFile(filePath)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(data)
		return
	}

	http.NotFound(w, r)
}

func getContentType(path string) string {
	switch {
	case strings.HasSuffix(path, ".css"):
		return "text/css"
	case strings.HasSuffix(path, ".js"):
		return "application/javascript"
	case strings.HasSuffix(path, ".mjs"):
		return "application/javascript"
	case strings.HasSuffix(path, ".png"):
		return "image/png"
	case strings.HasSuffix(path, ".jpg"), strings.HasSuffix(path, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(path, ".gif"):
		return "image/gif"
	case strings.HasSuffix(path, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(path, ".ico"):
		return "image/x-icon"
	case strings.HasSuffix(path, ".woff"):
		return "font/woff"
	case strings.HasSuffix(path, ".woff2"):
		return "font/woff2"
	case strings.HasSuffix(path, ".ttf"):
		return "font/ttf"
	case strings.HasSuffix(path, ".otf"):
		return "font/otf"
	case strings.HasSuffix(path, ".html"), strings.HasSuffix(path, ".htm"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(path, ".json"):
		return "application/json"
	case strings.HasSuffix(path, ".webp"):
		return "image/webp"
	case strings.HasSuffix(path, ".webmanifest"):
		return "application/manifest+json"
	default:
		return "application/octet-stream"
	}
}

// ---- init ----

func init() {
	dataDir := DataDir()
	os.MkdirAll(dataDir, 0755)
	log.Printf("数据目录: %s", dataDir)
	// 初始化 SQLite 数据库（替代 JSON 文件存储）
	store.DB()
	log.Println("SQLite 数据库已就绪")
}

func getBackendPort() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	if p := os.Getenv("wizard_app_port"); p != "" {
		return p
	}
	return "5553"
}

// ====== 主进程文件日志（用于排查 bug） ======

var mainLogFile *os.File

// LogDir 返回日志目录
func LogDir() string {
	if d := os.Getenv("TRIM_PKGVAR"); d != "" {
		return filepath.Join(d, "logs")
	}
	if d := os.Getenv("TRIM_APPDEST"); d != "" {
		return filepath.Join(d, "logs")
	}
	// 飞牛默认位置
	return "/var/apps/fn_qycs/var/logs"
}

func initMainLogger(logDir string) {
	if err := os.MkdirAll(logDir, 0755); err != nil {
		log.Printf("创建日志目录失败: %v", err)
		return
	}
	logPath := filepath.Join(logDir, "main.log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		log.Printf("打开主日志文件失败: %v", err)
		return
	}
	mainLogFile = f
	// 同时输出到 stderr（被 cmd/main 的 nohup 重定向到 debug.log）
	log.SetOutput(io.MultiWriter(os.Stderr, f))
}

func mainLogger(level, msg string) {
	line := fmt.Sprintf("[%s] [%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), level, msg)
	// 写入文件
	if mainLogFile != nil {
		mainLogFile.WriteString(line)
		mainLogFile.Sync()
	}
	// 写入 stderr
	os.Stderr.WriteString(line)
}

// ---- 调试接口 ----

type debugDevicesResp struct {
	ActiveDevices  []*service.Device    `json:"activeDevices"`
	OfflineDevices []*service.Device    `json:"offlineDevices"`
	Connections    *handler.DebugWSInfo `json:"connections"`
	ServerAddrs    []string             `json:"serverAddrs"`
}

func handleDebugDevices(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	dm := service.GetDeviceManager()

	// 获取服务器自身地址
	addrs := []string{}
	ifaces, err := net.Interfaces()
	if err == nil {
		for _, iface := range ifaces {
			iaddrs, err := iface.Addrs()
			if err != nil {
				continue
			}
			for _, addr := range iaddrs {
				addrs = append(addrs, addr.String())
			}
		}
	}

	resp := debugDevicesResp{
		ActiveDevices:  dm.GetAllDevices(),
		OfflineDevices: dm.GetOfflineDevicesForDebug(),
		Connections:    handler.GetWSHandler().GetDebugInfo(),
		ServerAddrs:    addrs,
	}
	json.NewEncoder(w).Encode(resp)
}
