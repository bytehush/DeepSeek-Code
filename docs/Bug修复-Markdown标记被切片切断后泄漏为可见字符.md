# Bug 修复——Markdown 标记（`**`）被行级切片切断后泄漏为可见字符

> **状态**：待修复（文档就绪，等用户拍板再写代码）
> **类型**：Bug 修复（视觉瑕疵 + 文档可信度）
> **关联**：与 `docs/UX优化-连续滚动与滚动条拖动.md`（行级切片上线）的回归
> **截图**：`屏幕截图 2026-08-27 204528.png`（`↓ 348 行`） / `屏幕截图 2026-08-27 204536.png`（`↓ 393 行`）

---

## 1. 现象（用户描述 + 截图核实）

**用户描述**：「分析图中 bug 生成结构化文档」——两张截图均截自同一长会话的不同滚动位置，肉眼可见两类瑕疵：
1. **可见的 `**` 标记**：在应当渲染为加粗样式的位置上，反而以**裸字符 `**`** 出现于输出文本之中。
2. **右侧散布的蓝色竖线/短划**：聊天区右半部分（不同行、不同列）零散出现 `*` / `│` / `┊` 一类**单字符宽的标记碎片**。

**截图逐张核实**：

| 截图 | 滚动位置 | 文本对照 | 可见瑕疵 |
|---|---|---|---|
| 204528 | `↑ 114 行 / ↓ 348 行`（滚到上方历史） | `Agent> 我看到这是一个项目目录。让我读关键文件 (package.json、README、feature_list)...` `✓ 执行工具 read_file` `…(省略后 31 行)` | 多条右侧散布的蓝色短划/竖线；间距不规则 |
| 204536 | `↑ 159 行 / ↓ 393 行`（更深的历史） | 顶部 `(省略前 40 行)` / 中部 `✓ 执行工具 read_file` / 段落「...Git 集成等能力,并同时提供 ** 产生都是中文的开发者。」/ 「—**双模型路由**:主循环用 ... 推理模型 `deepse`」/ `(省略后 215 行)` | **可见 `**` 字符**嵌入正文；右侧同样散布蓝色短划 |

**关键观察**：
- **可见 `**` 出现在文本流中**（截图 1 第 4-5 行），按设计它应当被 `Markdown.tsx:23` 的 regex `/(\*\*([\s\S]+?)\*\*/g)` 解析为不可见 marker。
- **碎片散布在所有滚动状态下都存在**（顶、中、底），不是某个特定 scroll offset 暴露。
- **只在长对话被切片时出现**：`(省略前/后 N 行)` 标记的存在 = 切片发生过 = 触发条件满足。
- 用户认知里这等同于「文档里漏出了源代码符号」——既丑又失信。

**矛盾点（强信号）**：`renderInline` 的正则**明确**会消费 `**...**`；当 `**` 完整可见时本不该泄漏。泄漏 ⇒ 正则**没有匹配上这一对**——这是根因定位的关键线索。

---

## 2. 根因分析

### 2.1 直接根因：行级切片把配对 marker 切断后，孤儿 `**` 被 renderInline 当作普通文本输出

两条数据通路：

```
messages[i].text（原始 markdown，带 **）
  ↓ useAgentController 累积（纯字符串拼接，无 markdown 知识）
splitTextToLines(text, innerW, prefixW)            ← markdown-lines.ts:40
  ↓ 按 displayWidth 字符级折行；不知道有 markdown
clipMessageRows(..., visStart, visEnd)             ← markdown-lines.ts:96
  ↓ 行级切片；可被裁只剩「开头部分」/「结尾部分」
MarkdownMessage(text={sliced})                     ← cli/app.tsx:541
  ↓ buildBlocks → renderInline → 正则解析 **
若 sliced 只包含配对 `**` 中的一个，孤儿作为字面文本渲染
```

- 输入例：原文本 `...并同时提供 **MCP 工具**，让...`
- `splitTextToLines` 按列宽在某处换行；若换行点恰在 `**...**` 内部
- `clipMessageRows` 取可见段[visStart, visEnd)；若可见段只裁到 `**MCP` 这块，`**` 成了孤儿
- `renderInline` 看不到完整配对 → `text.slice(last, m.index)` 把这段裸文本（含 `**`）push 出去 → 渲染为可见字符

> 既然 renderInline 的正则 `[\s\S]+?` 是**非贪婪且跨行**的，单纯「折行在中间」不会断；真正的切断点来自 **`clipMessageRows` 的可见区间 visStart/visEnd 把 `**xxx**` 两端推到不同可见段**（一段含 `**`，另一段含 `**`，中间 `xxx` 在省略区里）。

### 2.2 深层根因：测量宽度 ≠ 渲染宽度（`splitTextToLines` 把 `*` 当 1 列，但渲染 0 列）

- `displayWidth('*') === 1`（markdown-lines.ts:13，单宽 ASCII）
- `splitTextToLines` 因此为 `**` 预留 2 列宽度
- 实际渲染：asterisk 经 `renderInline` 解析后**成为不可见 marker**（折入 `<Text bold>`），**占用 0 列**
- 当 `**恰好卡在切行点附近`：
  - 测量层认为 `**` 占 2 列，划在行尾
  - 渲染层认为 `**` 不占列，行内容会向左缩进
  - 视觉上产生「右边缘的竖线」——即截图里散落的蓝色短划/星号碎片

> 也就是说，**散布的蓝色碎片极可能是 `*` / `**` 卡在切行边缘**：(1) 行级切片让它落在右侧列上；(2) ink 的 `<Text>` 节点交叠造成渲染残留/重叠 → 出现零散短划。

### 2.3 最深层根因：行级切片模型缺少「Markdown 语法感知」层

`splitTextToLines` 与 `clipMessageRows` 把文本当作纯字符串处理。它们不知道：

| 不知道的事 | 引发问题 |
|---|---|
| `**` / `*` / `` ` `` 是成对 marker | 切在中间会把 marker 留成孤儿 |
| marker 宽度=0（渲染后） | 测量宽度偏大、行尾留位 |
| `*`/`**` 与中文/半角符号相邻时无空格 | 终端可能把 `文字**` 黏连成一团 → 视觉密集 |

**任一修复都必须在切片层引入 markdown 边界感知**——要么在切片前剥离 marker（最简单）、要么切片时跳过 marker 区域（保留结构但易对齐错位）、要么重新设计让切片作用于已解析的 block 列表（最彻底但改动大）。

---

## 3. 关键代码锚点表

| 文件 : 行 | 内容 | 影响 |
|---|---|---|
| `src/app/markdown-lines.ts:40-69` | `splitTextToLines`——字符级折行，把 `*` 当 1 列 | 测量宽度偏大；marker 可被切行点切在边缘 |
| `src/app/markdown-lines.ts:96-136` | `clipMessageRows`——按 [visStart, visEnd) 切可见行对，可让配对 marker 落到不同时段 | 孤儿 `**` 的源头 |
| `src/app/markdown-lines.ts:13-28` | `displayWidth`——`*` 计为 1 列，与渲染实际列宽不一致 | 估算偏大，错估行数；也是右边缘碎片散布的次因 |
| `src/cli/Markdown.tsx:20-42` | `renderInline`——`\*\*([\s\S]+?)\*\*` regex；匹配失败的文本经 `text.slice(last, m.index)` 原样 push | 孤儿 `**` 渲染出口 |
| `src/cli/app.tsx:540-547` | `MarkdownMessage text={it.text}`——接收 clipped text 后不再二次过滤 | 切片结果到此定型，修复必须上溯 |
| `src/app/useAgentController.ts:107-112` | `appendTo`——纯字符串 `+=` 追加 chunk | LLM 半成对的 `**`（如先打 `**bold` 再续 `text**`）会在中途进入 messages |
| `src/cli/Markdown.tsx:111` | 无序列表 regex `/^[-*]\s+(.*)$/`——切到行首 `**` 不会误识别（`[-*]` 是列表） | 不属本次 bug，但提示：marker 解析与切片边界天然冲突 |

---

## 4. 修改方向（≥2 方案 + 推荐 + 不做清单）

### 方案 A：切片前剥离 markdown marker，再让 `splitTextToLines` 测量渲染真实宽度（推荐，最小变更）

**核心思路**：在 `splitTextToLines` 和 `clipMessageRows` 入口增加「去 marker」中间步骤：
- 维护一份 `maskedText`：把 `**...**` 替换为等长空白、`*...*` / `` `...` `` / `~~...~~` 同理
- `displayWidth(maskedText) === 估算后真实渲染宽度`（marker 占用 0 列）
- 在 maskedText 上折行后，再把行号映射回原 text 取真实字符

**改动文件**：
- `src/app/markdown-lines.ts`：新增 `maskMarkdownMarkers(text: string): string`（最简实现：`s.replace(/\*\*([\s\S]+?)\*\*/g, (_, inner) => ' '.repeat(inner.length))`，其它类型同款；不实现粗体内嵌套）
- `splitTextToLines` 内部用 `masked` 算宽，行回填时用原文本
- 风险：嵌套 marker（`**bold *italic***`）粗体里再斜体会丢——但本项目当前 markdown 源都是一层，不会踩到

**影响**：
- 估算列宽与渲染列宽一致 → `splitTextToLines` 行数 100% == ink 实际行数
- `**`、`*` 不再被切在边缘 → 散布碎片消失
- 不修改 `Markdown.tsx`，`renderInline` 仍按原逻辑解析

**代价**：~30 行新代码。

### 方案 B：把切片作用在已解析的 block 列表上（最彻底）

**核心思路**：把 `MarkdownMessage` 当前的 `buildBlocks(text, opts)` 提到外层：
- 先 `buildBlocks(text)` 拿到 block 列表（每个 block 是一个 `<Text>` 子树）
- 给 block 加 `displayWidth` 估算（`react-reconciler` 不可行；只能 fake 包装：`{ displayWidth, component }`）
- sliceArea 沿 block-行号滑动
- MarkdownMessage 接收「起始 block + 起始行」渲染

**代价**：侵入 `Markdown.tsx` 渲染管线，逻辑迁移量大；得逐个 block 测宽，复杂度爆炸。

### 方案 C（不推荐）：仅在 `clipMessageRows` 加 marker-pair 探测（保守补丁）

**核心思路**：切片时检测可见区间是否横跨 `**...**`，若是，整对搬到边界（同段头或同段尾）。

**问题**：存在「多对 marker 共同存在」「marker 跨越 visStart 边界且起始位置不可回退」等组合；补丁越摞越厚。

### 不做清单（防战术蔓延）

- **不改 Markdown.tsx 的 renderInline**：现有解析逻辑本身正确，孤儿文本流出是上游切片的责任。改 renderInline 只会让它变笨（比如强制吞 `**` 会把真正没配对的输入也吞掉，掩盖真实文本错误）。
- **不改 Markdown.tsx 把 `**` 渲染为 SGR 加粗**：ink `<Text bold>` 已正确处理加粗；问题在切片，不在解析。
- **不改 useAgentController 的 `appendTo` 流式逻辑**：流式累积是必要的，半成对的 `**` 总会来；正确的修补点是切片在每一 token 刷新时已经能正确处理。
- **不改 innerW / selectRowWindow 不变量**：底层行级模型的保证（渲染总行数 == sliceArea）已通过上一轮修复（`c524dde`）兑现；本 bug 与之正交。

### 推荐方案：**A**（最小变更、根因直击、与既有 markdown 解析逻辑解耦）

理由：
1. 根因 = 切片层无 markdown 感知 → 在切片层补齐最直接
2. **不动渲染层** = 不破坏现有 MarkdownMessage memo/React 性能
3. 改动只在 `markdown-lines.ts`，无跨文件影响，便于评审 + 回退
4. 可独立写单测：选含 `**`/`*`/`` ` `` 的 fixture → `displayWidth(masked)` == 真实渲染列宽（用 ink 无头渲染断言）

---

## 5. 验收 DoD

1. **截图 204528 / 204536 复现失败**：`npm start` → 长会话后滚到任一带省略标记的滚动位置，聊天区**没有任何可见的 `**`/`*` 字符**。
2. **右侧散布碎片消失**：在所有 hidden ∈ {0, maxHidden/2, maxHidden} 三个滚动点截图，**右半部分屏幕无孤立短划/竖线**。
3. **回归 1**：普通会话无 markdown 的消息渲染内容不变（实测 `你好` / `请帮我读 README.md` 等用户消息无差异）。
4. **回归 2**：含标准 `**bold**` 的助手消息仍正确加粗（截图肉眼校验 + DOM 不必要）。
5. **回归 3**：M1-M4 + 连续滚动 + 滚动条拖动综合回归 18+ 项全过。
6. **回归 4**：含三连 `***` / 多重嵌套 `**a *b* c**` 的边界用例——**可降级为「不要求支持嵌套」，文档注明**，不阻塞本次修复。
7. **tsc --noEmit` 0 errors**。
8. 单测新增 fixture：`displayWidth/maskedText/computed lines` 三组对照（详见方案 A 测试矩阵）。

---

## 6. 风险与边界

- **嵌套 marker**：方案 A 的 `maskMarkdownMarkers` 对 `**bold *italic* text**` 只把外层替换为空白，内部 `*italic*` 仍被另一遍替换。**这是巧合的有利行为**——内层 mask 完成时它已经是空白，再做 `\*([\s\S]+?)\*` 匹配会失败。建议不处理嵌套，本项目 markdown 源单层足够。
- **隐藏字符差异**：某些 LLM 会用 `\*` 转义（不该被解析）。`renderInline` 当前不处理 `\*` → 不会被误删，本方案也不引入此风险。
- **emoji / 零宽字符**：CJK 之外的全角符号在 `displayWidth` 已覆盖；但表情包的 `‍`（零宽连字）当前**不被识别**为 0 宽——已有缺陷，本次不修。
- **极窄终端 innerW<10**：`Math.max(10, cols - 5)` 已设底线，行数估算法在 innerW=1 时 `splitTextToLines` 也用 `max(1, ...)`——逻辑已经稳妥。

---

## 7. 附录 A：用户本机复现

```powershell
cd "D:\作业\AI Agent\deepseek-code-agent"
npm start
```

1. 最大化窗口（rows ≈ 40+）
2. 触发 Agent 输出包含 `**bold**`、`*italic*`、`code` 的回复（如「介绍项目」类 prompt）
3. 多轮累积至聊天区总行 > sliceArea（产生省略标记）
4. 用 PgUp/PgDn/滚轮 在任意滚动位置截图
5. 观察：当前 Bug = (a) 文本内出现 `**` 字符；(b) 右侧散布蓝色短划/竖线
6. 期待修复后 = (a)(b) 全部消失，markdown bold 仍正常显示为加粗效果

---

## 8. 附录 B：相关代码索引

- `src/app/markdown-lines.ts:13-28` `displayWidth` —— 单宽 `*` 计算
- `src/app/markdown-lines.ts:40-69` `splitTextToLines` —— 字符级折行（方案 A 主入口）
- `src/app/markdown-lines.ts:96-136` `clipMessageRows` —— 行级切片 + 省略 marker
- `src/cli/Markdown.tsx:20-42` `renderInline` —— markdown 解析（**不动**）
- `src/cli/Markdown.tsx:51-150` `buildBlocks` —— 整条消息 → ink 节点数组
- `src/cli/app.tsx:540-547` 消息渲染入口
- `src/cli/app.tsx:222` `innerW = Math.max(10, cols - 5)`（上一轮 `c524dde` 修复锚点）
- `src/app/useAgentController.ts:107-112` `appendTo`（流式累积）

---

## 9. 实施记录（2026-08-27，已修复）

> 本节记录实际实现与 §4 规划的偏差，作为未来维护依据。

### 9.1 与 §4 方案 A 的偏差表

| §4 规划 | 实际实现 | 原因 |
|---|---|---|
| 方案 A：切片前剥离 marker 生成 maskedText，再折行映射回原文 | **等价但更简**：不生成 maskedText，改为 `maskMarkdownMarkers` 生成**等长掩码**（marker 符号→零宽 `\u200B`，长度不变 → 折行点 1:1 映射回原文，无需位置映射回填） | 等长掩码让「测宽 + 取原文」一步到位，避免长度不一致的位置映射 |
| `displayWidth(maskedText) === 渲染宽度` | `displayWidth` 新增零宽字符（U+200B/C/D/FEFF）计 0 列；掩码把 marker 符号替换为 U+200B → `displayWidth(masked) === 渲染宽度` ✓ | 与规划一致 |
| 未提词级折行 | **新增词级断行**（对齐 wrap-ansi `trim:false, hard:true`）：按空格分词、词间补空格、行满换行、超长词 wrapWord 硬拆 | **实证发现**：ink 的 `<Text wrap="wrap">` 底层是 wrap-ansi，是**词级**断行而非字符级硬切。旧实现（c524dde 及以前）用字符级硬切，对含空格/英文的长文本会**低估/高估行数**（`DeepSeek`、`API` 等词在行尾换行点不同）→ 新实现若不处理会暴露该既有偏差。已用 bug-check4 系列实证对齐 |
| pair 原子放置（§4.1「不实现粗体内嵌套」） | 保留：`**x**` / `*x*` / `` `x` `` / `~~x~~` 作为**原子词**整对放置，绝不在 pair 中间切断；超长词硬拆时**pair 仍整对**（wrapWord 循环内也查 pairRanges） | 防泄漏核心，与规划一致 |

### 9.2 落地改动

| 文件 | 改动 |
|---|---|
| `src/app/markdown-lines.ts` | `displayWidth` 增零宽字符；新增 `maskMarkdownMarkers`（等长掩码）+ `markerPairRanges`；`splitTextToLines` 重写为 **marker 感知 + 词级断行**（分词→词间空格→wrapWord 硬拆，pair 原子）；`clipMessageRows` 不变（继承） |
| `src/app/viewport.ts` | `displayWidth` 同步零宽字符（保持同源） |
| `test/markdown-lines.test.ts` | 新增：mask 等长/嵌套边界、词级断行、长文本切片无孤儿 marker 回归 |
| `scripts/bug-check4-marker-slice.tsx` | 新增：marker 文本 declared==real 实证（ink 无头渲染） |
| `scripts/bug-check4b-clip-render.tsx` | 新增：任意 [visStart,visEnd) 切片 → clipMessageRows → 重渲染行数一致性 + 无孤儿 marker |

### 9.3 曾被尝试但否决的方案（保留教训）

- **纯字符级硬切 + mask 测宽**（文档 §4.1 字面实现）：长文本含英文词时 declared≠real（低估/高估 1 行）——因 ink 是词级断行，字符级无法精确对齐。实证后否决，改为词级断行。
- **维护「最近空格断点」回退式词级**（第一版词级实现）：空格归属处理错误（ink 是行尾保留空格 + 行满空格去行首，非回退式），且 pair 与空格交互复杂。实证后否决，改为**显式分词**（segments 逐字符切分，空格切段空串保留），与 `string.split(' ')` 语义完全一致。

### 9.4 验证方式（沙箱无 TTY 替代方案）

- **单测**（10 项）：mask 等长/宽度、pair 原子切行、clip 全区间无孤儿、词级断行、CJK/零宽回归。
- **bug-check4**（ink 无头渲染）：marker 文本 `splitTextToLines` 声明行数 == `MarkdownMessage` 真实渲染行数。innerW=30/20/14/10/8 全 OK；`**加粗** innerW=3` 为文档 §6 极窄边界（真实终端 `Math.max(10, cols-5)` 不可能触发），FAIL 属预期。
- **bug-check4b**：长文本（含英文词 + 多类型 marker）innerW=40/60/115，全文 + 全部切片（87 个采样点）declared==real 且无孤儿 marker —— **TOTAL=87 FAIL=0**。
- `tsc --noEmit` 0 errors。

### 9.5 待用户本机手测

`npm start` → 触发 Agent 输出含 `**bold**`/`*italic*`/`` `code` ``/`~~del~~` 的回复 → 多轮累积后滚动到带 `…(省略前/后 N 行)` 的位置截图：文本内**无可见 `**` 字符**、右侧**无散布短划**、markdown bold 仍正常加粗、滚动条位置与内容同步。
