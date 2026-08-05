package handler

import (
	"encoding/json"
	"log"
	"net/http"

	"fn_qycs/service"
)

// HandleSettings 传送设置 API
// GET  → 返回当前设置（密码字段脱敏）
// PUT  → 保存设置（密码为 "********" 时保留原密码）
func HandleSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")

	switch r.Method {
	case http.MethodGet:
		settings := service.LoadSettings()
		resp := *settings
		resp.TurnPassword = maskPassword(settings.TurnPassword)
		resp.TurnsPassword = maskPassword(settings.TurnsPassword)
		json.NewEncoder(w).Encode(resp)

	case http.MethodPut:
		var s service.AppSettings
		if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "无效的请求数据"})
			return
		}
		// 密码字段为掩码值时保留原密码
		existing := service.LoadSettings()
		if s.TurnPassword == "********" {
			s.TurnPassword = existing.TurnPassword
		}
		if s.TurnsPassword == "********" {
			s.TurnsPassword = existing.TurnsPassword
		}
		// 回填默认值
		if s.StunServer == "" {
			s.StunServer = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
		}
		if s.MaxFileSizeMB <= 0 {
			s.MaxFileSizeMB = 50
		}
		if err := service.SaveSettings(&s); err != nil {
			log.Printf("settings save error: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": "保存失败"})
			return
		}
		json.NewEncoder(w).Encode(map[string]bool{"success": true})

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// HandleMaxFileSize 返回最大文件大小限制（供前端传输页面动态获取）
func HandleMaxFileSize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	settings := service.LoadSettings()
	resp := map[string]int{
		"max_file_size_mb": settings.MaxFileSizeMB,
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(resp)
}

func maskPassword(pwd string) string {
	if pwd == "" {
		return ""
	}
	return "********"
}
