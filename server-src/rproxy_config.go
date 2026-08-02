package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ProxyConfig 反向代理配置
type ProxyConfig struct {
	BackendAddr string `json:"backend_addr"`
	Domain      string `json:"domain"`
	Port        int    `json:"port"`
	CertPath    string `json:"cert_path"`
	KeyPath     string `json:"key_path"`
	GzipEnabled bool   `json:"gzip_enabled"`
	HstsEnabled bool   `json:"hsts_enabled"`
}

// DataDir 返回数据目录路径
func DataDir() string {
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

// LoadConfig 读取持久化配置，找不到返回 nil
func LoadConfig() *ProxyConfig {
	configPath := filepath.Join(DataDir(), "rproxy-config.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil
	}
	var cfg ProxyConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	return &cfg
}

// SaveConfig 保存配置到磁盘
func SaveConfig(cfg *ProxyConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	configPath := filepath.Join(DataDir(), "rproxy-config.json")
	return os.WriteFile(configPath, data, 0644)
}
