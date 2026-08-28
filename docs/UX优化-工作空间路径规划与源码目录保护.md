# UX 优化 — 工作空间路径规划与源码目录保护

> **状态**：已实现（commit `0cbd978`，详见 §9）
> **类型**：UX 优化 / 安全加固
> **关联**：`src/cli/main.ts`、`src/app/assemble.ts`、`src/agent/pi-tools.ts`、`src/agent/system-prompt.ts`、`src/app/useAgentController.ts`
> **截图**：无（用户文字描述）

## §1 需求（用户原话 + 拆解）

### 用户原话

> "要求把这个 agent 做路径规划，自己源文件一个储存路径，工作空间一个存储路径（支持自定义路径），每次他都在修改自己源文件的路劲里面工作，这是很危险的，你先需求分析，然后进行代码锚定找到原因，最后生成结构化文档进行开发"

### 一句话重述

用户在源码目录（`D:/作业/AI Agent/deepseek-code-agent`）启动 agent，agent 的全部文件工具与 bash 都在**自己的源码目录**里执行——agent 可能覆盖/删除/修改自身代码，危险；需要把「agent 自身源码目录」与「agent 干活的工作空间」分开，并支持自定义工作空间路径。

### 需求拆解

| # | 需求 | 现状 | 标记 |
|---|---|---|---|
| R1 | **工作空间与源码目录隔离**：agent 的 read/write/edit/bash 只能在工作空间内生效 | ❌ 工具 cwd = `process.cwd()` = 启动目录（`assemble.ts:30`），无隔离 | **真问题** |
| R2 | **源码目录受保护**：写工具（write/edit/bash 写操作）解析后落源码目录 → 拒绝；读允许 | ❌ 无任何保护（`pi-tools.ts:20-23` safePath 只解析不校验） | **真问题** |
| R3 | **工作空间支持自定义路径**：`--workspace <path>` / `DSA_WORKSPACE` 环境变量 / 配置文件 | ❌ `assembleAppProps` 已有 `opts.workspace` 参数，但 CLI 未接线（`main.ts:52` 不传） | **部分满足**（参数位已预留） |
| R4 | **启动时检测 cwd == 源码目录 → 提示 + 自动使用安全工作区** | ❌ 静默直接使用 | **真问题** |
| R5 | **agent 明确知道工作区在哪**（系统提示注入 workspace + Banner 展示） | ❌ system-prompt.ts:46 写死「工作目录即用户当前项目根目录」；Banner 显示 `process.cwd()` | **需确认**（提示措辞） |
| R6 | bash 命令也限制在工作区内（防 `cd ..` / 绝对路径逃逸写源码） | ⚠️ 部分满足：spawn 已用 `cwd` 启动，但无落点校验 | **真问题**（工具层） |

**需确认项（已确认 2026-08-28 用户拍板）**：
- ✅ Q1：「自己源文件一个储存路径」= **agent 自身代码目录（deepseek-code-agent）作为只读保护目录**——write/edit/bash 写操作禁止落在源码目录，read 允许。
- ✅ Q2：cwd == 源码目录时的默认工作区：**警告 + 自动切 `~/.dsa/workspace`**（自动创建，可被 `--workspace` 覆盖）。

## §2 根因分析（代码走查，高置信）

### 根因链：workspace 默认 = 启动目录 = 源码目录

```
用户: npm start（在源码目录 D:/作业/AI Agent/deepseek-code-agent）
  ↓
main.ts:23   const cwd = process.cwd();          // = 源码目录
main.ts:52   assembleAppProps(creds)             // ⚠️ 不传 workspace
  ↓
assemble.ts:30  workspace = opts?.workspace ?? process.cwd()   // = 源码目录
assemble.ts:52  createAtomicTools({ cwd: workspace })          // 工具根 = 源码目录
  ↓
pi-tools.ts:38/58/79  safePath(cwd, p) → resolve(cwd, p)       // 读写全部落源码目录
pi-tools.ts:105       spawn(cmd, { cwd, shell: true })         // bash 在源码目录执行
  ↓
结论：agent 的 4 个原子工具全部直接操作自己的源码目录
```

**证据类型**：代码走查（file:line 完整链路）+ 磁盘实证（`~/.dsa/` 存在独立用户目录，但**从未用于 workspace**）。

### 危险场景（用户点明 + 推导）

| 场景 | 后果 |
|---|---|
| 用户让 agent「review src/ 并修复」 | agent 直接 `edit_file` 改自己的 `src/agent/*.ts`，可能破坏自身逻辑 |
| agent bash 跑 `git reset --hard` / `rm -rf` | 直接炸掉整个源码仓库 |
| `/rollback`（`chat.ts:213` 基于 `ctx.cwd`） | 误回退源码目录的文件变更 |
| 多会话共享源码目录 | 多个 agent 实例互相覆盖源码 |

### 为什么现有权限闸挡不住

`pi-agent.ts:62-71` 的 `beforeToolCall` 只按 `explore/ask/execute` 拦「是否允许写」，**不校验写到哪里**——execute 模式下 agent 可写任意路径。路径级保护必须下沉到工具层（`safePath`）。

## §3 关键代码锚点表

| 文件:行 | 内容 | 影响 |
|---|---|---|
| `src/cli/main.ts:23` | `const cwd = process.cwd()` | 启动目录捕获点（= 源码目录的源头） |
| `src/cli/main.ts:52` | `assembleAppProps(creds)` — **不传 workspace** | workspace 参数位已存在但 CLI 未接线（R3 部分满足） |
| `src/app/assemble.ts:30` | `workspace = opts?.workspace ?? process.cwd()` | **根因核心**：默认 workspace = 启动目录 |
| `src/app/assemble.ts:52` | `createAtomicTools({ cwd: workspace })` | 工具工作根注入点 |
| `src/agent/pi-tools.ts:20-23` | `safePath(cwd, p) = resolve(cwd, p)` — 只解析不校验 | **写路径无保护**（R2 缺口） |
| `src/agent/pi-tools.ts:38/58/79` | read/write/edit 全部 `safePath(cwd, params.path)` | 读写落点 = workspace |
| `src/agent/pi-tools.ts:105` | `spawn(params.command, { cwd, shell: true })` | bash 工作根 = workspace（无逃逸校验） |
| `src/agent/pi-agent.ts:62-71` | `beforeToolCall` 仅按模式拦写，不校验路径 | 权限闸不覆盖「写哪」 |
| `src/agent/system-prompt.ts:46` | 「工作目录即用户当前项目根目录」 | 提示与真实 workspace 语义不符（R5） |
| `src/app/useAgentController.ts:229` | `cwd: process.cwd()` — ChatContext.cwd | /style、/model、/rollback 的配置读写根（`chat.ts:177/199/213`）——需同步改为 workspace |
| `src/cli/app.tsx:16-19` | Banner `cwdShow` 显示 `process.cwd()` | UI 需改为显示 workspace |
| `src/app/chat.ts:213` | `rollbackManager.rollback(steps, ctx.cwd)` | /rollback 落在 cwd = 源码目录（危险场景之一） |

## §4 修改方向

### 方案对比

| 方案 | 解决什么 | 核心思路 | 改动文件 | 代价 | 推荐度 |
|---|---|---|---|---|---|
| **A — 工具层路径隔离 + CLI workspace 接线**（最小治本） | R1/R2/R3/R4 | `createAtomicTools` ctx 扩展 `{ cwd, protectedRoots }`；`safePath` 写路径落 protectedRoots → throw；`main.ts` 解析 workspace 优先级 `--workspace` > `DSA_WORKSPACE` > （cwd==源码根 ? 警告 + `~/.dsa/workspace` : cwd）；ChatContext.cwd / Banner 同步 | `main.ts`、`assemble.ts`、`pi-tools.ts`、`useAgentController.ts`、`app.tsx`、`chat.ts`(rollback 用 workspace) | 中（60-90 行） | ✅ **推荐** |
| **B — A + bash 破坏性命令防护** | R6 加强 | 在 A 基础上，bash 命令字符串解析拦截（`rm -rf`/`del /s`/`git reset --hard`/`git push --force` 等）→ 需 permission=execute 才放行 | 同上 + `pi-tools.ts` | 中（+30 行） | 次选（二期加固） |
| **C — 仅提示层**（改 system-prompt + Banner） | R5 只 | 不改工具层，只告知 agent「工作区在哪、别碰源码」 | `system-prompt.ts`、`app.tsx` | 小（10 行） | ❌ 不满足 R1/R2 本质诉求（不可靠） |
| **D — 完整沙箱/虚拟 FS** | 全隔离 | 文件系统虚拟化（如 chroot/deno sandbox 级） | 大量 | 高 | ❌ 超范围（CLI 项目没必要） |

### ✅ 推荐路径：方案 A（先落地）+ 方案 B 项列入二期

理由：
- **治本**：路径保护下沉到工具层（`safePath` 校验），不依赖模型自觉，explore/ask/execute 三模式都生效
- **最小**：不引入沙箱/虚拟 FS，只加「写路径落点校验」+「workspace 解析接线」，改动集中在 6 个文件
- **顺带修复**：ChatContext.cwd（/style、/model、/rollback 的根）一并切到 workspace，消除「配置写源码目录」隐患
- 方案 B（bash 破坏性命令拦截）不阻塞 A，二期再加（当前 execute 模式已有用户确认语义，破坏性命令可复用 `isMutatingTool` 扩展）

### 不做清单（防战术蔓延）

- ❌ **不动 agent loop / 权限闸结构**（`pi-agent.ts` beforeToolCall 语义不变，只可能在其内加「路径级」判定）
- ❌ **不实现文件系统沙箱/虚拟化**（D 方案，超范围）
- ❌ **不新增 20+ 领域工具**（仍是 4 原子工具，stock-Pi 哲学不变）
- ❌ **不改账户体系 / ~/.dsa/users 数据结构**（已有独立存储，本次只新增 `~/.dsa/workspace` 默认目录）
- ❌ **不动 markdown 渲染 / 视口 / 滚动**（上两轮刚修的 TUI 链路不碰）

## §5 验收 DoD

### 主诉场景

- [ ] **D1**：在源码目录（`deepseek-code-agent/`）执行 `npm start` → 启动时**出现警告**「检测到工作目录是 Agent 源码目录，已自动切换到安全工作区 `~/.dsa/workspace`」，且 Banner 显示工作区为 `~/.dsa/workspace`
- [ ] **D2**：在任意其他目录（如 `D:/work/foo`）执行 `npm start -- --workspace D:/work/bar` → 工作区为 `D:/work/bar`（flag 优先）
- [ ] **D3**：设 `DSA_WORKSPACE=D:/work/env` 后在任意目录启动（不传 flag）→ 工作区为 `D:/work/env`（env 次优）
- [ ] **D4**：agent 尝试 `write_file path="../deepseek-code-agent/src/cli/app.tsx"`（相对路径逃逸）或绝对路径写入源码目录 → 工具**拒绝**（错误回灌模型），源码目录文件未被修改
- [ ] **D5**：agent `read_file` 源码目录文件（如 `../../deepseek-code-agent/package.json`）→ **允许**（读不拦）

### 验证手段

- [ ] **V1**：单测覆盖 `safePath` 新校验（写路径落 protectedRoots → throw；正常路径通过；相对/绝对/`..` 逃逸三形态）
- [ ] **V2**：`tsc --noEmit` 0 错；`sanitize.test.ts` / `markdown-lines.test.ts` 回归全绿
- [ ] **V3**：spike 模拟「源码目录内启动」断言 workspace 解析结果 = `~/.dsa/workspace` 且打印警告
- [ ] **V4**：spike 模拟 write/edit 落源码目录 → 断言 throw（工具层拒绝，不依赖模型）

### 回归项

- [ ] **R1**：4 原子工具在正常工作区读写/编辑/bash 行为不变（explore/ask/execute 权限语义不变）
- [ ] **R2**：`/style`、`/model`、`/rollback` 正常工作（根从 cwd 切到 workspace 后配置读写一致）
- [ ] **R3**：GUI 后端（复用 assembleAppProps）不因新增参数签名破坏

### 门槛

- 每个独立改动 = 1 commit（`type(scope): 为什么改`）
- 不破坏上两轮 TUI 修复（box-drawing / Scrollbar）——回归测试必须包含

## §6 风险与边界

| 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|
| 用户**确实想**让 agent 改自己的源码（dogfooding） | 用户对 agent 说「重构你自己」 | 高 | 提供显式逃生门：`--workspace` 明确指向源码目录时**放行**（用户显式指定 = 知情同意） |
| `~/.dsa/workspace` 不存在 | 首次使用 | 低 | assemble 时 `mkdirSync(recursive)` 自动创建 |
| 相对路径逃逸判定误伤 | 项目内 `../` 引用（monorepo 兄弟包） | 中 | protectedRoots 只含**源码根**；monorepo 用户可 `--workspace` 指定父目录 |
| bash 无法 100% 拦截写 | `bash -c "echo x > ../src/x"` 重定向 | 中 | 方案 B（二期）做命令解析；一期靠「workspace 隔离 + 提示」显著缩小破坏面 |
| 环境变量污染 | 用户 shell 里残留 DSA_WORKSPACE | 低 | flag 优先级最高，文档注明可用 `--workspace` 覆盖 |
| Windows 路径大小写 | `D:/...` vs `d:/...` | 低 | 比较前 `normalize()` + `toLowerCase()`（win32） |

## §7 附录 A：复现 demo（用户本机可执行）

1. **现状复现（危险演示）**：
   - `cd D:/作业/AI Agent/deepseek-code-agent && npm start`
   - 输入「列出当前目录文件」→ agent 用 bash `ls` 列出的是 **agent 自己的源码目录**
   - 输入「把 package.json 的 name 改成 demo」→ agent 直接改自己的 package.json（**危险确认**）
2. **修复后验证**（方案 A 落地后）：
   - 同上启动 → 出现警告 + 自动切 `~/.dsa/workspace`，Banner 显示工作区
   - 输入「创建 hello.txt」→ 文件落在 `~/.dsa/workspace/hello.txt`，源码目录无变化
   - 输入「读 ../../deepseek-code-agent/package.json」→ 可读但不可写

## §8 附录 B：相关代码索引

### 修改候选文件

- `src/cli/main.ts:23-52` — workspace 参数解析（flag/env/默认策略）
- `src/app/assemble.ts:19-56` — opts.workspace 接线 + sourceRoot 传递
- `src/agent/pi-tools.ts:16-27` — `AtomicToolContext` 扩展 `protectedRoots` + `safePath` 校验
- `src/app/useAgentController.ts:229` — ChatContext.cwd → workspace
- `src/cli/app.tsx:16-19` — Banner cwdShow → workspace
- `src/app/chat.ts:213` — rollback 根 → workspace
- `src/agent/system-prompt.ts:46` — 「工作目录」措辞 → workspace 语义 + 源码保护规则

### 新增文件

- `src/config/workspace.ts`（可能）— workspace 解析纯函数（flag/env/检测/默认），便于单测
- `test/workspace.test.ts` — 解析优先级 + 源码目录检测 + 逃逸路径拒绝

### 文档参考

- `docs/TUI界面优化-需求与方案.md`（上轮架构讨论，含「代码分层 ≠ 感知分层」原则）

## §9 实施记录（开发完成后回写）

> **状态**：已实现（commit `0cbd978`，方案 A 全量）
> **实施日期**：2026-08-28

### §9.1 与文档规划的偏差表

| 规划（§4 方案 A / §8） | 实际实施 | 原因 |
|---|---|---|
| 新增 `src/config/workspace.ts` 解析纯函数 | 落地（`resolveWorkspace` / `parseWorkspaceFlag` / `isWithin` / `DEFAULT_WORKSPACE_SUBDIR`） | 无偏差 |
| `pi-tools.ts` write/edit 走 `safeWritePath` 落 protectedRoots → throw | 落地；**bash 写保护未做**（一期靠 workspace 隔离 + 提示，符合 §6 风险表「方案 B 二期」） | 与文档一致 |
| `main.ts` workspace 解析 + 警告 | 落地；`mkdirSync(默认工作区)` **失败不阻塞启动**（try/catch） | 比文档更宽容——目录创建失败不应挡死 TUI 启动 |
| `system-prompt.ts` 注入 workspace + 保护规则 | 落地为 `buildSystemPrompt(workspace, protectedRoots)` 模板替换（`{{WORKSPACE}}` / `{{PROTECTED_ROOTS}}` 占位） | 实现细节（保持 SYSTEM_PROMPT 常量兼容导出） |
| `chat.ts:213` rollback 根 → workspace | **未直接改 chat.ts**——rollback 用 `ctx.cwd`，改 `useAgentController.ts:229` 传入 `props.workspace` 即自动生效 | 更小改动面（单点改根） |
| AppProps 加 workspace | 落地（types.ts） | 无偏差 |
| 测试覆盖 V1（safePath 校验） | 落地 14 用例（含逃逸三形态 + read 不拦 + 旧语义兼容） | 无偏差 |

### §9.2 落地改动摘要

| 文件 | 改动 | commit |
|---|---|---|
| `src/config/workspace.ts`（新增） | resolveWorkspace / parseWorkspaceFlag / isWithin / DEFAULT_WORKSPACE_SUBDIR | `0cbd978` |
| `src/agent/pi-tools.ts` | AtomicToolContext.protectedRoots + safeWritePath（write/edit 保护） | `0cbd978` |
| `src/agent/system-prompt.ts` | buildSystemPrompt(workspace, protectedRoots) 注入 | `0cbd978` |
| `src/app/assemble.ts` | opts.protectedRoots 接线 + buildSystemPrompt + 返回 workspace | `0cbd978` |
| `src/app/types.ts` | AppProps.workspace | `0cbd978` |
| `src/cli/main.ts` | --workspace flag / DSA_WORKSPACE env 解析 + 警告 + 默认工作区 mkdir | `0cbd978` |
| `src/app/useAgentController.ts` | ChatContext.cwd → props.workspace | `0cbd978` |
| `src/cli/app.tsx` | Banner cwd → props.workspace | `0cbd978` |
| `test/workspace.test.ts`（新增） | 14 用例 | `0cbd978` |

### §9.3 曾被尝试但否决的方案

- **bash 写保护（方案 B）**：一期未做（依赖命令字符串解析，不可靠且范围大）。靠「workspace 隔离 + 提示」已显著缩小破坏面；二期可加 `rm -rf` / `git reset --hard` / `git push --force` 等黑名单命令二次确认。
- **拒绝启动强制 --workspace（Q2 另一选项）**：用户拍板选「警告 + 自动切默认工作区」，不打断上手流程。
- **改 chat.ts rollback 根**：被「改 useAgentController 单点」替代（rollback 消费 ctx.cwd 不变）。

### §9.4 验证方式（沙箱无 TTY 时的替代验证路径）

- `npx tsc --noEmit` → 0 错 ✅
- `npx tsx --test test/workspace.test.ts` → 14/14 ✅（解析优先级 / flag 两形式 / 相对·绝对·`..` 逃逸拒绝 / read 不拦 / 无 protectedRoots 旧语义兼容）
- `npx tsx --test test/sanitize.test.ts test/markdown-lines.test.ts` → 18/18 ✅（上两轮 TUI 修复回归）
- `npx tsx scripts/spike-workspace-e2e.mjs` → ALL PASS：真实项目根做 sourceRoot，源码目录内启动产生警告 + 切 `C:\Users\MECHREVO\.dsa\workspace`；flag/env/正常目录三态正确；prompt 注入含只读保护规则且无占位符残留

### §9.5 待用户本机手测项

- [ ] **D1**：`cd D:/作业/AI Agent/deepseek-code-agent && npm start` → 出现源码目录警告，Banner 显示 `~/.dsa/workspace`；输入「创建 hello.txt」→ 文件落在工作区，源码目录无变化
- [ ] **D2**：`npm start -- --workspace D:/work/foo` → Banner 显示 `D:/work/foo`
- [ ] **D3**：`set DSA_WORKSPACE=D:/work/env` 后 `npm start`（不传 flag）→ Banner 显示 `D:/work/env`
- [ ] **D4**：让 agent `write_file` 绝对路径写源码目录文件 → 工具拒绝（思考盒出现「拒绝写入受保护目录」错误）
- [ ] **R1**：正常工作区里 read/write/edit/bash 行为不变；/style、/model、/rollback 正常（配置写进工作区）
