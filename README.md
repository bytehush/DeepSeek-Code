# DeepSeek Code Agent

一个直连 DeepSeek 官方 API 的**终端编程 Agent**。用中文交互，在终端里完成
「读代码 → 理解结构 → 改 / 建代码 → 跑命令验证」的闭环。

适合：想在本地用 DeepSeek 模型做编程辅助、且希望交互与产出都是中文的开发者。

> **当前形态：极简 CLI**。
> 2026-08-26 的 `6ed6596` 做过一次「极简模式」重构，砍掉了 Web GUI、RAG 记忆层、
> 技能系统、MCP、审查编排、Trace 等附加层，只保留 coding agent 本质。
> 本文档描述的是重构后的实际状态。

## 功能

- **直连官方 API**：无中转、无代理，密钥只保存在本地。
- **全中文交互**：对话、代码注释均为中文。
- **持久化 Agent**：基于 `@earendil-works/pi-agent-core`，跨轮累积上下文。
- **4 个原子工具**：`read_file` / `write_file` / `edit_file` / `bash`，复杂能力由模型组合完成。
- **权限三模式**：`explore`（只读）/ `ask`（需确认）/ `execute`（自动执行）。
- **Plan Mode**：先输出执行步骤，确认后再动手。
- **源码目录保护**：agent 的工作区与自身源码目录分离，写操作禁止落到源码根。
- **文件回滚**：`/rollback` 撤销最近的文件变更，按工作目录作用域隔离。
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
| `/set-key` 或 `/login` | 更换 API Key |
| `/clear` | 清空对话上下文 |
| `/exit` 或 `/quit` | 退出 |

**键盘快捷键**：`←` 打开会话 / 历史面板；`Ctrl+C` 中断当前思考 / 工具执行；
`PageUp` / `PageDown` 翻页；`Ctrl+End` 跳回最新消息。

### 输出风格（`/style`）

- **human（默认）**：用通俗类比解释，讲清「做了什么 / 为什么 / 怎么验证」。
- **professional**：规范术语、结论先行、保留技术细节。
- **raw**：保留模型默认输出。

## 工具

只有 4 个原子工具。复杂能力（代码审查、依赖审计、项目结构分析等）由模型组合这 4 个工具完成。

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件（支持 `offset` / `limit`） |
| `write_file` | 写入 / 覆盖文件 |
| `edit_file` | 字符串替换修改 |
| `bash` | 执行 shell 命令，流式返回输出 |

路径相对工作区解析。写操作受源码目录保护约束（详见「工作区」一节）。

## 项目结构

```
src/
  cli/         CLI 交互层（TUI 入口、登录、Markdown 渲染、字符净化）
  app/         内核装配、聊天主逻辑、viewport 计算、React 控制器
  agent/       Agent 运行时（Pi 适配、原子工具、系统提示、输出风格）
  config/      工作区解析与保护、模型档位配置
  auth/        凭证读写（scrypt 哈希）
  permission/  三模式权限闸门
  utils/       通用工具（日志、Markdown、文件回滚）
test/          单元测试（node:test，零额外依赖，无需 API Key）
eval/          评测用例定义与历史结果
scripts/       排查 / 验证脚本（非构建产物）
docs/          设计文档与 Bug 修复记录
```

## 开发

```bash
npm run typecheck   # TypeScript strict 类型检查（覆盖 src/test/eval/scripts）
npm test            # 单元测试（node:test，无需 API Key）
```

- 类型检查开启 `strict`，无显式 `any`。
- `npm test` 只跑不依赖外部服务的用例，可在无网络、无密钥环境下执行。

## 安全说明

- 密钥只保存在本地 `.env` 或 `~/.dsa/credentials.json`，均不入库。
- 文件工具的写操作限制在工作区内，路径遍历会被拒绝。
- 源码根作为受保护目录，agent 无法写入自身代码。
- 凭证用 scrypt 加盐哈希存储，无明文。

## License

基于 [MIT 许可证](./LICENSE) 开源。允许自由使用、修改与分发，唯须保留版权声明与许可声明。
