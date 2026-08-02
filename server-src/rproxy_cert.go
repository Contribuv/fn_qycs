package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CertManager 飞牛系统证书管理
type CertManager struct {
	certConfPath string
	log          func(level, msg string)
}

type certEntry struct {
	Domain      string   `json:"domain"`
	Certificate string   `json:"certificate"`
	Fullchain   string   `json:"fullchain"`
	PrivateKey  string   `json:"privateKey"`
	Used        bool     `json:"used"`
	SAN         []string `json:"san"`
	ValidTo     int64    `json:"validTo"`
	Sum         string   `json:"sum"`
}

// CertInfo 可用证书
type CertInfo struct {
	Domain   string   `json:"domain"`
	SANs     []string `json:"sans"`
	CertPath string   `json:"cert_path"`
	KeyPath  string   `json:"key_path"`
}

// CertDisplayInfo 前端展示用证书信息
type CertDisplayInfo struct {
	Domain   string   `json:"domain"`
	SANs     []string `json:"sans"`
	Expired  bool     `json:"expired"`
	Expires  string   `json:"expires"`
	Used     bool     `json:"used"`
	Sum      string   `json:"sum"`
	CertPath string   `json:"cert_path"`
	KeyPath  string   `json:"key_path"`
}

func NewCertManager(log func(level, msg string)) *CertManager {
	path := os.Getenv("TRIM_CERT_CONF")
	if path == "" {
		path = "/usr/trim/etc/network_cert_all.conf"
	}
	return &CertManager{certConfPath: path, log: log}
}

func (m *CertManager) shouldExclude(e certEntry) bool {
	if e.Domain == "fnOS" {
		return true
	}
	for _, s := range e.SAN {
		if strings.Contains(s, "fnos.net") {
			return true
		}
	}
	if strings.Contains(e.Domain, "fnos.net") {
		return true
	}
	return false
}

func (m *CertManager) resolveCertPath(preferred, domain string) string {
	if preferred != "" {
		if _, err := os.Stat(preferred); err == nil {
			return preferred
		}
	}
	if domain == "" {
		return preferred
	}
	dir := filepath.Dir(preferred)
	if dir == "." || dir == "" {
		return preferred
	}
	for _, ext := range []string{".crt", ".pem", ".cert"} {
		if c := filepath.Join(dir, domain+ext); fileExists(c) {
			return c
		}
	}
	return preferred
}

func (m *CertManager) resolveKeyPath(preferred, domain string) string {
	if preferred != "" {
		if _, err := os.Stat(preferred); err == nil {
			return preferred
		}
	}
	if domain == "" {
		return preferred
	}
	dir := filepath.Dir(preferred)
	if dir == "." || dir == "" {
		return preferred
	}
	for _, ext := range []string{".key", ".pem"} {
		if c := filepath.Join(dir, domain+ext); fileExists(c) {
			return c
		}
	}
	return preferred
}

func (m *CertManager) validateCert(certPath, keyPath string) (*x509.Certificate, []string, error) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, nil, fmt.Errorf("加载失败: %v", err)
	}
	if len(cert.Certificate) == 0 {
		return nil, nil, fmt.Errorf("证书链为空")
	}
	x509Cert, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, nil, fmt.Errorf("解析失败: %v", err)
	}
	sans := x509Cert.DNSNames
	if len(sans) == 0 {
		sans = []string{x509Cert.Subject.CommonName}
	}
	return x509Cert, sans, nil
}

// GetCertByDomain 根据域名查找可用证书（同时匹配主域名与 SAN）
func (m *CertManager) GetCertByDomain(domain string) *CertInfo {
	for _, c := range m.listCerts() {
		if c.Domain == domain {
			return &c
		}
		for _, san := range c.SANs {
			if san == domain {
				return &c
			}
		}
	}
	return nil
}

// GetCertsForDisplay 获取证书列表（含显示信息）
func (m *CertManager) GetCertsForDisplay() []CertDisplayInfo {
	entries := m.loadEntries()
	if entries == nil {
		return nil
	}
	var result []CertDisplayInfo
	nowMs := time.Now().UnixMilli()

	for _, e := range entries {
		if m.shouldExclude(e) {
			continue
		}
		preferredCert := e.Fullchain
		if preferredCert == "" {
			preferredCert = e.Certificate
		}
		if preferredCert == "" {
			continue
		}
		certPath := m.resolveCertPath(preferredCert, e.Domain)
		keyPath := m.resolveKeyPath(e.PrivateKey, e.Domain)

		x509Cert, sans, err := m.validateCert(certPath, keyPath)
		if err != nil {
			m.log("WARN", fmt.Sprintf("证书跳过(不可用): 域名=%s, %v", e.Domain, err))
			continue
		}
		if len(sans) == 0 {
			sans = e.SAN
			if len(sans) == 0 {
				sans = []string{e.Domain}
			}
		}

		var expires string
		expired := false
		if x509Cert != nil {
			expires = x509Cert.NotAfter.Format("2006-01-02 15:04")
			expired = time.Now().After(x509Cert.NotAfter)
		} else if e.ValidTo > 0 {
			expires = time.UnixMilli(e.ValidTo).Format("2006-01-02 15:04")
			expired = nowMs > e.ValidTo
		} else {
			expires = "未知"
		}

		result = append(result, CertDisplayInfo{
			Domain:   e.Domain,
			SANs:     sans,
			Expired:  expired,
			Expires:  expires,
			Used:     e.Used,
			Sum:      e.Sum,
			CertPath: certPath,
			KeyPath:  keyPath,
		})
	}
	return result
}

func (m *CertManager) listCerts() []CertInfo {
	entries := m.loadEntries()
	if entries == nil {
		return nil
	}
	var certs []CertInfo
	for _, e := range entries {
		if m.shouldExclude(e) {
			continue
		}
		preferredCert := e.Fullchain
		if preferredCert == "" {
			preferredCert = e.Certificate
		}
		if preferredCert == "" {
			continue
		}
		certPath := m.resolveCertPath(preferredCert, e.Domain)
		keyPath := m.resolveKeyPath(e.PrivateKey, e.Domain)
		if certPath == "" || keyPath == "" {
			continue
		}
		_, sans, err := m.validateCert(certPath, keyPath)
		if err != nil {
			m.log("WARN", fmt.Sprintf("证书跳过(不可用): 域名=%s, %v", e.Domain, err))
			continue
		}
		certs = append(certs, CertInfo{
			Domain:   e.Domain,
			SANs:     sans,
			CertPath: certPath,
			KeyPath:  keyPath,
		})
	}
	return certs
}

func (m *CertManager) loadEntries() []certEntry {
	data, err := os.ReadFile(m.certConfPath)
	if err != nil {
		m.log("WARN", fmt.Sprintf("读取证书配置失败: %s (%v)", m.certConfPath, err))
		return nil
	}
	var entries []certEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		m.log("WARN", fmt.Sprintf("解析证书配置失败: %v", err))
		return nil
	}
	return entries
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
