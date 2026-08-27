# TUI Bug 修复——全屏状态下滑到顶部时聊天区底部出现空白

> **状态**：待修复（文档就绪，等用户拍板）
> **类型**：Bug 修复（视觉瑕疵）
> **关联**：本文与 `docs/UX优化-连续滚动与滚动条拖动.md` §9.1 优化 A 后的回退场景强相关
> **截图**：2026-08-27 193505（顶部+ ↓52行）/ 193512（中部+ ↓49行）/ 193516（贴底 无指示器）

---

## 1. 现象（用户描述 + 截图核实）

**用户描述**：「全屏状态下页面滑动到顶部时候底下会出空白，后续向下滑动就没有这个情况了」

**截图逐张核实**（基于 Windows Terminal 全屏 rows≈40）：
| 截图 | 状态 | 指示器 | 聊天区视觉 |
|---|---|---|---|
| 193516（贴底） | scrollOffset = 0 | 无（无 ↑↓） | 内容贴底部 / 边框，无空白 |
| 193505（顶部） | scrollOffset ≈ 52 | `↓ 52 行 · PgDn 回到底部` | 内容渲染在中上，**底部大片空白直到边框底边**（约 12-17 行的纯空行） |
| 193512（滚一点） | scrollOffset ≈ 49 | `↓ 49 行 · PgDn 回到底部` | 内容上移，**底部空白缩小但仍可见** |

**关键观察**：空白 **只在 `hiddenRows > 0`（向上滚动到顶/中）时出现**，向下滚回底即消失。
**矛盾点**：截图中内容总行数与 sliceArea 几乎相当（指示器 52 行 + 大约 27 行可见 ≈ 79 行），按 `selectRowWindow` 的设计应该**渲染满 sliceArea 行**（绝不留空，文档 §4.1 的承诺），但实际却出现大段空行。

---

## 2. 根因分析（多因素叠加）

### 2.1 直接根因：聊天区消息列的渲染行数 < sliceArea

看 `src/cli/app.tsx:529-555` 的聊天区布局：

```
<Box flexGrow={1} flexDirection="column" borderStyle="round" paddingX={1}>   ← 圆角边框父盒
  <Box flexDirection="row" height={sliceArea}>                                ← 消息+滚动条 row，固定 N 行
    <Box flexDirection="column" flexGrow={1}>                                 ← 消息列（增长占满）
      {window.rendered.map(...)}                                              ← selectRowWindow 的渲染
      {c.busy && <ThinkingIndicator />}
    </Box>
    <Scrollbar />                                                              ← 1 列
  </Box>
  <Box flexGrow={1} />                                                         ← ⚠️ 弹力 spacer
  <ScrollIndicator />                                                          ← 1 行
</Box>
```

**关键事实**：
- `Box height={sliceArea}` 给的是**包含 Scrollbar 那 1 列在内的总行数**——消息列实际可用 < sliceArea
- 但更致命的是 **`selectRowWindow` 自己计算的渲染行数也会少于 sliceArea**，原因见 2.2

### 2.2 深层根因：`selectRowWindow` 的循环可能提前结束（不变量破裂）

`src/app/viewport.ts:179-227` 的 selectRowWindow 注释明确承诺：**「渲染总行数严格 == sliceArea，不再有大段空白」**——但**这个不变量在两种场景下被破坏**：

**场景 A（理论）**：当 `totalRows <= sliceArea` 时，`hidden = max(0, hiddenRows) = 0`，`endRow = totalRows`，渲染 `min(sliceArea, totalRows) = totalRows < sliceArea` 行——但 `linesAbove = 0 = linesBelow = 0`，indicator 不显示，用户不会滚动，所以不暴露。

**场景 B（实测）**：当 `hiddenRows > 0` 但内容**不是逐行整数对齐到消息边界**时，循环里：

```ts
const lines = Math.min(sliceArea - shown, visEnd - visStart);
rendered.push({ ... height: lines ... });
shown += lines;
if (shown >= sliceArea) break;
```

**`shown` 用 `visEnd - visStart`**（按消息行数算）。如果最后一条可见消息只渲染了部分尾部（`visEnd - visStart < visEnd-real`），循环中 `shown < sliceArea` 时 break 没有触发（**因为 `if (shown >= sliceArea)` break 仍然依赖 shown **），但 **last messages 的实际可见行总和 < sliceArea**——剩下的 `sliceArea - shown` 行就是空白。

但这只解释了「上半部分」——但实际上截图 193505 的「内容渲染在中上 + 底部大片空白」说明 selectRowWindow 渲染的结果本身就少。

### 2.3 最深层根因：「**可视化行数**」与「**显示行数**」是两套度量

| 模块 | 度量 | 含 +1 间距？ | 与 ink 实际渲染匹配？ |
|---|---|---|---|
| `estimateLines`（viewport.ts:32）| 布局用 | ✅ 末尾 `+1` 算间距 | ❌ 偏高 ~N（N=消息数）|
| `splitTextToLines`（markdown-lines.ts:40）| selectRowWindow 用 | ❌ 精确折行 | ✅ 但不计入间距视觉 |

两套度量未对齐，导致：
- `layout.total = Σ estimateLines = window.totalRows + N`（多了 N 行间距）
- 滚动条/ScrollIndicator 用 `window.totalRows`，但 layout 计算 maxScroll 时**未做归一**（见 app.tsx:248：`maxHiddenRowsRef = window.totalRows - sliceArea`——已经按 row-window 算的，但**渲染条数还是会被消息条数限制**）

### 2.4 全屏放大这个 Bug 的诱因

`computeAreaHeight(rows) = max(3, rows - BANNER_ROWS(15) - INPUT_ROWS(4) - SAFETY_ROWS(2))`：

- 窗口 rows=24 → sliceArea=3（最小值）
- 窗口 rows=30 → sliceArea=9
- 窗口 rows=40（全屏最大化）→ sliceArea=19
- 窗口 rows=50 → sliceArea=29

**全屏时 sliceArea 较大**（`window.totalRows` 也在同一基准），消息少的场景下 `totalRows < sliceArea` 不滚动（场景 A）；**消息多到够滚动时**（193505 这种），selectRowWindow 的 `shown` 在 hidden>0 时不严格==sliceArea，**剩余空间被 Box 默认 `alignItems: stretch / flex-start`** 显示为底部空行（这是 ink Box 的固定行为，无 `alignItems="flex-end"` 这种属性可用）。

---

## 3. 关键代码锚点（含行号）

| 文件:行 | 内容 | 影响 |
|---|---|---|
| `src/cli/app.tsx:529-555` | 圆角边框父盒 + 消息+滚动条 row + spacer + indicator | 布局负责（Box 默认不垂直居底，不会自动消除末尾空白） |
| `src/cli/app.tsx:536` | `<Box flexDirection="row" height={sliceArea}>` | 消息+滚动条固定 sliceArea 行；但**消息列实际可用 = sliceArea**，不算入 Scrollbar 占的 1 列——**这里有一行高度偏移**（Scrollbar 是 1 列宽行高，仍在同一行 height 内，但视觉上让消息区感觉"少了一行底部"）|
| `src/cli/app.tsx:556` | `<Box flexGrow={1} />` spacer | 在 border 父盒内 `<Box height=sliceArea> + spacer + <ScrollIndicator>` 三段式——spacer 始终存在（不论上下滚动），**只是当 hideenRows=0 时 sliceArea 已经被填满、spacer 自然压缩为 0** |
| `src/app/viewport.ts:200-218` | selectRowWindow 主循环 | `shown = Σ lines`，但 `lines = visEnd - visStart` 按消息行数算——**`shown` 不一定 == sliceArea** |
| `src/app/viewport.ts:215` | `const lines = Math.min(sliceArea - shown, visEnd - visStart);` | 关键裁剪点：保护「不超出 sliceArea」但不**保证「填满 sliceArea」** |
| `src/app/viewport.ts:32-41` | `estimateLines` 末尾 `+1` | 间距保险，**与 splitTextToLines 不对齐**——导致 layout / window 两套度量 |

---

## 4. 三处修复方向（按推荐顺序）

### 4.1 方向 A（最快，推荐）：父盒布局让消息列垂直**撑满**

**改动**（app.tsx:529-558）：
- 把消息列所在的内层 `<Box flexDirection="column" flexGrow={1}>` 移除（它对内容只是「最大可伸展」容器）
- 或在父盒内 `<Box flexDirection="row" flexGrow={1}>` 内放消息列 + Scrollbar，**外层 column 删掉 height={sliceArea} 的内 row**
- 让消息列 `height={sliceArea}` **精确就是 sliceArea 行**——里面的内容不足时由 selectRowWindow 在每条首/末加 `…省略` 标记（已实现）补到 sliceArea 行

但这要修改 layout 比较激进。

### 4.2 方向 B（最小变更，推荐）：在 selectRowWindow 末尾**强制补齐 sliceArea 行**

**改动**（viewport.ts:218 处 break 前）：
- 新增断言：`if (shown < sliceArea)` → 在最后一条消息的尾部追加行占位符（如 `│  · …… ……`）
- 或更优雅：**返回的 `rendered` 数组的最后一项高度设为 sliceArea**，由 ink 在该条 Box 末尾自动填空白不可行——ink 没这机制
- 最干净：**在 selectRowWindow 渲染前就强制生成 N 行 padding 行**，作为「最后一条消息的隐式末尾 padding」

实际实现可以是修改 selectRowWindow：当 `shown < sliceArea` 时，给最后渲染的消息追加 `\n` + padding 行（每行一个空格），凑满 sliceArea。

### 4.3 方向 C（最优雅）：统一 `estimateLines` 与 `splitTextToLines` 两套度量

**改动**（viewport.ts:32-41）：
- 去掉 `estimateLines` 的 `+1` 间距保险
- 由 `selectRowWindow` 内部在循环里**手动给相邻消息之间分配 1 行间距**（类似 wrap），保证渲染 == sliceArea
- 或更激进：**只保留 `splitTextToLines`**，layout 也用它

代价：单条消息的视觉间距会**实时变化**（取决于渲染条数与 sliceArea），不如硬编码 +1 稳定。

### 4.4 推荐方案：**A 方向 + B 方向 组合**

**最小代码量 = 方向 B**（在 selectRowWindow 凑 sliceArea 行）。改动最少：
- viewport.ts 在末尾 `shown < sliceArea` 时把最后渲染的 item 高度强行设为 sliceArea - alreadyShown
- app.tsx 调整：聊天区 Box 简化（去掉内 row 的 height，让消息列 `flexGrow={1}` 自适应）

---

## 5. 验收 DoD

修复完成后必须达到：

1. **截图 193505 复现失败**：全屏最大化 + /help 3 次 + PgUp 到顶部 → 聊天区底部**无空白**（内容紧贴边框底边）
2. **回归**：截图 193516（贴底）依然无空白
3. **回归**：M1-M4 + A + B/C 综合 16 项断言全过
4. **回归**：Bash + PowerShell 两种终端都不引入新问题
5. **边界**：rows 极小（如 18）退化情况不破坏边框
6. **行级一致性**：`shown === sliceArea` 在所有 hidden∈[0, maxHidden] 取值下都成立

---

## 6. 风险与边界

- **极窄终端**：rows=18 时 sliceArea=min(3, ...) 但消息本身可能 wrap 多行——仍需 selectRowWindow 的兜底
- **Banner 估算偏差**：`BANNER_ROWS=15` 是写死估算，实际可能多 1 行（wrap）——若 sliceArea 大 1，selectRowWindow 应渲染 N+1 行但只渲染 N——也会留空。这正是 4.2 的 B 方向修复
- **CJK 全宽**：`splitTextToLines` 已正确处理，与 ink `wrap="wrap"` 基本一致
- **行数估算法与渲染实际差距**：极少数 Markdown 结构（代码块 ``` ```、引用 > **\`）可能让 ink 多占 1-2 行——这种误差是 4.1/4.2 共同的隐患，目前 M1 已通过 SAFETY_ROWS=2 做了保险

---

## 7. 附录 A：完整复现 demo（用户本机手测）

```powershell
cd "D:\作业\AI Agent\deepseek-code-agent"
npm start
```

1. 最大化窗口（rows ≈ 40+）
2. 连续输入 3 次 `/help` + 回车，制造多行内容
3. 按 `PgUp` 连续 20 次滚到顶部
4. 观察聊天区底部：当前 Bug = 底部有多行空行（直到边框底）
5. 期待修复后 = 底部紧贴边框

---

## 8. 附录 B：相关代码索引

- `src/cli/app.tsx:119-141` ScrollIndicator
- `src/cli/app.tsx:144-157` Scrollbar
- `src/cli/app.tsx:227-249` layout + window useMemo + 引用 ref
- `src/cli/app.tsx:536-558` 聊天区 Box 主布局（关键修改点）
- `src/app/viewport.ts:32-57` estimateLines / computeAreaHeight / prefixWidthOf
- `src/app/viewport.ts:179-227` selectRowWindow（关键修改点）
- `src/app/markdown-lines.ts:40-69` splitTextToLines（精确折行，与 estimateLines 度量差 +1）
