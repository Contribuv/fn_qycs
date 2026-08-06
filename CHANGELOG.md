# 千盈传送 更新日志

## v2.1.0 (2026-08-06)

### 新功能
- **TURN/TURNS 连通性测试**：网关传送设置页面新增测试按钮，基于 Offer/Answer 触发完整 ICE gathering，实时验证中继服务器可达性和凭据正确性
- **SQLite 数据库存储**：替代原 JSON 文件方案，设置数据事务性持久化；网关页面与 ICE 接口读取同一数据源，彻底消除密码掩码不一致导致的各类问题
- **TURN 可达性后台验证**：页面加载后异步探测 TURN 服务器是否真能分配 relay 候选，修正 UI 网络能力指示器
- **gateway API 路径 TCP/Unix 自适应**：测试时 TCP 直连和生产环境 Unix 网关均可正确调用 API

### 修复
- 网关设置保存后测试按钮功能丢失（密码掩码 `********` 与真实密码不一致导致 15s 超时）
- 网络能力 Pill 文案使用真实中继结果回写，而非仅凭 URL 配置判断

### 优化
- 网关传送设置推荐文案更新，免费 TURN 推荐指向 metered.ca
- 移除密码掩码逻辑，密码从数据库完整恢复至前端 `type=password` 域

## v2.0.9 (2026-08-06)

- **修复 TURN 中继配置失效**：用户在传送设置中填写裸地址（如 `free.expressturn.com:3478`，未带 `turn:` 前缀）时，`/api/ice-servers` 原样返回，浏览器会将该地址当作 STUN 服务器而非 TURN，导致中继实际不可用；同时前端按 `turn:` 前缀判定，误报「未配置 TURN 中继，跨网穿透可能失败」。现后端自动补全 `turn:` / `turns:` 协议前缀（已有前缀则原样保留）

## v2.0.8 (2026-08-06)

- **NAT 穿透优先直连**：本机探测到 STUN 反射地址（srflx）时，实际传输优先使用仅 STUN 的直连打洞（不带 TURN），避免明明能 NAT 穿透却误走 TURN 中继；直连失败或超时（12s）自动降级为 TURN 中继兜底，两端自动协调重建连接
- **修复网络能力误判**：TURN relay 候选不再被计入「已获取公网地址」；仅配置 TURN 时如实显示「已配置 TURN 中继，可跨网互传」，不再误导用户
- **连接通路提示优化**：连接成功后明确区分「已通过 NAT 穿透直连」「已通过公网 IPv6 直连」「已通过 TURN 中继连接（对端 NAT 无法穿透）」
- **接收端降级等待**：直连模式失败时接收端不再误报「跨网连接失败」，静默等待发送端 TURN 降级重建（20s 超时）
- **传送设置**：新增免费 TURN 服务器申请引导，可在 ExpressTURN（www.expressturn.com）免费申请 TURN 中继服务

## v2.0.7 (2026-08-06)

- **传输稳定性**：新增 `cleanupAllTransfers` 统一清理方法，发送/接收/取消后释放所有 P2P 资源（PC/DC/Buffer/Writable/WakeLock），重置 `_lastViaTurn` 网络探测状态，清空 `selectedFiles` 和 `selectedTarget`，确保下次传输从干净状态开始
- **刷新持久化**：桌面端流式写盘（File System Access API）同步写入 IndexedDB 分片备份，`chunkCount` 正确记录；刷新页面后 `renderReceiveList` 根据 `chunkCount > 0` 显示查看/下载按钮；`loadHistory` 携带 `chunkCount` 字段；`startDownload` 优先 IndexedDB 恢复
- **传送设置页面**：修复深色主题下输入框 `:-webkit-autofill` 自动填充变白；修复 `.settings-info-tip` 中 `--gw-bg-secondary` 和 `--gw-primary` CSS 变量不存在；`.url-link` 和 `.settings-info-tip a` 添加 `:visited` 颜色；`settings-info-tip` 底部间距 4px→10px；`mac-hint` 颜色 tertiary→secondary 提升可读性
- **安全加固**：新增 `tcpGatewayGuard` 中间件，TCP 端口 `:5553/gateway*` 返回 404，管理面板仅允许通过飞牛统一网关 Unix Socket 访问

## v2.0.6 (2026-07-31)

- 修复公网反代部署下同内网设备互发现失败
- 修复 netCapPill 对同公网出口设备的错误判断
- 优化 LocalLanIP 上报等待机制
- 房间内同一局域网设备正确显示"局域网直连"
- 新增 PC 端二维码分享（扫描即可加入房间）
- 二维码支持深色/浅色主题自适应
- header-tabs 动态对齐 main 容器中心
- 修复移动端加入房间后页面位置
- TURN 自建服务器引导说明
