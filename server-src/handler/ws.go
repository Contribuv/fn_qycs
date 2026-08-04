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
	mu             sync.RWMutex
	connections    map[string]*websocket.Conn
	writeMu        map[string]*sync.Mutex
	connRestricted map[string]bool
}

var wsh *WSHandler
var wshOnce sync.Once

// GetWSHandler 获取单例
func GetWSHandler() *WSHandler {
	wshOnce.Do(func() {
		wsh = &WSHandler{
			connections:    make(map[string]*websocket.Conn),
			writeMu:        make(map[string]*sync.Mutex),
			connRestricted: make(map[string]bool),
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

	// 网络模式判定（v2.0.1 重构）：
	// 判定标准不再是"IP 是否为私网"，而是"客户端与谁同子网"：
	//   - 与服务器同子网（含服务器自身热点） -> 局域网（自动发现）
	//   - 与另一客户端同用户子网（连同一热点/WiFi，LocalLanIP 同前缀） -> 局域网（自动发现）
	//   - 其余（移动网络、异网、跨子网） -> 公网受限（仅房间互传）
	// 默认保守：无法确认同子网即受限，避免误暴露设备。
	restricted := !isSameSubnetAsServer(ip)
	if restricted {
		log.Printf("非服务器局域网连接（可能公网/异网，需经房间互传）: ip=%s", ip)
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
		h.connRestricted[deviceID] = restricted
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
		h.connRestricted[deviceID] = restricted
		h.mu.Unlock()

		// 注意：先注册设备（注册后才能正确收发设备列表/上线广播）
		device = dm.Register(deviceID, deviceName, ip)

		// 发送欢迎消息
		h.sendToConn(conn, &Message{
			Type: "welcome",
			Payload: map[string]interface{}{
				"deviceId": deviceID,
				"device":   device,
				"reused":   false,
			},
		})

		// 广播新设备上线（仅向非受限/局域网连接广播，公网受限连接不暴露局域网设备）
		go h.BroadcastLan(&Message{
			Type:    "device_online",
			Payload: device,
		})
	}

	// 发送当前设备列表（排除自己）；公网受限模式不暴露局域网设备
	if restricted {
		h.sendToConn(conn, &Message{
			Type:    "lan_only",
			Payload: map[string]string{"message": "当前为公网模式，仅支持暗号房间互传"},
		})
	} else {
		devices := h.getVisibleDevices(device.ID)
		h.sendToConn(conn, &Message{
			Type:    "device_list",
			Payload: devices,
		})
	}

	// 读取消息
	h.readLoop(conn, device.ID)
}

// readLoop 读取消息循环
func (h *WSHandler) readLoop(conn *websocket.Conn, deviceID string) {
	defer func() {
		h.mu.Lock()
		delete(h.connections, deviceID)
		delete(h.writeMu, deviceID)
		delete(h.connRestricted, deviceID)
		h.mu.Unlock()

		// 延迟离开房间：刷新页面时旧连接断开后新连接会在数秒内重连，
		// TryRegisterOrReuse 会复用同一 deviceId。若立即 LeaveRoom 会导致
		// 新连接 room_list 查不到房间 -> 房间状态丢失。
		// 等待 OfflineKeepDuration 后，若设备仍未重连（不在活跃列表中），才真正退房。
		go func() {
			time.Sleep(service.OfflineKeepDuration)
			// 设备已重连（在活跃列表中）-> 不退房
			if _, ok := service.GetDeviceManager().GetDevice(deviceID); ok {
				return
			}
			// 设备未重连 -> 真正离开房间并通知其他成员
			if room, left := service.GetRoomManager().LeaveRoom(deviceID); left {
				h.BroadcastRoom(room, deviceID, &Message{
					Type: "room_device_left",
					Payload: map[string]interface{}{
						"deviceId": deviceID,
					},
				})
			}
		}()

		// 使用 MarkOffline 而非 Unregister：设备断开后保留离线缓存
		// 便于刷新页面时复用设备记录
		service.GetDeviceManager().MarkOffline(deviceID)

		// 安全修复：使用 BroadcastLan 而非 Broadcast，避免向公网受限用户泄露局域网设备离线信息
		h.BroadcastLan(&Message{
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
		// 返回与自身同子网（服务器 LAN 或同用户热点/WiFi）的可见设备列表。
		// 若无可互见设备（纯公网、无同子网同伴），下发 lan_only 引导使用房间。
		devices := h.getVisibleDevices(deviceID)
		if len(devices) == 0 {
			h.SendToDevice(deviceID, &Message{
				Type:    "lan_only",
				Payload: map[string]string{"message": "当前为公网模式，仅支持暗号房间互传"},
			})
		} else {
			h.SendToDevice(deviceID, &Message{
				Type:    "device_list",
				Payload: devices,
			})
		}

	case "report_lan":
		// 前端探测到本机局域网 IP 后上报，用于"同用户子网"判定（热点/WiFi 直连场景）
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if lanIP, ok := payload["lanIp"].(string); ok && lanIP != "" {
				service.GetDeviceManager().UpdateLanIP(deviceID, lanIP)
				// 刷新彼此可见性（不依赖 isRestricted，热点用户也能拿到同子网同伴）
				devices := h.getVisibleDevices(deviceID)
				if len(devices) == 0 {
					h.SendToDevice(deviceID, &Message{
						Type:    "lan_only",
						Payload: map[string]string{"message": "当前为公网模式，仅支持暗号房间互传"},
					})
				} else {
					h.SendToDevice(deviceID, &Message{
						Type:    "device_list",
						Payload: devices,
					})
				}
				// 关键修复：上报后广播 device_online 通知已连接的同子网设备。
				// 连接时 BroadcastLan 因 LocalLanIP 尚为空而漏掉同子网同伴；
				// 现在 LocalLanIP 已就绪，sameSubnet 可正确判定，同伴应能发现此设备。
				if dev, ok := service.GetDeviceManager().GetDevice(deviceID); ok {
					go h.BroadcastLan(&Message{
						Type:    "device_online",
						Payload: dev,
					})
				}
			}
		}

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
					// 安全修复：使用 BroadcastLan 避免向公网受限用户泄露局域网设备信息
					h.BroadcastLan(&Message{
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

	case "transfer_cancel":
		// 传输取消通知：转发给对端，使其感知取消而非误判为连接异常
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if toID, ok := payload["toId"].(string); ok {
				h.SendToDevice(toID, &Message{
					Type: "transfer_cancel",
					Payload: map[string]interface{}{
						"taskId": payload["taskId"],
					},
				})
			}
		}

	// ===== 公网互传房间系统（v2.0.1）=====
	case "room_create":
		h.handleRoomCreate(deviceID, msg.Payload)

	case "room_join":
		h.handleRoomJoin(deviceID, msg.Payload)

	case "room_leave":
		h.handleRoomLeave(deviceID)

	case "room_list":
		h.handleRoomList(deviceID)

	case "room_webrtc_offer":
		h.handleRoomWebRTC(deviceID, "room_webrtc_offer", msg.Payload)

	case "room_webrtc_answer":
		h.handleRoomWebRTC(deviceID, "room_webrtc_answer", msg.Payload)

	case "room_webrtc_candidate":
		h.handleRoomWebRTC(deviceID, "room_webrtc_candidate", msg.Payload)
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

// isRestricted 检查某设备是否为公网受限连接
func (h *WSHandler) isRestricted(deviceID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connRestricted[deviceID]
}

// getVisibleDevices 返回对某设备可见的设备列表（排除自己）。
//
// 网络模式（v2.0.1 重构 + 修正）：
//   - 与服务器同子网（服务器 LAN 内） -> 互见
//   - 与另一客户端同用户子网（连同一热点/WiFi，前端探测局域网 IP 同 /24 前缀） -> 互见、直连
//   - 其余（移动、异网、跨子网且无同子网同伴） -> 不互见，仅可房间互传
//
// 关键修正：可见性不再依赖"自身是否公网受限"，而是"与候选设备是否同子网"。
// 连同一热点/WiFi 的公网用户（客户端 IP 为公网出口，但 LocalLanIP 同前缀）
// 也应互相发现并直连，之前被 isRestricted 误杀，现已解开。
func (h *WSHandler) getVisibleDevices(selfID string) []*service.Device {
	self, ok := service.GetDeviceManager().GetDevice(selfID)
	if !ok {
		return []*service.Device{}
	}

	all := service.GetDeviceManager().GetDevicesExcluding(selfID)
	visible := make([]*service.Device, 0, len(all))
	for _, d := range all {
		if d == nil {
			continue
		}
		// 与自己在同一个子网（服务器子网或同用户子网）才可见
		if !sameSubnet(self, d) {
			continue
		}
		visible = append(visible, d)
	}
	return visible
}

// sameSubnet 判断两个设备是否处于同一局域网（任一维度）：
//  1. 二者客户端 IP 都与服务器同子网（服务器 LAN 内）
//  2. 二者前端探测到的局域网 IP 落在同一私网前缀（连同一热点/WiFi）
func sameSubnet(a, b *service.Device) bool {
	if a == nil || b == nil {
		return false
	}
	// 维度 1：都与服务器同子网
	if isSameSubnetAsServer(a.IP) && isSameSubnetAsServer(b.IP) {
		return true
	}
	// 维度 2：同用户子网（前端探测的局域网 IP 私网前缀相同，且非服务器子网）
	if a.LocalLanIP != "" && b.LocalLanIP != "" {
		if lanPrefixEqual(a.LocalLanIP, b.LocalLanIP) {
			return true
		}
	}
	return false
}

// lanPrefixEqual 判断两个局域网 IP 是否在同一 /24 私网前缀。
// 仅对私有地址生效，避免把公网 IP 当子网判定。
func lanPrefixEqual(ipA, ipB string) bool {
	pa := net.ParseIP(strings.TrimSpace(ipA))
	pb := net.ParseIP(strings.TrimSpace(ipB))
	if pa == nil || pb == nil {
		return false
	}
	// 仅私网地址参与"同用户子网"判定
	if !isPrivateIP(ipA) || !isPrivateIP(ipB) {
		return false
	}
	va := pa.To4()
	vb := pb.To4()
	if va == nil || vb == nil {
		return false
	}
	// 比较前三段（/24）
	return va[0] == vb[0] && va[1] == vb[1] && va[2] == vb[2]
}

// isSameSubnetAsServer 判断客户端 IP 是否落在服务器自身任一网卡网段内。
// 这是"服务器局域网"判定的唯一标准：与服务器同子网才视为 LAN。
func isSameSubnetAsServer(ipStr string) bool {
	if ipStr == "" || ipStr == gatewayClientIP {
		// 统一网关透传：视为本机可信入口，允许局域网发现
		return true
	}
	ip := net.ParseIP(strings.TrimSpace(ipStr))
	if ip == nil {
		return false
	}
	for _, subnet := range serverSubnets {
		if subnet.Contains(ip) {
			return true
		}
	}
	return false
}

// BroadcastLan 仅向非受限（局域网）连接广播，公网受限连接不接收局域网设备信息。
// 对于设备上下线/改名事件，进一步按"同子网"过滤：仅通知与源设备处于同一
// 局域网（服务器子网或同用户子网）的接收方，避免异网/异热点设备互相感知。
func (h *WSHandler) BroadcastLan(msg *Message) {
	data, _ := json.Marshal(msg)
	h.mu.RLock()
	defer h.mu.RUnlock()

	// 提取源设备（用于同子网过滤）；非设备事件则全员（局域网内）广播
	var srcDev *service.Device
	if dev, ok := msg.Payload.(*service.Device); ok {
		srcDev = dev
	}

	for id, conn := range h.connections {
		// 设备事件：仅同子网接收方可见（含连同一热点/WiFi 的公网受限用户）
		if srcDev != nil {
			if target, ok := service.GetDeviceManager().GetDevice(id); ok {
				if !sameSubnet(srcDev, target) {
					continue
				}
			} else {
				continue
			}
		}
		if mu, ok := h.writeMu[id]; ok {
			mu.Lock()
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Printf("BroadcastLan error: %v", err)
			}
			mu.Unlock()
		} else {
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Printf("BroadcastLan error: %v", err)
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
				delete(h.connRestricted, id)
			}
			h.mu.Unlock()

			h.BroadcastLan(&Message{
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
		// 受信任代理但未提供转发头：
		// - Unix Socket（飞牛统一网关）：isLocalEntry 返回 true，返回固定标识，由 isLocalEntry 兜底放行
		// - 直接 localhost TCP 访问（非反代/网关）：isLocalEntry 返回 false，
		//   不能返回 "gateway"（会被 isPrivateIP 判为 false 导致误判公网模式），
		//   应回退到 RemoteAddr 提取真实 loopback IP
		if isLocalEntry(r) {
			return gatewayClientIP
		}
		// localhost TCP 直连：落入下方直连逻辑提取 127.0.0.1 / ::1
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
		// IPv4 CGNAT (运营商级NAT) 不视为私网：
		// 移动流量等出口多为 100.64/10，应判定为公网受限，避免误发现异网设备
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

	// 启动自检：打印进程实际收集到的服务器网卡网段
	// 在 Docker/虚拟化部署时，这里拿到的是容器网络命名空间内的网段（如 172.17.0.0/16），
	// 不一定包含真实用户设备所在的 192.168.x.x。若用户真实网段不在列表中，
	// "服务器同子网（维度1）"判定会失效，此时需依赖维度2（前端上报 LocalLanIP 同/24）兜底。
	if len(serverSubnets) == 0 {
		log.Println("[NET-CHECK] 警告：未收集到任何服务器网卡网段，维度1(服务器同子网)发现将始终失效")
	} else {
		segs := make([]string, 0, len(serverSubnets))
		for _, s := range serverSubnets {
			segs = append(segs, s.String())
		}
		log.Printf("[NET-CHECK] 服务器网卡网段(维度1判定基准)共 %d 个: %s", len(segs), strings.Join(segs, ", "))
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

// roomDevicesPayload 把房间成员转为前端设备视图 payload
func roomDevicesPayload(room *service.Room) []*service.RoomMember {
	return room.MemberList()
}

// handleRoomCreate 创建房间
func (h *WSHandler) handleRoomCreate(deviceID string, _ interface{}) {
	dm := service.GetDeviceManager()
	dev, _ := dm.GetDevice(deviceID)
	name := ""
	if dev != nil {
		name = dev.Name
	}
	room := service.GetRoomManager().CreateRoom(deviceID, name)
	h.SendToDevice(deviceID, &Message{
		Type: "room_created",
		Payload: map[string]interface{}{
			"roomId":  room.ID,
			"code":    room.Code,
			"ownerId": room.OwnerID,
			"devices": roomDevicesPayload(room),
		},
	})
}

// handleRoomJoin 通过暗号加入房间
func (h *WSHandler) handleRoomJoin(deviceID string, payload interface{}) {
	pl, ok := payload.(map[string]interface{})
	if !ok {
		h.SendToDevice(deviceID, &Message{
			Type:    "room_error",
			Payload: map[string]interface{}{"code": "invalid_payload", "message": "无效的加入请求"},
		})
		return
	}
	code, _ := pl["code"].(string)
	if code == "" {
		h.SendToDevice(deviceID, &Message{
			Type:    "room_error",
			Payload: map[string]interface{}{"code": "invalid_code", "message": "暗号不能为空"},
		})
		return
	}

	dm := service.GetDeviceManager()
	dev, _ := dm.GetDevice(deviceID)
	name := ""
	if dev != nil {
		name = dev.Name
	}

	room, joined := service.GetRoomManager().JoinRoom(code, deviceID, name)
	if !joined {
		h.SendToDevice(deviceID, &Message{
			Type:    "room_error",
			Payload: map[string]interface{}{"code": "room_not_found", "message": "房间不存在或已解散"},
		})
		return
	}

	// 通知加入者房间信息
	h.SendToDevice(deviceID, &Message{
		Type: "room_joined",
		Payload: map[string]interface{}{
			"roomId":  room.ID,
			"code":    room.Code,
			"ownerId": room.OwnerID,
			"devices": roomDevicesPayload(room),
		},
	})

	// 广播其他成员有新设备加入
	go h.BroadcastRoom(room, deviceID, &Message{
		Type: "room_device_joined",
		Payload: map[string]interface{}{
			"id":   deviceID,
			"name": name,
		},
	})
}

// handleRoomLeave 离开当前房间
func (h *WSHandler) handleRoomLeave(deviceID string) {
	room, left := service.GetRoomManager().LeaveRoom(deviceID)
	if !left {
		return
	}
	go h.BroadcastRoom(room, deviceID, &Message{
		Type: "room_device_left",
		Payload: map[string]interface{}{
			"deviceId": deviceID,
		},
	})
	h.SendToDevice(deviceID, &Message{Type: "room_left", Payload: map[string]interface{}{}})
}

// handleRoomList 查询自身所在房间信息（重连恢复房间态）
func (h *WSHandler) handleRoomList(deviceID string) {
	room, ok := service.GetRoomManager().GetRoomByDevice(deviceID)
	if !ok {
		h.SendToDevice(deviceID, &Message{
			Type: "room_info",
			Payload: map[string]interface{}{
				"inRoom":  false,
				"devices": []interface{}{},
			},
		})
		return
	}
	h.SendToDevice(deviceID, &Message{
		Type: "room_info",
		Payload: map[string]interface{}{
			"roomId":  room.ID,
			"code":    room.Code,
			"ownerId": room.OwnerID,
			"devices": roomDevicesPayload(room),
		},
	})
}

// handleRoomWebRTC 房间内 WebRTC 信令转发（注入 fromId，转发给指定成员）
func (h *WSHandler) handleRoomWebRTC(fromID, msgType string, payload interface{}) {
	pl, ok := payload.(map[string]interface{})
	if !ok {
		return
	}
	toID, _ := pl["toId"].(string)
	if toID == "" {
		return
	}
	pl["fromId"] = fromID
	h.SendToDevice(toID, &Message{Type: msgType, Payload: pl})
}

// BroadcastRoom 向房间内（除 exceptID 外）所有成员广播
func (h *WSHandler) BroadcastRoom(room *service.Room, exceptID string, msg *Message) {
	members := room.MemberList()
	for _, m := range members {
		if m.ID == exceptID {
			continue
		}
		h.SendToDevice(m.ID, msg)
	}
}
