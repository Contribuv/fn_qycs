package service

import (
	"encoding/json"
	"os"
	"path/filepath"
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

// settingsDataDir 返回设置数据目录（与 main.DataDir 逻辑一致）
func settingsDataDir() string {
	if d := os.Getenv("DATA_DIR"); d != "" {
		return d
	}
	if pkgVar := os.Getenv("TRIM_PKGVAR"); pkgVar != "" {
		return filepath.Join(pkgVar, "data")
	}
	if appDest := os.Getenv("TRIM_APPDEST"); appDest != "" {
		return filepath.Join(appDest, "data")
	}
	return filepath.Join(os.TempDir(), "fn_qycs")
}

// GetDefaultSettings 返回默认设置
func GetDefaultSettings() *AppSettings {
	return &AppSettings{
		MaxFileSizeMB: 50,
		StunServer:    "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302",
	}
}

// LoadSettings 读取设置，找不到返回默认值
func LoadSettings() *AppSettings {
	configPath := filepath.Join(settingsDataDir(), "app-settings.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return GetDefaultSettings()
	}
	var s AppSettings
	if err := json.Unmarshal(data, &s); err != nil {
		return GetDefaultSettings()
	}
	// 回填默认值
	if s.StunServer == "" {
		s.StunServer = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
	}
	if s.MaxFileSizeMB <= 0 {
		s.MaxFileSizeMB = 50
	}
	return &s
}

// SaveSettings 保存设置到磁盘
func SaveSettings(s *AppSettings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	configPath := filepath.Join(settingsDataDir(), "app-settings.json")
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return os.WriteFile(configPath, data, 0644)
}
