package service

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// TransferTask 传输任务
type TransferTask struct {
	ID          string    `json:"id"`
	FileName    string    `json:"fileName"`
	FileSize    int64     `json:"fileSize"`
	SentSize    int64     `json:"sentSize"`
	FromID      string    `json:"fromId"`
	ToID        string    `json:"toId"`
	FilePath    string    `json:"-"`
	Status      string    `json:"status"` // pending, transferring, completed, cancelled
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// TransferManager 传输任务管理器
type TransferManager struct {
	mu      sync.RWMutex
	tasks   map[string]*TransferTask
	baseDir string
}

var tm *TransferManager
var tmOnce sync.Once

// GetTransferManager 获取单例
func GetTransferManager() *TransferManager {
	tmOnce.Do(func() {
		// 创建临时文件目录
		baseDir := filepath.Join(os.TempDir(), "fn_qycs")
		os.MkdirAll(baseDir, 0755)

		tm = &TransferManager{
			tasks:   make(map[string]*TransferTask),
			baseDir: baseDir,
		}
	})
	return tm
}

// CreateTask 创建传输任务
func (tm *TransferManager) CreateTask(id, fileName string, fileSize int64, fromID, toID string) (*TransferTask, error) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	task := &TransferTask{
		ID:        id,
		FileName:  fileName,
		FileSize:  fileSize,
		FromID:    fromID,
		ToID:      toID,
		Status:    "pending",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	// 创建临时文件
	filePath := filepath.Join(tm.baseDir, id)
	file, err := os.Create(filePath)
	if err != nil {
		return nil, err
	}
	file.Close()

	task.FilePath = filePath
	tm.tasks[id] = task

	return task, nil
}

// AppendData 追加数据到任务文件
func (tm *TransferManager) AppendData(id string, data []byte) (int, error) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	task, ok := tm.tasks[id]
	if !ok {
		return 0, fmt.Errorf("task not found: %s", id)
	}

	file, err := os.OpenFile(task.FilePath, os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	n, err := file.Write(data)
	if err != nil {
		return 0, err
	}

	task.SentSize += int64(n)
	task.UpdatedAt = time.Now()

	return n, nil
}

// GetTask 获取任务
func (tm *TransferManager) GetTask(id string) (*TransferTask, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	task, ok := tm.tasks[id]
	return task, ok
}

// GetTaskByFile 获取文件对应的任务
func (tm *TransferManager) GetTaskByFile(fileName string) (*TransferTask, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	for _, task := range tm.tasks {
		if task.FileName == fileName && task.ToID != "" {
			return task, true
		}
	}
	return nil, false
}

// UpdateTaskStatus 更新任务状态
func (tm *TransferManager) UpdateTaskStatus(id, status string) bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	task, ok := tm.tasks[id]
	if !ok {
		return false
	}

	task.Status = status
	task.UpdatedAt = time.Now()
	return true
}

// DeleteTask 删除任务
func (tm *TransferManager) DeleteTask(id string) error {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	task, ok := tm.tasks[id]
	if !ok {
		return nil
	}

	// 删除文件
	os.Remove(task.FilePath)
	delete(tm.tasks, id)

	return nil
}

// GetFileReader 获取文件读取器（支持 Seek，用于流式边写边读）
func (tm *TransferManager) GetFileReader(id string) (io.ReadSeekCloser, error) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	task, ok := tm.tasks[id]
	if !ok {
		return nil, fmt.Errorf("task not found: %s", id)
	}

	return os.Open(task.FilePath)
}

// GetPendingTasks 获取待接收的任务
func (tm *TransferManager) GetPendingTasks(toID string) []*TransferTask {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	tasks := make([]*TransferTask, 0)
	for _, task := range tm.tasks {
		if task.ToID == toID && task.Status == "pending" {
			tasks = append(tasks, task)
		}
	}
	return tasks
}
