# idearelay — MVP 实现 spec

> 这是 wayfinder 地图（issue #1）的终点产物，**快进产出**：把地图上尚未逐张 grill 的决策，按已锁定的 ADR 与选型调研给出的推荐答案定死，汇总成实现 agent 能直接动手的规格。
> 未经过你本人 grill 的那部分集中在 §17「快进假设」，**那里每一项都是可以推翻的**；推翻时走新 ADR，不要就地改。
>
> 术语一律用 `CONTEXT.md` 里的词，不要同义词漂移。

---

## 0. 给实现 agent：怎么用这份 spec

### 0.1 阅读顺序

1. `CONTEXT.md` —— 词汇表（**必须用这里的词**）
2. `docs/adr/0001`–`0009` —— 已锁定的架构决策，是这份 spec 的依据
3. `docs/research/stack-survey.md` —— 每模块可以抄哪个开源项目
4. **本文件** —— 要动手的规格
5. `docs/wayfinder/handoff-prompt.md` —— 已查实的硬事实（Pi SDK / Jev / Laya / ASR / iOS）

### 0.2 开发纪律

- **一次做一条垂直切片**（§18），每条都要能单独跑起来验证。
- **先跑通端到端最窄路径**（丢一个音频进去 → 出文字 → 落盘 → 能看），再横向加功能。
- 所有 Provider 通过**接口**使用，业务层不认识任何具体实现（ADR-0009）。
- SQLite 行是真相，文件是投影，**投影只读**（ADR-0002）。

### 0.3 派发子 agent 时的工具暴露原则（**硬性**）

> 这条是所有者明确要求的：**不要把工具全量暴露给子 agent。**

- 派发子 agent 时，**只在它的指令里点名它需要调用的那一个 / 少数几个工具**（例如「用 `mcp__xcodebuildmcp__build_sim` 编译」「用 `WebSearch` 查 X」），不要让它带着整套工具集去自己挑。
- 本项目的 `xcodebuildmcp`（74 个工具）已配 `defer_loading: true`：默认不进上下文，需要时用 `ToolSearch` 精准取用。**保持这个设置**。
- 子 agent 的 prompt 里写明：**你只被允许使用 X、Y 两个工具**；需要别的就返回「需要工具 Z」而不是自行扩大权限。
- 这条与 ADR-0006（执行器最小权限）是同一精神，只是作用在「派发」这一层。

---

## 1. 目标与非目标

### 1.1 MVP 要交付的（用户视角的端到端闭环）

1. 手机上**锁屏录 40 分钟**边走边讲，音频**可靠回传**到工作站（断网可续、进程被杀可续）。
2. 工作站把音频变成**两个 revision 的 Transcript**（Provisional 流式 + Final 精转），并落成 SQLite + 文件投影。
3. 每份 Transcript 自动**总结 + 打标 + 分类**；系统只把**没把握**的推进 **Inbox** 给人处理。
4. 属于需求的段落被**拆成多个 `Requirement`**，每个都带**混合锚点**指回原文（上下文不丢）。
5. 每个 `Requirement` 可触发 **WorkflowRun**：RAG 补背景 → 找现成开源方案 → 不成则调 to-PRD 式 skill 补齐。（MVP 做到「跑通并落 Deliverable」，执行器可先 dry-run。）
6. 首页是 **Inbox**，不是录音列表。

### 1.2 明确不做（Out of scope，见地图 #1）

- 小程序 / PWA 作为录音端；Rust 实现；Google Drive 或任何云端作为真相源；多用户 / 计费 / 云端多租户；自研向量库；端侧 STT。

---

## 2. 系统拓扑

```
┌─────────────┐        Tailscale/WireGuard (端到端加密)        ┌──────────────────────────────┐
│  iPhone     │ ───────────────────────────────────────────▶ │  工作站 Hub (Node 常驻进程)     │
│  (原生 App) │   HTTPS + TUS 断点续传上传音频                  │  ── 唯一真相源 ──              │
│             │ ◀─────────────────────────────────────────── │  SQLite (权威) + 文件 (投影)    │
│  录音/队列   │   Inbox / Requirement / 投影 的只读拉取        │  队列 · 流水线 · Pi agent · API │
└─────────────┘                                              └──────────────┬───────────────┘
                                                                             │ 单向镜像 (可选)
                                                                             ▼
                                                          Google Drive / S3 / WebDAV / R2 (SyncAdapter)
```

- **Hub 是唯一写入规范数据的地方**（ADR-0001）。云端（阿里云等）只允许作为 `Relay`：暂存、转发、带 TTL 删除，**永不持有第二个真相源**。
- 手机经 Tailscale 直连工作站，无需公网 IP；HTTPS 用 `tailscale cert` 签出的 `https://<machine>.<tailnet>.ts.net`（裸 IP + HTTP 不是 secure context）。
- 工作站关机时手机进**发送队列**，联网后重传。

---

## 3. 技术栈（锁定）

| 层 | 选型 | 依据 |
|---|---|---|
| Hub 语言 | **TypeScript / Node** | ADR-0003（Pi SDK 只有 TS、无 server 模式） |
| Hub 骨架 | 参照 **Karakeep**：API 进程 + SQLite + 内置队列 + 独立 worker | stack-survey §二 |
| DB | **SQLite**（`better-sqlite3` + Drizzle） | ADR-0002 |
| 队列 | **自建 job 表**：抄 liteque 的原子 claim + 幂等入队、vardiya 的心跳 / stall reclaim / 死信 | stack-survey §二（Node 无 SQLite 后端的 durable execution 库） |
| 文件监听 | **chokidar** + 原子写（`.tmp` → `mv`）；consume folder 形状抄 paperless-ngx | stack-survey §二 |
| 流式 ASR | **sherpa-onnx**（Apache-2.0、Node 绑定、真流式、热词） | stack-survey §三 |
| Final 精转 | **FunASR**（Paraformer-zh，中英双语、热词、时间戳、OpenAI 兼容 HTTP 服务） | stack-survey §三 |
| 决策层 | **Jev**（首个实现，云端）→ **Laya**（自托管可替换） | ADR-0005 |
| Agent 引擎 | **Pi** `@earendil-works/pi-agent-core` v0.80.7（进程内） | ADR-0003 |
| RAG | **sqlite-vec**（同库向量）+ **FTS5**（BM25）混合；embedding 用 **sqlite-lembed**（本地 `.gguf`，无 Python） | stack-survey §六 |
| 调研 agent | 抄 **dzhng/deep-research** 的 TS breadth/depth 循环 + GitHub MCP tool | stack-survey §七 |
| 手机端 | **iOS 原生**（SwiftUI） | ADR-0008 |
| 手机上传 | **tus**：`TUSKit` + `@tus/server` + `@tus/file-store` | stack-survey §一 |
| 手机本地存储 | **SwiftData** | ADR-0008 后果（队列 + 上传状态持久化） |
| 明确不用 | 本地优先同步框架全家桶、Syncthing、端侧 STT、AnythingLLM/RAGFlow/Dify/Chromi、嵌入 Tailscale SDK | stack-survey |

---

## 4. 仓库与目录结构

```
/
├── AGENTS.md                     # skill 配置
├── CONTEXT.md                    # 词汇表
├── .mcp.json                     # 项目级 MCP：xcodebuildmcp (defer_loading)
├── .codebuddy/settings.json      # 项目级插件：swift-lsp
├── docs/
│   ├── adr/                      # 0001–0009
│   ├── agents/                   # issue-tracker / triage-labels / domain
│   ├── research/stack-survey.md
│   ├── wayfinder/handoff-prompt.md
│   └── spec/mvp-implementation.md   # 本文件
├── packages/
│   └── contracts/                # 共享 TS 类型：Provider 接口、领域类型、capability 定义
│       └── src/{domain,providers,events}.ts
├── apps/
│   ├── hub/                      # Node 常驻进程
│   │   ├── src/
│   │   │   ├── index.ts          # 启动：config → db → queue → watcher → http
│   │   │   ├── config/           # Provider 注册表、凭证来源（env）
│   │   │   ├── db/               # schema、migrations、repo
│   │   │   ├── queue/            # job 表、worker loop、心跳、死信
│   │   │   ├── watcher/          # consume folder（chokidar）
│   │   │   ├── pipeline/         # asr → summarize → classify → split
│   │   │   ├── workflows/        # WorkflowSpec/Run/Stage；Pi agent 驱动
│   │   │   ├── providers/        # asr/ model/ decision/ storage/ sync/ rag/ executor/
│   │   │   ├── projections/      # SQLite → 文件（确定性、带 checksum）
│   │   │   ├── events/           # append-only events + 物化投影
│   │   │   └── http/             # 给手机端的 API + tus 端点
│   │   └── package.json
│   └── ios/
│       └── IdeaRelay.xcodeproj
│           └── IdeaRelay/
│               ├── App/          # 入口、依赖装配
│               ├── Recorder/     # AVAudioSession + AVAudioRecorder + 后台模式
│               ├── Uploader/     # TUSKit + 断点续传 + 队列
│               ├── Inbox/        # SwiftUI 列表 + 动作
│               ├── Store/        # SwiftData：录音队列、上传状态
│               ├── Networking/   # URLSession + tailnet hostname
│               └── Settings/     # ASR provider / 权限 / 同步配置
└── data/                         # 运行时数据（gitignore）
    ├── idea-relay.db
    ├── recordings/<recording_id>/audio.m4a
    ├── requirements/<req_id>-<slug>.md
    ├── deliverables/<run_id>/…
    └── inbox/                    # consume folder（手机上传落点）
```

---

## 5. 数据模型（SQLite）

> 原则：**行是真相，文件是投影**。所有表带 `created_at`。凭证**不进库**（走环境变量）。

### 5.1 录音与转写

```sql
recordings (
  id TEXT PK,                 -- uuid
  created_at INTEGER, source_device TEXT,
  duration_ms INTEGER, sample_rate INTEGER, channels INTEGER,
  audio_path TEXT, audio_checksum TEXT,
  status TEXT                 -- queued|received|transcribing|ready|failed
)

transcript_revisions (
  id TEXT PK, recording_id TEXT FK,
  kind TEXT,                  -- 'provisional' | 'final'
  provider_id TEXT, model TEXT, language_hints TEXT,
  is_current INTEGER,         -- 同一 kind 只有一个 current
  created_at INTEGER
)

segments (
  id TEXT PK, revision_id TEXT FK,
  idx INTEGER, start_ms INTEGER, end_ms INTEGER,
  text TEXT, speaker TEXT, confidence REAL
)
```

### 5.2 需求与溯源（ADR-0004 混合锚点）

```sql
requirements (
  id TEXT PK, title TEXT, body_path TEXT,   -- 投影文件路径
  status TEXT,              -- draft|open|running|done|rejected
  created_at INTEGER, source_revision_id TEXT FK
)

requirement_source_refs (
  requirement_id TEXT FK,
  recording_id TEXT,            -- 主锚点
  start_ms INTEGER, end_ms INTEGER,
  char_start INTEGER, char_end INTEGER,   -- 辅助
  asr_revision_id TEXT,         -- 生成时的 revision
  quote_snippet TEXT            -- 自解释快照
)
```

### 5.3 Inbox 与决策审计

```sql
inbox_items (
  id TEXT PK, kind TEXT,        -- requirement|idea|log|task|reference|question|unknown
  subject_type TEXT, subject_id TEXT,
  payload_json TEXT,            -- 供 UI 渲染的结构化内容
  confidence REAL,              -- 决策层给的校准概率
  abstained INTEGER,
  status TEXT,                  -- pending|accepted|rejected|rerouted
  resolution_json TEXT, created_at INTEGER, resolved_at INTEGER
)

decisions (                     -- 每次 DecisionProvider 调用的审计
  id TEXT PK, subject_type TEXT, subject_id TEXT,
  primitive TEXT,               -- choice|score|noul
  question TEXT, options_json TEXT,
  answer_json TEXT, confidence REAL, certainty TEXT,
  provider TEXT, model_version TEXT, created_at INTEGER
)
```

### 5.4 工作流

```sql
workflow_specs (id TEXT PK, name TEXT, definition_json TEXT, enabled INTEGER, schedule TEXT)
workflow_runs (
  id TEXT PK, spec_id TEXT FK, subject_type TEXT, subject_id TEXT,
  status TEXT,                  -- pending|running|succeeded|failed|rolled_back
  grant_json TEXT,              -- run 级授权（ADR-0006）
  workspace_path TEXT, created_at INTEGER, finished_at INTEGER
)
run_stages (id TEXT PK, run_id TEXT FK, name TEXT, status TEXT,
            started_at INTEGER, ended_at INTEGER, detail_json TEXT)
```

### 5.5 队列（自建，stack-survey §二）

```sql
jobs (
  id TEXT PK, kind TEXT, payload_json TEXT,
  status TEXT,                  -- pending|claimed|succeeded|failed|dead
  attempts INTEGER, max_attempts INTEGER, run_at INTEGER,
  locked_by TEXT, locked_at INTEGER, heartbeat_at INTEGER,
  last_error TEXT, idempotency_key TEXT UNIQUE,   -- 幂等入队
  created_at INTEGER, finished_at INTEGER
)
```

### 5.6 事件 seam（append-only）

```sql
events (
  id INTEGER PK AUTOINCREMENT,
  aggregate_type TEXT, aggregate_id TEXT,
  seq INTEGER,                  -- 每 aggregate 单调递增
  type TEXT, payload_json TEXT, created_at INTEGER,
  UNIQUE(aggregate_type, aggregate_id, seq)
)
```

### 5.7 知识库 / 产物 / Provider

```sql
corpora (id TEXT PK, name TEXT, kind TEXT, config_json TEXT)
corpus_docs (id TEXT PK, corpus_id TEXT FK, path TEXT, checksum TEXT, mime TEXT, indexed_at INTEGER)
artifacts (id TEXT PK, run_id TEXT FK, kind TEXT, path TEXT, checksum TEXT, created_at INTEGER)
providers (id TEXT PK, kind TEXT, name TEXT, config_json TEXT, capabilities_json TEXT, enabled INTEGER)
```

### 5.8 文件投影规则（确定性，ADR-0002）

- 每个投影文件旁写一个 `.sha256`，并登记进 `events`（`type = projection.written`）。
- 投影**只读**：Hub 从不读回投影做业务判断。
- **手改检测**：Hub 定期比对 checksum；不一致 → 作为**新 revision 导入**（`events.type = file.manually_edited`），**绝不静默合并**。
- 命名必须确定性（`requirements/<id>-<slug>.md`，slug 由 id + 稳定规则生成），否则重建会产生 diff 噪声。

---

## 6. 事件 seam

- **写入**：所有状态变化先写 `events`（同事务或同批），再由投影器物化到表 / 文件。
- **实时**：进程内 `EventEmitter` 供 HTTP 层做 SSE，推给手机端（只读）。
- **手机增量拉取**：形状抄 WatermelonDB —— `GET /changes?since=<lastPulledAt>` 返回 `{ changes, deletions(墓碑), timestamp }`。
- **可观测**：一个 run 的「跑到哪、有没有挂」= 一条 SQL：

```sql
SELECT s.name, s.status, s.started_at, s.ended_at
FROM run_stages s WHERE s.run_id = ? ORDER BY s.started_at;
-- 心跳超时判定挂掉：
--   workflow_runs.status='running' AND max(heartbeat) < now-120s
```

> Pi **没有专用 error 事件**（ADR-0003）：失败只能从 `tool_execution_end` 的 `isError` 与**心跳超时**推断。

---

## 7. Provider 契约（7 个）

> 全部定义在 `packages/contracts`。**异步、可序列化**（ADR-0009）。注册表登记：名称 / 类型 / 凭证来源 / capability。

### 7.1 ASRProvider（ADR-0007 两阶段）

```ts
interface AsrCapabilities {
  streaming: boolean;
  maxSessionDurationMs: number | null;   // DashScope 实时有会话上限
  hotwords: boolean;
  diarization: boolean;
  languages: string[];
  revisions: Array<'provisional' | 'final'>;
  resume: boolean;                       // 断线能否续传（多数为 false）
}

interface AsrProvider {
  readonly id: string;
  readonly capabilities: AsrCapabilities;

  /** Provisional：流式临时文本，UI 句末原地替换 */
  stream?(audio: AsyncIterable<AudioChunk>, opts: StreamOpts): AsyncIterable<PartialSegment>;

  /** Final：整段精转，落成 is_current 的 final revision */
  transcribe(audio: AudioRef, opts: TranscribeOpts): Promise<TranscriptResult>;
}
```

- 前端**只根据 `capabilities` 显示/隐藏选项**（例如无 `hotwords` 就不显示热词框）。
- MVP 首个实现：`capabilities.streaming = false`（先只做 Final，占位 Provisional）。

### 7.2 ModelProvider

```ts
interface ModelProvider {
  readonly id: string;
  models(): ModelInfo[];                       // 含能力：上下文长度、是否支持结构化输出
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
```

- 自定义 OpenAI 兼容端点（远程自建模型）也是它的一个实现。

### 7.3 DecisionProvider（ADR-0005 三原语）

```ts
type Primitive = 'choice' | 'score' | 'noul';

interface DecisionRequest {
  primitive: Primitive;
  question: string;
  options?: string[];                          // choice：≤20 项（Laya 约束）
  scale?: { min: number; max: number; labels?: string[] };  // score
  thresholdOverrides?: {                       // per-call 覆盖默认阈值
    high?: number; low?: number; noulBand?: [number, number];
  };
}

interface DecisionResult {
  primitive: Primitive;
  choice?: string; probabilities?: Record<string, number>;
  score?: number;
  probability?: number;                        // noul
  confidence: number;                          // 校准概率
  certainty: 'high' | 'medium' | 'low';
  abstained: boolean;                          // 一等结果，不是低置信的同义词
  modelVersion: string;
}

interface DecisionProvider {
  readonly id: string;
  decide(req: DecisionRequest): Promise<DecisionResult>;
}
```

- Jev 首个实现：`POST https://api.typesafe.ai/v1/systemone`，`TYPESAFE_API_KEY`，**model 钉版本**。默认阈值 `0.8 / 0.5 / [0.35,0.65]` 官方未校准 → **必须 per-call 可覆盖**。
- Laya 可替换实现（Apache-2.0 自托管）：零样本约 0.35，需先攒标注数据 specialize。

### 7.4 StorageProvider（规范数据的持久化底层）

```ts
interface StorageProvider {
  readonly id: string;
  readonly capabilities: { vector: boolean; fullText: boolean; airGapped: boolean };
  put(blob: BlobRef): Promise<void>;
  get(key: string): Promise<BlobRef | null>;
}
```

- 首个实现 = 本地 `data/` + SQLite 文件。

### 7.5 SyncProvider（**单向镜像**，ADR-0002 语义）

```ts
interface SyncProvider {
  readonly id: string;
  readonly capabilities: { direction: 'push'; ttlDays: number | null };
  push(target: SyncTarget, files: ProjectedFile[]): Promise<SyncResult>;
}
```

- 不参与冲突裁决。Google Drive / S3 / WebDAV / R2 各是一个实现。
- **MVP 可以先只写接口 + 一个本地「dry-run」实现**。

### 7.6 RAGProvider（ADR-0009；stack-survey §六）

```ts
interface RagProvider {
  readonly id: string;
  readonly capabilities: { hybrid: boolean; embeddingModel: string | null };
  index(docs: CorpusDoc[]): Promise<void>;
  retrieve(query: string, opts: RetrieveOpts): Promise<RagHit[]>;  // BM25 + KNN 融合
}
```

- 首个实现：`sqlite-vec` + FTS5，embedding 走 `sqlite-lembed`（本地 `.gguf`）。
- 可替换实现：把本机已有的 `codebase-memory-mcp` / Obsidian vault 包一层。

### 7.7 ExecutorProvider（ADR-0006）

```ts
interface ExecutorJob {
  id: string; requirementId: string;
  workspacePath: string;                       // 每 run 独立目录
  toolWhitelist: string[];                     // 显式允许的工具/命令
  readAllow: string[];                         // 可读的 Corpus 路径白名单
  prompt: string; deliverablePath: string;
}

interface ExecutorProvider {
  readonly id: string;
  readonly capabilities: { sandboxed: boolean; toolWhitelist: boolean; rollback: boolean };
  submit(job: ExecutorJob): Promise<ExecutorHandle>;
  status(h: ExecutorHandle): Promise<ExecutorStatus>;   // stage / 是否挂掉
  rollback(h: ExecutorHandle): Promise<void>;            // 丢弃工作目录 + 审计外部副作用
}
```

- 交接 = **`ExecutorJob` 文件 + 监听目录的拉取模型**（Pi 无 RPC，ADR-0003/0006），不是推送。
- 凭证**不进 agent**，由宿主代理调用。
- **MVP：先只定义协议 + 一个 dry-run 实现**（把 job 写出来、模拟回一个 Deliverable），不真跑任意代码。

---

## 8. 工作流引擎

### 8.1 WorkflowSpec（模板）

```jsonc
{
  "name": "requirement-research",
  "stages": [
    { "name": "rag-context",  "kind": "tool", "tool": "rag.retrieve" },
    { "name": "scan-oss",     "kind": "agent", "tools": ["github.search"], "promptTemplate": "scan-oss" },
    { "name": "enrich",       "kind": "agent", "tools": ["rag.retrieve","web.search"], "promptTemplate": "to-prd" },
    { "name": "write",        "kind": "tool", "tool": "projection.writeDeliverable" }
  ],
  "gate": { "autoRunWhen": { "confidence_min": 0.8, "abstained": false } }
}
```

- 阶段顺序 / 工具 / 提示词模板都在 `definition_json` 里；支持「默认开启 / 定时开启」（`enabled` / `schedule`）。
- 手机端可覆盖**提示词模板**（模板存 Hub，手机只编辑文本）。

### 8.2 驱动 Pi

- 用 `new Agent({ initialState: { systemPrompt, model, tools, messages } })` → `agent.subscribe(e => mapToStage(e))` → `await agent.prompt(...)`。
- **事件 → Stage 映射**：`agent_start/end`、`turn_start/end`、`tool_execution_start/update/end`（含 `toolName`/`args`/`result`/`isError`）。
- **没有专用 error 事件** → Stage 失败 = `isError` 或**心跳超时**。
- **checkpoint**：用 `AgentHarness` + JSONL session 落盘到 run 工作目录，崩溃后从最后一个成功 stage 恢复。

---

## 9. 闸门与 Inbox

- 每段内容经 DecisionProvider 回答一组问题（choice/score/noul）→ 得到 `kind` + `confidence`。
- **闸门**：`confidence ≥ 0.8` 且 `!abstained` → 自动推进；否则 → 写 `inbox_items`。
- **顶层类目（≤7，远低于 Laya 的 20 上限）**：`requirement` / `idea` / `log` / `task` / `reference` / `question` / `unknown`。
- **Inbox 首屏**（PRD 目标形态）：分组显示「已总结 N」「识别 N 个需求」「N 个普通想法」「N 个日志」「N 个疑似任务」；人只处理系统没把握的部分。
- **人工修正回流**：每次 accept/reject/reroute 记成 `(文本, 标签)` 对，写入标注表，供后续 specialize Laya。
- **阈值必须 per-call 可覆盖**（Jev 默认未校准）。

---

## 10. 需求拆分与溯源

- 输入：一份 Final Transcript。输出：N 个 `Requirement`，各带若干 `SourceRef`。
- **共享背景不丢**：40 分钟里分别聊了 App / RAG / DB / UI，拆出 4 份需求，各自持有自己的 `[start_ms, end_ms]`，但都指向同一 `recording_id`。
- **重跑 ASR 后**：因主锚点是时间戳，旧需求可**自动重新对齐**（不是数据丢失）。
- 需求文档是投影（`requirements/<id>-<slug>.md`），正文含 `quote_snippet` 便于人读时自解释。
- **这是本项目唯一没有开源先例的部分**（stack-survey §四）——优先保证它正确，再谈其它。

---

## 11. Hub 运行时

- **启动顺序**：load config → 注册 providers → open db + migrate → 起 worker loop → 起 watcher → 起 HTTP。
- **watcher**：chokidar 监听 `data/inbox/`，`awaitWriteFinish` + 原子写去重（手机上传先落 `.part` 再 `mv`）。
- **worker loop**：从 `jobs` 原子 claim（`UPDATE … WHERE status='pending' AND run_at<=now LIMIT 1 RETURNING …`），跑完写 `heartbeat_at`；超时未心跳 → stall reclaim；超过 `max_attempts` → 死信。
- **崩溃恢复**：所有长任务都以「一个 job 行 + 一个 run 目录 + JSONL session」为 checkpoint；重启后扫描 `running` 且心跳超时的 run，从最后成功 stage 续。
- **HTTP API（给手机）**：`POST /upload`（tus）· `GET /recordings` · `GET /inbox` · `POST /inbox/:id/{accept,reject,reroute}` · `GET /requirements` · `GET /changes?since=` · `GET /runs/:id/stages`。

---

## 12. iOS App

### 12.1 模块

| 模块 | 职责 | 关键点 |
|---|---|---|
| `Recorder` | 长时录音 | `AVAudioSession` `.record`（或 `.playAndRecord`）+ `UIBackgroundModes: audio`；写**单个连续 `.m4a`**，不要在录制时切段（stack-survey §一） |
| `Uploader` | 断点续传上传 | `TUSKit`；**持久化 upload URL**，App 被杀后可续；联网即从队列重传 |
| `Store` | 本地持久化 | SwiftData：录音队列、上传状态、待处理项缓存 |
| `Inbox` | 首屏 | SwiftUI 列表；动作 accept/reject/reroute/转发执行 |
| `Networking` | 与 Hub 通信 | `URLSession` + `https://<machine>.<tailnet>.ts.net`（**不是**裸 IP/HTTP） |
| `Settings` | 配置 | ASR provider 选项（按 capability 显示）、权限、同步目标 |

### 12.2 硬约束

- **锁屏录音**靠 `UIBackgroundModes: audio` + `AVAudioSession`（ADR-0008）。来电 / 闹钟会中断；内存压力下可能被终止 → **分段 checkpoint**（每写一段 flush 元数据）。
- **上传在 app 进程内做**：iOS 后台 `URLSession` + VPN 组合未文档化（ADR-0008 后果）。
- **免费 Apple ID 签名风险未验证**：personal team 是否允许 audio 后台模式 + 麦克风权限，Apple 文档未说明。**这是 #2 spike 要实测的**，若不支持，$99/年 是唯一解。
- 界面设计参照飞书妙记：转写句末原地替换、可回看原文。

### 12.3 开发时用哪些 skill（见 §14）

---

## 13. 一次录音的完整数据流

```
1. iPhone 录音（后台，单文件 .m4a）
2. 结束 → 入本地队列 → TUS 上传到 Hub 的 /upload（断点续传）
3. Hub 收到 → data/inbox/<id>.part → 原子 mv → jobs 入队 (kind=transcribe)
4. worker: ASR Final 精转 → 写 transcript_revisions(kind=final) + segments
5. 投影：recordings/<id>/transcript.final.md (+ .sha256)
6. jobs 入队 (kind=enrich): 总结 → DecisionProvider 分类/打标 → 拆 Requirement(带 SourceRef)
7. 闸门判定：高置信自动跑 workflow；低置信/abstain → inbox_items
8. 手机拉 /changes → Inbox 首屏呈现；人处理 → 回写 → 事件 → 投影
9. (可选) requirement workflow → RAG/调研/执行器 → deliverables/<run_id>/…
10. (可选) SyncAdapter 单向镜像到 Drive/S3
```

---

## 14. 开发工作流：如何调用已装好的 Apple skill

> 本机已装 20 个 iOS/Swift skill（user 级）。**按阶段调用，不要一次全上。**

| 开发阶段 | 调用哪个 skill | 用途 |
|---|---|---|
| 搭工程 / 定架构 | `swift-architecture` | 状态所有权、模块边界、MV/MVVM 取舍 |
| 写录音模块 | `swift-concurrency` + `background-processing` | actor 隔离、`Task`、BGTaskScheduler / 后台 URLSession |
| 后台上传 | `ios-networking` | URLSession、后台传输、重试、中间件 |
| 本地存储 | `swiftdata` | `@Model`、`ModelContainer`、`@ModelActor` 后台写 |
| UI（Inbox） | `swiftui-patterns` → `swiftui-navigation` / `swiftui-layout-components` | 视图组合 → 导航 → 布局 |
| 交互动效 | `swiftui-animation` / `swiftui-gestures` | 列表动效、手势 |
| 长列表性能 | `swiftui-performance` / `swiftui-ui-patterns` | Inbox 滚动、渲染 |
| 无障碍 / 双语 | `ios-accessibility` / `ios-localization` | VoiceOver、String Catalog、中英对照 |
| 凭证 | `swift-security` | Keychain 存 token / 证书 |
| 测试 | `swift-testing` | `@Test` / `#expect` / 参数化 |
| 跑模拟器 / 自动化 | `ios-simulator` / `ios-debugger-agent` | `simctl`、XcodeBuildMCP |
| 崩溃 / 性能 | `debugging-instruments` | LLDB、Instruments、内存图 |
| 代码规范 | `swift-api-design-guidelines` | 命名、label、文档 |

**工具**（项目级，仅在本项目生效）：

- `xcodebuildmcp`（MCP，`.mcp.json`，`defer_loading:true`）—— build / run / debug / simulator。
- `swift-lsp`（插件，`.codebuddy/settings.json`）—— `.swift` 代码智能（需新会话或 `/reload-plugins`）。

**缺口**：没有 AVFoundation / 音频录制类 skill —— 锁屏长录音要**直接查 Apple 官方文档**，不要指望 skill 兜底。

---

## 15. 快进假设（未决项的默认答案 —— 可推翻）

> 以下每项原本是地图上的一张 ticket，本 spec 用推荐答案定死。**推翻时走新 ADR。**

| 原 ticket | 采用的默认答案 | 风险 |
|---|---|---|
| ASRProvider 能力契约与候选实现 | §7.1 的 capability 清单；MVP 先只做 Final，Provisional 占位 | 未做实机流式验证 |
| Pi agent 集成与 stage 事件映射 | §8.2；心跳超时判挂 | Pi 无 error 事件，误判风险 |
| SQLite schema / 事件 seam / 文件投影 | §5 / §6 / §5.8 | 「文件是投影」无开源先例，须严守只读 + checksum |
| Inbox 分类体系与阈值 | §9 的 7 类 + 0.8 阈值 | Jev 阈值未在你的数据上校准 |
| 执行器交付契约 | §7.7 + §8.1；MVP 只 dry-run | 真实沙箱实现推迟 |
| 需求拆分与 RAG 的 WorkflowSpec 形态 | §8.1 | 提示词模板未实测 |
| Inbox 首屏原型 | PRD 目标形态（分组） | 未经视觉原型验证 |
| 技术选型锁定 | §3 | Karakeep 骨架 + 自建队列需自证 |
| 同步 adapter 语义 | **单向镜像**（§7.5），MVP 可 dry-run | 双向合并明确排除 |
| RAG 具体适配器 | sqlite-vec + FTS5 + sqlite-lembed | 本机暂无 embedding 模型，需先落一个 `.gguf` |
| 中英对照形态 | **转写层直接出双语**（ADR 未覆盖，此处定） | 成本/延迟翻倍 |
| 定时/默认开启策略 | WorkflowSpec 的 `enabled`/`schedule` 字段；Hub 常驻 | 未定义守护方式 |
| 权限设置界面 | Settings 模块，按 capability 渲染 | 未原型 |
| 声音来源选择 / 手机导出分享 | iOS 侧后续切片 | 未设计 |
| 开源发布形态 | **monorepo**（apps/hub + apps/ios + packages/contracts） | 未定 npm 发包方式 |
| iPhone 免费签名可行性 | **未决**，由 #2 spike 实测 | **全项目最大风险** |

---

## 16. 环境事实（本机已就绪）

- **Xcode 26.6（17F113）**：`/Applications/Xcode-26.6.0.app`，已 `xcode-select` 选中；iOS 26.5 SDK + 模拟器 SDK；Swift 6.3.3。
  - 为什么不是 27.0：**Xcode 27 要求 macOS 26.6+，本机 macOS 26.2 不满足**（Apple 官方 SDK 要求表）。
- **iOS 模拟器 runtime**：iOS 26.5 Simulator（23F77，8.52 GB）已下载安装（见交付时状态）。
- 项目级工具：`.mcp.json`（xcodebuildmcp，`defer_loading`）+ `.codebuddy/settings.json`（swift-lsp）。
- 20 个 iOS/Swift skill（user 级）。
- 其他：`xcodes`（`~/.local/bin`）、`aria2`（下载加速）、Homebrew、Node、`gh`。

---

## 17. 实现切片顺序（里程碑）

> 每条都是**可单独验证**的垂直切片。先 M0–M3（无手机也能跑），再 M4 起接手机。

- **M0 骨架**：monorepo + `packages/contracts`（7 个 Provider 接口）+ Hub 启动 + SQLite migrate + job 表 + 一个 echo worker。
- **M1 音频→文字**：consume folder 监听 → ASR Final（FunASR HTTP）→ `transcript_revisions(final)` + `segments` → 投影 `transcript.final.md`。
- **M2 总结与分类**：ModelProvider 总结；DecisionProvider 分类/打标；闸门 → `inbox_items`；投影。
- **M3 需求拆分与溯源**：拆 Requirement + 写 `requirement_source_refs`（五元组）→ 投影 md；ASR 重跑后的重对齐测试。
- **M4 手机录音与上传**：iOS App（Recorder + Uploader + Store）；TUS 到 Hub；断网/杀进程可续。
- **M5 工作流 run（Pi）**：WorkflowSpec/Run/Stage；Pi 事件→Stage；心跳与崩溃恢复；executor **dry-run**。
- **M6 RAG**：sqlite-vec + FTS5 + sqlite-lembed；`rag.retrieve` 接进工作流。
- **M7 同步与收尾**：SyncProvider 一个真实实现（先本地/WebDAV）；Inbox 交互完善；中英对照。

**最高优先且必须先做**：**#2 iPhone 后台录音与回传 spike** —— 它决定载体路线是否成立，且不依赖上面任何一条。

---

## 18. 验收标准

- [ ] 丢一个 40 分钟音频进 `data/inbox/`，无需人工干预产出 Final Transcript 投影文件。
- [ ] 同一段音频产生 Provisional 与 Final 两个 revision，且 Final 为 current。
- [ ] 一份 Transcript 能拆出 ≥2 个 `Requirement`，每个都能凭 `SourceRef` 定位回原文时间区间。
- [ ] 重跑 ASR 后旧 `Requirement` 能自动重对齐，不丢引用。
- [ ] 低置信 / abstain 的内容必然进 Inbox；高置信的自动推进。
- [ ] 手机锁屏录 40 分钟，联网后自动上传成功；中途断网/杀进程后能续传。
- [ ] 一个 WorkflowRun 能从手机看到「跑到哪个 Stage、有没有挂」，且崩溃后能从断点恢复。
- [ ] 执行器 dry-run 能把 `ExecutorJob` 落成文件并交回一份 Deliverable。
- [ ] 关掉所有云端 Provider（除 ASR/Decision 外），系统仍能启动、仍能读历史数据。
- [ ] 换掉任意一个 Provider 实现只需改一行注册，业务层不动。
