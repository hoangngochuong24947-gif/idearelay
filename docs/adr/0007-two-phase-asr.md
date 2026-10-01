---
status: accepted
---

# ASR 两阶段：Provisional 与 Final 是两个 revision

边录边流式转写天生不准。因此一次录音产生两类 `TranscriptRevision`：**Provisional**（流式，句末会被原地替换）与 **Final**（整段结束后精转，作为归档版本）。这正是 FunASR 官方的 2pass 模式（`2pass-online` → `2pass-offline`），也是飞书妙记一类产品的做法。MVP 只接云端（`paraformer-realtime-v2` WebSocket），但 `ASRProvider` 协议不变，本地精转之后可直接挂上。

**Considered Options**

- **纯流式、不做二次精转**：最简最省，但口误、术语、断句错误全部留在归档里——而这些文本是要喂给 agent 拆需求的。
- **纯本地自建**：完全 air-gapped，但需要先解决手机到工作站的实时链路，且流式精度较低。
- **两阶段**（选定）。

**Consequences**

- UI 必须支持「句末原地替换」的展示语义，否则临时文本会被误当成结论。
- 热词/术语纠正是质量关键（DashScope 支持 `vocabulary_id` 与即时纠错；`language_hints` 只能填一个值，中英混说靠模型自判）。
- 断线不可续传（无 session resume），端侧必须缓冲音频并依赖 Final 那一次精转兜底。
