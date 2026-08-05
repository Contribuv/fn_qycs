# 千盈传送 更新日志

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
