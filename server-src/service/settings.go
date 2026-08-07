package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"fn_qycs/store"
)

// AppSettings 应用设置（传送设置）
type AppSettings struct {
	MaxFileSizeMB int    `json:"max_file_size_mb"`
	StunServer    string `json:"stun_server"`
	TurnServer    string `json:"turn_server"`
	TurnUsername  string `json:"turn_username"`
	TurnPassword  string `json:"turn_password"`
	TurnsServer   string `json:"turns_server"`
	TurnsUsername string `json:"turns_username"`
	TurnsPassword string `json:"turns_password"`
}

// GetDefaultSettings 返回默认设置
func GetDefaultSettings() *AppSettings {
	return &AppSettings{
		MaxFileSizeMB: 50,
		StunServer:    "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302",
	}
}

// LoadSettings 从 SQLite 读取设置。首次启动时自动从旧 app-settings.json 迁移数据。
func LoadSettings() *AppSettings {
	db := store.DB()
	s := &AppSettings{}
	err := db.QueryRow(`SELECT max_file_size_mb, stun_server, turn_server, turn_username, turn_password,
		turns_server, turns_username, turns_password FROM app_settings WHERE id = 1`).Scan(
		&s.MaxFileSizeMB, &s.StunServer, &s.TurnServer, &s.TurnUsername, &s.TurnPassword,
		&s.TurnsServer, &s.TurnsUsername, &s.TurnsPassword,
	)
	if err != nil {
		// 首次运行：尝试从旧 JSON 迁移
		if migrated := migrateFromJSON(s); migrated {
			// 迁移成功，写入 DB（静默）
			SaveSettings(s)
			log.Println("[DB] 已从 app-settings.json 迁移设置到 SQLite")
			return s
		}
		return GetDefaultSettings()
	}
	defaults := GetDefaultSettings()
	if s.StunServer == "" {
		s.StunServer = defaults.StunServer
	}
	if s.MaxFileSizeMB <= 0 {
		s.MaxFileSizeMB = defaults.MaxFileSizeMB
	}
	return s
}

// SaveSettings 保存设置到 SQLite
func SaveSettings(s *AppSettings) error {
	db := store.DB()
	if s.StunServer == "" {
		s.StunServer = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
	}
	if s.MaxFileSizeMB <= 0 {
		s.MaxFileSizeMB = 50
	}
	if s.MaxFileSizeMB > 2048 {
		s.MaxFileSizeMB = 2048
	}
	_, err := db.Exec(`UPDATE app_settings SET max_file_size_mb=?, stun_server=?, turn_server=?, turn_username=?, turn_password=?,
		turns_server=?, turns_username=?, turns_password=?, updated_at=datetime('now') WHERE id=1`,
		s.MaxFileSizeMB, s.StunServer, s.TurnServer, s.TurnUsername, s.TurnPassword,
		s.TurnsServer, s.TurnsUsername, s.TurnsPassword,
	)
	if err != nil {
		return fmt.Errorf("保存设置失败: %w", err)
	}
	return nil
}

// migrateFromJSON 尝试从旧 app-settings.json 迁移数据，成功返回 true
func migrateFromJSON(s *AppSettings) bool {
	configPath := filepath.Join(store.DataDir(), "app-settings.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return false
	}
	// 此文件可能被 check 到仓库（如 app-settings.example.json），解码失败则不迁移
	if err := json.Unmarshal(data, s); err != nil {
		return false
	}
	// 迁移完成后删除原 JSON 避免重复迁移
	os.Remove(configPath)
	return true
}

// ---- 兼容旧调用：返回 sql.DB 供其他模块直接使用 ----
func GetDB() *sql.DB {
	return store.DB()
}
