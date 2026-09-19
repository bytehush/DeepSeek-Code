# AGENTS.md — DeepSeek CLI 编程 Agent 操作手册 & 项目 Spec

> 本文件既是给 Agent 自身的「操作手册」，也是本项目的 **Spec**。
> **当前形态：极简 CLI**（`6ed6596 refactor(core): 极简模式` 之后的实际状态）。

## 1. 项目定位

直接接入 **DeepSeek 原生 API** 的命令行编程 Agent。面向中文开发者，在终端完成
「读代码 → 理解结构 → 改 / 建代码 → 跑命令验证」的闭环。

**不做万能助手**，只做编程垂直场景，且保持最小形态。

## 2. 目标用户 & 高频任务

- **目标用户**：无法 / 不愿使用 Claude 海外账户的开发者；中文母语；习惯终端工作流。
- **高频任务**：
  1. 理解陌生代码库（读文件、看目录结构）
  2. 实现新功能 / 修复 bug（编辑、新建文件）
  3. 重构（多文件协同修改）
  4. 跑命令验证（构建、测试、lint、git 状态）
  5. 多轮对话保持上下文记忆（由持久化 Agent 承担）

## 3. Agent 工具列表（共 4 个）

> **设计原则**：工具越少，模型选型越准、行为越可控。
> 极简模式下只保留 4 个原子工具，复杂能力由模型用这 4 个组合完成，
> 不再提供自研领域工具（曾经的 `review_code` / `audit_dependencies` / `terminology` /
> `project_discover` / `delegate` 等已在 `6ed6596` 中删除）。

| 工具 | 参数 | 说明 | 风险级 |
|------|------|------|--------|
| `read_file` | `path`, `offset?`, `limit?` | 读取文件内容 | 低 |
| `write_file` | `path`, `content` | 写入 / 覆盖文件 | 中（覆写） |
| `edit_file` | `path`, `old_string`, `new_string` | 字符串替换（需唯一匹配） | 中（覆写） |
| `bash` | `command`, `cwd?` | 执行 shell 命令，流式返回 stdout / stderr | 高（需确认） |

**路径解析**：相对路径基于 workspace（agent 的工作目录）解析。

**写路径保护**：写操作若落在受保护目录（源码根）内，直接拒绝并把错误回灌模型。
覆盖相对路径、绝对路径、`..` 逃逸三种形态。

**失败处理**：工具直接 throw，Pi Agent 会把错误作为 tool error 回灌给模型，
模型据此自我纠正，不静默跳过。

## 4. 拒答边界

- **绝不执行**：`rm -rf /`、格式化磁盘、修改系统关键文件、读取并回显 `.env` 等密钥文件内容。
- **绝不替代人类做不可逆决策**：`git push --force`、`DROP DATABASE`、批量删除需用户显式确认。
- **绝不写入源码根**：避免 agent 修改自身代码。

## 5. 确认点（权限层）

- 危险命令 / 覆写重要文件 → 默认 **Ask** 模式，需用户确认。
- 读 / 普通命令 → 默认 **Execute** 模式，自动放行。
- 支持三档切换：`Explore`（只读安全）/ `Ask`（需确认）/ `Execute`（自动放行）。

## 6. 架构边界

- **应用交互层**（`src/cli`、`src/app`）：TUI 渲染、登录、Markdown 展示、
  workspace 解析、React 状态控制器。
- **Agent 运行时层**（`src/agent`）：Pi Agent 适配、原子工具、系统提示、输出风格。
- **配置层**（`src/config`）：工作区解析与源码目录保护、模型档位（flash / pro）。
- **权限层**（`src/permission`）：三模式闸门决策。
- **凭证层**（`src/auth`）：API Key 读写（scrypt 哈希）。
- **通用层**（`src/utils`）：日志、Markdown 处理、文件回滚栈。

**已删除的层**（`6ed6596`，不再存在于代码中）：
`gui/`、`gui/web/`、`memory/`（RAG 记忆）、`skills/`（技能加载）、`mcp/`（MCP 客户端）、
`review/`（审查编排）、`context/`（历史 + trace）、`history/`（会话面板）、
`llm/`（自研 API 封装，现由 `@earendil-works/pi-ai` 承担）、`tools/`（自研工具集，
现仅保留 `agent/pi-tools.ts` 的 4 个原子工具）。

## 7. 运行方式

```bash
npm start          # 启动 TUI
npm run typecheck  # 类型检查（覆盖 src/test/eval/scripts）
npm test           # 单元测试（node:test，无需 API Key）
```

**模型**：`deepseek-v4-flash`（默认，快）/ `deepseek-v4-pro`（深度推理），
CLI 内用 `/model` 切换。

**工作区**：`--workspace` flag > `DSA_WORKSPACE` env > 自动判定。
自动判定时若 cwd 在源码根内，切到 `~/.dsa/workspace`。

## 8. 评测

`eval/` 保留了 23 个黄金用例的**定义**（`cases.ts`、`golden-cases.md`）。

> ⚠️ 原评测执行脚本 `eval/run-eval.ts` 依赖已删除的 `src/llm/`、`src/context/`、
> `src/tools/`，已在极简模式收尾时移除。当前评测套件**不可直接运行**，
> `cases.ts` 作为未来重写评测时的素材保留。

## 9. 开发纪律

- **受控改动**：不重构、不过度优化、不动无关代码。
- **改前先列清单**：改动文件 + 原因 + 影响范围，确认后才动手。
- **typecheck 是底线**：`npx tsc --noEmit` 零错误才能提交。
  （tsconfig 的 `include` 已覆盖 `src` / `test` / `eval` / `scripts`，
  避免出现「检查不到坏引用」的盲区。）
- **单元测试**：不依赖外部服务的用例必须通过（`npm test`）。
- **发现无用代码走 git 历史**：删除前确认目标确实无引用，删除后 commit message
  说明原因。

## 10. 后续演进

当前阶段目标：**把 CLI 做扎实**。这是进入后续发展的前提。

不在当前范围（如需引入，应新建结构化设计文档后再实施）：
- 自研差异化工具（代码审查、依赖审计、术语对照等）
- 记忆层 / 技能系统 / MCP 接入
- Web GUI
