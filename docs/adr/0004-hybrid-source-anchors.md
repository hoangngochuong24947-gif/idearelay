---
status: accepted
---

# Requirement 的溯源用混合锚点

拆分出的 `Requirement` 不能丢失原始上下文，因此 `SourceRef` 存五元组：`recording_id` + `start_ms/end_ms`（主锚点）+ `char_range`（辅助）+ `asr_revision` + `quote_snippet`（自解释）。时间戳抗 ASR 重跑，字符偏移提供精度，快照让人读需求文档时不必跳转。

**Considered Options**

- **纯字符偏移 + asr_revision**：最精确，但换模型或修正术语重跑一遍 ASR，所有引用全部错位。
- **不用锚点、直接把原文复制进需求文档**：上下文确实不丢，但产生多处副本，无法回溯，需求文档与 Transcript 会各自漂移。
- **混合锚点**（选定）：以时间戳为主，重跑 ASR 不影响引用。

**Consequences**

- 40 分钟录音里分别聊了 App、RAG、数据库、UI 时，拆出的四份需求共享同一段背景，各自持有自己的时间区间。
- 重跑 ASR 产生新 revision 后，旧需求需要重新对齐——但因为有时间戳，这是可自动化的对齐，不是数据丢失。
