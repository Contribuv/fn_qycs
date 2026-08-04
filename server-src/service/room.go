package service

import (
	"math/rand"
	"strconv"
	"sync"
	"time"
)

// RoomMember 房间成员（轻量视图，仅含前端展示所需字段）
type RoomMember struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Room 公网互传房间
type Room struct {
	ID       string       `json:"id"`       // 房间内部标识（uuid 类）
	Code     string       `json:"code"`     // 6 位数字暗号
	OwnerID  string       `json:"ownerId"`  // 房主 deviceId
	Members  map[string]*RoomMember `json:"-"` // deviceId -> 成员
	mu       sync.RWMutex
	CreatedAt time.Time
}

// MemberList 返回成员列表（不含房主？包含全部成员，前端自行过滤）
func (r *Room) MemberList() []*RoomMember {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]*RoomMember, 0, len(r.Members))
	for _, m := range r.Members {
		list = append(list, m)
	}
	return list
}

// AddMember 加入成员，返回是否成功（房间上限由调用方控制）
func (r *Room) AddMember(id, name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Members[id] = &RoomMember{ID: id, Name: name}
}

// RemoveMember 移除成员，返回移除后房间是否空了
func (r *Room) RemoveMember(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.Members, id)
	return len(r.Members) == 0
}

// GetMember 获取成员
func (r *Room) GetMember(id string) (*RoomMember, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.Members[id]
	return m, ok
}

// RoomManager 房间管理器（单例）
type RoomManager struct {
	mu     sync.RWMutex
	byID   map[string]*Room   // roomID -> Room
	byCode map[string]*Room   // code   -> Room
}

var rm *RoomManager
var rmOnce sync.Once

// GetRoomManager 获取单例
func GetRoomManager() *RoomManager {
	rmOnce.Do(func() {
		rm = &RoomManager{
			byID:   make(map[string]*Room),
			byCode: make(map[string]*Room),
		}
	})
	return rm
}

// CreateRoom 创建房间，返回房间与暗号
func (m *RoomManager) CreateRoom(ownerID, ownerName string) *Room {
	code := m.newCode()
	room := &Room{
		ID:        generateRoomID(),
		Code:      code,
		OwnerID:   ownerID,
		Members:   make(map[string]*RoomMember),
		CreatedAt: time.Now(),
	}
	room.AddMember(ownerID, ownerName)

	m.mu.Lock()
	m.byID[room.ID] = room
	m.byCode[room.Code] = room
	m.mu.Unlock()
	return room
}

// JoinRoom 通过暗号加入房间，返回房间与是否成功
func (m *RoomManager) JoinRoom(code, deviceID, deviceName string) (*Room, bool) {
	m.mu.RLock()
	room, ok := m.byCode[code]
	m.mu.RUnlock()
	if !ok {
		return nil, false
	}
	room.AddMember(deviceID, deviceName)
	return room, true
}

// LeaveRoom 离开房间（按 deviceID 查找其所在房间），返回所在房间（若有）
func (m *RoomManager) LeaveRoom(deviceID string) (*Room, bool) {
	m.mu.RLock()
	var found *Room
	for _, r := range m.byID {
		if _, ok := r.GetMember(deviceID); ok {
			found = r
			break
		}
	}
	m.mu.RUnlock()
	if found == nil {
		return nil, false
	}

	empty := found.RemoveMember(deviceID)
	if empty {
		m.mu.Lock()
		delete(m.byID, found.ID)
		delete(m.byCode, found.Code)
		m.mu.Unlock()
	}
	return found, true
}

// GetRoomByDevice 获取某设备所在的房间
func (m *RoomManager) GetRoomByDevice(deviceID string) (*Room, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, r := range m.byID {
		if _, ok := r.GetMember(deviceID); ok {
			return r, true
		}
	}
	return nil, false
}

// newCode 生成不重复的 6 位数字暗号
func (m *RoomManager) newCode() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for i := 0; i < 100; i++ {
		c := rand.Intn(900000) + 100000
		code := strconv.Itoa(c)
		if _, ok := m.byCode[code]; !ok {
			return code
		}
	}
	// 极端情况：时间戳兜底（取后 6 位）
	c := time.Now().UnixNano() % 1000000
	return strconv.FormatInt(c+100000, 10)[1:]
}

// generateRoomID 生成房间内部 ID
func generateRoomID() string {
	return "r" + time.Now().Format("20060102150405") + randomString(6)
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
