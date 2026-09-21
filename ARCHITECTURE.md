# ARCHITECTURE.md — 自研内核的分层结构

> **当前形态：自研内核 P0**（`7b626bd refactor(core): 自研内核 P0` 之后的实际状态）。
> 外部 Agent 运行时 `@earendil-works/pi-agent-core` / `pi-ai` 已整体移除，
> ReAct 循环、SSE 解析、工具注册表、权限矩阵、出站记账收进 `src/core/` 自研层。
> 决策依据（ADR D1-D5）见 `docs/重设计方案-编程Agent基座.md`。

## 分层总览

```
┌──────────────────────────────────────────────────────────┐
│ 应用交互层  src/cli  +  src/app                            │
│  TUI 渲染 · 流式输出 · 登录 · Markdown · workspace 解析     │
│  职责：消费 CoreEvent 事件流；把用户输入变成 kernel.prompt() │
│  不该：直接调模型、直接执行工具                             │
└───────────────┬──────────────────────────────────────────┘
                │ CoreEvent（唯一输出契约，字段级冻结）
┌───────────────▼──────────────────────────────────────────┐
│ 内核层 src/core                                            │
│  loop/        AgentKernel：ReAct 循环 + 系统提示 + 输出风格 │
│  provider/    ModelHub：角色路由（actor/critic/cheap）      │
│               OpenAI-compatible 适配器 + 自研 SSE 解析      │
│               OutboundLedger：先记账后发送，不可绕过        │
│  tools/       ToolRegistry：注册表 = 提示词单一事实源       │
│               6 个原子工具（read/write/edit/list/search/bash）│
│  permission/  decide()（三模式）+ decide3()（能力矩阵）     │
│  trace/       TraceSink：事件流 JSONL 落盘                  │
│  assemble.ts  组装入口（cli/main.ts 调用）                  │
└───────┬──────────────────────────┬───────────────────────┘
        │ 唯一外发路径              │ 唯一执行路径
┌───────▼────────────────┐  ┌──────▼───────────────────────┐
│ 模型层（provider 边界）  │  │ 文件系统 / shell（工具作用域）│
│ OpenAI-compatible 协议  │  │ 工作区隔离 + 受保护目录      │
│ 一家适配器覆盖多家厂商   │  │ 写前快照 → /rollback         │
└────────────────────────┘  └──────────────────────────────┘

        ↕ 支撑 ↕
┌──────────────────────────────────────────────────────────┐
│ 配置层 src/config    凭证层 src/auth    通用层 src/utils    │
│ 工作区/档位            0o600 显式传参     日志·MD·回滚栈     │
└──────────────────────────────────────────────────────────┘
```

## 数据流：一次用户输入的完整旅程

```
用户输入
  → AgentKernel.prompt()                  (core/loop/kernel.ts)
  → 每步现场重建 system prompt            (registry.promptSection() —— 提示词工具
  │                                        清单由注册表生成，非手写)
  → ModelHub.stream('actor', req)         (core/provider/hub.ts)
  → adapter.serialize(req)  ——签名拿不到 apiKey
  → OutboundLedger.append() ——先记账（字节数/SHA-256/消息构成/目的地）
  → adapter.stream(req, apiKey, body) ——后发送（body 就是刚记账那份字节）
  ← SSE 解析（core/provider/sse.ts，处理 TCP 分片/多字节切断）
  → 工具调用：safeParse → decide3 权限裁决 → (ask 确认) → execute
  → 结果回灌模型，循环直到无工具调用 / 中断 / 防空转触发
  → 全程以 CoreEvent 流出：UI 渲染、trace 落盘、eval 记录共用这一条流
```

## 层间关键机制位置（Debug 时先查哪层）

| 问题现象 | 先查哪里 |
|----------|----------|
| 工具调用失败 | `src/core/tools/atomic.ts` + `src/core/permission/engine.ts` 裁决 |
| 写入被拒绝 | `safeWritePath`（atomic.ts）+ `src/config/workspace.ts` protectedRoots |
| 流式输出中断 / 乱码 | `src/core/provider/sse.ts`（有专门边界单测） |
| 模型没收到某工具 | `src/core/tools/registry.ts`（注册表即事实源） |
| 提示词与实际工具不符 | 不可能结构性发生——见 `registry.promptSection()` + e2e 断言 |
| 出站数据核对 | `~/.dsa/outbound/*.jsonl` 或 CLI 内 `/outbound` |
| 模型跑偏 / 重复 | `src/core/loop/system-prompt.ts` + kernel 防空转（REPEAT_LIMIT） |
| 多轮上下文丢失 | `AgentKernel.messages`（跨轮持久化）+ `/clear` 语义 |
| TUI 渲染错位 | `src/cli/app.tsx` + `src/app/markdown-lines.ts` |
| 启动即退出 | `src/cli/main.ts` 的 TTY 检测 |
| 回滚不生效 | `src/utils/rollback.ts` 的 cwd 作用域 |

## 技术栈定位

| 技术 | 层 | 作用 |
|------|----|------|
| 自研 AgentKernel | 内核 · loop | ReAct 循环、事件契约、失败回灌、防空转 |
| 自研 ModelHub | 内核 · provider | 角色路由 + 唯一外发出口 + 记账强制 |
| 自研 SSE 解析 | 内核 · provider | OpenAI-compatible 流式协议（原 Pi 代偿层） |
| `zod` | 内核 · tools | 工具参数 schema（→ JSON Schema 上线） |
| `ink` + `react` | 应用交互层 | 终端 TUI 渲染 |
| `chalk` | 应用交互层 | 输出可读性、状态区分 |
| `tsx` | 工程 | 免构建直接跑 TS |
| `~/.dsa/credentials.json` | 凭证层 | 密钥 0o600，显式传参，不走 env |

## 模型策略

| 档位 | 模型 | 用途 | 切换方式 |
|------|------|------|---------|
| flash（默认） | `deepseek-v4-flash` | 日常读写、工具调度，响应快、成本低 | `/model flash` |
| pro | `deepseek-v4-pro` | 需要深度推理的复杂任务 | `/model pro` |

档位由用户显式切换（`/model`），配置落 `.dsa/model-mode.json`；
ModelHub 的绑定支持惰性函数，切换在下一轮即时生效。
`actor/critic/cheap` 三角色路由在 hub 层已就位，P0 三角色同绑，
P2 引入异厂商 critic（交叉评审）与低价 cheap（压缩）。

## 安全不变式（架构级，非约定级）

1. **记账不可绕过**：`hub.stream()` 是唯一外发路径，serialize → 记账 → 发送
   写死在同一函数里；适配器签名不允许自行 stringify 后发送。
2. **密钥结构性隔离**：`serialize(req)` 参数表里没有 apiKey；
   凭证不写 `process.env`；`bash` 子进程 env 剥离凭证类变量。
3. **`.git` 与凭证不可被发现**：list/search 工具硬编码排除目录集合，
   不存在「换个参数就能扫到」的路径。
4. **写操作可回滚**：所有落盘前 snapshot；写路径先过 protectedRoots 校验。
5. **失败不静默**：工具 throw → 错误文本作为 tool result 回灌模型。

## 设计原则

- **注册表即事实源**：提示词、线协议、权限维度、评测断言全部从 ToolRegistry
  生成——幽灵工具（提示词承诺但实现不存在）在结构上不可能出现。
- **无消费者不造接口**（ADR D5）：任何抽象必须有第二处真实引用才允许存在。
- **一条事件流三个消费者**：UI、trace、eval 共用 CoreEvent，不另造观测机制。
- **工具少而原子**：6 个原子工具，复杂能力由模型组合完成。
- **Harness > 换模型**：同一模型在不同编排/权限/反馈设施下差距巨大，
  内核质量是上限的主要来源。
