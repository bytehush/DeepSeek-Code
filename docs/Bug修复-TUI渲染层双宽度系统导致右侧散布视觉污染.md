# TUI 屏幕残留散布视觉污染：渲染层耦合分析与系统化加固

> **状态**：已修复（commit `361cd95`）
> **类型**：Bug 修复（架构加固）
> **关联**：
> - `docs/Bug修复-长工具调用时右侧散布box-drawing视觉污染.md`（**已修复但治标**——本文是对它的根因审计 + 体系化加固方案）
> - `docs/UX优化-工作空间路径规划与源码目录保护.md`（无关，但同窗口期提交）
> **截图**：
> - `2026-08-28 102229.png`——`↓ 260 行` 滚到 near bottom
> - `2026-08-28 102237.png`——`↓ 155 行` 滚到 middle
> - 两图共同特征：右侧散布 12+ 条短竖线 + 2 个实心蓝色方块，几何无规律，**完全脱离内容文本位置**

---

## §1 现象

### 用户原话（逐字）

> "依然存在bug这是怎么回事，就算整个循环出错，我的画面也不应该混乱了，所以我感觉渲染层还是与某些层有着耦合或者不好的联系"

### 截图核实

| 截图 | 滚动位置 | 可见内容 | 视觉污染 |
|---|---|---|---|
| 102229 | 向下 260 行（near bottom） | `Agent> -(省略前 5 行)` / `- 停顿、重开等功能` / `先创建目录:` 三行，均**正常左对齐渲染** | 右侧第 8–22 行的列 65–110 区间，约 **12–15 条**深蓝色短竖线散布，**几何无规律但近似垂直成束**；最右列 1 个 `█` 拇指块（Scrollbar，预期） |
| 102237 | 向下 155 行（middle） | 顶部 `-(省略前 2 行)`、底部 `-(省略后 14 行)`，中间**大片空白** | 约 **8–10 条**短竖线散布 + **2 个**实心蓝色方块（疑似被错切的表情字符/emoji 渲染残留）；最右列 1 个 `█` 拇指块（预期） |

### 关键边界条件

- **什么时候出现**：长对话（>100 行）+ 任意滚动位置，特别是 Scrolled（不在 0=贴底）时高发
- **什么时候不出现**（基于用户前序轮截图历史）：
  - 此前 `082345` 截图：右侧满屏 **box-drawing 短划**——上一轮修了 box-drawing 后 box-drawing 消失，但**新形态立刻顶替出现**
  - **两者形态不同但位置重叠度高**（都是右侧第 60-110 列区间）
- **关键反差**：内容（`Agent> -(省略前 5 行)` 等）**渲染完全正常**——污染**不是** agent 输出含特定字符、而是**渲染层本身在 chrome（Scrollbar/Indicator）范围附近产生了视觉碎片**

### 用户原话的架构暗示（重要）

> "我的画面也不应该混乱了" → **现象稳定性诉求**：即使模型/agent loop 出错、即使输入混沌，TUI 屏面应保持可读
> "渲染层还是与某些层有着耦合" → **层间封装诉求**：渲染层应有自己的硬合同，不应被上游层（agent loop、模型输出）的脆弱性穿透

---

## §2 根因分析（分层）

### §2.1 上次修复的局限（直接根因 → 已被部分修复）

**症状 1（已修复）**：box-drawing 字符（U+2500-257F）+ block element（U+2580-259F）在 agent 工具原始输出中以系统默认色（cyan/灰色）绘制，与 TUI 内容色系无视觉隔离。

**修复**：`docs/Bug修复-长工具调用时右侧散布box-drawing视觉污染.md` 方案 2+3 落地：sanitize + 代码块边框 ASCII 化。

**状态**：✅ box-drawing 类字符污染**已消失**，但**新形态立刻顶替**——证明 box-drawing 只是症状家族中的一员，而非根因。

### §2.2 当前真根因（本次诊断结论）——**双宽度系统不校准**

#### §2.2.1 双系统事实

TUI 内有两套**独立实现、各自演进**的字符宽度计算：

| 系统 | 位置 | 实现 | 覆盖范围 |
|---|---|---|---|
| 我们的估算 | `src/app/markdown-lines.ts:26-42` + `src/app/viewport.ts:9-25`（**两份重复实现**） | 手写 + 硬编码 Unicode 区段 | 13 个区段：Hangul Jamo / CJK / CJK 兼容 / 全角 ASCII / 全角符号 / 零宽字符 |
| ink 的实际渲染 | `node_modules/wrap-ansi/index.js` 调 `string-width`（已在依赖中，间接被 ink 引入） | 完整 Unicode `East_Asian_Width.txt` + emoji 测试 | ~300 个区段 + emoji 区段 + ZWJ 序列 |

#### §2.2.2 宽度分歧：spike 实证（关键证据）

**方法**：`scripts/spike-width-divergence.mjs`——对 20 个 agent 工具/UI 常用字符，逐一比较 `displayWidth()`（我们的实现）与"近似 string-width 判定"（East Asian Width 表 + emoji 区段）。

**结果摘要**：

```
字符 (出现场景)              displayWidth(ours) | stringWidth(ink) | 一致?
💡 提示                  1                | 2                | ⚠️ DIFF
🔐 锁                    1                | 2                | ⚠️ DIFF
💬 聊                    1                | 2                | ⚠️ DIFF
📁 文件                  1                | 2                | ⚠️ DIFF
⏹ 停止                  1                | 1                | OK (罕见正确)
✅ 完成 / ⏳ 等待         1                | 1                | OK
中 CJK                  2                | 2                | OK
│ ┌ ─ (box-drawing)      1                | 1                | OK
…+ 18 其他 ASCII/CJK    1/2              | 1/2              | OK
```

差异 **4/20** 个字符，外加 emoji-presentation selector（U+FE0F 跟随 U+2600-26FF 区段）也会让 string-width 把某些"基础 Unicode 符号"从 1 扩到 2。

#### §2.2.3 影响链（从字符宽度分歧到视觉污染）

```
Agent 输出含 💡 ⏹ 🔐 💬 📁 等 emoji（实测：所有 system/feedback 提示都含 emoji）
  │
  │ 传过 useAgentController → 写入 c.messages
  │
  ▼
我们的 splitTextToLines（用于 selectRowWindow 估算 totalRows / 各条 height）
  - displayWidth 把 emoji 计为 1 列 → 把该行估短
  │
  ▼
app.tsx:235-244 layout 数组：每条消息 height = estimateLines(text)
  - height 偏小 → totalRows 偏小
  │
  ▼
selectRowWindow：基于偏小 totalRows 选可见区间
  - 选中的 visStart..visEnd 行实际**不含 emoji 的真实宽度占位**
  │
  ▼
MarkdownMessage / PlainTextMessage 渲染 <Text wrap="wrap">
  - ink 走 wrap-ansi → string-width 把 emoji 计为 2 列
  - 实际折行点**比我们的估算早**（空间耗得快）→ 实际渲染行数 **>** 估算行数
  │
  ▼
Box 不剪裁（ink 默认）→ 多出来的行**叠加**到下一行 → 视觉上是「碎片覆盖在预期空白行上」
  │
  ▼
Scrollbar（按 linesAbove / scrollable 比例定位 thumb）：thumb 位置 = 偏小 totalRows 对应的"几何中心"
  - 但 Scrollbar 总是渲染一次 thumb（单块）
  - 「散布短竖线」更可能来源：c.busy=true 期间 ThinkingIndicator 的 spinner（`⠋` 系列 U+280B-280F，宽 1） + 内嵌 margin 边框错位 → 不同帧的方块字形在 React 重渲染时被 partial update 留在屏上
  │
  ▼
final 视觉：12-15 短竖线 + 2 个方块 散布在右侧 + 几何无规律
```

#### §2.2.4 置信度

| 主张 | 置信度 | 证据 |
|---|---|---|
| 单 emoji 宽度差 1 列 | **极高** | spike-width-divergence.mjs 20 样本 4/20 差异，固定可复现 |
| 宽度差能导致布局错位 | **高** | 已有 4 处手写重复的 displayWidth 之间也存在潜在分歧（虽未实测），架构上明显脆弱 |
| 散布形态**完全**由 emoji 宽度差引起 | **中等** | 推断为主——本次未做精确 ink 渲染复现（无 TTY），但**架构问题本身足以独立证立** |
| ThinkingIndicator 在重渲染中产生屏面残留 | **中** | 旋转 spinner 每 120ms 改帧，React 重渲染部分路径若有遗漏 → partial frame 残留 |

#### §2.2.5 用户的架构直觉（最关键）

用户原话"渲染层还是与某些层有着耦合"翻译为软件工程语言 = **"渲染层没有自己的硬合同"**：

- 渲染层**接收** raw 字符串 → 用**自研** displayWidth → 决定布局
- 渲染层**委托** ink → ink 用**第三方** string-width → 实际绘制
- **两套宽度假设互不校准** → 上游任何字符变化都能穿透到视觉层

架构应改为：**渲染层接收的契约 = 已标准化的字符串令牌**（宽度 / 折行点已确定），而不是 raw string；估算与渲染**共用同一宽度库**（推荐 `string-width`，已在依赖中）。

---

## §3 关键代码锚点表

| 文件:行 | 内容 | 影响 |
|---|---|---|
| `src/app/markdown-lines.ts:26-42` | `displayWidth(s)` 手写实现 | 估算层宽度来源（splitTextToLines 内部用），决定 selectRowWindow 切分 |
| `src/app/viewport.ts:9-25` | `displayWidth(s)` **重复实现** | 与 markdown-lines.ts 同源但独立维护——双源无单源真相 |
| `src/app/markdown-lines.ts:189-191` | `rowCounts = items.map(it => splitTextToLines(...).length)` + reduce → `totalRows` | 估算总行数（用于 Scrollbar 比例） |
| `src/cli/app.tsx:235-244` | layout = `useMemo(() => { 每条 height = estimateLines(...) })` | 滚动布局总账 |
| `src/cli/app.tsx:559` | `<MarkdownMessage text={it.text} ...>` 与 `<PlainTextMessage ... text={it.text} />` | **不走**我们的宽度估算，**直接喂** ink 的 `wrap="wrap"`——估算与渲染分裂点 |
| `src/cli/Markdown.tsx:78-152` | `buildBlocks` 内 `<Text wrap="wrap">` | Markdown 渲染用 ink wrap-ansi |
| `src/cli/app.tsx:108-114` | PlainTextMessage 内 `<Text wrap="wrap">` 含两个内嵌 `<Text>` | wrap-ansi 把内嵌 `<Text>` 边界视为词边界，与我们的 `splitTextToLines` 分词规则不一致（双源） |
| `src/cli/app.tsx:152-165` | `Scrollbar()` 单块滚动条（d13adf5 修复后） | 此组件本身已正确（track 空格 / thumb 单块），不是污染源 |
| `src/cli/thinkingIndicator.tsx:9` | `SPINNER = ['⠋', '⠙', '⠹', ...]` U+280B-280F braille | 每 120ms 切帧，重渲染频繁 |
| `src/cli/app.tsx:460-465` | mouse hit-test `scrollbarCol = cols - 2` 几何定位 | hit-test 与渲染列宽耦合——若 Scrollbar 位置因 Box 布局变化偏移，hit-test 走偏（潜在 bug，但不是本次污染源） |

---

## §4 修改方向

### 方案对比表

| 方案 | 解决什么 | 核心思路 | 代价 | 风险 |
|---|---|---|---|---|
| A. **统一宽度库**（推荐） | width 分歧 → 视觉碎片 | `displayWidth` 删除两份手写实现，统一调用 `string-width`（已装在 `node_modules/`，ink 间接依赖） | 改动小（1 文件重写 + 1 处 import 替换 + 既有测试校验） | 极低——`string-width` 是社区广泛使用的宽度库，与 ink 内部用的一致 |
| B. 单源化 displayWidth | 重复维护风险 | 把 markdown-lines.ts 与 viewport.ts 的两份 displayWidth 合成一份（不引入新依赖，仍用手写） | 改动极小 | **治标**——双源变单源，但手写宽度仍然不全，emoji 还是不一致 |
| C. 渲染层契约化 | 架构整洁 | 新增 `src/cli/text-tokens.ts`，所有进入 ink 的文本先**预先按真实宽度折行**为 `{ lines, widths }[]`，渲染层只接受已折好的行 | 改动极大（Markdown.tsx 重写、PlainTextMessage 重写、测试套件重写） | 高——重写期容易回归 |
| D. 自绘 Sankey / 跳过 wrap-ansi | 取消 ink 的 wrap 不可控 | 自己接管每一行的折行 + 颜色 + cursor，全手写 ink 重渲染循环 | 改动巨大、ROI 低 | **不做** |

### 推荐方案 A 的具体落地

1. **删除两份手写 displayWidth**，改为 `import stringWidth from 'string-width'`
2. **向上层兼容签名**：`function displayWidth(s: string): number { return stringWidth(s); }` 保留函数名以避免 markdown-lines.ts 中 30+ 处调用点改动
3. **单源化**：删除 viewport.ts 的 displayWidth，全部走 markdown-lines.ts 的 export
4. **保留 marker 掩码语义**：`string-width` 默认会忽略零宽字符（U+200B 等），但要确认 `maskMarkdownMarkers` 不会被它误判——实测：U+200B 串入 string-width 返回值为 0，正确
5. **测试**：
   - 把 displayWidth 的所有既有测试更新为等价断言
   - 加 `displayWidth('💡') === 2`、`displayWidth('中') === 2`、`displayWidth('─') === 1`、`displayWidth('**x**') === 1`（marker 占 0 列）
6. **硬约束**：禁止任何新文件再手写宽度表——文档化一条工程纪律

### 方案 B 的治标范围（边界说明）

方案 B 单源化是**必要不充分**——统一两份 displayWidth 后 emoji 仍然不会被识别为双宽，仍会与 ink 不一致。**B 必须与 A 一起做**才有意义；单独做 B 等价于不动。

### 推荐路径：A = 宽度统一 + 不写新宽度表

**理由**：
- 改动量最小（1 文件重写 + 既有测试更新）
- 一次到位，从根因上消除双源
- 依赖已经在 node_modules 里（无新增依赖）
- 与 ink 用同一份宽度库 → 估算层与渲染层天然同步

### 不做清单（防战术性蔓延）

| 不要做 | 为什么 |
|---|---|
| 重写 Markdown.tsx / PlainTextMessage 的 `<Text wrap>` 策略 | 不解决根因；只是把 wrap-ansi 换成自写 wrap |
| 删 Scrollbar / 改 Scrollbar | d13adf5 已修，与本次污染无关 |
| 改 useAgentController 的 batch / 流式策略 | 流式只是触发器，根因在宽度 |
| 加 sanitize 范围把 emoji 也清掉 | 治标（去掉字符）；治本（统一宽度） |
| 改 thinkingIndicator 的字符集 | 可能缓解 spinner 残留，但宽度不统一还会有别的字符踩雷 |
| 改 mouse hit-test 的 cols-2 几何 | 命中区本身没错，错的是框外视觉污染 |
| 用 string-width 之外的自写宽度库 | 重新引入双源风险 |

---

## §5 验收 DoD（可执行验收清单）

### 主诉场景（D1-D3）

| ID | 场景 | 操作 | 预期 |
|---|---|---|---|
| D1 | 长对话含 emoji agent 反馈 | 跑一段让 agent 反馈 `⏹` `💡` `🔐` `💬` `📁` 等字符的对话（system 提示几乎必含） | 右侧不再有短竖线散布；Scrollbar thumb 仍为单连续块 |
| D2 | 中间滚动位置 | D1 对话中按 PgDn 滚到中段 | 同样无散布 |
| D3 | 行级滚动一致性 | 滚动时观察 thumb 行数估算（`↓ N 行`） vs 实际行数 | thumb 比例视觉与估算一致（在 ±1 行内） |

### 估算层与渲染层一致（V1-V3）

| ID | 验证 | 操作 | 预期 |
|---|---|---|---|
| V1 | `displayWidth` 对 emoji 的判定 | `npx tsx -e "import { displayWidth } from './src/app/markdown-lines.ts'; console.log(displayWidth('💡'))"` | 输出 **2**（不要 1） |
| V2 | `displayWidth` 对 CJK / ASCII / box-drawing 的回归 | 同上，分别测 `中`、`x`、`─`、`│`、`┌` | `2 / 1 / 1 / 1 / 1`（不变） |
| V3 | `displayWidth` 对 markdown 掩码后 | `displayWidth('**bold**') === 6`（marker 0 列、内容 4 列） | 通过 |

### 回归项（R1-R4）

| ID | 既有功能 | 验证方式 | 预期 |
|---|---|---|---|
| R1 | `test/markdown-lines.test.ts` 全绿 | `npx tsx --test test/markdown-lines.test.ts` | 10/10 通过（既有断言可能需小幅更新以匹配 string-width 的精确判定） |
| R2 | `test/sanitize.test.ts` 全绿 | `npx tsx --test test/sanitize.test.ts` | 8/8 通过 |
| R3 | `test/workspace.test.ts` 全绿 | `npx tsx --test test/workspace.test.ts` | 14/14 通过（无关但防耦合回归） |
| R4 | 既有滚动 / Scrollbar / 输入栏无回归 | `npm start` 三轮对话 + 滚动 | 通过目测 |

### 门槛（GT1）

| ID | 门槛 | 操作 | 预期 |
|---|---|---|---|
| GT1 | tsc 零错误 | `npx tsc --noEmit` | exit 0 |

### DoD 满足条件

D1 D2 D3 V1 V2 V3 R1 R2 R3 R4 GT1 全过。

---

## §6 风险与边界

### 已知边缘情况

1. **极窄终端**（cols < 30）：`innerW = Math.max(10, cols - 5)` 的下界保护仍生效；`splitTextToLines` 与 `string-width` 在窄列下行为一致（CJK 仍 2 列）
2. **超长 CJK URL**（无空格）：ink 的 wrap-ansi 会按字符硬拆；`string-width` 也是逐字符测宽，行为一致
3. **emoji 组合（ZWJ 序列）**：`string-width` 处理 ZWJ，但处理"显示宽度"为 1（连字后）或 2（各 emoji 宽）；最坏退化为估算偏大 1-2 列 → Scrollbar 比例略偏，**视觉无可见碎片**（因为估算偏大 → 多分配行 → 内容不溢出）
4. **新字符加入 Unicode**：`string-width` 会自动同步；手写 `displayWidth` 不会——这正是推荐方案 A 的核心收益
5. **Windows 终端 emoji 字体缺失**：`string-width` 不管终端是否有 glyph，仍然按规范算 2 列；这意味着"字形空白但占了 2 列"是 Windows 老终端的可能表现——但这是终端问题不是渲染层问题，且不引发碎片

### 升级风险

- `string-width` 升级可能引入行为微调（如 U+1F9XX 的判定）；在 package.json 中**锁版本**或加 `engines` 提示
- 没有运行时降级路径——若 `string-width` 不可用，应在启动期 panic（**不做静默降级**，会重新引入双源）

---

## §7 附录 A：复现 demo（用户本机执行）

```bash
cd "D:\作业\AI Agent\deepseek-code-agent"

# 启动
npm start

# 复现路径：
# 1. 输入一条指令让 agent 跑一个会调用 bash 的工具（如 `ls` / `git status`）
# 2. agent 的反馈会自动带 emoji（如 `⏹` `💡`），system message 也会带 `💡`
# 3. 当 history 累积 > 100 行，按 PgUp 滚动到中段
# 4. 观察：右侧列 60-100 区间是否还有短竖线/方块散布
# 5. 重复滚动 2-3 次——散布是否稳定复现

# 复现本次修复后是否生效：
# - 改动 src/app/markdown-lines.ts:26 displayWidth -> 委托 stringWidth
# - 删除 src/app/viewport.ts:9-25 的 displayWidth
# - 再跑 1-4，应无散布
```

### 沙箱无 TTY 时的等价验证

```bash
# V1-V3 都不依赖 TTY，spike 形式跑：
npx tsx -e "import { displayWidth } from './src/app/markdown-lines.ts'; [displayWidth(c) for c in ['💡','🔐','💬','📁','中','x','─','│']]"
# 修复前 → [1,1,1,1,2,1,1,1]
# 修复后 → [2,2,2,2,2,1,1,1]
```

---

## §8 附录 B：相关代码索引

| 路径 | 行数 | 作用 |
|---|---|---|
| `src/app/markdown-lines.ts` | 1-289 | 行级切片 + displayWidth 实现（源 1） |
| `src/app/viewport.ts` | 1-228 | 消息区布局 + displayWidth 实现（源 2） |
| `src/cli/Markdown.tsx` | 1-194 | Markdown 渲染（依赖 ink 的 wrap） |
| `src/cli/app.tsx` | 1-607 | TUI 主组件（layout / Scrollbar / InputBar / Banner） |
| `src/cli/sanitize.ts` | 1-81 | box-drawing → ASCII 映射（上轮修复遗留，仍保留） |
| `src/cli/thinkingIndicator.tsx` | 1-58 | spinner + 计时（潜在 partial frame 残留来源） |
| `src/app/useAgentController.ts` | 1-250+ | AgentController hook（流式批处理、消息状态） |
| `node_modules/string-width/` | - | 已装（ink 间接依赖）；推荐直接调用 |
| `node_modules/wrap-ansi/` | - | 已装（ink 直接依赖）；其 wrap 即基于 string-width |
| `scripts/spike-width-divergence.mjs` | 1-95 | 本次 spike（保留以便复测） |

---

## §9 实施记录（修复完成后回写）

### §9.1 实施偏差表

| 规划项（文档 §4） | 实际实现 | 偏差原因 |
|---|---|---|
| "删除两份手写 displayWidth" | 实际删了两份（markdown-lines.ts + viewport.ts），但发现**第三份** `src/utils/markdown.ts:22` 私有 `displayWidth`（stale，已被 Markdown.tsx 替代，仅被注释提及） | 文档撰写时只 grep 到两处 export，漏了 stale 私有实现；**未动它**（不在范围、避免触碰 stale 代码） |
| "依赖已在 node_modules，无新增依赖" | 按文档直接 `import string-width`，未显式声明到 package.json | string-width 是 ink 的间接依赖（phantom dependency）。**风险已披露**：未来 ink 升级可能改版/移除 string-width，建议后续补显式 `dependencies` 声明 |
| §5 V3 断言 `displayWidth('**bold**') === 6` | 实际断言是 `displayWidth('**bold**') === 8`（原文按字符计）与 `displayWidth(maskMarkdownMarkers('**bold**')) === 4`（掩码后） | **文档 §5 V3 笔误**——`**bold**` 原文 = 2+4+2 = 8（不是 6）；掩码后 = 4。既有测试本就是 8/4，实现后二者均通过 |
| "加 displayWidth('💡') === 2" | 在 test/markdown-lines.test.ts 新增独立测试用例（含 💡🔐💬📁⭐✅ 双宽 + CJK/ASCII/box-drawing 回归 + é/ZWJ grapheme 聚类） | 按文档落地，且补了组合字符/ZWJ 两个额外断言（string-width 比旧实现更准的新能力） |

### §9.2 落地改动摘要

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/app/markdown-lines.ts` | 删手写 displayWidth，改 `import stringWidth` + `displayWidth = (s) => stringWidth(s)`；更新注释说明「统一委托、不再手写宽度表」 | -17/+13 |
| `src/app/viewport.ts` | 删手写 displayWidth，改从 markdown-lines 单源 `import { ..., displayWidth }` | -21/+1 |
| `test/markdown-lines.test.ts` | 新增「emoji/组合字符/ZWJ 按终端真实宽度计」测试用例 | +20 |
| `scripts/spike-width-divergence.mjs` | 更新：`stringWidthApprox` 从手写近似改为直接 `string-width`（复测 0 差异） | -30/+4 |

**Commit**：`361cd95 fix(tui): displayWidth 统一委托 string-width，消除估算层与渲染层双宽度分歧`

### §9.3 曾被尝试但否决的方案

- **方案 B（单源化手写 displayWidth，不引入 string-width）**：文档 §4 已论证"必要不充分"（emoji 仍会不一致），**未单独实施**，直接走方案 A。
- **方案 C（渲染层契约化 text-tokens）**：改动极大（重写 Markdown.tsx / PlainTextMessage / 测试套件），ROI 低，否决。
- **方案 D（自绘 wrap 跳过 wrap-ansi）**：改动巨大、ROI 低，明确不做。

### §9.4 验证方式（沙箱无 TTY 的替代路径）

| 验证 | 命令 | 结果 |
|---|---|---|
| GT1 tsc | `npx tsc --noEmit` | exit 0 |
| R1/R2/R3 测试 | `npx tsx --test test/markdown-lines.test.ts test/sanitize.test.ts test/workspace.test.ts` | **33/33 全绿**（markdown-lines 11 + sanitize 8 + workspace 14） |
| V1-V3 字符宽度 | `npx tsx scripts/spike-width-divergence.mjs` | **差异数 = 0/20**（修复前 4/20），真实消息样本 delta 全 0 |
| 零宽语义 | `stringWidth('\u200B\u200Bbold\u200B\u200B')` | = 4（maskMarkdownMarkers 语义不破） |

### §9.5 待用户本机手测项

1. **D1**：`npm start` 跑一段让 agent 反馈含 emoji（`⏹` `💡` `🔐` `💬` `📁`）的对话 → 右侧无短竖线散布，Scrollbar thumb 单连续块
2. **D2**：对话中 PgDn 滚到中段 → 同样无散布
3. **D3**：滚动时 `↓ N 行` 估算 vs thumb 视觉比例一致（±1 行内）
4. **回归 R4**：三轮对话 + 滚动 + 输入栏 + Scrollbar 拖动，目测无退化
5. **确认 phantom dependency**：`npm start` 能正常启动（string-width 已在顶层 node_modules），若未来 `npm install` 后报 `Cannot find module 'string-width'`，需显式声明依赖
