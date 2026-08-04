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
	// fullPool 为完整候选昵称池（固定名 + 词缀×水果组合），已随机打乱，
	// 保证所有昵称出现频率公平、无顺序偏好。
	fullPool []string
	poolPos  int // 下一个待取位置
}

var nameGen *NameGenerator
var nameGenOnce sync.Once

// buildPool 构建并打乱完整候选池
func buildPool(rng *rand.Rand) []string {
	pool := make([]string, 0, len(fixedNames)+len(prefixes)*len(fruits))
	pool = append(pool, fixedNames...)
	for _, p := range prefixes {
		for _, f := range fruits {
			pool = append(pool, p+f)
		}
	}
	// Fisher-Yates 洗牌，保证公平随机
	for i := len(pool) - 1; i > 0; i-- {
		j := rng.Intn(i + 1)
		pool[i], pool[j] = pool[j], pool[i]
	}
	return pool
}

// GetNameGenerator 获取单例
func GetNameGenerator() *NameGenerator {
	nameGenOnce.Do(func() {
		rng := rand.New(rand.NewSource(time.Now().UnixNano()))
		nameGen = &NameGenerator{
			usedNames: make(map[string]bool),
			rng:       rng,
			fullPool:  buildPool(rng),
		}
	})
	return nameGen
}

// Generate 生成随机设备名。
// 从已洗牌的完整池中按顺序取第一个未使用的昵称，保证：
//  1. 固定名与组合名出现频率公平（融合同一池，无优先级）；
//  2. 无顺序偏好（池已 Fisher-Yates 打乱）；
//  3. 不会重复，直到池耗尽。
func (g *NameGenerator) Generate() string {
	g.mu.Lock()
	defer g.mu.Unlock()

	for g.poolPos < len(g.fullPool) {
		cand := g.fullPool[g.poolPos]
		g.poolPos++
		if !g.usedNames[cand] {
			g.usedNames[cand] = true
			return cand
		}
	}

	// 池耗尽（极端情况：所有昵称都被占用），退回随机组合
	for attempts := 0; attempts < 100; attempts++ {
		prefix := prefixes[g.rng.Intn(len(prefixes))]
		fruit := fruits[g.rng.Intn(len(fruits))]
		name := prefix + fruit
		if !g.usedNames[name] {
			g.usedNames[name] = true
			return name
		}
	}
	return "传送者" + strings.Repeat("*", g.rng.Intn(5)+1)
}

// Release 释放名字（设备离线时调用），并将其重新放回待取池，
// 使其在后续生成中可再次被公平取到（避免昵称池随时间缩小）。
func (g *NameGenerator) Release(name string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.usedNames[name] {
		return
	}
	delete(g.usedNames, name)
	// 在池中查找该名字；若已在已取区间，则交换回待取区间并回退 pos
	for i := 0; i < g.poolPos; i++ {
		if g.fullPool[i] == name {
			g.poolPos--
			g.fullPool[i], g.fullPool[g.poolPos] = g.fullPool[g.poolPos], g.fullPool[i]
			break
		}
	}
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
