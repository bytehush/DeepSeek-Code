# AGENTS.md — DeepSeek CLI 编程 Agent 操作手册 & 项目 Spec

> 本文件既是给 Agent 自身的「操作手册」，也是本项目的 **Spec**。
> **当前形态：自研内核 P0**（`7b626bd` 全量替换 Pi SDK 之后的实际状态）。
> 产品定位与分期路线的决策依据：`docs/重设计方案-编程Agent基座.md`（ADR D1-D5）。

## 1. 项目定位

直接接入 **DeepSeek 原生 API** 的命令行编程 Agent。面向中文开发者，在终端完成
「读代码 → 理解结构 → 改 / 建代码 → 跑命令验证」的闭环。

定位一句话：**一句话入口 + 强编排内核 + 全程可控 + 数据边界可见**。
不做万能助手，只做编程垂直场景；内核自研，不依赖外部 Agent 运行时。

## 2. 目标用户 & 高频任务

- **目标用户**：无法 / 不愿使用 Claude 海外账户的开发者；中文母语；习惯终端工作流。
- **高频任务**：
  1. 理解陌生代码库（读文件、列目录、正则检索）
  2. 实现新功能 / 修复 bug（编辑、新建文件）
  3. 重构（多文件协同修改）
  4. 跑命令验证（构建、测试、lint、git 状态）
  5. 多轮对话保持上下文记忆（AgentKernel 跨轮持久化 + 重启会话恢复）

## 3. Agent 工具列表（共 6 个，注册表 = 单一事实源）

> **设计原则**：工具越少，模型选型越准、行为越可控。
> 系统提示中的工具清单由 `ToolRegistry.promptSection()` 生成——
> **提示词里出现但注册表里没有的工具在结构上不可能存在**（幽灵工具是旧版
> 最大教训，见设计稿 §1）。新增工具必须：注册进 registry + 自带
> capability/risk 维度 + 有真实消费者，三者缺一不可。

| 工具 | 参数 | 能力 | 风险级 |
|------|------|------|--------|
| `read_file` | `path`, `offset?`, `limit?` | read | 低 |
| `write_file` | `path`, `content` | write | 中（覆盖前自动快照） |
| `edit_file` | `path`, `old`, `new`（需唯一匹配） | write | 中 |
| `list_files` | `dir?`, `pattern?`, `max?` | read | 低 |
| `search_files` | `query`(正则), `pattern?`, `dir?` | read | 低 |
| `bash` | `command`, `timeoutSec?` | exec | 高（破坏性命令无条件升级确认） |

**路径解析**：相对路径基于 workspace 解析；绝对路径、`..` 逃逸一律过
`safePath` + protectedRoots 校验，落在受保护目录（源码根）内直接拒绝并回灌。

**结构性排除**：`list_files` / `search_files` 硬编码跳过 `.git`、`node_modules`、
`dist` 等目录（SKIP_DIRS），不存在「换个参数就能扫到敏感目录」的路径。

**失败处理**：工具 throw → 错误文本作为 tool result 回灌模型，模型据此自我
纠正，不静默跳过（内核不变式 1）。

## 4. 拒答边界

- **绝不执行**：`rm -rf /`、格式化磁盘、修改系统关键文件、读取并回显 `.env` 等密钥文件内容。
- **绝不替代人类做不可逆决策**：`git push --force`、`DROP DATABASE`、批量删除需用户显式确认。
- **绝不写入源码根**：避免 agent 修改自身代码（protectedRoots 强制）。
- **幻觉工具**：模型调用未注册工具时，回灌「不存在于注册表」而非崩溃（kernel.runTool）。

## 5. 确认点（权限层：三模式 × 能力矩阵）

`src/core/permission/engine.ts` 是**唯一权限真相**，纯函数，无旁路：

- `decide()`：旧单轴三模式 `explore`（只读）/ `ask`（需确认）/ `execute`（自动）。
- `decide3()`：能力矩阵 `read/write/exec/net` × `auto/confirm/block`，
  经 `matrixFromMode()` 与三模式对齐；裁决优先级：
  destructive → block 层 → 不可信仓库 net → confirm 层 → auto（高风险仍可升级）。
- P0 现状：net 能力尚无工具使用（沙箱与不可信仓库门控在 P2）；
  破坏性命令由 `isDestructive()` 的 POSIX 模式集判定。

## 6. 架构边界

- **应用交互层**（`src/cli`、`src/app`）：trace-first TUI、登录、Markdown、workspace 解析。
  渲染是事件流的纯折叠（`app/timeline.ts`：UiMessage[] = fold(UiEvent[])），
  恢复会话 = 重放内核消息列；编排层（`app/chat.ts`）只发事件不拼气泡。
  只消费 `CoreEvent`，不触模型与工具。
- **内核层**（`src/core/`）：`loop/`（AgentKernel+事件契约+系统提示+输出风格）、
  `provider/`（ModelHub+OpenAI-compatible 适配器+SSE+OutboundLedger）、
  `tools/`（注册表+原子工具）、`permission/`、`trace/`、`session/`（回合末快照，
  按工作区归集，load 永不抛）、`assemble.ts`。
- **配置层**（`src/config`）：工作区解析与保护、模型档位。
- **凭证层**（`src/auth`）：API Key 读写（0o600）。密钥**显式传参**进 ModelHub，
  绝不写 `process.env`；`serialize(req)` 签名里没有 apiKey。
- **通用层**（`src/utils`）：日志、Markdown、回滚栈。

**已删除的层**（不再存在于代码中）：
`src/agent/`（Pi 适配层，P0 重写为 `src/core/loop` + `core/tools`）、
`src/permission/`（并入 `core/permission`）、`src/app/assemble.ts`、`keyContext.ts`；
更早删除的 GUI/RAG/skills/MCP 层不复活（设计稿 §7 明确排除）。
依赖侧移除：`@earendil-works/*`、`openai`、`ws`、`react-dom`、`typebox`、`vite` 系。

## 7. 运行方式

```bash
npm start          # 启动 TUI
npm run typecheck  # 类型检查（覆盖 src/test/eval/scripts）
npm test           # 单元 + e2e 测试（node:test，无需 API Key、无网络）
npx tsx eval/run-eval.ts --tier code   # 无密钥评测基线
```

**模型**：`deepseek-v4-flash`（默认）/ `deepseek-v4-pro`（深度推理），
CLI 内 `/model` 切换，经 ModelHub 惰性绑定下一轮即时生效。

**工作区**：`--workspace` flag > `DSA_WORKSPACE` env > 自动判定。
自动判定时若 cwd 在源码根内，切到 `~/.dsa/workspace`。

## 8. 评测（三层体系的地基）

`eval/` 现在是**可运行的**：

- `cases.ts`：22 个黄金 case（code 15 / llm 5 / human 2），工具名与注册表
  严格一致；`test/eval-cases.test.ts` 会静态扫描 check() 源码，**断言了不存在
  的工具直接让 CI 红**。
- `run-eval.ts`：被测对象即产品本体——mock 理想轨迹注入 ProviderAdapter 边界，
  kernel / 权限 / 工具 / 记账全部真实运行；`--real` 换真模型；`--tier llm`
  走 hub 裁判打分；`--k` 出 pass@k。
- 评测的出站记账写入临时 HOME，不污染用户真实账本。
- 结果落 `eval/results.json` + `RESULTS.md`，形成版本序列（P1/P2 的对比基线）。

## 9. 开发纪律

- **受控改动**：不重构、不过度优化、不动无关代码。
- **改前先列清单**：改动文件 + 原因 + 影响范围，确认后才动手。
- **typecheck 是底线**：`npx tsc --noEmit` 零错误才能提交
  （tsconfig `include` 覆盖 `src`/`test`/`eval`/`scripts`，无坏引用盲区）。
- **单元测试**：`npm test` 必须全绿；核心不变式改动须同步改
  `test/kernel-e2e.test.ts` / `test/sse-parser.test.ts` 的对应断言。
- **事件契约冻结**：`CoreEvent` 是 UI/trace/eval 三方消费者的共享契约，
  改字段形状须三处同步，禁止为单一消费者私造事件。
- **发现无用代码走 git 历史**：删除前确认无引用，commit message 说明原因。
- **D5 纪律**：没有真实消费者的接口 / 配置 / 抽象不允许合入。

## 10. 后续演进（P0 已交付，按设计稿分期推进）

- **P1 上下文管理**：`core/context`（预算 + LLM 摘要 + snip 降级），
  压缩走 cheap 角色且成本入 ledger；200+ 轮压测不触 token_limit。
- **P2 上限层**：actor/critic/cheap 异厂商路由、`/review` 交叉评审闭环、
  不可信仓库默认禁网、bash 沙箱化。
- 持续：每阶段跑全量 eval 进 `RESULTS.md`——「数据说话」。

不在当前范围（引入须先有消费者 + 设计文档）：Web GUI、记忆层/RAG、技能系统、
MCP、多会话 fork、发布 npm。
