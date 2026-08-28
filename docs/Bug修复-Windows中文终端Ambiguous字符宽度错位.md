# Windows 中文终端 Ambiguous 字符宽度错位（TUI 渲染残留）

> **状态**：已修复（commit 待回写）
> **类型**：Bug 修复（架构加固，第 4 轮同族问题）
> **关联**：
> - `docs/Bug修复-TUI渲染层双宽度系统导致右侧散布视觉污染.md`（**已修复**——emoji 双宽分歧；本文是同一族问题的**另一半**：Ambiguous 字符在 Windows 中文终端的 2 列渲染）
> - `docs/Bug修复-长工具调用时右侧散布box-drawing视觉污染.md`（已修复——box-drawing sanitize）
> **触发**：用户提供第三方《TUI 渲染异常问题分析报告》，要求"按照整个方案进行优化"
> **截图**：2026-08-28 102229 / 102237（同族问题的不同表现）

---

## §1 现象与第三方报告审计

### 用户原话

> "还是会出现渲染错误，这是分析报告如下……按照整个方案进行优化"

### 第三方报告核心主张审计（诚实标注对错）

| 报告主张 | 审计结论 | 依据 |
|---|---|---|
| §3.1③ 字符宽度计算偏差（Unicode Ambiguous Width）是原因之一 | ✅ **方向正确，且是主因**，但报告未点破**具体是 UI 自绘字符**（Scrollbar `█`、InputBar `╍`、边框 box-drawing、`•` `…` `↑` 等），而非用户内容 | 见 §2 根因分析 |
| §3.1① ANSI 转义序列处理失败；建议 SetConsoleMode 启用 ENABLE_VIRTUAL_TERMINAL_PROCESSING | ❌ **对 Node/ink 项目不适用**：Node ≥ 10 在 Windows 启动时自动为 stdout 启用 VT 处理；cmd.exe + conhost（Win10+）原生支持 VT | 这是给原生 C/Python TUI 的建议，Node 侧无需手动处理 |
| §4.1 更换 Windows Terminal 解决约 90% | ⚠️ **夸大且治标**：Windows Terminal 的 Ambiguous 渲染取决于**字体**——Cascadia 等西文字体按 1 列，中文字体（Sarasa/微软雅黑）仍按 2 列。换终端 ≠ 修根因 | 根因在代码字符选择，换终端只是换字体语义 |
| §3.1② 终端 Resize 竞态 | ⚠️ 次要因素，非主因 | 布局在 resize 时会重算，但 Ambiguous 宽度是**恒定错位**（与 resize 无关） |
| §3.1④ 异步渲染/刷新竞态 | ⚠️ 次要因素；已有流式批处理（useAgentController batchedSetMessages） | 非主因 |
| §3.1⑤ cmd.exe 兼容性差 | ⚠️ 部分成立：cmd.exe 在中文 DBCS locale 下按 2 列渲染 Ambiguous；但**任何**中文 locale 终端（含 Windows Terminal + 中文字体）都如此 | 需修代码，不是换终端 |

### 关键洞察

报告 §3.1③ 的"宽度偏差"方向**完全正确**，但它描述的是一般性问题。真正的具体根因是：

**我们的 UI 自绘字符（Scrollbar/InputBar/边框/装饰符）几乎全部是 EAW=Ambiguous 字符**——上一轮 string-width 修复解决了 emoji（RGI emoji 明确 2 列），但 Ambiguous 字符在 Windows 中文 conhost 下被渲染为 **2 列**，而 string-width 默认（ambiguousIsNarrow: true）按 **1 列**估算——**估算层与渲染层的分歧依然存在，只是换了字符类别**。

---

## §2 根因分析

### §2.1 直接根因：UI 自绘字符 = Ambiguous，Windows 中文终端渲染 2 列

**实证**（`scripts/spike-ui-char-width.mjs`，沙箱实测 string-width 判定）：

```
U+2588 █  Scrollbar thumb / WhaleMascot  → string-width 1 列 [EAW=Ambiguous]
U+254D ╍  InputBar 虚线                    → string-width 1 列 [EAW=Ambiguous]
U+2500 ─  ink 边框 single/round 横线        → string-width 1 列 [EAW=Ambiguous]
U+2502 │  ink 边框 single/round 竖线        → string-width 1 列 [EAW=Ambiguous]
U+2022 •  Markdown 列表前缀                 → string-width 1 列 [EAW=Ambiguous]
U+2026 …  省略标记                          → string-width 1 列 [EAW=Ambiguous]
U+2191 ↑ / U+2193 ↓ / U+25CF ● / U+00B7 ·  → string-width 1 列 [EAW=Ambiguous]
U+258C ▌  光标指示                          → string-width 1 列 [EAW=Ambiguous]
```

**Windows conhost（中文 DBCS locale）行为**：EAW=Ambiguous 字符使用宽字体渲染 = **2 列**。这是 Windows 控制台的已知行为（与字体强相关，中文 locale 必现；英文 locale 才按 1 列）。

### §2.2 影响链（结构性错位，每行都受影响）

```
Scrollbar thumb █（2 列）→ Scrollbar 组件占 2 列 → 内容区实际可用宽度 = cols-6
                                                     而估算 innerW = cols-5
→ 每行实际比估算窄 1 列 → 折行点提前 → 实际行数 > 估算行数
→ selectRowWindow 按低估 totalRows 选区间 → 渲染内容超出分配高度
→ ink Box 不剪裁 → 多余行叠加到下一行 → 右侧散布碎片/方块残留
```

同理：
- InputBar `╍`.repeat(width)：2 列/字符 → 虚线实际 2×width 列 → **溢出屏宽**（截图 1 的"虚线边框错位"）
- Banner/chat Box 边框 `┌─┐│`/`╭─╮│`：2 列 → 边框占 2 列 → 内容区整体偏移
- WhaleMascot `█`：2 列 → 图案错位 + Banner 高度变化 → 聊天区顶部错位
- `•`（Markdown 列表）：2 列 → 列表行宽度偏差 → 行数估算偏差
- `…`（省略标记）：2 列 vs 估算 1 列 → 标记超 budget → 折行成 2 行 → 溢出

### §2.3 为什么前几轮没根治（诚实追溯）

| 轮次 | 修复 | 覆盖的字符类别 | 未覆盖 |
|---|---|---|---|
| d13adf5 | Scrollbar track 空格化 | box-drawing 轨道 | thumb `█` 仍是 Ambiguous |
| 8bd5382 | sanitize box-drawing → ASCII | **消息内容**里的 box-drawing | **UI 自绘字符**（Scrollbar/InputBar/边框）没动 |
| 361cd95 | displayWidth → string-width | emoji 明确双宽 | Ambiguous（string-width 默认按 1 列，Windows 渲染 2 列） |

**根因是持续的：UI 自绘字符始终是 Ambiguous，在 Windows 中文终端始终 2 列。** 每一轮修的都是"内容类"问题，漏了"结构类"的 UI 字符。

### §2.4 为什么沙箱 spike 全绿

沙箱（Linux / 非 DBCS locale）把 Ambiguous 按 1 列渲染，与 string-width 一致——**测试环境与用户终端行为不同**。这是"测试通过 ≠ 用户环境修复"的典型案例，必须靠**代码字符选择**保证跨终端一致，而非依赖测试环境。

---

## §3 关键代码锚点表（修复前）

| 文件:行（修复前） | 字符 | 影响 |
|---|---|---|
| `src/cli/app.tsx` Scrollbar | `█` U+2588 | thumb 2 列 → 内容区窄 1 列 → **每行折行提前**（核心） |
| `src/cli/app.tsx` InputBar `dashedLine` | `╍` U+254D | 2×width 列 → 溢出屏宽 |
| `src/cli/app.tsx` Banner/chat Box `borderStyle="single"/"round"` | `┌─┐│╭╮╰╯` | 边框 2 列 → 内容区偏移 |
| `src/cli/app.tsx` WhaleMascot | `█` U+2588 | 图案错位 + Banner 高度 |
| `src/cli/app.tsx` ScrollIndicator | `↑↓●·` U+2191/2193/25CF/00B7 | 指示器宽度偏差 → 换行风险 |
| `src/cli/app.tsx` InputBar 光标 | `▌` U+258C | 光标 2 列 → 输入行错位 |
| `src/cli/Markdown.tsx` 列表前缀 | `•` U+2022 | 列表行宽度偏差 |
| `src/app/markdown-lines.ts` fitMark | `…` U+2026 | 标记超 budget 折行 |
| `src/cli/login.tsx` | `•` `…` `·` | 登录框宽度错位 |

---

## §4 修改方向（已按推荐实施）

### 原则：UI 自绘字符一律使用「明确 1 列」字符

| 类别 | 替换方案 | 理由 |
|---|---|---|
| 实心块（Scrollbar thumb / WhaleMascot） | `█` → **背景色空格** `<Text backgroundColor>` | 空格明确 1 列，视觉保持实心；任何终端一致 |
| 虚线 / 边框 | `╍` → `-`；`borderStyle="single"/"round"` → **`"classic"`**（ASCII `+-|`） | ink 的 classic 边框全 ASCII，明确 1 列 |
| 装饰符（`•` `●` `·` `↑` `↓` `▌` `…`） | → `-` `*` `|` `^` `v` `|` `...` | 全部 ASCII |
| 掩码 | `•` → `*` | ASCII |

### 不做清单（防战术蔓延）

| 不做 | 为什么 |
|---|---|
| displayWidth 改 ambiguousIsNarrow: false | 英文终端会反向偏差（1 列实际 vs 2 列估算 → 底部空白）；保持 true + UI 字符明确化是跨终端最优 |
| sanitize 扩展吃 Ambiguous 用户内容 | 用户内容里的 `·` `—` 是合法字符，不应被吞；结构性 UI 字符修好即可 |
| 更换终端/字体（报告 §4.1） | 使用侧缓解，非修复；代码字符明确化后任何终端一致 |
| 改 hit-test 几何 | Scrollbar 改 1 列后 hit-test（cols-2）自动正确 |

### 遗留边界（诚实声明）

用户内容里的 Ambiguous 字符（`·` `—` `•` 等中文文本常用）仍可能 ±1 列误差——零散出现、概率低、视觉影响小，**不做处理**（接受为内容语义）。

---

## §5 验收 DoD（已执行）

| ID | 验证 | 结果 |
|---|---|---|
| GT1 | `npx tsc --noEmit` | ✅ 0 错 |
| R1-R3 | markdown-lines / sanitize / workspace 测试 | ✅ 33/33 |
| R5 | **新增** `test/ui-char-width.test.ts` 源码扫描：UI 文件字符串字面量不含 EAW=Ambiguous 字符 | ✅ 2/2（含已知 UI 字符宽度断言） |
| V4 | `scripts/spike-ui-char-width.mjs`：UI 字符判定记录 | ✅ 全部 Ambiguous 已从源码清除 |
| V5 | `grep` 验证 src/cli 无遗留 Ambiguous 字面量（除注释） | ✅ |

### 新增防回归测试（关键）

`test/ui-char-width.test.ts`：**扫描 UI 源码**（app.tsx/login.tsx/Markdown.tsx/thinkingIndicator.tsx/sanitize.ts/markdown-lines.ts）的字符串字面量，断言不含 EAW=Ambiguous 字符（box-drawing/block/arrows/geometric/`·` `—` `•` `…` `›`）。

**为什么必须源码扫描**：这类 bug 在沙箱 Linux 测不出来（渲染行为与 Windows 一致），只有**代码字符选择**能保证跨终端稳定。未来任何人把 `-` 换回 `─`、把 `*` 换回 `•`，测试立即失败。

---

## §6 风险与边界

1. **视觉变化**：列表 `•` → `-`、边框圆角 → ASCII 直角、指示器 `↑↓` → `^v`——**功能不变，装饰简化**。用户在意品牌（Abyssal Pixel），但稳定性优先；如需恢复圆角边框，可后续用背景色方案自定义 borderStyle。
2. **WhaleMascot 背景色方案**：ink 的 `<Text backgroundColor>` 逐段渲染，性能 OK（Banner 仅渲染一次）；眼睛用黑背景空格，视觉与 `█` 一致。
3. **CRLF 坑**：Windows 文件 CRLF 下 `$` 锚定在正则中会失效（`\r` 是行终止符不被 `.` 匹配）——本次在测试中踩到，改用 `[^\r\n]*`。
4. **用户内容 Ambiguous**：接受 ±1 列边缘误差（见 §4 遗留边界）。

---

## §7 附录 A：复现与验证（用户本机）

```bash
cd "D:\作业\AI Agent\deepseek-code-agent"
npm start   # cmd.exe 中文环境
# 触发长对话（含工具调用 + 滚动），观察：
# 修复前：右侧散布蓝色短竖线/方块、输入框虚线溢出、滚动区错位
# 修复后：以上全部消失；Scrollbar thumb 为纯色块（背景色）；边框为 ASCII 直角
```

沙箱等价验证：
```bash
npx tsx --test test/ui-char-width.test.ts   # 源码扫描（防回归）
npx tsx --test test/markdown-lines.test.ts  # 省略标记 ... 断言
```

---

## §8 附录 B：相关代码索引

| 路径 | 作用 |
|---|---|
| `src/cli/app.tsx` | Scrollbar 背景色 thumb / InputBar `-` / classic 边框 / 指示器 ASCII / WhaleMascot 背景色 |
| `src/cli/Markdown.tsx` | 列表前缀 `- ` |
| `src/cli/login.tsx` | 掩码 `*` / `...` / `|` / classic 边框 |
| `src/app/markdown-lines.ts` | fitMark 省略标记 `...` |
| `src/cli/whaleArt.ts` | art 数据源（`█` 保留，app.tsx 消费时转背景色） |
| `test/ui-char-width.test.ts` | 防回归源码扫描（新增） |
| `scripts/spike-ui-char-width.mjs` | UI 字符 EAW 判定记录（新增，保留） |

---

## §9 实施记录（修复完成）

### §9.1 实施偏差表

| 规划 | 实际 | 偏差原因 |
|---|---|---|
| 报告 §4.2「SetConsoleMode 启用 VT」 | **未实施**——Node/ink 已自动处理 | 审计后判定不适用（§1 表格） |
| 报告 §4.2「强制全屏重绘」 | **未实施**——ink 已用 diff 更新 | 治标；根因是字符宽度 |
| 报告 §4.2「输出节流防抖」 | **未实施**——已有流式批处理 | 非主因 |
| 报告 §4.1「更换 Windows Terminal」 | 留给用户自选（使用侧缓解） | 非修复 |

### §9.2 落地改动摘要（文件 + commit）

| 文件 | 改动 |
|---|---|
| `src/cli/app.tsx` | Scrollbar thumb → 背景色空格；InputBar `╍`→`-`、`▌`→`|`；Banner/chat Box/KeyCapture 边框 → classic；指示器 `↑↓●·`→`^v*|`；WhaleMascot `█`→背景色；cwd `…/`→`.../` |
| `src/cli/Markdown.tsx` | 列表前缀 `• ` → `- ` |
| `src/cli/login.tsx` | 掩码 `•`→`*`、`…`→`...`、`·`→`|`、边框 → classic |
| `src/app/markdown-lines.ts` | fitMark/clipMessageRows 省略标记 `…` → `...` |
| `test/ui-char-width.test.ts`（新增） | UI 源码 Ambiguous 扫描 + 已知字符宽度断言 |

**Commit**：`<待 commit>`

### §9.3 曾被尝试但否决的方案

- **displayWidth 改 ambiguousIsNarrow: false**：英文终端反向偏差，否决
- **sanitize 扩展吞 Ambiguous 用户内容**：破坏合法字符，否决
- **自定义 ink borderStyle 保持圆角**：可行但复杂，先 classic 稳定

### §9.4 验证方式

tsc 0 错；35/35 测试全绿（含新增 UI 扫描）；spike-ui-char-width 记录判定

### §9.5 待用户本机手测项

1. cmd.exe 中文环境 `npm start` → 右侧无散布、输入框虚线不溢出、边框为 ASCII 直角
2. 长对话 + 滚动 → 无残留伪影
3. Windows Terminal + 中文字体下同样干净（跨终端验证）
