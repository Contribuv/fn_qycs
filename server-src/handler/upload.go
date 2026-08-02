package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"fn_qycs/service"
)

// UploadHandler 文件上传处理器
type UploadHandler struct{}

var uploadHandler *UploadHandler

// GetUploadHandler 获取上传处理器
func GetUploadHandler() *UploadHandler {
	if uploadHandler == nil {
		uploadHandler = &UploadHandler{}
	}
	return uploadHandler
}

// HandleUpload 处理文件上传
func (h *UploadHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := r.ParseMultipartForm(100 << 20); err != nil {
		http.Error(w, "Failed to parse form: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "No file provided", http.StatusBadRequest)
		return
	}
	defer file.Close()

	taskID := r.FormValue("taskId")
	toID := r.FormValue("toId")

	if taskID == "" || toID == "" {
		http.Error(w, "Missing taskId or toId", http.StatusBadRequest)
		return
	}

	task, ok := service.GetTransferManager().GetTask(taskID)
	if !ok {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	data, _ := io.ReadAll(file)
	n, err := service.GetTransferManager().AppendData(taskID, data)
	if err != nil {
		http.Error(w, "Failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	service.GetTransferManager().UpdateTaskStatus(taskID, "transferring")

	// 实时通知接收方进度
	GetWSHandler().SendToDevice(task.ToID, &Message{
		Type: "transfer_progress",
		Payload: map[string]interface{}{
			"taskId":     taskID,
			"sentSize":   task.SentSize,
			"fileSize":   task.FileSize,
			"percentage": float64(task.SentSize) / float64(task.FileSize) * 100,
			"fromId":     task.FromID,
		},
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":    true,
		"taskId":     taskID,
		"uploaded":   n,
		"total":      task.FileSize,
		"percentage": float64(task.SentSize) / float64(task.FileSize) * 100,
	})
}

// HandleUploadComplete 处理上传完成
func (h *UploadHandler) HandleUploadComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TaskID string `json:"taskId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	service.GetTransferManager().UpdateTaskStatus(req.TaskID, "completed")

	// 通知接收方：100% 完成（流式下载会自动结束）
	task, _ := service.GetTransferManager().GetTask(req.TaskID)
	if task != nil {
		GetWSHandler().SendToDevice(task.ToID, &Message{
			Type: "transfer_progress",
			Payload: map[string]interface{}{
				"taskId":     task.ID,
				"sentSize":   task.FileSize,
				"fileSize":   task.FileSize,
				"percentage": 100,
				"fromId":     task.FromID,
			},
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"taskId":  req.TaskID,
	})
}

// CreateTask 创建传输任务
func (h *UploadHandler) CreateTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		FromID   string `json:"fromId"`
		ToID     string `json:"toId"`
		FileName string `json:"fileName"`
		FileSize int64  `json:"fileSize"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	taskID := generateTaskID()

	task, err := service.GetTransferManager().CreateTask(taskID, req.FileName, req.FileSize, req.FromID, req.ToID)
	if err != nil {
		http.Error(w, "Failed to create task: "+err.Error(), http.StatusInternalServerError)
		return
	}

	GetWSHandler().SendToDevice(req.ToID, &Message{
		Type: "transfer_request",
		Payload: map[string]interface{}{
			"taskId":   task.ID,
			"fileName": task.FileName,
			"fileSize": task.FileSize,
			"fromId":   task.FromID,
		},
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"taskId":  task.ID,
	})
}

// GetTask 获取任务信息
func (h *UploadHandler) GetTask(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimPrefix(r.URL.Path, "/api/task/")
	taskID = strings.TrimSuffix(taskID, "/")

	task, ok := service.GetTransferManager().GetTask(taskID)
	if !ok {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(task)
}

// CancelTask 取消任务
func (h *UploadHandler) CancelTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TaskID string `json:"taskId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	service.GetTransferManager().DeleteTask(req.TaskID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
	})
}

func generateTaskID() string {
	return time.Now().Format("20060102150405") + "-" + randomString(12)
}
