---
status: accepted
---

# DecisionProvider 用 choice / score / noul 三原语

决策层协议只认识三种原语：**choice**（从给定选项中选一个，返回分布与置信度）、**score**（在有序刻度上定位）、**noul**（一个是/否判断的校准概率）。首个实现用 TypeSafe 的 Jev（`POST https://api.typesafe.ai/v1/systemone`，`TYPESAFE_API_KEY`，model 钉版本不用 `jev-latest` 别名），开源的 Laya（Apache 2.0，可自托管）作为可替换实现——两者恰好共用同一组原语，所以协议不必为任何一方妥协。

**Considered Options**

- **用 LLM 的 structured output 打标**：最省事，但 LLM 自报的 confidence 是编出来的 token，没有数学校准，而 Inbox 的全部前提（只处理没把握的）依赖校准概率。
- **直接上 Laya 零样本**：架构一步到位，但 Laya 零样本仅 ~0.35（接近随机），官方明说它是「需要 specialize 的快基础模型」。
- **Jev 优先、协议保持可替换**（选定）。

**Consequences**

- Jev 默认阈值（`confidence_high 0.8` / `confidence_low 0.5` / `noul_band [0.35, 0.65]`）**官方声明未在任何用户数据上校准**，因此必须 per-call 可覆盖。
- Jev 是闭源云端、无法自托管，与 air-gapped 目标冲突。协议层已把它隔离成一个 Provider；Laya 路线需要先攒人工修正作为标注数据再做 specialize。
- TypeSafe 官方**不发 MCP server**，市面上的 `typesafe-mcp` / `jev-agent-mcp` 均为社区第三方——用它们等于把 API key 交给陌生人，不采用。
- Laya 的 choice 在选项 >20 时精度崩塌（Banking77 上 0.425），顶层类目数受此约束。
