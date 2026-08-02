package handler

import (
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fn_qycs/service"
)

// DownloadHandler 文件下载处理器
type DownloadHandler struct{}

var downloadHandler *DownloadHandler

// GetDownloadHandler 获取下载处理器
func GetDownloadHandler() *DownloadHandler {
	if downloadHandler == nil {
		downloadHandler = &DownloadHandler{}
	}
	return downloadHandler
}

// HandleDownload 处理文件下载（流式：边上传边下载）
func (h *DownloadHandler) HandleDownload(w http.ResponseWriter, r *http.Request) {
	// 从路径获取 taskID
	path := r.URL.Path
	taskID := strings.TrimPrefix(path, "/download/")

	if taskID == "" {
		http.Error(w, "Missing task ID", http.StatusBadRequest)
		return
	}

	// 获取任务
	task, ok := service.GetTransferManager().GetTask(taskID)
	if !ok {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	fileName := escapeFileName(task.FileName)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+fileName+`"; filename*=UTF-8''`+fileName)
	w.Header().Set("Content-Length", strconv.FormatInt(task.FileSize, 10))
	w.Header().Set("Cache-Control", "no-cache")

	// 获取文件读取器
	reader, err := service.GetTransferManager().GetFileReader(taskID)
	if err != nil {
		log.Printf("Failed to open file: %v", err)
		http.Error(w, "Failed to read file", http.StatusInternalServerError)
		return
	}
	defer reader.Close()

	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	// 流式读取：文件还在写入时，边写边读
	buf := make([]byte, 64*1024)
	var readPos int64 = 0

	for {
		n, err := reader.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				log.Printf("Write error: %v", werr)
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
			readPos += int64(n)
		}

		if err != nil {
			// 读到 EOF，检查任务是否已完成
			currentTask, exists := service.GetTransferManager().GetTask(taskID)
			if !exists {
				// 任务被删除
				break
			}
			if currentTask.Status == "completed" && readPos >= currentTask.SentSize {
				// 上传已完成且已读完所有数据
				break
			}
			// 等待更多数据写入
			time.Sleep(50 * time.Millisecond)
			// 重新 seek 到当前位置以重置 EOF 状态
			reader.Seek(readPos, 0)
		}
	}

	// 通知发送端下载完成
	GetWSHandler().SendToDevice(task.FromID, &Message{
		Type: "transfer_downloaded",
		Payload: map[string]interface{}{
			"taskId": taskID,
			"toId":   task.ToID,
		},
	})

	// 通知接收方：文件已保存到本地（HTTP 流式下载真正结束）
	GetWSHandler().SendToDevice(task.ToID, &Message{
		Type: "transfer_saved",
		Payload: map[string]interface{}{
			"taskId": taskID,
		},
	})

	// 延迟删除任务文件
	go func() {
		time.Sleep(5 * time.Minute)
		service.GetTransferManager().DeleteTask(taskID)
	}()
}

// HandleRangeDownload 处理断点续传（备用，未使用）
func (h *DownloadHandler) HandleRangeDownload(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	taskID := strings.TrimPrefix(path, "/download/")

	if taskID == "" {
		http.Error(w, "Missing task ID", http.StatusBadRequest)
		return
	}

	task, ok := service.GetTransferManager().GetTask(taskID)
	if !ok {
		http.Error(w, "Task not found", http.StatusNotFound)
		return
	}

	reader, err := service.GetTransferManager().GetFileReader(taskID)
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusInternalServerError)
		return
	}
	defer reader.Close()

	// 使用 http.ServeFile 自动处理 Range
	fileName := escapeFileName(task.FileName)
	w.Header().Set("Content-Disposition", `attachment; filename="`+fileName+`"`)
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, fileName, time.Now(), readSeeker{reader})
}

// readSeeker 将 io.ReadCloser 包装为 io.ReadSeeker
type readSeeker struct {
	rc interface {
		Read(p []byte) (n int, err error)
		Close() error
	}
}

func (rs readSeeker) Read(p []byte) (n int, err error) {
	return rs.rc.Read(p)
}

func (rs readSeeker) Close() error {
	return rs.rc.Close()
}

func (rs readSeeker) Seek(offset int64, whence int) (int64, error) {
	return 0, nil // 不支持真正的 seek
}

// escapeFileName 转义文件名
func escapeFileName(fileName string) string {
	fileName = strings.ReplaceAll(fileName, "\"", "")
	fileName = strings.ReplaceAll(fileName, "\n", "")
	fileName = strings.ReplaceAll(fileName, "\r", "")
	return fileName
}
