# idearelay 技术选型调研：别人是怎么实现的

按模块罗列可直接抄或可嵌入的开源实现。结论列是推荐，不是中立罗列。

## 一、手机端 capture

| 环节 | 候选 | 结论 |
|---|---|---|
| 长时录音 | WhisperAX（`argmaxinc/WhisperKit` 示例 App）、Diktafon、Whisperboard（2024 后停更） | **抄 WhisperAX 的结构**：`AVAudioRecorder` 写单个连续 `.m4a`，`AVAudioSession` 用 `.playAndRecord` + `UIBackgroundModes: audio`。**不要**在录制时切段——开源项目普遍不做，切段会把中断处理复杂化；分段交给转写侧（VAD/30s 窗口） |
| 端侧 STT | WhisperKit（CoreML，实时流式，词级时间戳）、whisper.cpp（可移植、有 `examples/stream`）、Apple `SFSpeechRecognizer` | **服务端转写，端侧不做**。Apple 官方明确说「plan for a one-minute limit」，且无词级时间戳。真要离线再上 WhisperKit |
| 可续传上传 | **tus**：`TUSKit`(iOS) / `tus-android-client` / `tus-js-client` / `@tus/server` + `@tus/file-store`(Node, MIT) | **直接采用 tus**。40 分钟音频的断点续传是被 tus 协议解决的问题，自己用 HTTP Range 只是重新实现一遍。把 upload URL 持久化，App 被杀后能续 |
| VPN | `tailscale/tailscale`（BSD-3，但 iOS GUI 不开源） | **不嵌入**：iOS 没有可嵌入的 Tailscale SDK（App Store 版本装的是 `NEPacketTunnelProvider` 配置）。手机上装 Tailscale App，我们的 App 直连 tailnet hostname 即可 |
| 同步框架 | PowerSync、ElectricSQL、Replicache（已进维护模式，作者让用 Zero）、Jazz、InstantDB、WatermelonDB | **全都不用**。它们都会引入第二个真相源，与 ADR-0001 冲突，且为单人单写者场景属于杀鸡用牛刀 |
| 文件同步 | Syncthing、**Möbius Sync**（第三方商业 iOS 客户端） | **不用**。Syncthing 无官方 iOS 客户端，且 iOS 上没有任何 App 能常驻后台同步。手机侧只保留「发送队列」语义 |

## 二、工作站 Hub

**骨架参照**：[Karakeep](https://github.com/karakeep-app/karakeep) —— Next.js Web/API 进程 + SQLite + 自带 SQLite 队列（liteque）+ 独立 worker 进程。这是最接近「本地服务 + SQLite + 后台任务 + API + Web UI」的开源形态。

| 环节 | 候选 | 结论 |
|---|---|---|
| 任务队列 | BullMQ(Redis)、pg-boss/River(PG)、Temporal、Inngest、Trigger.dev、DBOS Transact TS（**需要 Postgres**）、**liteque**（TS + better-sqlite3 + Drizzle，原子 claim、幂等入队）、**vardiya**（心跳、stall reclaim、dead-letter、cron） | **自己写 job 表，抄 liteque 的 schema 与原子 claim + vardiya 的心跳/stall reclaim/死信**。诚实结论：Node 里**不存在**「SQLite 后端的 durable execution 库」，DBOS 是最近的但要 Postgres |
| 事件 seam | LiveStore（SQLite 事件溯源 + 同步引擎）、eventlite-sourcing、WatermelonDB 的 pull/push 协议 | **抄模式不抄框架**：append-only `events(id, aggregate_id, seq, type, payload json, created_at)` + 物化投影表。给手机端的增量同步形状抄 WatermelonDB（`lastPulledAt` + 增删改墓碑） |
| 文件监听 | chokidar（`awaitWriteFinish`）、watchman、裸 `fs.watch`（macOS 上不可靠） | **chokidar + 原子写（`.tmp` → `mv`）**。去重与半写文件处理抄 [paperless-ngx 的 consume folder](https://docs.paperless-ngx.com/setup/)；流水线形状抄 [beets importer](https://beets.readthedocs.io/en/latest/dev/importer.html) 的显式分段 |
| 「跑到哪个环节 / 有没有挂掉」 | — | 一个 job 行带 `stage` / `status` / `attempts` / `heartbeat_at`，这个问题就是一条 SQL |

### ⚠️ 一处没有先例的设计

「**SQLite 权威、磁盘文件是确定性投影**」在开源里找不到同款。最接近的是 [SiYuan](https://github.com/siyuan-note/siyuan)，但它是**反向**的：`.sy` 文件是真相，SQLite 只是异步重建的二级索引。Actual Budget 是 SQLite 权威但**不产生文件投影**；Joplin 是 SQLite 权威、同步时序列化成文件。

结论：这个设计要保留（指针必须稳定），但要接受它是自创的，并把「投影只读 + checksum + 手改即新 revision 导入」写成硬约束。

## 三、ASR

| 用途 | 候选 | 结论 |
|---|---|---|
| Final 精转（40 分钟中英混合） | **FunASR**（Paraformer-zh / FunASR-Nano：中英双语、热词、时间戳、OpenAI 兼容 HTTP 服务 + MCP server）、SenseVoice（234M，CPU 友好，带情感/事件）、WhisperX（词级对齐 + pyannote 说话人分离，但英文更强） | **FunASR 做 Final**。热词是刚需（术语、人名、项目名），Whisper 只有 `initial_prompt` 这种弱条件。WhisperX 只在英文占比高时才考虑 |
| 流式（Provisional） | **sherpa-onnx**（Apache-2.0，原生流式 + 热词 + **有 Node bindings**，无 PyTorch）、RealtimeSTT、WhisperLiveKit（UFAL 流式的活跃分支）、WhisperLive | **sherpa-onnx**：唯一同时给到 Apache-2.0 + Node 绑定 + 真流式 + 热词的选项 |
| 两阶段 | FunASR 官方 2pass、RealtimeSTT 的「快速假设 + 权威重解码」 | **抄这个模式**：先出快速假设喂 UI，结束后来一次权威重解码作为 Final revision |
| 不要碰 | insanely-fast-whisper（2024 后停更） | — |

## 四、语音 → 笔记/需求 的整链产品

- **[AudioNotes](https://github.com/harry0703/AudioNotes)**（MIT，Python）：本地 FunASR 转写 → Ollama（qwen）→ 结构化 Markdown + 对话；带领域热词。**最接近我们定位的开源实现**，但它是 Chainlit Python 应用，不能嵌入，只能抄它的本地优先接线方式。
- Blinko（MIT，TS/Tauri，AI 笔记）、memos（MIT，Go）：是笔记存储，不是语音流水线。
- Voicenotes：闭源商业产品。

### ⚠️ 第二处没有先例的设计

没有开源项目做「**一段长转写 → 拆成多个离散条目，且每个条目带 span 指针指回原文**」。AudioNotes 产出一份笔记，Blinko/memos 是笔记库。

结论：**这就是本产品真正的核心**。拆分与溯源（ADR-0004 的混合锚点）没有可抄的对象，只能自己造——也正因如此，它值得先在地图上验证，而不是先写代码。

## 五、Agent 编排

仍在 Pi（`pi-agent-core`）上。但下列模式值得偷：

- **LangGraph.js**：checkpointer、time-travel、HITL interrupt —— 最好的「崩溃后从中间恢复」参考
- **Trigger.dev / Inngest AgentKit**：durable step 边界（把每步输出落盘，崩溃后从断点续）
- **Mastra**：`DurableStepIds` 这种显式命名，正好是「agent 跑到哪个环节」的 UI 所需

不采用：Inngest / Trigger.dev 的基础设施（要 Postgres，且假设常驻 runtime），OpenAI Agents SDK（Pi 无 server 模式）。Pi 的 `Agent` 是内存对象，checkpoint 行必须由我们自己写进 SQLite。

## 六、RAG / 知识库

- **[sqlite-vec](https://github.com/asg017/sqlite-vec)**：向量存在同一个 SQLite 文件的 `vec0` 表里（MIT/Apache-2.0，pre-v1 有 breaking change；`npm install sqlite-vec`）
- **FTS5 混合检索**：BM25 + KNN
- **[sqlite-lembed](https://github.com/asg017/sqlite-lembed)**：本地 `.gguf` embedding，**不需要 Python 服务** —— 正好解掉「本机没有 embedding 模型」这个卡点
- 不采用：AnythingLLM / RAGFlow / Dify（完整平台，Docker + Python + 自带 DB/UI，单人场景过重）；Morphik 是 BSL 不是开源；LanceDB/Chroma 会打破「一个文件即全部真相」

## 七、需求调研 Agent

- **[dzhng/deep-research](https://github.com/dzhng/deep-research)**（TypeScript，MIT）：迭代式 breadth/depth 循环（Firecrawl 搜索 + OpenAI 兼容 LLM）。**和我们的技术栈一致，最小可抄**
- GPT Researcher（Apache-2.0）：planner 生成问题 → 并行爬取 agent → 汇总并追踪来源 → 出报告。有 GitHub MCP server 示例
- Stanford STORM（MIT）：多视角 → 模拟专家对话 → 带引用的大纲/文章

结论：抄 **dzhng/deep-research 的 TS 循环** + GPT Researcher 的「planner → 并行搜索 → 引用」形状；「去 GitHub 找现成方案」这一步用 **GitHub MCP tool** 实现，而不是接一整个项目。没有开源项目专门做「给一份需求文档，去搜索现成方案并写结论」——这段组装是我们的。
