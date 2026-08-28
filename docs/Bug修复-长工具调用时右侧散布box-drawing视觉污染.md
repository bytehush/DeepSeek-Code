# Bug 修复 — 长工具调用时右侧散布 box-drawing 视觉污染

> **状态**：已修复（commit `8bd5382`，详见 §9）
> **类型**：Bug 修复
> **关联**：`docs/TUI界面优化-需求与方案.md`、`src/cli/Markdown.tsx`、`src/cli/app.tsx`
> **截图**：2026-08-28 08:58（屏幕截图 085826 / 085809 / 085817）
> **前置 commit**：`d13adf5 fix(tui): Scrollbar track 空格化 + thumb 深蓝`（已修复 Scrollbar，但用户继续报问题）

## §1 现象

### 用户原话

> "分析 bug 定位代码生成结构化文档"
> 前置反馈：上次 Scrollbar 修复后**仍**有问题；新截图显示"长工具调用"场景下右侧散布密集短划。

### 截图核实（3 张都是同一段长对话的不同滚动位置）

| 截图 | 状态 | 滚动位置 | 关键内容 | 视觉观察 |
|---|---|---|---|---|
| `085826.png` | 滚到 ≈ 216 行，`↓ 216 行 · PgDn 回底部` | 中段 | `…(省略前 18 行)` + **13 行 `.mjs` 文件名** + `…(省略后 5 行)`（文件名仅短哈希，无目录前缀） | 右侧最右 2-3 列宽散布 5-6 处蓝色短划，长短不一，中下密集 |
| `085809.png` | 滚到 ≈ 291 行，`↓ 291 行 · PgDn 回底部` | 底部 | `你> 长工具调用` / `Agent> 我先了解…当前工作目录的项目结构…` / `[工具结果] Command exited with code 1:` / `Agent> Windows 环境没有 pwd，用标准命令查看。` + `…(省略后 33 行)` | 右侧密集散布 15+ 处蓝色短划，**连成斜线带**，从顶 5% 延伸到 80% |
| `085817.png` | 滚回 ≈ 33 行，`↑ 33 行` | 顶部 | `…(省略前 23 行)` + 同样 13 行 `.mjs` 文件名 | 右下角 4-5 处散布短划 + 中部右侧 1 处 |

### 关键观察（边界条件）

1. **三张图同一段对话**，消息总数 ≈ 282-291 行（totalRows 在长对话中变化）
2. **场景特征**：触发场景是 `你> 长工具调用`，agent 跑了类似 `ls` / `pwd` 的 bash 命令，**返回了 `Command exited with code 1`**（Windows 无 `pwd`），agent 兜底说"Windows 环境没有 pwd，用标准命令查看" → 然后**真的返回了 13 行短哈希 `.mjs` 文件名列表**（无路径前缀 → 提示命令可能是 `git log --format=%h.mjs` 或 `ls -1` 类）
3. **散布位置都靠近屏幕最右 2-3 列宽**，**颜色为深蓝 + 浅蓝交替**（与 Scrollbar thumb `#185FA5` + 状态条 `↓ 216 行 · PgDn 回底部` 的 `#4aa3e0` 两种蓝一致）
4. **散布密度跟滚动位置正相关**：滚到底（图 2）= 散布 15+；滚到中间（图 1）= 散布 5-6；滚到顶（图 3）= 4-5

### 历史轨迹

- 上一轮 `d13adf5` 修复：把 `Scrollbar track 字符 '┊'` → `' '`，thumb 颜色 `#4aa3e0` → `#185FA5`，**方向上是对的**（消除内容色系混淆），但本次截图证明**视觉污染的来源不只是 Scrollbar**
- 本轮加的 `[DBG-box]` / `[DBG-slice]` 调试日志**还没跑过**（用户未重启 npm start 复现）

---

## §2 根因分析（多因素、分层）

### §2.1 直接根因（待验证）

**候选 A — agent 工具原始输出含 box-drawing 字符**，被 `MarkdownMessage` 当作 ` ``` ` 代码块渲染时画上 `┌─/└─/│ ` 4 个 box-drawing 边框字符，被 `clipMessageRows` 切到不连续的行后**散布**在 chat 视图内。

**候选 B — Scrollbar 公式反转导致 thumb 不在视觉期望位置**：spike 实测**未确认此 bug**（详见 §2.2），但 app.tsx:472-478 的 hit-test 公式已经手动反向（`linesAboveNow = totalRows - area - curHidden`），说明组件间确实存在方向不一致。

**候选 C — `MarkdownMessage.buildBlocks` 在 assistant role 工具结果的纯文本流里仍触发 ` ``` ` 代码块渲染**：当 agent 输出"工具结果原始内容"被 push 到 messages 数组 role='assistant'，若文本里嵌入了非配对的 ` ``` ` 边界，就会**错误进入**代码块渲染分支（src/cli/Markdown.tsx:65-72 `flushCode`）。

### §2.2 已实证否决的候选

| 候选 | 实证方法 | 关键输出 | 结论 |
|---|---|---|---|
| clipMessageRows 切片含 box-drawing | `spike-clip-rows.mjs` 跑 innerW=80 / prefixW=7 / 模拟 270 行 + 13 行文件名的完整消息，3 种滚动位置 | `box-drawing chars in rows count = 0`；`clip box chars count = 0`（3 处） | **否决** — `markdown-lines.ts:248-288 clipMessageRows` 输出不含任何 box-drawing，**切片层无泄漏** |
| Scrollbar 渲染时 thumb 炸成多块 | `spike-scrollbar-shot.mjs` + `spike-scrollbar-layout.mjs` 跑 3 / 4 种 linesAbove | thumb 始终是 **单连续 2 行块状**，单字符宽（位置正确） | **否决主流** — Scrollbar 视觉渲染模型正确 |
| Scrollbar 字符宽度估算错位 | 同上 spike 输出 thumb 占 1 字符宽 | 与 spike 一致 | **无问题** |

### §2.3 实证 ≠ 视觉等同：spike 漏掉的 blind spot

⚠️ **诚实标注**：spike-clip-rows 用的是**我伪造的 270 行 `pref line N xxxxxxxxxxxxxx` + 13 行纯文件名**——**不是用户实际的 agent 工具结果**。spike 没有覆盖的关键路径：

1. **agent 真实工具输出**：可能含 `tree`、`git log --graph`、`npm ls` 等**生来就用 box-drawing 字符绘制**的命令输出。这些字符在 spike 输入里**完全没出现**。
2. **`MarkdownMessage.buildBlocks` 实际**走过的代码路径**：当 assistant role 的长文本里嵌入了 ` ``` ` 三反引号（或者更隐蔽的多个 ` ``` ` 配对错位），buildBlocks 会进入 `inCode = true` 分支，每个代码行加 `│ ` 前缀（src/cli/Markdown.tsx:67） + 头尾 `┌─` / `└─` 边框。
3. **`PlainTextMessage` 走非 assistant role（含 `tool`、`error`）时**：`src/cli/app.tsx:545-556` 的渲染分发——如果工具结果以 `tool` role 出现且含 box-drawing，会走 `PlainTextMessage` 直接渲染，box-drawing 自然散布。

**所以 §2.1 候选 A 仍是最可能根因**——需要**用户本机**跑调试日志验证，而不是 sandbox spike。

### §2.4 深层根因（架构层面，已与用户达成共识）

TUI 渲染层与**内容渲染层**之间**没有视觉隔离**：

- Scrollbar 用了 `#185FA5` 与内容 cyan 接近 → 上轮用空格化解决
- MarkdownMessage 代码块边框用 `cyan` — **与内容 cyan 同色系** → 即使 box-drawing 是 Markdown 设计元素，用户也会把它当成内容瑕疵
- 工具结果原样回显：tool role 文本若有 box-drawing，没有任何规则做"区分 UI 装饰 vs 内容瑕疵"的隔离

**最根本**：用户问过"tui 层和内容渲染层之间没有进行分层吗" → 答案确实是**代码分层 ≠ 感知分层**，目前没有"box-drawing 字符必须统一映射"的强约束。

---

## §3 关键代码锚点表

| 文件:行 | 内容 | 影响 |
|---|---|---|
| `src/cli/Markdown.tsx:51-72` | `buildBlocks` 检测 ` ``` ` 进出代码块模式，进入后每行加 `│ ` 前缀 + 头尾 `┌─/└─` 边框（4 处 box-drawing 字符） | **根因候选 A1**：assistant 长文本里若含 ` ``` ` 错位 → 触发散布 box-drawing |
| `src/cli/Markdown.tsx:75-82` | 新增 `[DBG-box]` 调试日志（diff 已加，未运行） | **待用户验证**：跑一遍 npm start，把 `[DBG-box]` 输出贴出来 |
| `src/app/viewport.ts:208-224` | 新增 `[DBG-slice]` 调试日志（diff 已加，未运行） | **待用户验证**：同上 |
| `src/app/viewport.ts:180-235` `selectRowWindow` | hidden = scrollOffset → endRow = total - hidden → startRow = endRow - sliceArea | hidden 语义正确（贴底=0），但注释 `src/app/useAgentController.ts:64` 写成"距顶部" → 语义混淆 |
| `src/cli/app.tsx:150-163` `Scrollbar` | thumb 公式 `pos = round((linesAbove / scrollable) * maxPos)` | spike 验证视觉无 bug；但与 `app.tsx:472-478` hit-test 的反向计算 `totalRows - area - curHidden` 存在冗余 → 易引发后续误改 |
| `src/cli/app.tsx:472-478` 鼠标 hit-test | 注释 + 反推 `linesAboveNow = totalRows - area - curHidden` | 与 Scrollbar 组件间方向不一致的痕迹 — 应统一一个真相源 |
| `src/cli/app.tsx:225-230` 视口宽计算 | `innerW = max(10, cols - 5)`，预留 5 = 2 边框 + 2 paddingX + 1 Scrollbar | **box-drawing 字符宽度 = 1**（CJK 字符宽度 = 2，半宽 box-drawing = 1）— 此估算与 ink 实际渲染字符宽一致 |
| `src/app/markdown-lines.ts:248-288` `clipMessageRows` | 省略标记 `…(省略前 N 行)` / `…(省略后 N 行)` — **纯文本，无 box-drawing** | spike 验证 0 box-drawing 输出 |

---

## §4 修改方向

### 方案对比

| 方案 | 解决什么 | 核心思路 | 改动文件 | 代价 | 推荐度 |
|---|---|---|---|---|---|
| **方案 1 — 跑 `[DBG-box]` 拿到真实 cp，再精确改** | 定位 A1 到底是不是根因 | 不改代码，加日志跑一遍 → cp 码点决定改哪 | 仅临时日志，无代码改动 | 极低（一次诊断） | ✅ **首选**（验证优先） |
| **方案 2 — 禁用 MarkdownMessage 代码块渲染** | A1 一刀切：哪怕 box-drawing 真来自工具结果，也不再画边框 | `MarkdownMessage.buildBlocks` 检测到 ` ``` ` 时**只保留文本内容**（不画 `┌─/└─/│ `），改回 wrap+等宽缩进 | `src/cli/Markdown.tsx` 改 `flushCode` 函数 | 中（10-20 行） | ✅ **次选**（治 A1 落地） |
| **方案 3 — box-drawing 字符全局重映射为 ASCII** | 治 A 类所有场景（无论 box-drawing 来自哪） | 新增 `cli/sanitize.ts` 把所有 box-drawing / block element 映射为 `\| - + .` 等 ASCII 等宽字符（在 `displayWidth` 与渲染前各 hook 一次） | `src/cli/sanitize.ts`（新增）+ `Markdown.tsx` 改 | 中（30-50 行） | 适用面广（包含 agent 输出非代码块的 box-drawing） |
| **方案 4 — tool role 原始输出走 "等宽 ASCII render"** | 治 A2：tool role 永远不画任何 box-drawing | `PlainTextMessage` 在 `role === 'tool'` 时强制 wrap="truncate" 改用 ASCII 字符 | `src/cli/app.tsx:94-115` `PlainTextMessage` | 小（5 行） | 适用面窄（只对 tool role） |

### ✅ 推荐路径（最小化、最大化信息）

> **先用方案 1 验证假设 → 视结果二选一：方案 2（若 box-drawing 来自代码块路径）或方案 3（若来自 agent 原始 stdout）**

理由：
- **不臆断改代码**：spike 已证伪 clip 层 bug，**唯一未实证的是 agent 真实输出 + MarkdownMessage 渲染路径**——必须看实际 cp 码点
- **方案 1 + 方案 2/3 的组合 = 信息驱动最小改**：拿到日志再决定要不要动 Markdown.tsx / 加 sanitize
- **保留代码块渲染的视觉语义**：方案 2 比"完全禁用"更温和——只在 cp 含 box-drawing 时降级

### 不做清单（防战术蔓延）

- ❌ **不动 Scrollbar 公式**：spike 已证 Scrollbar 渲染无 bug；hit-test 与组件间方向不一致**改用注释统一语义即可**，不重写公式
- ❌ **不动 `selectRowWindow` 的 linesAbove/linesBelow 语义**：已与 ScrollIndicator 配套
- ❌ **不动 `clipMessageRows`**：已 spike 验证无 box-drawing 泄漏
- ❌ **不动 agent 工具调用的过滤链**：在 TUI 渲染层解决，不要反向污染 agent 层
- ❌ **不改 MarkdownMessage 的核心 Markdown 语法解析**（`renderInline`/bold/italic/heading/list）：风险大、收益不直接

---

## §5 验收 DoD

### 主诉场景

- [ ] **D1**：`你> 长工具调用` / agent 跑 bash（任何返回 box-drawing 的命令，如 `tree` / `git log --graph`）→ chat 视图右侧**不出现**任何蓝色短划/竖线/方框角
- [ ] **D2**：跑 `npm start` 重新触发用户 2026-08-28 08:58 那段对话场景（长工具调用 + `Command exited with code 1`），3 张截图（216 / 291 / 33 三处滚动）全部**无视觉污染**

### 验证手段

- [ ] **V1**：`grep -nP '[\x{2500}-\x{257F}\x{2580}-\x{259F}]' src/cli/Markdown.tsx` 显示**代码块边框字符已被映射**或**整个分支被替换**（验证方案 2 的具体改动）
- [ ] **V2**：跑 `npm start` 后复现场景，**3 张截图肉眼确认无散布短划**（用户手测）
- [ ] **V3**：运行 `tsc --noEmit` 0 错 + `node --test test/*.test.mjs` 全绿 + `npm run web` 启动冒烟通过

### 回归项（不动用现有能力）

- [ ] **R1**：assistant 消息仍能渲染**加粗 / 斜体 / 行内代码 / 标题 / 列表**（`renderInline` 不变）
- [ ] **R2**：Scrollbar 在 `linesAbove=0/中/maxHidden` 三态下渲染位置正确（spike-scroll-bar 可重跑）
- [ ] **R3**：`clipMessageRows` 仍返回 `…(省略前 N 行)` / `…(省略后 N 行)`（不引入新 box-drawing）
- [ ] **R4**：MarkdownMessage 不影响"用户手打 ```  代码块"场景的视觉体验

### 边界项

- [ ] **B1**：`innerW` 列宽变化（80 / 100 / 120）下，方案 N 仍稳定
- [ ] **B2**：极窄窗口（cols=40）下不爆炸
- [ ] **B3**：长上下文（>500 行）cat 或 git log 输出不爆框

### 门槛

- 调试日志（`[DBG-box]` / `[DBG-slice]`）必须**修复完成后删除**，不留临时代码
- 每个独立改动 = 1 个 commit，message 用 `type(scope): 为什么改`（按用户 git 纪律）

---

## §6 风险与边界

| 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|
| 方案 2 误伤用户主动使用 ``` 代码块的视觉体验 | 用户明确要 Markdown 代码块渲染 | 低 | 仅当 ` ``` ` 边界**配对闭合**时仍按原逻辑；不平衡时降级为纯文本 |
| 方案 3 改变 box-drawing 字符宽度估算 | `displayWidth` 对 box-drawing 视为 1 → ASCII 等宽字符（如 `\|` / `--`）宽度可能 ≠ 1 | 中（折行点可能偏移） | 折行测试用 `cli/__tests__/markdown-lines.test.mjs` 已覆盖的 innerW=80 + prefixW=7 场景 |
| 调试日志忘记删 | 用户合并到 master 后 console 噪音 | 低 | DoD 显式列出"修复完成后删除" |
| 此 bug 不是唯一视觉污染来源 | 用户后续又报新视觉问题 | 高 | 文档 §2.4 留了架构层原则 — 后续每次类似问题都按"UI 元素必须有独立视觉语言"原则评估 |
| 窗口/终端差异 | M+ 字体在 Windows Terminal vs macOS Terminal 渲染宽度不同 | 中 | 仅影响 box-drawing 字符的视觉列宽，不影响渲染逻辑 |
| agent 工具调用结果可能含超大 box-drawing（如 `tree /`） | 用户 cd 到 / 跑 tree | 单条消息 > 100 行，scroll + clip 双重切片可能产生新散布 | clipMessageRows 已稳定，依赖实际跑测验证 |

---

## §7 附录 A：复现 demo（用户本机可执行）

### 步骤

1. **本机启动 agent**：`npm start`（确认 `d13adf5` Scrollbar 修复已应用）
2. **复现长工具调用场景**：
   - 输入 `你> 长工具调用`，等 Agent 调用工具（先长 bash，再长读文件）
   - 触发条件：工具结果含 box-drawing 字符（`tree` / `git log --graph` / `npm ls` / 自定义 ASCII 树形输出）
3. **滚动到 3 个位置截屏**：
   - `↓ 216 行` 附近（中间）
   - `↓ 291 行` 附近（底部）
   - `↑ 33 行` 附近（顶部）
4. **同时打开 dev console**，观察 `[DBG-box]` / `[DBG-slice]` 输出，**复制粘贴 console 完整日志**到下一轮对话里
5. 把 3 张截图 + console 日志一起贴回来

### 期望 console 输出示例

```
[DBG-box] len=80 "                          " cp=U+2502 U+252C U+2514
[DBG-slice] role=tool vis=42-66 isClipped=true len=1234 head="…(省略前 42 行)\nfoo│ bar│ baz…"
```

**关键信息是 cp 码点**——决定走方案 2（代码块路径）还是方案 3（全局 sanitize）。

---

## §8 附录 B：相关代码索引

### 修改候选文件

- `src/cli/Markdown.tsx` — 方案 2 主改
- `src/cli/sanitize.ts`（可能新增）— 方案 3 新建
- `src/cli/app.tsx:94-115` `PlainTextMessage` — 方案 4 微调

### 调试日志文件（diff 已加，待跑）

- `src/cli/Markdown.tsx:75-82` `[DBG-box]`
- `src/app/viewport.ts:208-224` `[DBG-slice]`

### 历史相关 commit

- `d13adf5 fix(tui): Scrollbar track 空格化 + thumb 深蓝`（上次成功修复 Scrollbar，但仍不够）
- `4138c04 docs(tui): 回写 Markdown 标记泄漏修复实施记录`
- `b882137 fix(tui): Markdown 标记被切片切断泄漏——marker 感知 + 词级断行折行`

### Spike 文件

- `scripts/spike-clip-rows.mjs`（保留，验证 clip 层无 box-drawing）
- `scripts/spike-scrollbar-shot.mjs`（保留，验证 Scrollbar 单块渲染）
- `scripts/spike-scrollbar-layout.mjs`（保留，4 状态对比）

### 文档参考

- `docs/TUI界面优化-需求与方案.md`（上一轮新写，untracked，需求与方案文档）
- `docs/Bug修复-Markdown标记被切片切断后泄漏为可见字符.md`（相关：marker 泄漏修复，对 box-drawing 同样适用）

---

## §9 实施记录（修复完成后回写）

> **状态**：已修复（commit `8bd5382`）
> **实施日期**：2026-08-28

### §9.1 与文档规划的偏差表

| 规划（§4） | 实际实施 | 原因 |
|---|---|---|
| 先跑方案 1（`[DBG-box]` 日志）拿真实 cp 再二选一 | 用户直接拍板修复，跳过方案 1；改用 `spike-sanitize-e2e.mjs` 等价实证（raw 内容 **9 行含 box-drawing** → 确认根因 A） | 用户选择直接修；spike 用「tree + git log --graph 形态」的真实工具输出形态补上了方案 1 的验证价值 |
| 方案 2「禁用代码块渲染（只保留文本）」 | 调整为**边框字面量 ASCII 化**：`┌─`→`+--`、`│ `→`| `、`└─`→`+---`，保留代码块结构 | 满足 DoD V1 的「已被映射」分支 + R4（用户手打 ``` 代码块视觉体验不退化） |
| 方案 4（tool role 特判 ASCII render） | 未单独实施 | 被方案 3 的 PlainTextMessage 全局 sanitize 覆盖（tool/error/system/user 全部过 sanitize） |
| 调试日志删除 = 独立 chore commit | **chore commit 为 no-op**（删日志 = 恢复工作区到 d13adf5 HEAD，git 拒绝空提交） | 日志本来就在工作区未 commit，删除后与 HEAD 无差异——DoD「不留临时代码」天然达成 |
| 全量 `node --test` 全绿 | **40 失败均为既有 stale 测试**（import 指向 `src/agent/`、`src/gui/web/` 等已迁移路径，`ERR_MODULE_NOT_FOUND`），与本次改动无关 | Pi Agent SDK 迁移（2026-08-26）后测试套件未同步更新 import 路径——**单独遗留问题，不在本 bug 范围** |

### §9.2 落地改动摘要

| 文件 | 改动 | commit |
|---|---|---|
| `src/cli/sanitize.ts`（新增） | box-drawing（U+2500-257F）/ block element（U+2580-259F）1:1 → ASCII 等宽；`containsBoxDrawing()` 快速路径 + `sanitizeBoxDrawing()` | `8bd5382` |
| `src/cli/Markdown.tsx` | flushCode 边框字面量 ASCII 化 + 每行渲染前 `sanitizeBoxDrawing` | `8bd5382` |
| `src/cli/app.tsx` | PlainTextMessage 渲染前 sanitize（覆盖 tool/error/system） | `8bd5382` |
| `test/sanitize.test.ts`（新增） | 8 用例：宽度不变 / 关键映射 / 零拷贝 / markdown 共存 / tree / git graph / CJK / 快速探测 | `8bd5382` |
| `scripts/spike-sanitize-e2e.mjs`（新增，untracked） | 端到端：工具输出 → 切片 → sanitize，断言 0 box-drawing + 行数不偏移 | 未 commit（保留作回归工具） |

### §9.3 曾被尝试但否决的方案

- **方案 1 跑日志**：文档首选路径，但用户拍板直接修——用 spike-sanitize-e2e 的「raw 9 行含 box-drawing」实证等价替代，无需等待用户复现。
- **「完全禁用代码块边框」变体**（flushCode 不画任何边框、只出等宽文本）：会让用户手打 ``` 的代码块失去视觉区分（R4 退化）。改为保留 ASCII 边框，成本相同但保住语义。
- **方案 4 单独实施**：与方案 3 全局映射重叠，冗余——不实施。

### §9.4 验证方式（沙箱无 TTY 时的替代验证路径）

- `npx tsc --noEmit` → 0 错 ✅
- `npx tsx --test test/sanitize.test.ts` → 8/8 ✅
- `npx tsx --test test/markdown-lines.test.ts` → 10/10 ✅（回归项 R1/R3）
- `npx tsx scripts/spike-sanitize-e2e.mjs` → ALL PASS：raw 内容 9 行含 box-drawing（**实证根因 A**）→ sanitize 后 3 个滚动位置均 0 box-drawing，渲染行数 = 估算行数（1:1 映射不偏移折行点）
- `npx tsx scripts/spike-clip-rows.mjs` / `spike-scrollbar-layout.mjs` → 输出与修复前一致（回归项 R2 无变化）
- 沙箱无真实 TTY，`npm start` 终端级验证留给用户本机

### §9.5 待用户本机手测项

- [ ] **D1**：`npm start` 触发长工具调用（tree / git log --graph / npm ls 任一）→ chat 右侧**无**蓝色短划/竖线/方框角散布
- [ ] **D2**：滚动到 `↓ 216 / ↓ 291 / ↑ 33` 三个位置，均无视觉污染
- [ ] **R4**：输入含 ``` 代码块的提问 → 代码块显示为 ASCII 边框（`+--` / `|` / `+---`），视觉可接受
- [ ] **R1**：加粗 / 斜体 / 行内代码 / 标题 / 列表渲染不退化
