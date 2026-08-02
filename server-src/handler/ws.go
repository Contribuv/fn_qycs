package handler

import (
	"encoding/json"
	"log"
	"math/rand"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"fn_qycs/service"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

// Message 消息结构
type Message struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
}

// WSHandler WebSocket 处理器
type WSHandler struct {
	mu          sync.RWMutex
	connections map[string]*websocket.Conn
	writeMu     map[string]*sync.Mutex
}

var wsh *WSHandler
var wshOnce sync.Once

// GetWSHandler 获取单例
func GetWSHandler() *WSHandler {
	wshOnce.Do(func() {
		wsh = &WSHandler{
			connections: make(map[string]*websocket.Conn),
			writeMu:     make(map[string]*sync.Mutex),
		}
		// 启动心跳检查协程
		go wsh.heartbeatChecker()
	})
	return wsh
}

// HandleWebSocket 处理 WebSocket 连接
func (h *WSHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	ip := getClientIP(r)

	log.Printf("WebSocket 连接: ip=%s, remoteAddr=%s, xff=%s, xri=%s",
		ip, r.RemoteAddr,
		r.Header.Get("X-Forwarded-For"),
		r.Header.Get("X-Real-IP"))

	// 拒绝非局域网设备的连接：先接受 WebSocket 连接，再发送限制消息
	// 这样前端可以区分“局域网限制”和“连接错误”，并显示 status-text 反馈
	// 统一网关（Unix Socket）视为可信局域网入口；反代流量按真实客户端 IP 判断，
	// 因此外网客户端经反代访问也会被拦截，不发现设备
	if !isLocalEntry(r) && !isPrivateIP(ip) {
		log.Printf("拒绝非局域网设备连接: ip=%s", ip)
		// 接受连接
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("WebSocket upgrade error: %v", err)
			return
		}
		// 发送局域网限制消息后关闭
		msg := `{"type":"error","code":"lan_only","message":"仅允许局域网设备连接"}`
		conn.WriteMessage(websocket.TextMessage, []byte(msg))
		conn.Close()
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	defer conn.Close()

	// 从请求中获取前端传入的名字（如果刷新页面会保存）
	deviceName := r.URL.Query().Get("name")
	if deviceName == "" {
		deviceName = service.GetNameGenerator().Generate()
	} else {
		// 使用前端传入的名字，强制标记为已用（TryRegisterOrReuse 内部会根据 ip+name 判断复用）
		service.GetNameGenerator().ForceUseName(deviceName)
	}

	// 尝试复用同名设备（刷新场景），否则注册新设备
	dm := service.GetDeviceManager()
	var device *service.Device

	// 尝试复用（通过 IP 匹配，同一浏览器刷新后 IP 相同，name 相同）
	reusedID, reusedDevice, reused := dm.TryRegisterOrReuse(ip, deviceName)
	if reused && reusedID != "" {
		deviceID := reusedID
		device = reusedDevice
		// 注册到 WebSocket 连接管理器（复用同一位置）
		h.mu.Lock()
		delete(h.connections, deviceID)
		if existingMu, ok := h.writeMu[deviceID]; ok {
			h.connections[deviceID] = conn
			h.writeMu[deviceID] = existingMu
		} else {
			h.connections[deviceID] = conn
			h.writeMu[deviceID] = &sync.Mutex{}
		}
		h.mu.Unlock()

		// 发送欢迎消息
		h.sendToConn(conn, &Message{
			Type: "welcome",
			Payload: map[string]interface{}{
				"deviceId": deviceID,
				"device":   device,
				"reused":   true,
			},
		})
	} else {
		deviceID := generateID()

		// 注册到 WebSocket 连接管理器
		h.mu.Lock()
		h.connections[deviceID] = conn
		h.writeMu[deviceID] = &sync.Mutex{}
		h.mu.Unlock()

		// 注意：先获取设备列表（此时自己还未注册），再注册设备
		existingDevices := dm.GetDevicesExcluding("")
		device = dm.Register(deviceID, deviceName, ip)

		// 发送欢迎消息和当前设备列表
		h.sendToConn(conn, &Message{
			Type: "welcome",
			Payload: map[string]interface{}{
				"deviceId": deviceID,
				"device":   device,
				"reused":   false,
			},
		})
		h.sendToConn(conn, &Message{
			Type:    "device_list",
			Payload: existingDevices,
		})

		// 广播新设备上线
		go h.Broadcast(&Message{
			Type:    "device_online",
			Payload: device,
		})
	}

	// 发送当前设备列表（排除自己）
	devices := service.GetDeviceManager().GetDevicesExcluding(device.ID)
	h.sendToConn(conn, &Message{
		Type:    "device_list",
		Payload: devices,
	})

	// 读取消息
	h.readLoop(conn, device.ID)
}

// readLoop 读取消息循环
func (h *WSHandler) readLoop(conn *websocket.Conn, deviceID string) {
	defer func() {
		h.mu.Lock()
		delete(h.connections, deviceID)
		delete(h.writeMu, deviceID)
		h.mu.Unlock()

		// 使用 MarkOffline 而非 Unregister：设备断开后保留离线缓存
		// 便于刷新页面时复用设备记录
		service.GetDeviceManager().MarkOffline(deviceID)

		h.Broadcast(&Message{
			Type: "device_offline",
			Payload: map[string]string{
				"deviceId": deviceID,
			},
		})
	}()

	conn.SetReadDeadline(time.Now().Add(service.TimeoutDuration))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(service.TimeoutDuration))
		return nil
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket read error: %v", err)
			}
			break
		}

		h.handleMessage(deviceID, message)
	}
}

// handleMessage 处理消息
func (h *WSHandler) handleMessage(deviceID string, data []byte) {
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("JSON unmarshal error: %v", err)
		return
	}

	switch msg.Type {
	case "heartbeat":
		service.GetDeviceManager().Heartbeat(deviceID)
		h.SendToDevice(deviceID, &Message{Type: "heartbeat_ack"})

	case "request_device_list":
		devices := service.GetDeviceManager().GetDevicesExcluding(deviceID)
		h.SendToDevice(deviceID, &Message{
			Type:    "device_list",
			Payload: devices,
		})

	// ===== WebRTC P2P 信令转发（服务器只做信令，不接触文件数据）=====
	case "transfer_request":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if toID, ok := payload["toId"].(string); ok {
				payload["fromId"] = deviceID
				h.SendToDevice(toID, &Message{Type: "transfer_request", Payload: payload})
			}
		}

	case "webrtc_offer":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if toID, ok := payload["toId"].(string); ok {
				payload["fromId"] = deviceID
				h.SendToDevice(toID, &Message{Type: "webrtc_offer", Payload: payload})
			}
		}

	case "webrtc_answer":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if toID, ok := payload["toId"].(string); ok {
				payload["fromId"] = deviceID
				h.SendToDevice(toID, &Message{Type: "webrtc_answer", Payload: payload})
			}
		}

	case "webrtc_candidate":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if toID, ok := payload["toId"].(string); ok {
				payload["fromId"] = deviceID
				h.SendToDevice(toID, &Message{Type: "webrtc_candidate", Payload: payload})
			}
		}

	case "update_name":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if name, ok := payload["name"].(string); ok {
				if name != "" {
					service.GetDeviceManager().UpdateName(deviceID, name)
					h.Broadcast(&Message{
						Type: "device_name_updated",
						Payload: map[string]string{
							"deviceId": deviceID,
							"name":     name,
						},
					})
				}
			}
		}

	case "transfer_accept":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if fromID, ok := payload["fromId"].(string); ok {
				// 通知发送方：接收方已同意，开始 WebRTC P2P 连接
				h.SendToDevice(fromID, &Message{
					Type: "transfer_accept",
					Payload: map[string]interface{}{
						"toId":   deviceID,
						"taskId": payload["taskId"],
					},
				})
			}
		}

	case "transfer_reject":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if fromID, ok := payload["fromId"].(string); ok {
				h.SendToDevice(fromID, &Message{
					Type: "transfer_reject",
					Payload: map[string]interface{}{
						"toId":   deviceID,
						"taskId": payload["taskId"],
					},
				})
			}
		}

	case "transfer_complete":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if toID, ok := payload["toId"].(string); ok {
				h.SendToDevice(toID, &Message{
					Type: "transfer_complete",
					Payload: map[string]interface{}{
						"taskId": payload["taskId"],
					},
				})
			}
		}
	}
}

// Broadcast 广播消息给所有设备
func (h *WSHandler) Broadcast(msg *Message) {
	data, _ := json.Marshal(msg)
	h.mu.RLock()
	defer h.mu.RUnlock()

	for id, conn := range h.connections {
		if mu, ok := h.writeMu[id]; ok {
			mu.Lock()
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Printf("Broadcast error: %v", err)
			}
			mu.Unlock()
		} else {
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Printf("Broadcast error: %v", err)
			}
		}
	}
}

// SendToDevice 发送消息给指定设备
func (h *WSHandler) SendToDevice(deviceID string, msg *Message) {
	h.mu.RLock()
	conn, ok := h.connections[deviceID]
	h.mu.RUnlock()

	if ok {
		h.sendToConn(conn, msg)
	}
}

// sendToConn 发送消息到连接
func (h *WSHandler) sendToConn(conn *websocket.Conn, msg *Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Marshal error for %s: %v", msg.Type, err)
		return
	}

	// 找到该连接对应设备的互斥锁，避免并发写冲突
	h.mu.RLock()
	var mu *sync.Mutex
	for id, c := range h.connections {
		if c == conn {
			mu = h.writeMu[id]
			break
		}
	}
	h.mu.RUnlock()

	if mu != nil {
		mu.Lock()
		defer mu.Unlock()
	}

	log.Printf(">>> 发送消息 [%s]: %s", msg.Type, string(data))
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("Send error: %v", err)
	}
}

// heartbeatChecker 心跳检查协程
func (h *WSHandler) heartbeatChecker() {
	ticker := time.NewTicker(service.HeartbeatInterval)
	defer ticker.Stop()

	for range ticker.C {
		// 发送 ping 维持连接（设备列表由前端主动请求，避免重复发送浪费带宽）
		h.mu.RLock()
		for deviceID := range h.connections {
			h.SendToDevice(deviceID, &Message{Type: "ping"})
		}
		h.mu.RUnlock()

		// 检查活跃设备超时
		timeoutIDs := service.GetDeviceManager().CheckTimeout()
		for _, id := range timeoutIDs {
			h.mu.Lock()
			if conn, ok := h.connections[id]; ok {
				conn.Close()
				delete(h.connections, id)
				delete(h.writeMu, id)
			}
			h.mu.Unlock()

			h.Broadcast(&Message{
				Type: "device_offline",
				Payload: map[string]string{
					"deviceId": id,
				},
			})
		}
	}
}

// DebugWSInfo 调试信息
type DebugWSInfo struct {
	ConnectionCount int      `json:"connectionCount"`
	ConnectionIDs   []string `json:"connectionIds"`
}

// GetDebugInfo 获取调试信息
func (h *WSHandler) GetDebugInfo() *DebugWSInfo {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ids := make([]string, 0, len(h.connections))
	for id := range h.connections {
		ids = append(ids, id)
	}
	return &DebugWSInfo{
		ConnectionCount: len(h.connections),
		ConnectionIDs:   ids,
	}
}

// gatewayClientIP 标识经由飞牛统一网关（Unix Socket）透传的请求。
// 网关透传原始请求但不设置 X-Forwarded-For，无法提取真实客户端 IP，
// 使用固定标识（而非 socket 路径字符串），避免设备注册写入非法 IP 与复用键污染。
const gatewayClientIP = "gateway"

// getClientIP 获取客户端 IP
// 仅信任来自可信代理（本机反代/统一网关）的 X-Forwarded-For / X-Real-IP，
// 直连请求可能伪造这些头，一律用 RemoteAddr
func getClientIP(r *http.Request) string {
	if isTrustedProxy(r) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			ips := strings.Split(xff, ",")
			rawIP := strings.TrimSpace(ips[0])
			// 优先返回 IPv4 地址
			if ipv4 := toIPv4(rawIP); ipv4 != "" {
				return ipv4
			}
			return rawIP
		}
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			if ipv4 := toIPv4(xri); ipv4 != "" {
				return ipv4
			}
			return xri
		}
		// 受信任代理但未提供转发头（如飞牛统一网关 Unix Socket 透传场景）：
		// 网关透传原始请求且不设置 X-Forwarded-For，无法提取真实客户端 IP。
		// 返回固定网关标识，避免回退到非法的 socket 路径字符串（如 @ 或 .sock 路径），
		// 也不写入设备注册逻辑造成污染；放行由 isLocalEntry 兜底。
		return gatewayClientIP
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	// 尝试提取 IPv4
	if ipv4 := toIPv4(ip); ipv4 != "" {
		return ipv4
	}
	return ip
}

// isTrustedProxy 判断请求是否来自可信代理（本机反代 127.0.0.1 或统一网关 Unix Socket）
// 只有可信代理设置的 X-Forwarded-For / X-Real-IP 才被采信，防止直连伪造
func isTrustedProxy(r *http.Request) bool {
	if r.RemoteAddr == "" {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// toIPv4 将 IPv4-mapped IPv6 地址（如 ::ffff:192.168.1.1）转换为 IPv4
// 如果本身就是 IPv4 或无法转换，返回空字符串
func toIPv4(rawIP string) string {
	ip := net.ParseIP(rawIP)
	if ip == nil {
		return ""
	}
	// To4() 对 IPv4-mapped IPv6 返回 4 字节，对普通 IPv4 返回 4 字节，对纯 IPv6 返回 nil
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ""
}

// generateID 生成唯一ID
func generateID() string {
	return time.Now().Format("20060102150405") + randomString(8)
}

// randomString 生成随机字符串
func randomString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

// privateIPRanges 私有/局域网 IP 网段
var privateIPRanges []*net.IPNet
var serverSubnets []*net.IPNet

func init() {
	for _, cidr := range []string{
		// IPv4 私有地址
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"127.0.0.0/8",
		// IPv4 链路本地
		"169.254.0.0/16",
		// IPv4 CGNAT (运营商级NAT)
		"100.64.0.0/10",
		// IPv6 私有地址
		"fc00::/7",
		"fe80::/10",
		"::1/128",
	} {
		_, network, err := net.ParseCIDR(cidr)
		if err == nil {
			privateIPRanges = append(privateIPRanges, network)
		}
	}

	// 收集服务器自身的网卡网段，用于同网段检测
	ifaces, err := net.Interfaces()
	if err == nil {
		for _, iface := range ifaces {
			addrs, err := iface.Addrs()
			if err != nil {
				continue
			}
			for _, addr := range addrs {
				if ipNet, ok := addr.(*net.IPNet); ok {
					serverSubnets = append(serverSubnets, ipNet)
				}
			}
		}
	}
}

// isLocalEntry 判断请求是否来自统一网关（Unix Socket）
//
// 仅 Unix Socket 视为本机可信入口：统一网关把请求直接转过来时，
// RemoteAddr 无法 SplitHostPort 解析（如 "@" 或空），此时应视为局域网。
//
// 反向代理（loopback TCP，RemoteAddr 为 127.0.0.1）不再视为可信入口，
// 反代流量必须通过 X-Forwarded-For 提取真实客户端 IP，再由 isPrivateIP 判定
// 真实客户端是否在局域网内，从而阻止外网用户经反代绕过 lan_only。
func isLocalEntry(r *http.Request) bool {
	if r.RemoteAddr == "" {
		return true
	}
	if _, _, err := net.SplitHostPort(r.RemoteAddr); err != nil {
		// 无法解析（Unix Socket 等）-> 视为本机可信入口（统一网关）
		return true
	}
	return false
}

// isPrivateIP 检测 IP 是否属于局域网/私有地址范围
func isPrivateIP(ipStr string) bool {
	ip := net.ParseIP(strings.TrimSpace(ipStr))
	if ip == nil {
		return false
	}
	// 1. 检查是否在已知私有网段
	for _, network := range privateIPRanges {
		if network.Contains(ip) {
			return true
		}
	}
	// 2. 检查是否与服务器在同一网段（处理公网IPv6但在同局域网的情况）
	for _, subnet := range serverSubnets {
		if subnet.Contains(ip) {
			return true
		}
	}
	return false
}
