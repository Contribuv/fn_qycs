package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"fn_qycs/service"
)

// ICEServer ICE 服务器配置
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// IceServersResponse /api/ice-servers 返回结构（前端 fetchIceServers 期望）
type IceServersResponse struct {
	IceServers []ICEServer `json:"iceServers"`
}

// HandleIceServers 返回公网 WebRTC 可用的 ICE 服务器列表
// 从传送设置中读取 STUN / TURN / TURNS 配置；
// 未配置 TURN/TURNS 则不启用中继穿透。
func HandleIceServers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	settings := service.LoadSettings()
	servers := []ICEServer{}

	// STUN 服务器
	if settings.StunServer != "" {
		servers = append(servers, ICEServer{URLs: splitAndTrim(settings.StunServer)})
	}

	// TURN 中继（配置了才启用）
	if settings.TurnServer != "" {
		turn := ICEServer{URLs: normalizeRelayURLs(splitAndTrim(settings.TurnServer), "turn")}
		if settings.TurnUsername != "" {
			turn.Username = settings.TurnUsername
			turn.Credential = settings.TurnPassword
		}
		servers = append(servers, turn)
	}

	// TURNS (TLS) 中继（配置了才启用）
	if settings.TurnsServer != "" {
		turns := ICEServer{URLs: normalizeRelayURLs(splitAndTrim(settings.TurnsServer), "turns")}
		if settings.TurnsUsername != "" {
			turns.Username = settings.TurnsUsername
			turns.Credential = settings.TurnsPassword
		}
		servers = append(servers, turns)
	}

	// 兜底：无任何配置时返回默认 Google STUN
	if len(servers) == 0 {
		servers = append(servers, ICEServer{
			URLs: []string{"stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"},
		})
	}

	resp := IceServersResponse{IceServers: servers}
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("ice-servers marshal error: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	// 允许跨域（房间模式可能经不同域名访问）
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(data)
}

// splitAndTrim 拆分逗号分隔并去空格
func splitAndTrim(s string) []string {
	parts := []string{}
	cur := ""
	for _, c := range s {
		if c == ',' {
			if cur != "" {
				parts = append(parts, cur)
				cur = ""
			}
			continue
		}
		if c == ' ' || c == '\t' || c == '\n' {
			continue
		}
		cur += string(c)
	}
	if cur != "" {
		parts = append(parts, cur)
	}
	return parts
}

// normalizeRelayURLs 确保中继服务器地址带协议前缀。
// 用户在传送设置中可能只填裸地址（如 free.expressturn.com:3478），
// 浏览器会把它当作 STUN 服务器而非 TURN，导致中继无法工作，也会让前端
// 误判为"未配置 TURN"。这里自动补全 turn:/turns: 前缀（已有前缀则保留）。
func normalizeRelayURLs(urls []string, scheme string) []string {
	out := make([]string, 0, len(urls))
	for _, u := range urls {
		u = strings.TrimSpace(u)
		lower := strings.ToLower(u)
		if strings.HasPrefix(lower, "turn:") || strings.HasPrefix(lower, "turns:") ||
			strings.HasPrefix(lower, "stun:") || strings.HasPrefix(lower, "stuns:") {
			out = append(out, u)
			continue
		}
		out = append(out, scheme+":"+u)
	}
	return out
}
