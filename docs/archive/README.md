# docs/archive — 已归档文档

本目录存放**描述已删除功能**的设计文档与调研报告。

归档原因：2026-08-26 的 commit `6ed6596 refactor(core): 极简模式` 砍掉了
Web GUI、RAG 记忆层、技能系统、MCP、审查编排、Trace 等附加层，
这些文档描述的对象已不在代码中。

**保留而非删除**的原因：其中包含真实的调研过程、方案权衡与踩坑记录，
若日后重新引入相关能力，可作为起点参考。

| 文档 | 原描述对象 | 现状 |
|------|-----------|------|
| `memory-design-survey.md` | RAG 记忆层调研 | 功能已删 |
| `记忆系统-轻量RAG-技术报告.md` | 记忆层技术实现 | 功能已删 |
| `gui-integration-plan.md` | Web GUI 集成方案 | 功能已删 |
| `realtime-rendering-design.md` | GUI 实时渲染设计 | 功能已删 |
| `anti-loop-comparison.md` | 防循环机制对比 | 对应逻辑已删 |
| `loop-guard-redesign.md` | 防循环重设计 | 对应逻辑已删 |
| `pro-cache-optimization.md` | 推理模型缓存优化 | 对应 llm 层已删 |
| `structured-output-plan.md` | 结构化输出方案 | 对应 structured-parse 已删 |
| `architecture-improvement-plan.md` | 架构改进方案 | 部分过时 |

> ⚠️ 归档文档中的代码路径、模块名、命令均**不代表当前代码状态**。
> 当前架构请以根目录 `README.md`、`AGENTS.md`、`ARCHITECTURE.md` 为准。
