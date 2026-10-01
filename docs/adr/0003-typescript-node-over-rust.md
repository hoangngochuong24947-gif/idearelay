---
status: accepted
---

# 全 TypeScript/Node，放弃 Rust

需求草稿最初要求用 Rust 实现工作流可观测性，但承载工作流的 Pi SDK（`@earendil-works/pi-agent-core` v0.80.7）只有 TypeScript 版本，且**没有 server 模式、没有 RPC**（`AgentTransport` 已移除），`Agent` 是纯内存对象。要驱动它就必须同进程，因此核心改为全 TypeScript/Node。

**Consequences**

- 放弃 Rust 在长驻守护进程上的内存与崩溃行为优势，改用 `AgentHarness` + JSONL session 做 checkpoint，加上显式的事件表来补偿。
- Pi 的 `tool_execution_start/update/end` 事件可直接映射成 `Stage`，但**没有专用 error 事件**——失败只能从 `isError` 结果与心跳超时推断，"有没有挂掉"必须靠超时判定。
- 若将来要把 `Hub` 换回 Rust，唯一的接缝是 Pi 的 Node 子进程边界（stdin/stdout 或 JSONL）。
