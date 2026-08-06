package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"
)

var (
	db   *sql.DB
	once sync.Once
)

// DataDir 返回数据目录（与 main.go 的 DataDir 逻辑一致）
func DataDir() string {
	if d := os.Getenv("DATA_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("TRIM_PKGVAR"); d != "" {
		return filepath.Join(d, "data")
	}
	if d := os.Getenv("TRIM_APPDEST"); d != "" {
		return filepath.Join(d, "data")
	}
	return filepath.Join(os.TempDir(), "fn_qycs")
}

// DB 返回全局数据库实例（单例，首次调用自动初始化）
func DB() *sql.DB {
	once.Do(func() {
		dir := DataDir()
		os.MkdirAll(dir, 0755)
		dbPath := filepath.Join(dir, "app.db")
		var err error
		db, err = sql.Open("sqlite", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
		if err != nil {
			panic(fmt.Sprintf("打开数据库失败: %v", err))
		}
		db.SetMaxOpenConns(1) // SQLite 单写，避免并发锁问题
		initSchema()
	})
	return db
}

func initSchema() {
	schema := `
	CREATE TABLE IF NOT EXISTS app_settings (
		id         INTEGER PRIMARY KEY CHECK (id = 1),
		max_file_size_mb INTEGER NOT NULL DEFAULT 50,
		stun_server       TEXT NOT NULL DEFAULT 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302',
		turn_server       TEXT NOT NULL DEFAULT '',
		turn_username     TEXT NOT NULL DEFAULT '',
		turn_password     TEXT NOT NULL DEFAULT '',
		turns_server      TEXT NOT NULL DEFAULT '',
		turns_username    TEXT NOT NULL DEFAULT '',
		turns_password    TEXT NOT NULL DEFAULT '',
		updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
	);
	`
	if _, err := db.Exec(schema); err != nil {
		panic(fmt.Sprintf("初始化数据库表失败: %v", err))
	}
	// 确保默认行存在
	if _, err := db.Exec(`INSERT OR IGNORE INTO app_settings (id) VALUES (1)`); err != nil {
		panic(fmt.Sprintf("插入默认设置行失败: %v", err))
	}
}

// Close 关闭数据库连接（进程退出时调用）
func Close() {
	if db != nil {
		db.Close()
	}
}
