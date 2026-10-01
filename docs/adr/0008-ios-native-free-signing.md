---
status: accepted
---

# 载体：iOS 原生 App，先试免费 Apple ID 签名

iOS 上只有原生 App 能锁屏录音（`UIBackgroundModes: audio` + `AVAudioSession.record`）；Safari/PWA 完全没有后台能力（Background Sync 与 Background Fetch 在 iOS Safari 均不支持，装到主屏不改变这一点）。微信小程序也被排除：官方 `RecorderManager.start` 的 `duration` 上限 600000ms（10 分钟）、后台 5 秒即挂起 JS 线程、`requiredBackgroundModes` 不提供录音、且网络出口要求 ICP 备案域名 + 可信 HTTPS + 后台白名单（Tailscale 不在同子网例外内）。Android 侧 `foregroundServiceType="microphone"` 同样可靠，且 APK 无签名仪式——但主力机是 iPhone。

**Considered Options**

- **PWA**：iOS 上锁屏即挂起，40 分钟录音不可能实现。
- **微信小程序**：10 分钟上限 + 后台挂起 + 域名备案，主场景直接不成立；它唯一站得住的位置是 Inbox 点按端。
- **iOS 原生 + $99/年**：唯一 Apple 官方支持路径，消除全部不确定性。
- **iOS 原生 + 免费 Apple ID 签名**（选定，先试）：$0，但需要 Mac + Xcode + 开启开发者模式，7 天一续（SideStore 可自动续签）。

**Consequences**

- **未验证风险**：免费 personal team 是否允许 `UIBackgroundModes: audio` 与麦克风权限，Apple 官方文档未说明。这是全项目最大单一风险，地图上第一张 ticket 就是实测它；若不支持，$99/年是唯一解。
- iOS 后台 `URLSession` 与 VPN 的组合未文档化，因此上传应在 app 进程内完成——而 audio 后台模式正好让 app 合法地在后台运行。
- 后台录音仍会被来电、闹钟中断；内存压力下进程可能被终止，需要分段 checkpoint。
