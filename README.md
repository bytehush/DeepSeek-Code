# DeepSeek Code Agent

一个直连 DeepSeek 官方 API 的**终端编程 Agent**。用中文交互，在终端里完成
「读代码 → 理解结构 → 改 / 建代码 → 跑命令验证」的闭环。

定位：**一句话入口 + 强编排内核 + 全程可控 + 数据边界可见**。
不要求你懂模型、选工作流——把复杂度留在内核里，把控制权留在你手里。

> **当前形态：自研内核（P0）**。
> 2026-09 起内核全量重写（`7b626bd`），移除 `@earendil-works/pi-agent-core` / `pi-ai`
> 等外部 Agent 运行时，ReAct 循环、SSE 流解析、工具注册表、权限矩阵、
> 出站记账全部自研。设计决策与分期路线见
> [`docs/重设计方案-编程Agent基座.md`](./docs/重设计方案-编程Agent基座.md)。

## 功能

- **直连官方 API，密钥用户持有**：无中转、无代理；密钥只进请求头，
  不进请求体、不进子进程环境变量、不写 `process.env`。
- **全中文交互**：对话、代码注释均为中文。
- **自研 ReAct 内核**：失败即回灌、每步可中断、防空转检测（截断回灌 /
  周期调用识别 / 连续失败停手交代）、所有退出路径打标签。
- **会话跨重启恢复**：回合末自动快照内核上下文到 `~/.dsa/sessions/`
  （按工作区归集、结构无密钥），重启后模型记得、屏幕也记得；`/clear` 清空。
- **6 个原子工具**：`read_file` / `write_file` / `edit_file` /
  `list_files` / `search_files` / `bash`。系统提示里的工具清单**由注册表生成**，
  结构上不存在「提示词有、实际没有」的幽灵工具。
- **权限三模式 × 能力矩阵**：`explore`（只读）/ `ask`（需确认）/ `execute`，
  叠加 read/write/exec/net × auto/confirm/block 四维裁决；破坏性命令无条件升级确认。
- **出站可审计（差异化核心）**：每次模型调用**先记账后发送**——字节数、
  请求体 SHA-256、每条消息的角色与体积、目的地，落盘 `~/.dsa/outbound/`，
  `/outbound` 随时查看导出。记账在架构上不可绕过。
- **Plan Mode**：先输出执行步骤，确认后再动手。
- **源码目录保护 + 文件回滚**：写操作禁止落到源码根；`/rollback` 撤销最近变更。
- **双模型档位**：`/model` 在 `flash`（快、省）与 `pro`（深度推理）间切换。

## 安装

要求 **Node.js ≥ 22**。

```bash
git clone https://github.com/bytehush/DeepSeek-Code.git
cd DeepSeek-Code
npm install
```

## 配置 API Key

两种方式，任选其一。

**方式 A：项目根目录 `.env`**

```bash
DEEPSEEK_API_KEY=sk-你的密钥
```

**方式 B：首次启动时输入**

直接 `npm start`，首次运行会进入登录界面提示输入 API Key，保存到 `~/.dsa/credentials.json`。
之后想更换，在 CLI 里用 `/set-key`。

> `.env` 已被 `.gitignore` 排除，不会误提交。
> 密钥仅显式传入模型中枢用于请求头；`bash` 工具启动的子进程环境会剥离
> 一切 `*_API_KEY` / `*_TOKEN` / `*_SECRET` 类变量。

在 [platform.deepseek.com](https://platform.deepseek.com) 获取 API Key。

## 使用

```bash
npm start          # 启动 TUI
npm run dev        # watch 模式（开发用）
```

> CLI 是终端交互程序，需要在**交互式终端**（Windows Terminal / PowerShell / Git Bash 等）中运行。
> 管道或无 TTY 环境下会直接给出提示并退出。

### 工作区

agent 的文件工具与 bash 的工作根目录（workspace）优先级：

```
--workspace <路径>  >  DSA_WORKSPACE 环境变量  >  自动判定
```

自动判定：若当前目录在源码根内 → 警告并切到 `~/.dsa/workspace`（自动创建）；
否则使用当前目录。

这样设计是为了避免在源码目录直接启动时，agent 把改动写进自身代码。
源码根作为**受保护目录**，写操作会被拒绝（读不受限）。

### 交互命令

| 命令 | 作用 |
|------|------|
| `/help` 或 `?` | 显示帮助面板 |
| `/mode explore\|ask\|execute` | 切换权限模式 |
| `/plan` | 开 / 关规划模式（只输出计划不执行） |
| `/style human\|professional\|raw` | 切换答复风格 |
| `/model flash\|pro` | 切换模型档位 |
| `/rollback [n]` | 回退最近 n 次文件变更（默认 1，仅当前工作目录） |
| `/outbound` | 查看出站数据留档摘要（内容摘要、体积、目的地） |
| `/set-key` 或 `/login` | 更换 API Key |
| `/clear` | 清空对话上下文与持久化会话 |
| `/exit` 或 `/quit` | 退出 |

**键盘快捷键**：`Ctrl+O` 展开/收起过程细节（默认只看结论与一行进度）；
`Ctrl+C` 中断当前思考 / 工具执行；`PageUp` / `PageDown` 与滚轮翻页。

### 输出风格（`/style`）

- **human（默认）**：用通俗类比解释，讲清「做了什么 / 为什么 / 怎么验证」。
- **professional**：规范术语、结论先行、保留技术细节。
- **raw**：保留模型默认输出。

## 工具

6 个原子工具，全部注册在 `src/core/tools/`。复杂能力（代码审查、依赖分析、
项目结构理解等）由模型组合这 6 个工具完成，**不做未实现能力的承诺**。

| 工具 | 说明 | 能力维度 | 风险级 |
|------|------|----------|--------|
| `read_file` | 读取文件（`offset`/`limit` 分段，二进制拒读） | read | 低 |
| `write_file` | 创建 / 覆盖文件（写前自动快照，可 `/rollback`） | write | 中 |
| `edit_file` | 字符串替换（要求唯一匹配；改前快照） | write | 中 |
| `list_files` | 递归列目录（`.git`/`node_modules` 等结构性排除） | read | 低 |
| `search_files` | 正则全文搜索（同上排除，命中上限 200） | read | 低 |
| `bash` | 执行 shell 命令（流式输出、可中断、超时强杀、env 凭证剥离） | exec | 高 |

路径相对工作区解析。写操作受源码目录保护约束（详见「工作区」一节）。

## 项目结构

```
src/
  core/        自研内核（本项目的心脏）
    loop/        ReAct 循环（AgentKernel）、CoreEvent 事件契约、系统提示、输出风格
    provider/    ModelHub 角色路由、OpenAI-compatible 适配器、SSE 解析、出站账本
    tools/       工具注册表（单一事实源）+ 6 个原子工具
    permission/  权限引擎（decide 三模式 + decide3 能力矩阵，纯函数）
    trace/       事件流 JSONL 落盘（UI / trace / eval 共用一条流）
  cli/         CLI 交互层（TUI 入口、登录、Markdown 渲染、字符净化）
  app/         聊天编排（chat.ts）+ trace-first 渲染内核（timeline.ts：事件流→转录折叠）
               + viewport 计算、React 控制器（消息列 = 事件日志的纯派生）
  config/      工作区解析与保护、模型档位配置
  auth/        凭证读写（0o600，密钥不入代码不入库）
  utils/       通用工具（日志、Markdown、文件回滚栈）
test/          单元与端到端测试（node:test，零额外依赖，无需 API Key）
eval/          黄金用例 22 个 + 可运行的评测 runner（--tier code 无密钥）
docs/          设计文档（重设计方案 ADR）与修复记录
```

## 开发

```bash
npm run typecheck   # TypeScript strict 类型检查（覆盖 src/test/eval/scripts）
npm test            # 单元 + e2e 测试（node:test，无需 API Key、无网络）
npx tsx eval/run-eval.ts --tier code   # 无密钥评测基线（mock 理想轨迹驱动真实内核）
```

- 类型检查开启 `strict`，无显式 `any`。
- `npm test` 只跑不依赖外部服务的用例，可在无网络、无密钥环境下执行。
- 内核端到端测试（`test/kernel-e2e.test.ts`）锁定核心不变式：事件契约、
  失败回灌、权限拦截、出站记账不可绕过、密钥不从 env 读取。

## 安全说明

- 密钥只保存在本地 `.env` 或 `~/.dsa/credentials.json`（0o600），均不入库。
- 密钥显式传参进模型中枢，**不写 `process.env`**；`bash` 子进程环境剥离凭证类变量。
- 序列化函数签名拿不到密钥——密钥在结构上进不了请求体与账本。
- 每次外发的字节数、SHA-256、消息构成、目的地逐条留档（`~/.dsa/outbound/`），
  先记账后发送，不可绕过；`DSA_OUTBOUND_DEBUG=1` 可落完整明文请求体自查。
- `.git`、密钥文件、构建产物被列举 / 搜索工具**结构性排除**，不存在可绕过的读取路径。
- 文件工具写操作限制在工作区内，路径遍历与受保护目录写入会被拒绝。

## License

基于 [MIT 许可证](./LICENSE) 开源。允许自由使用、修改与分发，唯须保留版权声明与许可声明。
