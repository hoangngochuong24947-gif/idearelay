---
status: accepted
---

# 工作站是唯一真相源，云端只是邮局

规范数据（SQLite + 文件）只存在于工作站上的 `Hub`；手机经 Tailscale/WireGuard 直连，数据不进云。任何云端组件只能是 `Relay`：暂存、转发、带 TTL 删除，永不持有第二个真相源。

**Considered Options**

- **云端 hub**（Cloudflare / 阿里云 / Cloudbase）：手机随时可用，但「文件 + SQLite 是真相源」就不成立，且引入运维与订阅成本。
- **云端缓冲 + 工作站拉取归档**：最灵活，但要维护两套状态和冲突合并。
- **本地优先 + Tailscale 直连**（选定）：Drive/S3 降级为 `SyncAdapter`，air-gap、可 fork、无苹果开发者账号等约束全部自然成立。

**Consequences**

- 工作站关机时手机无法落盘，端侧必须有缓冲与重传队列。
- 工作站不需要公网 IP，也没有公开攻击面。
- 「开源后不依赖作者的服务」这条目标得以字面成立：别人 fork 下来换成自己的 NAS 或什么都不接也能跑。
