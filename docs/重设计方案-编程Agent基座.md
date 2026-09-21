# 重设计方案 —— 编程 Agent 自研基座

> 状态：**已拍板的决策文档**（2026-09-21）。
> 本方案取代 `ARCHITECTURE.md` 所描述的「Pi SDK 承载内核」形态；
> 实施完成前，两份文档并存，以本方案为演进方向。

## 0. 决策记录（ADR）

| 决策 | 内容 | 理由 |
|------|------|------|
| D1 | **全量重写内核**，不采用与 Pi SDK 并存过渡的方案 | 并存会保留双事件契约、双模型抽象，重构期越长漂移越大；`AgentEvent` 事件契约独立于 Pi，UI 层可以零语义改动地接到新内核上，因此「不并存」的代价可控 |
| D2 | 移除依赖 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` | Pi 锁死 DeepSeek provider，与「多模型路由 / 异厂商交叉评审」的定位正面冲突 |
| D3 | 场景押注：**编程垂直**（不做万能助手） | 仓库现有资产（eval 用例、纯函数权限层、回滚栈、中文 TUI）全部压在编程场景上；通用性由第二个场景验证，不在本轮设计 |
| D4 | 差异化主张：**可验证的信任（数据边界可审计）+ 异厂商交叉评审** | 两者是闭源在位者结构性不能做的，不是「更好的 Claude Code」能覆盖的 |
| D5 | 基座建设纪律：**任何接口在写下时必须至少有一个真实消费者** | 防止「通用基座」退化为无场景验证的无限设计 |

## 1. 现状问题清单（重写要消灭的对象）

内核级缺陷（本轮重写范围内）：

1. **幽灵工具表** — `src/agent/system-prompt.ts` 指示模型调用 `search_code` / `ensure_dir` /
   `run_command` / `review_code` / `deep_gen` / `delegate` / `verify_answer` 等 13 个不存在的工具，
   且多为「必须调用」级指令；`pi-tools.ts` 实际只注册 4 个。模型每轮被命令寻找不存在的工具。
2. **环境身份硬编码错误** — `system-prompt.ts:45` 写死「当前运行环境为 Windows（win32）」，
   与实际 OS 无关。
3. **上下文压缩是空头承诺** — 提示词声称「系统会自动压缩为摘要」，代码中无任何压缩实现；
   长任务直接撞 token 上限，兜底是提示用户「新开一个会话」。
4. **无 provider 抽象，凭证走全局 env** — `assemble.ts` 以 `process.env.DEEPSEEK_API_KEY`
   注入密钥；多厂商并存时 env 互相踩踏，且 env 对子进程（bash 工具）可见，属于泄漏面。

工程遗留（清理范围内）：

5. 极简模式收尾后仍残留 GUI 时代依赖与文件：`openai`、`ws`、`react-dom`、`vite`、
   `vite.config.ts`、`css-stub.mjs`、`_e2e_*.mts`（零引用，typecheck 覆盖不到其真实语义）。
6. `eval/` 有 23 个黄金用例定义但**无 runner**，评测套件不可运行——「迭代依据」缺位。

## 2. 目标架构：五个子系统

```
┌─────────────────────────────────────────────────────────────┐
│ src/cli + src/app（保留，重接契约）                            │
│   TUI / Markdown / viewport / useAgentController              │
│   唯一依赖：CoreEvent 事件流（形状 = 现 AgentEvent，不变）      │
└───────────────┬─────────────────────────────────────────────┘
                │ 单一事件流（UI、trace、eval 三个消费者）
┌───────────────▼─────────────────────────────────────────────┐
│ src/core/ —— 自研内核                                          │
│                                                             │
│ ① loop        AgentKernel：ReAct 循环、工具调度、中断、重试     │
│ ② provider    ModelHub：多厂商注册表 + OpenAI-compat/Anthropic │
│               协议适配 + **出站记账（OutboundLedger）一等公民**  │
│ ③ context     上下文管理：token 预算 → LLM 摘要 → 确定性 snip  │
│               降级（压缩契约必须兑现给提示词）                  │
│ ④ permission  能力三维闸门：read / write+exec / net 分离，      │
│               纯函数决策保留现 decide() 形状                   │
│ ⑤ trace+eval  JSONL trace 落盘 + eval runner（GoldenCase 契约） │
└─────────────────────────────────────────────────────────────┘
```

### 支撑层（非独立子系统）

- `config/`（workspace 解析、model-mode → 改为角色路由配置）、`auth/`（KeyRing，按 provider 分组）、
  `utils/`（rollback / logger / markdown 原样保留）。

## 3. 关键接口（P0 冻结的契约）

```ts
// core/loop/events.ts —— 与现 AgentEvent 逐字段同形，仅更名；UI 契约零改动
export type CoreEvent = { /* 同 src/agent/loop.ts 的 AgentEvent union */ };

// core/loop/kernel.ts
export interface KernelOptions {
  hub: ModelHub;                // 模型中枢（含出站记账）
  tools: ToolRegistry;          // 工具单一事实源（见下）
  permission: PermissionEngine; // 三维闸门
  context: ContextManager;      // 压缩器
  trace: TraceSink;             // JSONL 落盘
  signal?: AbortSignal;
}
export class AgentKernel {
  prompt(input: string, opts?: RunOverrides): AsyncGenerator<CoreEvent>;
  abort(): void;
  get state(): SessionState;    // 跨轮持久上下文
}

// core/provider/hub.ts —— 消灭「字面量 deepseek」
export interface ModelRef { provider: string; id: string; role: 'actor' | 'critic' | 'cheap' }
export interface ChatRequest {
  model: ModelRef;
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  thinking?: 'off' | 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}
export interface ProviderAdapter {
  id: string;
  stream(req: ChatRequest, apiKey: string): AsyncGenerator<ProviderStreamEvent>;
}
export class ModelHub {
  register(a: ProviderAdapter): void;
  stream(req: ChatRequest): AsyncGenerator<CoreEvent>; // 出口即事件，且必经 OutboundLedger
}

// core/provider/ledger.ts —— 数据安全第 3 条的落点：任何模型调用不可绕过
export interface OutboundRecord {
  ts: string; provider: string; model: string; endpoint: string;
  bytes: number; payloadSha256: string;
  messageRoles: Array<{ role: string; bytes: number }>; // 逐条体积，不含正文
  fullPayloadPath?: string;                              // 用户开启 debug 模式时才有正文落盘
}
export class OutboundLedger { append(r: OutboundRecord): void; exportDir(dir: string): void; }
// 落盘 ~/.dsa/outbound/YYYY-MM.jsonl，CLI 提供 /outbound 查看与导出

// core/tools/registry.ts —— 消灭幽灵工具表的机制
export interface ToolSpec {
  name: string; description: string;
  parameters: ZodType;                 // 复用已有 zod，弃 typebox
  capability: 'read' | 'write' | 'exec' | 'net';
  risk: 'low' | 'mid' | 'high';
  execute(args: unknown, ctx: ToolCtx): AsyncIterable<ToolDelta>;
}
// 铁律：system prompt 的工具段由 registry 自动生成。
// 提示词中出现任何工具名的唯一来源是注册表——结构上不可能再有幽灵工具。

// core/permission/engine.ts —— 保留纯函数决策形状，扩维
export interface CapabilityMatrix { read: Tier; write: Tier; exec: Tier; net: Tier }
export type Tier = 'auto' | 'confirm' | 'block';
export function decide3(input: {
  matrix: CapabilityMatrix; capability: Capability; effectiveRisk: Risk; destructive: boolean;
}): PermissionVerdict; // allow | deny | require_confirm（同现 union）

// core/context/manager.ts —— 兑现提示词的承诺
export interface ContextManager {
  budget(): number;                       // 按当前 ModelRef 的窗口
  maybeCompact(messages: Msg[]): Promise<{ messages: Msg[]; compacted: boolean; summary?: string }>;
  // 策略：LLM 摘要（用 role='cheap' 模型）→ 失败时确定性 snip（head+tail 保留）→ 硬丢兜底
}
```

### 系统提示的重写原则

- 环境段运行时探测（`process.platform`），不再写死 win32；
- 工具段由 `ToolRegistry` 生成（见上）；
- 删除所有未实现能力的承诺（双模型质量门、delegate 等），P1/P2 实现后**随实现再生成**；
- 保留：中文交流准则、先规划后行动、失败回灌、prompt injection 防御段、诚实条款。

## 4. 文件级清单：删除 / 重写 / 移植 / 保留

### 删除（重写完成后即移除）

| 对象 | 原因 |
|------|------|
| `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 依赖 | D2 |
| `src/agent/pi-agent.ts`、`pi-tools.ts`、`loop.ts` | 由 `src/core/loop` + `core/tools` 取代 |
| `src/agent/system-prompt.ts` 的静态全文 | 改为模板 + registry 生成 |
| `openai`、`ws`、`react-dom`、`typebox` 依赖；`vite.config.ts`、`css-stub.mjs`、`_e2e_*.mts`、`ds-promo/` 评估后归档 | 极简模式遗留死引用 |
| `src/app/types.ts` 对 Pi 类型的 import | 契约改用 core |

### 移植（逻辑保留、位置迁移）

| 现位置 | 新位置 | 说明 |
|--------|--------|------|
| `src/permission/permission-system.ts` `decide()` | `core/permission/` | 纯函数原样搬，新增 `decide3` 三维版 |
| `src/permission/index.ts` `isDestructive()` | `core/permission/destructive.ts` | 正则表原样搬，补 POSIX 形态 |
| `src/config/workspace.ts` `isWithin`/`resolveWorkspace` | 原地保留 | 纯函数，已是好形状 |
| `src/app/assemble.ts` | 重写为 `core/assemble.ts` | 装配对象从 Pi Agent 换成 AgentKernel |
| `AgentEvent`（loop.ts:21-52） | `CoreEvent`（core/loop/events.ts） | 字段逐一不变，UI 零语义改动 |
| `src/auth/credentials.ts` | 扩展为 KeyRing | `{providers: {deepseek: {...}, ...}}`；密钥显式传参给 adapter，**不再写 process.env** |

### 保留（不动）

`src/cli/app.tsx`、`login.tsx`、`Markdown.tsx`、`sanitize.ts`、`thinkingIndicator.tsx`、
`src/app/chat.ts`、`viewport.ts`、`markdown-lines.ts`、`useAgentController.ts`（仅事件类型改名）、
`src/utils/rollback.ts`、`logger.ts`、`markdown.ts`、`test/*`（断言对象迁移时同步改 import）、
`eval/cases.ts`、`eval/types.ts`。

## 5. 分期路线与验收判据

### P0 — 内核骨架（消灭 §1 四个硬伤，恢复「可跑可测」）

范围：`core/loop` + `core/provider`（仅 OpenAI-compatible 协议，DeepSeek 走之）+
`core/tools`（read/write/edit/bash + **新增 search_files/glob** ——幽灵工具的正解是把提示词里
真实需要的检索能力做出来）+ 权限移植 + trace 落盘 + **eval runner 重建**。

验收（全部机器可判）：**2026-09-21 全部达成**。
- [x] `npm start` 全链路走自研内核，仓库无 `@earendil-works/*` import；
- [x] `npx tsc --noEmit` 零错误；`npm test` 通过（94/94，含 decide/isWithin/rollback/SSE 解析/kernel e2e 单测）；
- [x] `npx tsx eval/run-eval.ts --tier code` 可无密钥跑 code 档（15 case，pass@1 15/15 mock 轨迹基线）；
- [x] 出站逐调用记账（`~/.dsa/outbound/`，先记账后发送）+ `/outbound` 导出——e2e 断言覆盖记账与 summarize 代码路径；
- [x] system prompt 工具名 ⊆ registry（`test/kernel-e2e.test.ts`）+ eval 断言工具名 ⊆ registry（`test/eval-cases.test.ts` 静态扫描）。

### P1 — 上下文管理兑现承诺

范围：`core/context`（预算 + LLM 摘要 + snip 降级），提示词恢复压缩段落并使其为真；
多轮长任务在 eval 集上的 token 超限率 → 0。

验收：
- [ ] 200+ 轮压测不触 token_limit；摘要后模型行为正确引用摘要内容（llm 档用例）；
- [ ] 压缩用 cheap 角色模型，压缩成本计入 ledger。

### P2 — 上限层：路由 + 交叉评审 + 三维权限落地

范围：ModelHub 角色路由（actor 强 / critic 异厂商 / cheap 压缩）、`/review` 交叉评审闭环、
CapabilityMatrix 三维权限 + 不可信仓库默认禁网、bash 沙箱化（`sandbox-exec`/`bwrap` 分级）。

验收：
- [ ] 同一任务 actor 生成 → critic 评审 → 修正的闭环在 eval 上提升 pass@k（量化对比 P0 基线）；
- [ ] net 能力在确认前对所有 provider 端点外请求被阻断（单测 + e2e）。

### 持续（贯穿 P0-P2）

- trace 即事件流：UI 渲染、trace 落盘、eval 记录共用一条流，不另造观测机制；
- 每阶段结束跑全量 eval，结果进 `eval/RESULTS.md` 形成版本序列——这是「数据说话」的开始。

## 6. 风险登记

| 风险 | 缓解 |
|------|------|
| 自研 SSE 解析的边界 bug（Pi 原本代偿了这层） | P0 即为解析器写单测（分片/多字节截断/中止/错误帧），复用 `test/` 既有流式用例的断言思路 |
| 重写期无可用产品 | 分三个可独立运行的验收点，P0 完成即可用 `npm start`；master 分支保持极简版可用直至本方案合入 |
| 三维权限改造波及现有 y/n 交互 | `PermissionVerdict` union 不变，TUI 只加维度不加协议 |
| 多厂商 key 管理复杂度上升 | KeyRing 单文件 + 0o600，未配置的 provider 不出现在路由候选中 |

## 7. 本方案不含（明确排除，防止范围蔓延）

Web GUI、记忆层/RAG、技能系统、MCP、多会话 fork、发布到 npm。
如需引入，按 D5 纪律：先有消费者，再写设计文档，再实施。
