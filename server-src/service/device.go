package service

import (
	"sync"
	"time"
)

const (
	// 心跳间隔
	HeartbeatInterval = 30 * time.Second
	// 超时时间
	TimeoutDuration = 90 * time.Second
	// 离线缓冲时间（断开后保留设备记录的时长，用于刷新页面时复用）
	OfflineKeepDuration = 60 * time.Second
	// 离线设备清理检查间隔
	OfflineCleanupInterval = 15 * time.Second
)

// Device 设备信息
type Device struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	IP         string    `json:"ip"`         // 连接服务器的真实客户端 IP
	LocalLanIP string    `json:"localLanIp"` // 前端 WebRTC 探测到的本机局域网 IP（用于"同用户子网"判定）
	OnlineAt   time.Time `json:"onlineAt"`
	LastBeat   time.Time `json:"lastBeat"`
}

// DeviceManager 设备管理器
type DeviceManager struct {
	mu              sync.RWMutex
	devices         map[string]*Device
	offlineDevices  map[string]*Device // 离线缓存（保留 OfflineKeepDuration）
	startCleanerOnce sync.Once
}

var dm *DeviceManager
var dmOnce sync.Once

// GetDeviceManager 获取单例
func GetDeviceManager() *DeviceManager {
	dmOnce.Do(func() {
		dm = &DeviceManager{
			devices:        make(map[string]*Device),
			offlineDevices: make(map[string]*Device),
		}
		dm.startCleanerOnce.Do(func() {
			go dm.offlineCleaner()
		})
	})
	return dm
}

// Register 注册设备（如果设备ID已存在则复用原记录，仅刷新活跃时间）
func (dm *DeviceManager) Register(id, name, ip string) *Device {
	return dm.RegisterWithLan(id, name, ip, "")
}
// RegisterWithLan 注册设备并写入前端探测到的局域网 IP
func (dm *DeviceManager) RegisterWithLan(id, name, ip, lanIP string) *Device {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	// 复用已存在的设备（如刷新场景）
	if existing, ok := dm.devices[id]; ok {
		existing.LastBeat = time.Now()
		// 如果名字变了（比如刷新后分配了新名字），则释放旧名字
		if existing.Name != name && existing.Name != "" {
			GetNameGenerator().Release(existing.Name)
			existing.Name = name
		}
		existing.IP = ip
		if lanIP != "" {
			existing.LocalLanIP = lanIP
		}
		// 从离线缓存移除
		delete(dm.offlineDevices, id)
		return existing
	}

	device := &Device{
		ID:         id,
		Name:       name,
		IP:         ip,
		LocalLanIP: lanIP,
		OnlineAt:   time.Now(),
		LastBeat:   time.Now(),
	}

	dm.devices[id] = device
	return device
}

// TryRegisterOrReuse 尝试复用旧设备（同IP+同用户名的离线设备），否则注册新设备
// 返回 (deviceID, device, isReused)

// UpdateLanIP 更新设备前端探测到的局域网 IP（用户连接热点/WiFi 后上报）
func (dm *DeviceManager) UpdateLanIP(id, lanIP string) {
	if lanIP == "" {
		return
	}
	dm.mu.Lock()
	defer dm.mu.Unlock()
	if d, ok := dm.devices[id]; ok {
		d.LocalLanIP = lanIP
	}
}
func (dm *DeviceManager) TryRegisterOrReuse(ip, name string) (string, *Device, bool) {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	now := time.Now()

	// 只查找离线缓存中相同 IP+Name 的设备（刷新场景：旧连接已断开，设备在离线缓存中）
	for id, d := range dm.offlineDevices {
		if d.IP == ip && d.Name == name {
			d.LastBeat = now
			d.OnlineAt = now
			delete(dm.offlineDevices, id)
			dm.devices[id] = d
			return id, d, true
		}
	}

	// 不复用活跃设备：同 IP+Name 的活跃设备说明是同一台电脑的另一个标签页，
	// 复用会导致旧连接被覆盖、readLoop 退出时误把新连接的设备标记为离线
	return "", nil, false
}

// MarkOffline 标记设备离线（保留设备记录到离线缓存，延迟清理）
// 与 Unregister 不同：仅断开连接，但设备信息仍保留一段时间，便于刷新复用
func (dm *DeviceManager) MarkOffline(id string) {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	device, ok := dm.devices[id]
	if !ok {
		return
	}

	// 从活跃列表移到离线缓存
	delete(dm.devices, id)
	device.LastBeat = time.Now() // 记录离线时间
	dm.offlineDevices[id] = device
}

// Unregister 注销设备（真正删除，用于主动注销场景）
func (dm *DeviceManager) Unregister(id string) {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	delete(dm.devices, id)
	delete(dm.offlineDevices, id)

	// 释放名字
	GetNameGenerator().Release(dm.getDeviceNameLocked(id))
}

// Heartbeat 心跳
func (dm *DeviceManager) Heartbeat(id string) bool {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	device, ok := dm.devices[id]
	if !ok {
		return false
	}
	device.LastBeat = time.Now()
	return true
}

// UpdateName 更新设备名
func (dm *DeviceManager) UpdateName(id, name string) bool {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	device, ok := dm.devices[id]
	if !ok {
		return false
	}

	oldName := device.Name
	device.Name = name

	// 如果名字变了，释放旧的
	if oldName != name && oldName != "" {
		GetNameGenerator().Release(oldName)
	}

	return true
}

// GetDevice 获取设备
func (dm *DeviceManager) GetDevice(id string) (*Device, bool) {
	dm.mu.RLock()
	defer dm.mu.RUnlock()
	device, ok := dm.devices[id]
	return device, ok
}

// GetAllDevices 获取所有活跃设备
func (dm *DeviceManager) GetAllDevices() []*Device {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	devices := make([]*Device, 0, len(dm.devices))
	for _, d := range dm.devices {
		devices = append(devices, d)
	}
	return devices
}

// GetDevicesExcluding 排除指定ID的所有活跃设备
func (dm *DeviceManager) GetDevicesExcluding(excludeID string) []*Device {
	dm.mu.RLock()
	defer dm.mu.RUnlock()

	size := len(dm.devices)
	if excludeID != "" {
		// 如果指定的 ID 存在,容量减 1
		if _, exists := dm.devices[excludeID]; exists && size > 0 {
			size = size - 1
		}
	}

	devices := make([]*Device, 0, size)
	for id, d := range dm.devices {
		if id != excludeID {
			devices = append(devices, d)
		}
	}
	return devices
}

// CheckTimeout 检查超时的活跃设备（无心跳）
func (dm *DeviceManager) CheckTimeout() []string {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	now := time.Now()
	timeoutIDs := make([]string, 0)

	for id, device := range dm.devices {
		if now.Sub(device.LastBeat) > TimeoutDuration {
			timeoutIDs = append(timeoutIDs, id)
			delete(dm.devices, id)
			GetNameGenerator().Release(device.Name)
		}
	}

	return timeoutIDs
}

// offlineCleaner 清理过期的离线设备（后台协程）
func (dm *DeviceManager) offlineCleaner() {
	ticker := time.NewTicker(OfflineCleanupInterval)
	defer ticker.Stop()

	for range ticker.C {
		dm.mu.Lock()
		now := time.Now()
		for id, d := range dm.offlineDevices {
			if now.Sub(d.LastBeat) > OfflineKeepDuration {
				delete(dm.offlineDevices, id)
				GetNameGenerator().Release(d.Name)
			}
		}
		dm.mu.Unlock()
	}
}

// GetOfflineDeviceCount 获取离线设备数量（用于调试/状态展示）
func (dm *DeviceManager) GetOfflineDeviceCount() int {
	dm.mu.RLock()
	defer dm.mu.RUnlock()
	return len(dm.offlineDevices)
}

// GetOfflineDevicesForDebug 获取所有离线设备（调试用）
func (dm *DeviceManager) GetOfflineDevicesForDebug() []*Device {
	dm.mu.RLock()
	defer dm.mu.RUnlock()
	devices := make([]*Device, 0, len(dm.offlineDevices))
	for _, d := range dm.offlineDevices {
		devices = append(devices, d)
	}
	return devices
}

// GetDeviceName 获取设备名称（内部使用，需要读锁）
func (dm *DeviceManager) getDeviceNameLocked(id string) string {
	if device, ok := dm.devices[id]; ok {
		return device.Name
	}
	if device, ok := dm.offlineDevices[id]; ok {
		return device.Name
	}
	return ""
}
