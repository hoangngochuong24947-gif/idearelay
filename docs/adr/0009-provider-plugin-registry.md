---
status: accepted
---

# Provider 以进程内 TS 模块 + 注册表加载

核心只认识 `ASRProvider / ModelProvider / DecisionProvider / StorageProvider / SyncProvider / RAGProvider / ExecutorProvider` 这组接口；每个实现是一个进程内 TS 模块，在配置里登记（名称、类型、凭证来源、能力声明）。接口设计成异步且可序列化调用，将来要加子进程或 MCP 适配器时不必改业务层。

**Considered Options**

- **子进程 / CLI 协议**：解耦与沙箱潜力最强，但每次调用都有进程开销和一整套 IPC 协议要维护。
- **MCP server**：能直接复用生态，但 MCP 是面向 LLM 工具的协议，不适合 Storage/Sync 这类基础能力；且 stdio MCP 本质是本地子进程。
- **进程内模块 + 注册表**（选定）：Pi v0.80.7 本身没有插件系统（只有按目录约定加载的 `SKILL.md`），进程内模块是最直接可行的一层。

**Consequences**

- 换掉某个实现只需改一行登记，符合「开源后别人 fork 下来完全不经过我的服务器」。
- 能力声明（capability）是前端显示/隐藏选项的唯一依据——ASR 侧至少要有 streaming、max_session_duration、hotwords、diarization、languages、revision 这些字段。
- 凭证统一走环境变量，不进 git、不进 SQLite。
