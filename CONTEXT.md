# idearelay

边走边讲的长时语音，转成文字后自动分流成需求、想法、日志与任务。这份文件是本项目的词汇表——只定义概念本身，不描述实现。

## 录音与转写

**Recording**：
一段音频资产及其元数据（时长、来源设备、麦克风/声源选择）。是时间序列的起点。
_Avoid_: 音频、录音文件、会话

**Transcript**：
一段 Recording 对应的文字结果。它不是单一文本，而是由多个 revision 组成。
_Avoid_: 转写、字幕、文档

**TranscriptRevision**：
Transcript 的一个不可变版本。有两种：**Provisional**（流式转写产生的临时文本，句末会被原地替换）与 **Final**（整段精转产生的归档文本）。
_Avoid_: 草稿、修正版、快照

**Segment**：
Transcript 中一段可寻址的时间区间，是引用与切分的最小单位。
_Avoid_: 片段、块、chunk、段落

## 需求与溯源

**Requirement**：
从一段 Transcript 中派生出来的、独立可跟进的一条需求。它是派生物，不是原文副本。
_Avoid_: 需求（太泛）、issue、ticket、任务

**SourceRef**：
Requirement 指回原始 Transcript 的锚点。混合锚点：`recording_id` + `start_ms/end_ms`（主，抗 ASR 重跑）+ `char_range`（次，提供精度）+ `asr_revision` + `quote_snippet`（让人读时自解释）。
_Avoid_: source_segment_refs（内部字段名）、引用、链接、出处

## Inbox

**InboxItem**：
系统对某段内容做出判断后、置信度不足以自动推进时，推给人处理的那一条。系统的默认姿态是「只把没把握的交给人」。
_Avoid_: 待办、通知、提醒、收件箱条目

**Confidence**：
决策模型给出的校准概率，不是模型自报的措辞。Inbox 的闸门完全建立在这个值上。
_Avoid_: 把握、确定性、score（那是三原语之一）

**Abstention**：
决策层明确表示「我不知道」的状态。它是一个一等结果，不是低置信度的同义词。
_Avoid_: 失败、跳过、unknown

## 工作流

**WorkflowSpec**：
工作流的模板定义：按什么顺序做、用哪些工具、带哪些提示词模板。
_Avoid_: 工作流、流程、pipeline、配置

**WorkflowRun**：
一个 WorkflowSpec 针对某个具体对象的一次执行实例。有状态、有授权、可回滚。
_Avoid_: 运行、job、执行、任务

**Stage**：
WorkflowRun 内部的一个可观察环节。用来回答「agent 跑到哪一步了、有没有挂掉」。
_Avoid_: 步骤、节点、step、phase

## 产出

**Artifact**：
工作流产生的任何落盘结果。
_Avoid_: 文件、产物、输出

**Deliverable**：
执行器交回的、面向人阅读的最终成果文档。
_Avoid_: 交付物、报告、结果

**ExecutorJob**：
交给执行器的一次委托，由宿主写入、被执行器拉取。是交接的载体，不是执行本身。
_Avoid_: job、任务、请求、命令

## 知识与检索

**Corpus**：
可供 agent 检索复用的知识集合（既有历史转写，也有用户主动上传的文档）。
_Avoid_: 知识库、RAG、语料、文档库

## 基础设施与协议

**Hub**：
跑在工作站上的常驻进程，是唯一写入规范数据的地方。
_Avoid_: 服务端、后端、服务器、daemon

**Relay**：
只负责暂存与转发、不解析内容、有 TTL 的云端通道。它永远不是真相源。
_Avoid_: 云端、中转、同步、存储

**SyncAdapter**：
把数据镜像到外部存储（Google Drive / S3 / WebDAV / R2）的适配器。单向镜像，不参与冲突裁决。
_Avoid_: 同步、备份、云盘

**Provider**：
一种能力的实现，通过固定接口被核心使用（ASR / Model / Decision / Storage / Sync / RAG / Executor）。Pi、Whisper、Jev、Laya、Google Drive 都只是某个 Provider 的实现。
_Avoid_: 插件、服务、backend、驱动

## 决策

**Decision**：
决策模型对一组结构化问题的回答，用三种原语表达：**choice**（从给定选项中选一个）、**score**（在有序刻度上定位）、**noul**（一个是/否判断的概率）。
_Avoid_: 分类、打标、判断、推理

---

## 歧义词对照（本项目内禁止混用）

| 日常用词 | 实际指代的多个概念 |
| --- | --- |
| 文档 | Transcript / Requirement / Corpus 里的上传件 / Deliverable |
| 需求 | 用户想要的东西 / `Requirement` 实体 |
| 工作流 | WorkflowSpec（模板）/ WorkflowRun（实例）/ Stage（环节） |
| 同步 | SyncAdapter 的单向镜像 / 双向合并 |
| agent | Pi 的 `Agent` / research 子 agent / 外部 Executor |
| Provider vs Adapter | Provider 是能力实现；Adapter 是同步目标 |
| 处理 | 分类（决策层）/ 执行（Executor） |
