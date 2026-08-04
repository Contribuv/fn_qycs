package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
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
// 默认包含公共 STUN；若配置了 TURN（环境变量），则追加 TURN 中继，
// 提升对称型 NAT / 严格防火墙下的穿透成功率。
func HandleIceServers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	servers := []ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}},
		{URLs: []string{"stun:stun1.l.google.com:19302"}},
	}

	// 可选 TURN 配置（环境变量 TURN_URLS，逗号分隔；TURN_USERNAME / TURN_CREDENTIAL）
	if turnURLs := os.Getenv("TURN_URLS"); turnURLs != "" {
		turn := ICEServer{
			URLs:       splitAndTrim(turnURLs),
			Username:   os.Getenv("TURN_USERNAME"),
			Credential: os.Getenv("TURN_CREDENTIAL"),
		}
		servers = append(servers, turn)
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
