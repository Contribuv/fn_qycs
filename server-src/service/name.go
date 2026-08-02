package service

import (
	"math/rand"
	"strings"
	"sync"
	"time"
)

var (
	// 固定名字池
	fixedNames = []string{
		"袁粑粑", "韩条条", "陈三个", "韩二姐", "刘唧唧", "黄二哥", "小瑜姐姐",
	}

	// 词缀池
	prefixes = []string{
		"巨大的", "神奇的", "可爱的", "牛逼的", "傻傻的",
	}

	// 水果池
	fruits = []string{
		"蓝莓", "西瓜", "菠萝", "柿子", "苹果", "橙子", "香蕉", "葡萄", "草莓", "芒果",
		"猕猴桃", "火龙果", "荔枝", "龙眼", "樱桃", "桃子", "杏子", "李子", "梅子", "椰子",
	}
)

// NameGenerator 设备名生成器
type NameGenerator struct {
	mu       sync.Mutex
	usedNames map[string]bool
	rng      *rand.Rand
}

var nameGen *NameGenerator
var nameGenOnce sync.Once

// GetNameGenerator 获取单例
func GetNameGenerator() *NameGenerator {
	nameGenOnce.Do(func() {
		nameGen = &NameGenerator{
			usedNames: make(map[string]bool),
			rng:       rand.New(rand.NewSource(time.Now().UnixNano())),
		}
	})
	return nameGen
}

// Generate 生成随机设备名
func (g *NameGenerator) Generate() string {
	g.mu.Lock()
	defer g.mu.Unlock()

	// 优先使用固定名字
	for _, name := range fixedNames {
		if !g.usedNames[name] {
			g.usedNames[name] = true
			return name
		}
	}

	// 固定名字用完了，生成组合名字
	for attempts := 0; attempts < 100; attempts++ {
		prefix := prefixes[g.rng.Intn(len(prefixes))]
		fruit := fruits[g.rng.Intn(len(fruits))]
		name := prefix + fruit

		if !g.usedNames[name] {
			g.usedNames[name] = true
			return name
		}
	}

	// 理论上不会到这里，如果到了就返回带序号的
	return "传送者" + strings.Repeat("*", g.rng.Intn(5)+1)
}

// Release 释放名字（设备离线时调用）
func (g *NameGenerator) Release(name string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.usedNames, name)
}

// ForceUseName 强制标记名字为已使用
func (g *NameGenerator) ForceUseName(name string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.usedNames[name] = true
}

// IsValidName 检查名字是否有效
func (g *NameGenerator) IsValidName(name string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return !g.usedNames[name]
}
