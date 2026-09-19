# ARCHITECTURE.md — 极简 CLI 的分层结构

> **当前形态：极简 CLI**（`6ed6596 refactor(core): 极简模式` 之后的实际状态）。
> 早期版本曾有「应用/运行时/模型/工具/上下文」五层结构，其中
> `src/llm`、`src/tools`、`src/context` 等自研层已在极简模式中删除。

## 分层总览

```
┌──────────────────────────────────────────────────────────┐
│ 应用交互层  src/cli  +  src/app                            │
│  TUI 渲染 · 流式输出 · 登录 · Markdown · workspace 解析     │
│  职责：把用户输入变成请求，把 Agent 过程 / 结果展示出来      │
│  不该：直接调模型、直接执行工具                             │
└───────────────┬──────────────────────────────────────────┘
                │ 调用
┌───────────────▼──────────────────────────────────────────┐
│ Agent 运行时层  src/agent                                  │
│  Pi Agent 适配 · 4 个原子工具 · 系统提示 · 输出风格         │
│  职责：Agent 怎么做事——工具调度、权限决策、错误回灌         │
└───────┬──────────────────────────┬───────────────────────┘
        │ 模型调用                  │ 工具执行
┌───────▼────────────────┐  ┌───────▼──────────────────────┐
│ 模型层（外部依赖）       │  │ 工具层  src/agent/pi-tools.ts │
│ @earendil-works/pi-ai   │  │ read_file / write_file /      │
│ DeepSeek provider       │  │ edit_file / bash              │
│ 自研 src/llm 已删除     │  │ 路径防护 + 源码目录保护        │
└────────────────────────┘  └───────────────────────────────┘

        ↕ 支撑 ↕
┌──────────────────────────────────────────────────────────┐
│ 配置层 src/config   权限层 src/permission   凭证层 src/auth │
│ 通用层 src/utils（日志 · Markdown · 文件回滚栈）             │
└──────────────────────────────────────────────────────────┘
```

## 层间关键机制位置（Debug 时先查哪层）

| 问题现象 | 先查哪层 |
|----------|----------|
| 工具调用失败 | `src/agent/pi-tools.ts` + `src/permission` 闸门 |
| 写入被拒绝 | `src/config/workspace.ts` 的 protectedRoots 判定 |
| 流式输出中断 | `src/app/chat.ts` + `src/app/viewport.ts` |
| 模型跑偏 / 重复 | `src/agent/system-prompt.ts` |
| 多轮上下文丢失 | Pi Agent 的 initialState（`src/app/assemble.ts`） |
| TUI 渲染错位 | `src/cli/app.tsx` + `src/app/markdown-lines.ts` |
| 启动即退出 | `src/cli/main.ts` 的 TTY 检测 |
| 回滚不生效 | `src/utils/rollback.ts` 的 cwd 作用域 |

## 技术栈定位

| 技术 | 层 | 作用 |
|------|----|------|
| `@earendil-works/pi-agent-core` | Agent 运行时层 | 持久化 Agent、工具调度、流式事件 |
| `@earendil-works/pi-ai` | 模型层 | DeepSeek provider 接入、流式解析 |
| `typebox` | 工具层 | 工具参数 schema 校验 |
| `ink` + `react` | 应用交互层 | 终端 TUI 渲染 |
| `chalk` | 应用交互层 | 输出可读性、状态区分 |
| `zod` | 配置层 | 运行时配置校验 |
| `tsx` | 工程 | 免构建直接跑 TS |
| `.env` / `~/.dsa/credentials.json` | 凭证层 | 密钥不入代码 |

## 模型策略

| 档位 | 模型 | 用途 | 切换方式 |
|------|------|------|---------|
| flash（默认） | `deepseek-v4-flash` | 日常读写、工具调度，响应快、成本低 | `/model flash` |
| pro | `deepseek-v4-pro` | 需要深度推理的复杂任务 | `/model pro` |

档位选择由用户显式切换（`/model`），无自动路由。
配置落在 `.dsa/model-mode.json`。

## 设计原则

- **工具少而原子**：只保留 4 个原子工具，复杂能力由模型组合完成，
  避免工具膨胀导致选型分散。这是极简模式的核心取舍。
- **工作区与源码分离**：agent 的工作目录与自身源码目录严格隔离，
  写操作禁止落到源码根，防止 agent 改坏自己的代码。
- **失败即回灌**：工具失败直接 throw，错误作为 tool error 回灌模型，
  由模型自我纠正，不静默跳过。
- **Harness 五子系统**：Instructions（system prompt）/
  State（持久化 Agent 上下文）/ Verification（`eval/` 用例定义）/
  Scope（一次一任务）/ Lifecycle（启动 → 执行 → 清理）。
