package main

import (
	"crypto/tls"
	"crypto/x509"
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

//go:embed templates/gateway/index.html static/css/gateway.css
var rproxyAssets embed.FS

// ---- 全局单例（单进程共享） ----

var (
	gatewayProxy   *reverseProxy
	gatewayCerts   *CertManager
	gatewayLogger  *logManager
	gatewayTmpl    *template.Template
	gatewayCssData []byte
	gatewayBackend string
)

// ---- UI 初始化 ----

func initGateway(backend string) {
	gatewayBackend = backend
	gatewayLogger = newLogManager(500)
	gatewayCerts = NewCertManager(func(level, msg string) {
		gatewayLogger.add(level, msg)
	})
	gatewayProxy = newReverseProxy(ProxyConfig{BackendAddr: backend, GzipEnabled: true, HstsEnabled: true}, gatewayLogger)

	// 解析嵌入的模板
	tmpl, err := template.ParseFS(rproxyAssets, "templates/gateway/index.html")
	if err != nil {
		panic("failed to parse gateway template: " + err.Error())
	}
	gatewayTmpl = tmpl

	// 读取嵌入的 CSS
	cssData, err := rproxyAssets.ReadFile("static/css/gateway.css")
	if err != nil {
		panic("failed to read gateway css: " + err.Error())
	}
	gatewayCssData = cssData
}

// ---- HTTP Handlers ----

// handleGatewayPage 反代管理面板
func handleGatewayPage(w http.ResponseWriter, r *http.Request) {
	data := map[string]string{
		"title":     "外网访问",
		"appName":   "千盈传送",
		"localIp":   getLocalIP(),
		"localPort": parsePort(gatewayBackend),
		"author":    "联系反馈 微信：CQGGTF",
		"version":   "2.0.0",
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := gatewayTmpl.Execute(w, data); err != nil {
		gatewayLogger.add("ERROR", "模板渲染失败: "+err.Error())
		http.Error(w, "模板渲染失败", http.StatusInternalServerError)
	}
}

// handleGatewayCSS CSS 样式
func handleGatewayCSS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(gatewayCssData)
}

// apiStatus 返回反代状态
func apiStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, gatewayProxy.GetStatus())
}

// apiCerts 返回证书列表
func apiCerts(w http.ResponseWriter, r *http.Request) {
	certs := gatewayCerts.GetCertsForDisplay()
	if certs == nil {
		certs = []CertDisplayInfo{}
	}
	writeJSON(w, map[string]interface{}{"certs": certs})
}

// apiLogs 返回日志
func apiLogs(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if s := r.URL.Query().Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			limit = n
		}
	}
	writeJSON(w, map[string]interface{}{"logs": gatewayLogger.getAll(limit)})
}

// apiCheckPort 检查端口是否可用
func apiCheckPort(w http.ResponseWriter, r *http.Request) {
	portStr := r.URL.Query().Get("port")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		writeJSON(w, map[string]interface{}{"available": false, "message": "端口号无效"})
		return
	}
	available := checkPortAvailable(port)
	result := map[string]interface{}{"available": available, "port": port}
	if available {
		result["message"] = "端口可用"
	} else {
		result["message"] = "端口已被占用"
		if sp := suggestPort(port); sp > 0 {
			result["suggested_port"] = sp
		}
	}
	writeJSON(w, result)
}

// apiStart 启动反代
func apiStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Domain      string `json:"domain"`
		Port        int    `json:"port"`
		BackendAddr string `json:"backend_addr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, map[string]interface{}{"success": false, "message": "参数错误"})
		return
	}
	if req.Domain == "" {
		writeJSON(w, map[string]interface{}{"success": false, "message": "请选择域名"})
		return
	}
	if req.Port == 0 {
		req.Port = 7753
	}
	if req.BackendAddr == "" {
		req.BackendAddr = gatewayBackend
	}

	cert := gatewayCerts.GetCertByDomain(req.Domain)
	if cert == nil {
		writeJSON(w, map[string]interface{}{"success": false, "message": "未找到对应证书或证书不可用"})
		return
	}
	if !checkPortAvailable(req.Port) {
		msg := fmt.Sprintf("端口 %d 已被占用", req.Port)
		if sp := suggestPort(req.Port); sp > 0 {
			msg = fmt.Sprintf("端口 %d 已被占用，建议尝试端口 %d", req.Port, sp)
		}
		writeJSON(w, map[string]interface{}{"success": false, "message": msg})
		return
	}

	if gatewayProxy.IsRunning() {
		gatewayProxy.Stop()
		time.Sleep(500 * time.Millisecond)
	}

	if err := gatewayProxy.Start(req.Domain, req.Port, req.BackendAddr, cert.CertPath, cert.KeyPath); err != nil {
		gatewayLogger.add("ERROR", "启动反代失败: "+err.Error())
		writeJSON(w, map[string]interface{}{"success": false, "message": err.Error()})
		return
	}

	// 持久化配置
	if err := SaveConfig(&ProxyConfig{
		Domain:      req.Domain,
		Port:        req.Port,
		BackendAddr: req.BackendAddr,
		CertPath:    cert.CertPath,
		KeyPath:     cert.KeyPath,
	}); err != nil {
		gatewayLogger.add("WARN", "保存配置失败: "+err.Error())
	}
	writeJSON(w, map[string]interface{}{"success": true})
}

// apiStop 停止反代
func apiStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := gatewayProxy.Stop(); err != nil {
		writeJSON(w, map[string]interface{}{"success": false, "message": err.Error()})
		return
	}
	writeJSON(w, map[string]interface{}{"success": true})
}

// ---- 工具函数 ----

func writeJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func getLocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	return "127.0.0.1"
}

func parsePort(backend string) string {
	u, err := url.Parse(backend)
	if err != nil {
		return "5553"
	}
	if p := u.Port(); p != "" {
		return p
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

func checkPortAvailable(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

func suggestPort(preferred int) int {
	for i := 0; i < 20; i++ {
		p := preferred + i
		if checkPortAvailable(p) {
			return p
		}
	}
	return 0
}

// validateCertForDisplay 校验证书（前端展示用）
func validateCertForDisplay(certPath, keyPath string) (*x509.Certificate, error) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, err
	}
	if len(cert.Certificate) == 0 {
		return nil, fmt.Errorf("empty cert chain")
	}
	return x509.ParseCertificate(cert.Certificate[0])
}
