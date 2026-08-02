# 千盈传送 (fn_qycs) 飞牛 NAS FPK 应用打包计划

## 项目概述

将现有的局域网文件传输工具（WebRTC P2P 直传）打包为飞牛 NAS FPK 应用，支持 x86/ARM 双架构，集成反向代理功能，适配飞牛统一网关和主题系统。

- **应用名称**: fn_qycs（千盈传送）
- **版本**: 1.0.5
- **默认端口**: 5553（HTTP）/ 7753（HTTPS 反代）
- **目标平台**: 飞牛 NAS（x86_64 + ARM64）
- **参考项目**: fn_qyzb（千盈助播）

---

## 一、项目结构

```
fn_qycs/
├── build.sh                    # 双架构交叉编译脚本
├── logo.png                    # 1024x1024 应用图标（蓝色双向箭头）
├── PLAN.md                     # 本计划文档
├── server-src/                 # 主服务源码（Go）
│   ├── main.go                 # 主服务入口（端口 5553 + Unix Socket）
│   ├── go.mod / go.sum
│   ├── handler/                # HTTP 处理器
│   │   ├── ws.go               # WebSocket 信令转发
│   │   ├── upload.go           # 文件上传（兼容旧客户端）
│   │   ├── download.go         # 文件下载（流式）
│   │   └── gateway_handler.go  # 反代管理 API
│   ├── service/                # 业务逻辑层
│   │   ├── device.go           # 设备管理（在线/离线/心跳）
│   │   ├── name.go             # 设备名生成器
│   │   ├── transfer.go         # 传输任务管理
│   │   ├── cert_manager.go     # 飞牛系统证书管理
│   │   └── rproxy_manager.go   # 反代进程管理
│   ├── rproxy/                 # 反向代理独立模块（Go）
│   │   ├── main.go             # 反代入口
│   │   ├── proxy.go            # TLS 终止 + HTTP→HTTPS 301
│   │   ├── api.go              # 反代管理 API
│   │   ├── config.go           # 配置结构
│   │   ├── logger.go           # 日志管理
│   │   └── go.mod
│   └── static/                 # 前端静态资源（embed）
│       ├── index.html
│       ├── favicon.ico
│       ├── css/style.css
│       └── js/app.js           # 前端主逻辑 + 飞牛 SDK 集成
└── package/                    # FPK 打包目录
    ├── manifest                # 飞牛应用清单
    ├── ICON.PNG                # 桌面图标（大）
    ├── ICON_256.PNG            # 桌面图标（256）
    ├── app/
    │   ├── server/             # 主服务二进制
    │   │   ├── fn_qycs-server-amd64
    │   │   └── fn_qycs-server-arm64
    │   ├── rproxy/             # 反代二进制
    │   │   ├── qycs-rproxy-amd64
    │   │   └── qycs-rproxy-arm64
    │   └── ui/                 # 桌面图标配置
    │       ├── config          # 桌面快捷方式配置
    │       └── images/
    │           ├── icon_64.png
    │           └── icon_256.png
    ├── cmd/                    # 生命周期脚本（9 个）
    │   ├── main                # 主控脚本（start/stop/status/upgrade/uninstall）
    │   ├── install_init        # 安装前初始化
    │   ├── install_callback    # 安装后回调
    │   ├── upgrade_init        # 升级前备份
    │   ├── upgrade_callback    # 升级后回调
    │   ├── uninstall_init      # 卸载前回调
    │   ├── uninstall_callback  # 卸载后回调
    │   ├── config_init         # 配置修改前
    │   └── config_callback     # 配置修改后（触发重启）
    ├── config/
    │   ├── privilege           # 权限配置（运行用户）
    │   └── resource            # 资源配置（共享目录）
    └── wizard/                 # 安装向导（JSON）
        ├── install             # 安装向导（端口设置）
        ├── upgrade             # 升级向导
        └── uninstall           # 卸载向导（数据保留/删除）
```

---

## 二、核心功能模块

### 2.1 主服务（server-src/main.go）

- **TCP 监听**: 端口 5553（可由 wizard 配置）
- **Unix Socket**: 多路径创建，适配飞牛统一网关
  - 主路径: `/var/apps/fn_qycs/target/app.sock`
  - 备用路径: `${TRIM_APPDEST}/target/app.sock`
- **静态资源**: 使用 `embed.FS` 嵌入前端文件
- **WebSocket**: `/ws` 路径，用于设备发现和 WebRTC 信令转发
- **API 路由**:
  - `/api/create-task` - 创建传输任务
  - `/api/upload` - 文件上传
  - `/api/upload-complete` - 上传完成通知
  - `/download/{taskId}` - 流式下载
  - `/gateway/api/*` - 反代管理 API

### 2.2 反向代理（rproxy/）

- **独立进程**: 与主服务解耦，通过 API 管理
- **TLS 终止**: 支持 HTTPS，自动从飞牛系统读取证书
- **HTTP→HTTPS**: 同端口 301 重定向
- **WebSocket 转发**: 实现 Hijacker 接口支持升级
- **Gzip 压缩**: 静态资源自动压缩
- **HSTS**: 启用 Strict-Transport-Security
- **后端地址**: `http://127.0.0.1:5553`

### 2.3 证书管理（cert_manager.go）

- 读取飞牛系统证书配置: `/usr/trim/etc/network_cert_all.conf`
- 过滤 `fnos.net` 系统内置证书
- 支持按域名查找证书
- 提供证书列表展示（含 SAN、过期时间）

### 2.4 反代进程管理（rproxy_manager.go）

- **单例模式**: `sync.Once` 保证全局唯一
- **配置持久化**: 保存到 `${DATA_DIR}/rproxy-config.json`
- **自动恢复**: 系统重启后自动检测并恢复反代
- **进程监控**: `watchProcess` 协程监控子进程状态
- **端口检测**: 启动前检查端口可用性，提供建议端口

### 2.5 前端适配（static/js/app.js）

- **飞牛 SDK 集成**:
  - 检测 `window.sdk` 是否存在
  - 调用 `sdk.getPlatformConfig()` 获取系统主题
  - 监听 `sdk.$on('os/theme')` 事件实时切换主题
  - 飞牛桌面环境下隐藏主题切换选项
- **独立环境回退**:
  - 使用 `localStorage` 存储主题偏好
  - 监听 `prefers-color-scheme` 媒体查询
- **WebRTC P2P 直传**: 文件数据不经过服务器
- **IndexedDB 持久化**: 大文件分片存储，避免内存溢出

---

## 三、飞牛 FPK 规范适配

### 3.1 manifest 配置

```ini
appname               = fn_qycs
version               = 1.0.5
display_name          = 千盈传送
service_port          = 5553
checkport             = true
ctl_stop              = yes
gateway_socket        = app.sock
desktop_uidir         = ui
desktop_applaunchname = fn_qycs.Application
platform              = all
source                = thirdparty
```

### 3.2 统一网关适配

- **Socket 路径**: `/var/apps/fn_qycs/target/app.sock`
- **网关前缀**: `/app/fn_qycs`
- **桌面 URL**: `/app/fn_qycs/gateway`
- **多路径创建**: 系统重启后 `/var` 可能被清空，同时在 `TRIM_APPDEST/target` 创建备用 socket

### 3.3 生命周期脚本

| 脚本 | 触发时机 | 主要职责 |
|------|----------|----------|
| `install_init` | 安装前 | 创建数据目录，保存 wizard 配置 |
| `install_callback` | 安装后 | 记录安装日志 |
| `upgrade_init` | 升级前 | 备份配置文件，保存新端口 |
| `upgrade_callback` | 升级后 | 记录升级日志 |
| `uninstall_init` | 卸载前 | 记录卸载模式 |
| `uninstall_callback` | 卸载后 | 根据用户选择删除/保留数据 |
| `config_init` | 配置修改前 | 记录环境变量 |
| `config_callback` | 配置修改后 | 保存新配置，杀旧进程触发重启 |
| `main` | 日常管理 | start/stop/status/upgrade/uninstall |

### 3.4 安装向导

- **步骤 1**: 欢迎说明（功能介绍）
- **步骤 2**: 端口设置（默认 5553，HTTPS 反代默认 7753）

### 3.5 卸载向导

- **数据处理方式选择**:
  - 保留数据卸载（推荐）
  - 删除数据卸载

---

## 四、双架构编译

### 4.1 编译脚本（build.sh）

```bash
# 用法
./build.sh           # 编译双架构
./build.sh amd64     # 仅编译 amd64
./build.sh arm64     # 仅编译 arm64
./build.sh pack      # 编译后调用 fnpack 打包 FPK
```

### 4.2 编译参数

- `CGO_ENABLED=0` - 纯 Go 静态编译
- `GOOS=linux` - 目标系统
- `GOARCH=amd64|arm64` - 目标架构
- `-ldflags="-s -w"` - 去除调试信息，减小体积

### 4.3 输出目录

- 主服务: `package/app/server/fn_qycs-server-{arch}`
- 反代: `package/app/rproxy/qycs-rproxy-{arch}`

### 4.4 架构检测

运行时通过 `uname -m` 检测：
- `x86_64` → amd64
- `aarch64` → arm64

Go 代码中通过 `runtime.GOARCH` 检测（编译时确定）。

---

## 五、图标资源

所有图标均采用 `logo.png`（1024x1024，蓝色圆角背景 + 白色双向箭头），尺寸保持不变：

| 文件路径 | 用途 |
|----------|------|
| `package/ICON.PNG` | FPK 包图标 |
| `package/ICON_256.PNG` | FPK 包图标（256） |
| `package/app/ui/images/icon_64.png` | 桌面小图标 |
| `package/app/ui/images/icon_256.png` | 桌面大图标 |

---

## 六、Bug 修复记录

### 6.1 ARM 统一网关稳定性

**问题**: ARM 架构下统一网关 socket 路径不一致，导致桌面图标无法访问应用。

**修复**:
- 主服务在多个路径同时创建 socket（`/var/apps/fn_qycs/target/app.sock` + `TRIM_APPDEST/target/app.sock`）
- `status()` 只检查 PID 和 TCP 端口，不检查 socket 文件（避免残留文件误判）
- 启动前清理所有可能的残留 socket 文件

### 6.2 系统重启后反代无法恢复

**问题**: 飞牛系统重启后，反代进程丢失，公网 HTTPS 访问中断。

**修复**:
- `rproxy_manager.go` 实现配置持久化（`rproxy-config.json`）
- `GetRProxyManager()` 初始化时调用 `recoverStatus()` 自动检测并恢复
- 检查证书文件存在性，避免无效恢复
- 检查端口可用性，避免冲突

### 6.3 残留 socket 文件导致启动失败

**问题**: 系统重启后 `/var/apps/fn_qycs/target/app.sock` 残留，新进程无法绑定。

**修复**:
- `start()` 中清理所有可能的 socket 路径
- `createSocketListener()` 中 `os.Remove(sockPath)` 后再 `net.Listen`

### 6.4 反代多进程清理

**问题**: `stop()` 中 `pgrep` 可能返回多个 PID，`kill` 命令处理不当。

**修复**: 使用 `while read` 循环逐个处理 PID，确保所有反代进程被正确清理。

### 6.5 状态检测误判

**问题**: `status()` 中 `APP_PORT` 可能为空（配置文件未加载时）。

**修复**: 使用 `${APP_PORT:-5553}` 提供默认值兜底。

---

## 七、执行进度

### 已完成

- [x] 创建 fn_qycs 目录结构
- [x] 迁移主服务源码到 server-src/，修改端口为 5553
- [x] 移植反代 rproxy 源码，后端改为 127.0.0.1:5553
- [x] 移植证书管理 cert_manager.go
- [x] 新增 gateway_handler.go 反代管理 API
- [x] 前端集成飞牛 SDK 主题监听 + 隐藏主题切换
- [x] 主服务 main.go 支持 Unix Socket 多路径 + 端口 5553
- [x] 编写 manifest 配置
- [x] 编写 cmd/ 全部生命周期脚本（9 个）
- [x] 编写 wizard/ 安装/升级/卸载向导（3 个）
- [x] 编写 config/ privilege + resource
- [x] 编写 build.sh 交叉编译脚本（amd64 + arm64）
- [x] 复制图标文件（ICON.PNG / ICON_256.PNG / ui/images/）
- [x] 创建 ui/config 桌面图标配置文件
- [x] 修复 ARM 统一网关稳定性问题
- [x] 修复反代多进程清理逻辑
- [x] 修复 status() 状态检测误判
- [x] 完善卸载回调（支持共享目录）

### 待执行

- [ ] 编译测试验证（amd64 + arm64）
- [ ] 验证 rproxy_manager.go 适配正确性
- [ ] 在飞牛 NAS 上实际部署测试
- [ ] 使用 fnpack 打包 FPK 文件

---

## 八、技术要点

### 8.1 WebRTC P2P 直传

- 文件数据通过 WebRTC DataChannel 传输，不经过服务器
- 服务器只做信令转发（WebSocket）
- Vanilla ICE：SDP 包含完整候选，不 trickle
- DataChannel 流控：高水位 4MB / 低水位 1MB

### 8.2 流式分片存储

- 移动端使用 IndexedDB 持久化接收的文件
- 5MB 分片写入，避免内存溢出
- 刷新页面后可恢复历史记录

### 8.3 飞牛 SDK 主题适配

```javascript
// 飞牛环境下监听系统主题
if (typeof window.sdk !== 'undefined' && window.sdk) {
    const config = await window.sdk.getPlatformConfig();
    applyTheme(config.theme);
    await window.sdk.$on('os/theme', (theme) => {
        applyTheme(theme);
    });
}
```

### 8.4 反代 TLS 探测

- 同一端口同时支持 HTTP 和 HTTPS
- 读取首字节判断是否为 TLS（0x16）
- HTTP 请求自动 301 重定向到 HTTPS

---

## 九、部署流程

1. 在 Linux 环境执行 `./build.sh` 编译双架构二进制
2. 将 `package/` 目录复制到飞牛 NAS
3. 使用 `fnpack` 打包: `fnpack package/ fn_qycs_v1.0.5.fpk`
4. 在飞牛 NAS 应用中心上传 FPK 安装
5. 安装时设置服务端口（默认 5553）
6. 安装完成后通过桌面图标或 `http://飞牛IP:5553` 访问
7. 在应用内「公网访问」中配置反向代理域名和证书

---

## 十、注意事项

- 飞牛 NAS 需为 0.8.5 或以上版本
- ARM 设备需确保 socket 目录可创建（`/var/apps/fn_qycs/target/`）
- 反代需先在飞牛系统中配置域名和证书
- 移动端保存到相册功能需 HTTPS 环境（Web Share API 要求）
- 单次仅传输 1 个文件，确保稳定性
