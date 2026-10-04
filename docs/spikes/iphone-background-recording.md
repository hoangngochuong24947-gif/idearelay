# #2 — iPhone 后台录音与回传可行性 spike

> 状态：**代码与官方研究已完成；真机结论待 owner 实测**。
> 本文的所有"官方事实"都带 URL 与抓取日期；凡官方未明确、或只有理论推断的，一律标 **未验证 — 必须在真机测**。
> 本 spike 只做 **录音 + 持久化 + 验证**（记录 + 落盘 + 看得到文件）。Uploader / Inbox / Tailscale 回传属 M4，不在本文范围。

---

## 0. 一句话结论

按 Apple 官方 capability 矩阵，**免费 Apple ID（Personal Team）可以启用 Background modes 能力**（即 `UIBackgroundModes: audio`），且后台录音只需这个 Info.plist 声明 + 前台激活的 `AVAudioSession`，**不需要任何 provisioning entitlement**。因此**载体路线在文档层面成立**，但最终裁决只能由真机 40 分钟锁屏实测给出（见 §4 PASS/FAIL）。

---

## 1. 研究结论（逐条带出处）

### 1.1 免费账号能不能开 `UIBackgroundModes: audio`？

**能（文档层面已确认）。** Apple 官方"Supported capabilities (iOS)"表把 **Background modes** 标为 **ADP / ADEP / Apple Developer 三列全部可用**；其中 "Apple Developer" 一列的定义就是免费注册账号：

> "**Apple Developer:** Apple Account holders who have agreed to the Apple Developer Agreement to access certain resources on the Apple Developer website. No cost is associated with this agreement and developers can't distribute apps."

- 出处：<https://developer.apple.com/help/account/reference/supported-capabilities-ios>（页面更新 2026-09-17，抓取 2026-10-04）
- 该页的勾选是图片，Markdown 抓取会丢失；本次直接抓原始 HTML 核对，"Background modes" 行三个 `<td>` 均为 `<figure class="icon icon-checksolid" alt="yes">`。可在浏览器打开该页，"Background modes" 行第三列（Apple Developer）有勾。
- 对照：免费列**没有**勾的是 **Push notifications / iCloud / Wallet / Siri / Sign in with Apple / Associated domains / Network extensions / Personal VPN**。免费列**有**勾的是 Background modes、App groups、Data protection、HealthKit、HomeKit、Inter-App Audio、Keychain sharing、Maps、Wireless Accessory Configuration。
- 影响：Push notifications 不可用 ⇒ 后续**不能靠 APNs 静默推送**唤醒上传；与 ADR-0008 "上传在 app 进程内做"一致。

### 1.2 免费账号的签名限制（官方原文）

> - "You can register up to **10 App IDs**, which expire after **7 days**."
> - "You can register up to **3 devices**, which expire after **7 days**."
> - "You can install up to **3 apps per device**. Provisioning profiles that enable apps to be installed on a device will expire **7 days from issuance**. You'll need to rebuild and reinstall your app to your device after expiration."

- 出处：Apple "Developer account overview" <https://developer.apple.com/support/compare-memberships/>（重定向到 <https://developer.apple.com/help/account/>，抓取 2026-10-04）
- 与本项目的匹配度：只侧载 1 个 app、注册 1 台设备 ⇒ **10 App ID / 3 设备 / 3 app 的限制都够用**；真正麻烦的是 **7 天过期**（#11 相关，SideStore 类工具可自动续签，本文不展开）。

### 1.3 后台录音到底需要什么（entitlement / Info.plist / AVAudioSession）

**不需要任何 entitlement。** Background Modes 能力只是往 Info.plist 写 `UIBackgroundModes`：

> "Xcode adds the `UIBackgroundModes` array to your app's `Info.plist` file, if it isn't already present, and uses the modes you select to populate the array with the necessary values."

- 出处：<https://developer.apple.com/documentation/xcode/configuring-background-execution-modes>（抓取 2026-10-04）
- 录音类别的官方要求：

> "To continue recording audio when your app transitions to the background (for example, when the screen locks), add the `audio` value to the `UIBackgroundModes` key in your information property list file."

- 出处：`AVAudioSession.Category.record` <https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/record>（抓取 2026-10-04）

**Apple DTS 给出的"能无限期后台运行"的最小条件**（这是本 spike 最关键的官方答复，来自 Apple 工程师 Kevin Elliott）：

> "The basic requirements are: 1. Have the 'audio' background category. 2. **ONLY activate your audio session in the foreground.**"
> "Because your app has the 'audio' background category and an active audio session, which means it's allowed to stay active indefinitely (as long as its session is active)."
> "The 'audio' background category is all that you need to keep your app active."

- 出处：Apple Developer Forums thread 826462（2026-05）<https://developer.apple.com/forums/thread/826462>
- 落地到代码：`AVAudioSession.setActive(true)` 只在**前台 Start 时**调用一次；进入后台**不要** deactivate；停止时才 `setActive(false)`。本 spike 的 `RecorderController` 就是这么写的。

### 1.4 iOS 26.x 有没有变化？

**没有针对"只录音不放音"的限制变化。** 同一 Apple DTS 答复：

> Q: "Does iOS 26 distinguish 'audio recording with no audible output' from 'audio recording with audible output (e.g. a media playback session)'?" — A: "**No.**"
> Q: "Does `BGContinuedProcessingTask` (new in iOS 26) actually extend background CPU time for an app that is also using `UIBackgroundModes: audio` and an active `AVAudioSession`?" — A: "It would, but that doesn't really matter. The 'audio' background category is all that you need to keep your app active."

- `BGContinuedProcessingTask` 是 iOS 26 新增的"前台发起、后台续跑"能力（Apple `background-processing` skill 亦有说明），本 spike **不需要**它；它可作为后续上传阶段的加分项。

**⚠️ 风险信号（必须知道）**：该 thread 的提问者在 iOS 26.5 上遇到 **锁屏约 50 秒后进程被 SIGKILL**，但 Apple DTS 认为这是**该 app 自身**的问题（很可能音频会话被 deactivate），不是系统策略；DTS 现场用 Apple 官方 sample "Capturing stereo audio from built-in microphones" 在后台跑通了。**含义**：如果我们的 app 也在 ~50s 被杀，优先查 `log stream` / 崩溃日志里 `runningboardd` 的终止原因，而不是先下"iOS 不支持"的结论。

### 1.5 什么会打断后台音频，app 必须做什么

- 官方（`record` 类别说明）："Using this category doesn't prevent **phone calls, alarms, or other nonmixable audio sessions** from interrupting the audio session."
  - 出处：同 §1.3 的 `record` 页面。
- 处理方式（iOS 26 及更早，即本项目目标）：观察 `AVAudioSession.interruptionNotification`：
  - `.began`：更新 UI / 记账；**不要** deactivate 会话。
  - `.ended`：读 `AVAudioSessionInterruptionOptions`，若含 `.shouldResume` 则重新激活并恢复。
- **iOS 27 变化（前瞻）**：Apple 新文档说明 iOS 27 起改用生命周期通知 `didBecomeActiveNotification` / `didBecomeInactiveNotification` / `resumptionRecommendationNotification` 取代 `interruptionNotification`，后者将被弃用。本项目目标 iOS 26，先用 legacy 通知；升到 iOS 27 时按官方示例迁移。
  - 出处：<https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions>（抓取 2026-10-04）
- 本 spike 的处理：`RecorderController.handleInterruption` 走 legacy 通知；`.began` 累计已录时长并 `interruptionCount += 1`；`.ended` 尝试 `setActive(true)` + `recorder.record()` 续录同一文件。**续录是否真能追加同一 `.m4a` 属于 §1.7 未验证项。**

### 1.6 麦克风权限不是 entitlement

麦克风是**运行时隐私权限**，靠 `NSMicrophoneUsageDescription` 文案 + 首次运行时的 TCC 弹窗，不需要 provisioning entitlement。
- 出处：<https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription>（抓取 2026-10-04）
- 本 spike 在 `start()` 里用 `AVAudioApplication.requestRecordPermission` 显式请求。

### 1.7 仍未验证 — 必须在真机测

以下官方文档没有、也不可能有结论，只能实测（本文 §3/§4 就是为它们设计的）：

1. 免费 personal team 签出的 build 在 **iOS 26.5 真机**上，锁屏后是否真的拿到 audio 后台运行分类、并**连续存活 ≥ 40 分钟**。
2. 中断结束后 `AVAudioRecorder.record()` **能否追加到同一个 `.m4a`**（还是会覆盖/损坏）。
3. 进程被杀时，`.m4a` 的 `moov` 原子**是否已落盘、文件是否可播放**（AVAudioRecorder 通常在 `stop()` 时才 finalize）。
4. 40 分钟录音的**实际时长与文件大小**（本 spike 预估：单声道 AAC 64 kbps ≈ 19 MB / 40 min）。
5. 后台经 Tailscale **在 app 进程内上传**是否可行（M4 范围，本 spike 不测，但失败会连带影响）。
6. 内存压力下被终止的行为。

---

## 2. 本 spike 交付物：`apps/ios`

```
apps/ios/
├── project.yml                       # XcodeGen 源文件（工程从这里生成）
├── .gitignore
├── IdeaRelay.xcodeproj               # 生成物（xcodegen generate）
└── IdeaRelay/
    ├── Info.plist                    # UIBackgroundModes=[audio] + NSMicrophoneUsageDescription
    ├── App/IdeaRelayApp.swift        # @main + SwiftData ModelContainer
    ├── Recorder/RecorderController.swift  # AVAudioSession + AVAudioRecorder + 中断处理
    ├── Store/RecordingSession.swift  # @Model：可被 kill 后恢复的录音元数据
    └── Views/ContentView.swift       # Start/Stop + 计时 + 文件路径/大小 + 列表
```

- 技术栈：Swift 6 + SwiftUI + SwiftData + AVFAudio，Deployment Target iOS 17.0，iPhone only。
- 录音：**单个连续 `.m4a`**（AAC，44.1 kHz 单声道 64 kbps），写到 `Documents/Recordings/`，**录制中绝不切段**。
- 持久化：Start 时插入一条 `RecordingSession(status: .recording)`；Stop/中断实时更新；**下次启动扫描 `status == .recording` 的行，标为 `.interrupted` 并刷新磁盘大小**（模拟"进程被杀后恢复待上传录音"）。
- 中断：来电/闹钟计数并尝试同一文件续录。
- 文件可取回：`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`，可在"文件"App 里 `我的 iPhone → IdeaRelay → Recordings` 直接播放/拷贝。
- 重新生成工程（改过 `project.yml` 后）：`cd apps/ios && xcodegen generate`。**`xcodegen` 已由本次通过 `brew install xcodegen`（2.46.0）安装。**

---

## 3. 真机测试步骤（owner 照着做）

> 环境：Mac（Xcode **26.6**，本机已装）+ iPhone（目标 iOS 26.x，本机型号未知）+ 数据线（首次必须连线）。

**步骤 0 — 前置**
1. Mac 打开 Xcode 26.6。

**步骤 1 — 在 Xcode 登录免费 Apple ID**
1. `Xcode → Settings… → Accounts`，左下 `+` → `Apple ID`，登录你的免费 Apple ID。
2. 登录后该账号显示为 **Personal Team**（免费）。若显示"未加入开发者计划"是正常的，继续。

**步骤 2 — 打开工程并配置签名**
1. 打开 `apps/ios/IdeaRelay.xcodeproj`。
2. 选中左侧 `IdeaRelay` 工程 → `TARGETS: IdeaRelay` → `Signing & Capabilities`。
3. 勾选 `Automatically manage signing`；`Team` 选你的 **Personal Team**。
4. `Bundle Identifier` 改成**全球唯一**（免费账号按 bundle id 注册 App ID，重名会报错）。建议加后缀，例如：
   `dev.idearelay.IdeaRelay` → `dev.idearelay.IdeaRelay.<你的名字或缩写>`。
5. 确认 `Background Modes` 已列出且勾选了 **Audio, AirPlay, and Picture in Picture**（`project.yml`/`Info.plist` 已写好；若 Xcode 未显示该 capability，说明能力未被 team 接受 —— 记 FAIL-1）。

**步骤 3 — 打开开发者模式 + 信任证书**
1. 用数据线连接 iPhone，iPhone 上选"信任此电脑"。
2. iPhone：`设置 → 隐私与安全性 → 开发者模式` → 打开 → 重启 → 重启后确认。
   （出处：<https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device>）
3. 在 Xcode 顶部运行目标选你的 iPhone，点 Run（▶）。首次可能提示证书不受信：iPhone `设置 → 通用 → VPN与设备管理` → 信任你的 Apple ID 开发者证书。
4. 首次启动 app 会弹麦克风权限，点允许。

**步骤 4 — 短跑一遍（先 2 分钟）**
1. 点 `Start recording`，确认状态变红、计时走动。
2. 锁屏，等 2 分钟。
3. 解锁，点 `Stop recording`。
4. 列表里应出现一条 `DONE`，时长 ≈ 02:00，大小非 0。
5. 打开 iPhone"文件"App → `我的 iPhone → IdeaRelay → Recordings`，点开 `.m4a` **确认能播放、声音正常**。
   - 若列表显示 `INTERRUPTED` 或时长明显偏短 → 后台没存活，记 FAIL-2。

**步骤 5 — 关键：锁屏 40 分钟**
1. `Start recording`。
2. 立刻锁屏，把手机放兜里走动（可插耳机也可不插）。
3. 全程**不要**解锁看，让屏幕保持锁定 ≥ 40 分钟。
4. 回来看列表：`DONE`，时长 ≥ 40:00（允许中断造成的少量缺口），大小约 15–25 MB。
5. 播放 `.m4a`，抽查开头/中段/结尾都有声音。

**步骤 6 — 中断测试**
1. 开始录音 → 锁屏 → 用另一台手机给 iPhone 打电话（或设一个 1 分钟后的闹钟）→ 挂断/关闹钟。
2. 回来后列表 `Interruptions` 计数应 ≥ 1；录音应已续上（或干净结束）。
3. 播放：中断处可能有缺口，但音频不损坏、app 不崩溃。

**步骤 7 — 杀进程恢复测试**
1. 开始录音 → 回主屏（让 app 进后台）→ 上滑杀掉 app。
2. 重新打开 app。
3. 那条录音应显示 `INTERRUPTED`，**路径与大小仍在**（元数据恢复）。
4. 尝试播放该 `.m4a`：**能否播放记录到观测里**（这是 §1.7 第 3 点，不作为 PASS 门槛）。

**步骤 8 — 取回文件（可选，用 Mac）**
- Xcode → `Window → Devices and Simulators` → 选中 iPhone → `Installed Apps` 选 IdeaRelay → 齿轮 `Download Container…`，即可拿到完整 `Documents/Recordings/*.m4a`。

---

## 4. PASS / FAIL 判据

**PASS（全部满足 ⇒ 免费签名路线成立）**

- **P1** 用免费 Personal Team 能成功签名、安装、启动（无付费账号）。
- **P2** 锁屏 + 后台**连续 ≥ 40 分钟**不被挂起/杀死；Stop 后 `.m4a` **时长 ≥ 40:00 × 90%**（扣除中断缺口），且**能正常播放**。
- **P3** 文件大小与 40 分钟单声道 AAC 64 kbps 相符（约 15–25 MB）。
- **P4** 一次来电或闹钟中断被正确计数，录音能续上或干净结束，app 不崩溃，文件仍可播放。
- **P5** 杀进程后重启，pending 录音被标 `INTERRUPTED` 且路径/大小可恢复（**元数据**恢复即算通过；被杀文件的**可播放性**只记录，不作门槛）。
- **P6** 7 天过期后能用 Xcode 重新签名安装（重跑一次即可）。

**FAIL（任一条成立 ⇒ 免费签名路线不成立，$99/年 Apple Developer Program 为唯一解）**

- **F1** Xcode 在签名/安装阶段报错，明确拒绝 personal team 使用 background modes / 麦克风。
- **F2** 即便 `UIBackgroundModes: audio` 且会话在前台激活，锁屏几分钟内进程仍被系统性挂起/杀死（即重演 thread 826462 的 ~50s SIGKILL 且无法用会话保持解决）。
- **F3** 一旦进入后台，录音必然停止或 `.m4a` 无法 finalize / 不可播放。
- **F4** 无法在 7 天过期后重新签名安装。

---

## 5. 决策规则

- 全部 **PASS** ⇒ 保留"iOS 原生 + 免费 Apple ID 签名"载体（ADR-0008 维持），把 7 天续签（SideStore 类）并入 #11。
- 任一 **FAIL** ⇒ **推翻 ADR-0008 的免费签名假设，改用 $99/年 Apple Developer Program**；载体仍是 iOS 原生，代码不变，只是签名来源变化。
- 无论 PASS/FAIL，**P5 的"被杀 `.m4a` 是否可播放"要记录**：若不可播放，则 §12.2 的"分段 checkpoint"需要在 M4 用 `AVAudioEngine + AVAudioFile` 或周期性 flush 重新设计（**但不切段**这一条来自 stack-survey，先尽可能保住）。

---

## 6. 附录：本机已做的验证（无真机）

在 `/Users/jigroup1/orca/workspaces/idearelay/pinfish/apps/ios`：

| 命令 | 结果 |
|---|---|
| `xcodegen generate` | ✅ 生成 `IdeaRelay.xcodeproj`（xcodegen 2.46.0，本次 `brew install` 安装） |
| `xcodebuild -list -project IdeaRelay.xcodeproj` | ✅ 解析出 target/scheme `IdeaRelay`，Debug/Release |
| `xcodebuild build -project IdeaRelay.xcodeproj -scheme IdeaRelay -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO` | ❌ `Found no destinations … iOS 26.5 is not installed` —— **本机未安装 iOS 平台运行时**（见下），与代码无关 |
| `xcodebuild build -project IdeaRelay.xcodeproj -target IdeaRelay -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""` | ✅ **BUILD SUCCEEDED**（arm64-apple-ios，无签名，仅一条无害的 AppIntents 提示） |
| 产物核对 `build/Debug-iphoneos/IdeaRelay.app` | ✅ `UIBackgroundModes = [audio]`、`NSMicrophoneUsageDescription` 已嵌入；binary `arm64`，链接 `AVFAudio` / `SwiftData` / `SwiftUI` |

关于 scheme 构建失败：`xcodebuild -showdestinations` 显示唯一候选项 `Any iOS Device` 被标记 ineligible，错误为 `iOS 26.5 is not installed. Please download and install the platform from Xcode > Settings > Components.`。SDK 本身在 `/Applications/Xcode-26.6.0.app/…/iPhoneOS26.5.sdk`，但 Xcode 认为该平台组件未安装。**这不影响真机流程**：owner 在 Xcode 里连上 iPhone 后，Xcode 会自行解析设备目的地。本机若要走命令行，用上面的 **`-target`（不带 `-destination`）** 版本即可编译。

> 复现命令（无签名，仅验证编译）：
> ```sh
> cd apps/ios
> xcodegen generate
> xcodebuild build -project IdeaRelay.xcodeproj -target IdeaRelay \
>   -configuration Debug -sdk iphoneos \
>   CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""
> ```
