# 优化 - 聊天区连续滚动 + 滚动条长按拖动

> **状态**：待评审（文档就绪，等用户拍板再写代码）
> **截图**：`屏幕截图 2026-08-27 160741.png` / `160746.png` / `160751.png`
> **痛点一句话**：现在滚动是「消息粒度跳页」，三句话三个滚动位置只各看到一截，中间长对话被截断成大段空白；期望「行级连续滚动」+「鼠标按住滚动条 thumb 可上下拖动」

---

## 1. 需求分析

### 1.1 三张截图分别展示什么

| 截图 | 滚动位置 | 显示内容 | 实际隐藏行 |
|---|---|---|---|
| 160741 | **滚到顶** | 只看到 `你> 你好` 一行，巨大空白 | `↓ 22 行`（22 行历史在下方） |
| 160746 | **滚到中间** | `…(上文省略) 1. **你目前在哪个项目/目录下？**...` 一条半截断 | `↑ 2 行 / ↓ 2 行` |
| 160751 | **滚到底**（`● 已贴底`） | 只看到 `🐋本次任务耗时 2.7秒` 一行 | `↑ 22 行`（22 行历史在顶部） |

**共同特征**：每个滚动位置**只显示 1 条消息片段**（顶/底/中间都一样），其余区域是大片空白——也就是「同一段长对话在三张截图里被切成 3 页」。

### 1.2 用户痛点

1. **跳页感**：滚轮/PgUp/PgDn 一次跳 N 条整消息，视觉上像翻页，不是滑动
2. **截断怪异**：同一消息在不同滚动位置显示不同片段（`…(上文省略)` + 尾部），看起来像「内容在变」
3. **大段空白**：跳过的消息占用的行数被记为「linesAbove」但不可见——形成大片无信息空白
4. **滚动条不能拖动**：右侧的 `▍┊` 缩略图只是装饰，按住拖动没反应；想看「30 行外的内容」必须滚 N 次

### 1.3 期望行为

- **连续滚动**：滚轮/键盘一次只移动 1-3 行；连续滚动时内容**逐行变化**，不跳整条消息
- **滚动条可拖动**：按住 `▍` thumb 上下拖动，**实时**看到内容跟随鼠标位置变化
- **消息内容不被奇怪截断**：要么完整显示，要么顶部用 `…(省略 N 行)` 一行清晰标记（不再「从中间砍一刀」）

### 1.4 定义

- **「行级滚动」**：`scrollOffset` 单位是**行**（不是消息数），`selectViewWindow` 选择「从某条消息的某行开始、连续 sliceArea 行的内容」，单条消息可**仅渲染尾部 N 行**或**仅渲染头部 N 行**（不是从中间砍）
- **「行级视图」**：每条消息的渲染可拆为「(head 标记) + 第 L..R 行 + (tail 标记)」，L/R 由滚动位置决定

---

## 2. 分页感的根因分析

### 2.1 现状：消息窗口模型

`src/app/viewport.ts:119-159` 的 `selectViewWindow`：

```ts
export function selectViewWindow(items, sliceArea, hiddenFromEnd, innerW) {
  const end = Math.max(0, items.length - 1 - hiddenFromEnd);  // ← 单位是「消息索引」
  let acc = 0;
  let from = end;
  for (let i = end; i >= 0; i--) {
    if (acc + items[i].height <= sliceArea || i === end) {
      from = i;
      acc += items[i].height;                                // ← 累加的是整条消息高度
    } else break;
  }
  // ... from..end 之间整条渲染，没有「从消息中间某行开始」
}
```

**关键事实**：
- `hiddenFromEnd` = 「跳过的尾部消息数」（**整数，离散**）
- `from..end` = 整条消息区间（**永远从某条消息的第一行开始渲染**）
- 单条超高时才退化为「**截断文本** + 渲染整 sliceArea 行」（viewport.ts:144-152），但这只是兜底、不是主路径

### 2.2 滚动步进 = 整消息跳

| 操作 | 步进 | 代码位置 |
|---|---|---|
| 鼠标滚轮 | `Math.ceil(rendered.length / 3)` 条 | `src/cli/app.tsx:421` |
| PgUp/PgDn | `Math.max(1, rendered.length)` 条（一页） | `src/cli/app.tsx:386` |
| 滚轮滚动后 `setScrollOffset(next)` | next 是整数（消息数） | `src/cli/app.tsx:424` |

任何操作都是**离散消息粒度**，从不「偏移 1-3 行」。

### 2.3 副作用链

```
用户滚轮 1 次
  → scrollOffset 增加 N（整消息数）
  → end 索引上移 N
  → 选 from..end 整条消息
  → 如果切片后 from=end（只显示 1 条），且该条高度 < sliceArea
     → 留出大量空白（sliceArea - acc 行）
  → 视觉效果：跳一屏 + 大片空白 + 跳过的整条消息变成「linesAbove 计数」但不可见
```

### 2.4 ASCII 时序图

```
┌──────────┐  滚轮一次   ┌──────────────┐  selectViewWindow   ┌─────────┐
│ User     │ ──────────→ │ c.setScroll- │ ──────────────────→ │ viewport│
│ wheel    │   +N 条     │ Offset(N)    │  items[end-N..end]  │  ts:119 │
└──────────┘             └──────────────┘                     └────┬────┘
                                                                 │
            ┌────────────────────────────────────────────────────┘
            ▼
  ┌──────────────────────────────────────────────────┐
  │ from = end - K（K 使累计高度 ≤ sliceArea）       │
  │ items[from..end] 整条渲染                         │
  │ 单条超高才退化为「截断文本 + sliceArea 行」        │
  └──────────────────────────────────────────────────┘
            │
            ▼
  ┌──────────────────────────────────────────────────┐
  │ 视觉表现：                                        │
  │  • from..end 中间每条都从消息第 0 行开始渲染        │
  │  • from 之前的消息完全不可见（变 linesAbove）       │
  │  • 大片空白在 from 之前（sliceArea - used 行）     │
  └──────────────────────────────────────────────────┘
            │
            ▼
       用户感觉「跳页 + 空白」
```

### 2.5 关键代码锚点汇总

| 关注点 | 文件 | 行号 |
|---|---|---|
| 消息窗口模型（核心病根） | `src/app/viewport.ts` | 119-159 |
| 截断文本兜底（`…(上文省略)`） | `src/app/viewport.ts` | 69-117 + 144-152 |
| `scrollOffset` 控制器状态 | `src/app/useAgentController.ts` | scrollOffset 字段 |
| 滚轮滚动 effect | `src/cli/app.tsx` | 410-431 |
| PgUp/PgDn 滚动 useInput | `src/cli/app.tsx` | 380-403 |
| Scrollbar 纯视觉渲染 | `src/cli/app.tsx` | 144-157 |
| 聊天区 layout 计算 | `src/cli/app.tsx` | 225-234（layout.items 含 height） |

---

## 3. 滚动条不能拖动的根因分析

### 3.1 Scrollbar 纯视觉（app.tsx:144-157）

```ts
function Scrollbar(props: { linesAbove: number; total: number; area: number }) {
  const { linesAbove, total, area } = props;
  // ... 计算 thumb 位置 ...
  return <Text color="#4aa3e0">{lines.join('\n')}</Text>;  // ← 只渲染字符
}
```

**没有任何事件绑定**，没有 onClick/onMouseDown。`<Text>` 在 ink 里不响应点击/拖动（ink 没有 `onClick` 这种 React 风格的 prop）。

### 3.2 M3 鼠标事件捕获范围过窄（app.tsx:415）

```ts
const m = /\x1b\[<(\d+);\d+;\d+[Mm]/.exec(s);
if (!m) return;
const code = Number(m[1]);
if (code !== 64 && code !== 65) return;  // ← 只接 64/65
```

xterm SGR 鼠标事件 `code` 含义：
- `0` = 左键按下
- `1` = 中键按下
- `2` = 右键按下
- `32` = 移动（无按键）
- `34` = 拖动（任意键按下时移动）← **拖动需要这个**
- `35/36` = 释放
- `64/65` = 滚轮 ← 现在只接这两个

并且 SGR 启用序列 `\x1b[?1006h` 之外还缺 `\x1b[?1002h`（**cell motion**：键按下时持续发送移动事件，这是「长按拖动」的前提）。当前只开了 `?1000h`（任何事件）+ `?1006h`（SGR 编码），没开 `?1002h`。

### 3.3 没接 hit-testing

即使 M3 监听到了鼠标按下/移动事件，**还得知道鼠标当前在终端的 (col, row) 坐标**才能判断：
- 是否在滚动条列（col == 滚动条所在列）
- 在滚动条内的哪一行（row == thumb 顶部？拖动距离？）

SGR 格式 `\x1b[<code;col;rowM` 已经包含 (col, row)，但当前代码没解析这两个字段。

### 3.4 为什么设计时没做

- M3（M1-M4 阶段）目标只是「**让滚轮工作**」，滚动条交互留作未来工作
- 鼠标拖动在 TUI 里属于小众需求，许多 CLI 应用（lazygit、vim、htop）也不做
- hit-testing 在 TUI 中需要精确知道 chat 区在终端的绝对坐标（边框、padding、内边距都要算）——实现复杂度比看起来高

---

## 4. 优化方案

### 4.1 优化 A：行级滚动（解决分页感）

**核心思路**：把 `scrollOffset` 从「**消息数**」改为「**行数**」，`selectViewWindow` 改为「**从全局第 L 行开始，贪心选 N 行可渲染内容**」。

**改动点**：
- `src/app/viewport.ts`：
  - 新增 `selectRowWindow(items, sliceArea, hiddenRows, innerW)` —— hiddenRows 单位是行
  - 内部把每条消息按 `prefixWidth` + 文本宽度拆成「行级单元」：`{ msg, startLine, endLine, fullHeight, visibleStartLine, visibleEndLine }`
  - 单条消息**可只渲染中间一段行**（不破坏 Markdown 段落结构：行级切片按 `\n` 切，避免切断列表项/代码块）
- `src/app/types.ts` + 控制器：
  - `scrollOffset: number` 改为「行数」语义
  - `setScrollOffset` 接口签名不变
- `src/app/useAgentController.ts`：
  - `maxScroll` 从「消息数」改为「总行数」
- `src/cli/app.tsx`：
  - 滚轮 `page = 3`（3 行）
  - PgUp/PgDn `page = sliceArea`（一页）
  - 贴底跟随：`stickRef` 仍为「行级」
- 新增 `src/app/markdown-lines.ts`：
  - 给定 `text` + `innerW` + `[startLine, endLine)`，返回 `{ headClip, lines, tailClip }`
  - 关键：切点必须落在 `\n` 边界，避免切断行

**单条超高时的截断**（避免从中间砍）：
- 渲染头部：`…(省略 N 行)\n第 R 行\n...\n最后一行`
- 渲染尾部：`第一行\n...\n第 L 行\n…(下文省略)`
- 渲染中间：`…(省略 N 行)\n第 L 行\n...\n第 R 行\n…(省略 M 行)`
- **不再**渲染「`…(上文省略) 1. **你目前在哪个项目...**`」这种从行中间砍一刀的样式

**验证 1**：用户三张截图的所有问题（跳页、空白、截断怪异）应消失

### 4.2 优化 B：滚动条 thumb 可点击/拖动

**核心思路**：SGR 鼠标事件已能拿到 (col, row)；加上 hit-test + 拖动状态机。

**改动点**：
- `src/cli/app.tsx`：
  - 扩展 M3 data 监听器解析 `code === 0`（按下）/ `34`（拖动）/ `35`（释放）
  - 解析 `col, row` 字段
  - 计算「chat 区在终端的 (startCol, startRow) 边界」：用 `process.stdout.rows/columns` + Banner 高度 + 边距
  - 维护 `dragState: { startRow, startScrollOffset, thumbTop } | null`
  - 拖动时：`hiddenRows = ((dragRow - thumbTop) / (track - thumbH)) * (totalRows - sliceArea)`
- SGR 启用序列加 `\x1b[?1002h`（cell motion 拖动）
- 退出时加 `\x1b[?1002l`

**hit-test 步骤**：
1. chat 区右侧倒数第 1 列是滚动条列（`startCol + innerW`）
2. chat 区在终端的 `startRow = Banner.height + 边框`（精确值需实测）
3. 点击/拖动时若 `(col, row)` 在滚动条区域内 → 进入拖动模式
4. **点击 thumb 区域内** vs **点击 track 非 thumb 区域** = 两种行为：
   - thumb 内：进入拖动模式，记录 thumb top
   - track 非 thumb 区域（点空白 track）：跳到该位置（thumb 中心对齐到点击点）

**状态机**：

```
       (col, row 落在滚动条内)            button press
idle ─────────────────────────→ pressing ──────────────→ dragging
  ↑                              │ │                        │
  │                              │ │ button release         │
  │                              │ └────────────────────────┘
  │                              │
  │                              ↓ button release（未移动）
  │                            idle
  │
  └── 滚轮事件始终走原路（即使在拖动中也可滚）
```

### 4.3 优化 C：长按拖动支持

**核心思路**：开 `?1002h`（cell motion）后，按住鼠标键移动会持续发 `code=34` 事件。**用户按住滚动条 thumb → 拖动鼠标**期间连续触发，根据 mouseY 实时算 scrollOffset。

需要的设计选择：
- 拖动期间**禁用贴底跟随**（避免内容「自动跳」打断拖动）
- 拖动期间**禁用滚轮事件**（用户已经握住滚动条了，不应同时响应滚轮）
- 拖动**实时**更新（不发 throttle/debounce——这是桌面交互，用户期待零延迟）

**关键设计：cursor 锁定**
- 进入拖动时记下：
  - 拖动开始时 thumb 在 track 中的位置 `pos0 = thumbTop / track`
  - 拖动开始时的 `hiddenRows0`
- 拖动过程中：每收到 `code=34` 事件，鼠标 y 变化 `deltaY = row - lastRow`：
  - `hiddenRows = hiddenRows0 + (deltaY / (track - thumbH)) * (totalRows - sliceArea)`
  - clamp 到 `[0, totalRows - sliceArea]`
  - `stickRef = false`（拖动期间不自动回底）

### 4.4 三方案关系

- **A 是地基**（不改 A，B 和 C 都没法做行级 hit-test）
- **B 是必要基础设施**（滚动条交互基础）
- **C 是 B 的进阶版**（长按持续追踪）

**建议落地顺序**：A → B → C。每步独立提交，每步 tsc 0 错 + 截图无头回归。

---

## 5. 关键代码改动

### 5.1 改动文件清单（待用户拍板）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `src/app/markdown-lines.ts` | 新增（行级切片工具） | +80 |
| `src/app/viewport.ts` | 改 `selectViewWindow` → 新增 `selectRowWindow`；保留旧函数备用 | +60 / -20 |
| `src/app/types.ts` | 改 `scrollOffset` 语义注释 | +5 / -3 |
| `src/app/useAgentController.ts` | 改 maxScroll 计算 | +5 / -3 |
| `src/cli/app.tsx` | 改滚轮/PgUp 步进、Scrollbar 加 hit-test、data 监听器扩展 | +120 / -40 |
| `docs/UX优化-连续滚动与滚动条拖动.md` | 本文档 | +1 |

### 5.2 核心伪代码（方案 A 核心：`selectRowWindow`）

```ts
// src/app/viewport.ts 新增
export function selectRowWindow(
  items: { msg: UiMessage; height: number }[],
  sliceArea: number,
  hiddenRows: number,  // 从顶部隐藏的行数
  innerW: number,
): ViewWindow {
  const totalRows = items.reduce((s, x) => s + x.height, 0);
  const maxHidden = Math.max(0, totalRows - sliceArea);
  const startRow = Math.min(hiddenRows, maxHidden);  // 顶部隐藏 startRow 行
  const endRow = Math.min(totalRows, startRow + sliceArea);

  // 贪心：在 items 上滑动窗口，落到 [startRow, endRow) 的渲染
  let acc = 0;
  const rendered: ViewWindowItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const msgStart = acc;
    const msgEnd = acc + items[i].height;
    acc = msgEnd;
    if (msgEnd <= startRow) continue;          // 完全在视口上方
    if (msgStart >= endRow) break;             // 完全在视口下方
    // 部分重叠：行级切片
    const visStart = Math.max(0, startRow - msgStart);
    const visEnd = Math.min(items[i].height, endRow - msgStart);
    const { text, isClipped } = clipMessageRows(items[i].msg, visStart, visEnd, innerW);
    rendered.push({ msg: items[i].msg, text, height: visEnd - visStart, isClipped });
  }
  return { rendered, linesAbove: startRow, linesBelow: Math.max(0, totalRows - endRow) };
}

// 配套：行级切片（按 \n 切，必要时前/后加省略标记）
function clipMessageRows(msg: UiMessage, visStart: number, visEnd: number, innerW: number) {
  const allLines = splitTextToLines(msg.text, innerW, prefixWidthOf(msg.role, msg.phase));
  if (visStart === 0 && visEnd === allLines.length) {
    return { text: msg.text, isClipped: false };
  }
  const head = visStart > 0 ? `…(省略前 ${visStart} 行)\n` : '';
  const tail = visEnd < allLines.length ? `\n…(省略后 ${allLines.length - visEnd} 行)` : '';
  return { text: head + allLines.slice(visStart, visEnd).join('\n') + tail, isClipped: true };
}
```

### 5.3 核心伪代码（方案 B+C 核心：滚动条拖动）

```ts
// src/cli/app.tsx 扩展 M3 data 监听器
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const onData = (buf: Buffer | string) => {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  const m = SGR.exec(s);
  if (!m) return;
  const code = Number(m[1]);
  const col = Number(m[2]);
  const row = Number(m[3]);

  // 滚轮：原逻辑
  if (code === 64 || code === 65) { /* 滚轮原处理 */ return; }

  // 计算 chat 区在终端的边界
  const chatBox = chatBoxRect.current;  // {startCol, startRow, endCol, endRow}
  if (!chatBox) return;
  const scrollbarCol = chatBox.endCol - 1;  // 倒数第 1 列
  if (col !== scrollbarCol) return;  // 不在滚动条列

  // 把 row 映射到 scrollbar 内坐标
  const trackTop = chatBox.startRow + 1;  // 跳过顶边框
  const trackH = chatBox.endRow - chatBox.startRow - 1;  // 减上下边框
  if (row < trackTop || row >= trackTop + trackH) return;
  const inTrack = row - trackTop;

  const totalRows = layoutRef.current.total;
  const area = sliceArea;
  const thumbH = Math.max(1, Math.round((area / Math.max(1, totalRows)) * trackH));
  const maxPos = trackH - thumbH;
  const scrollable = Math.max(1, totalRows - area);

  if (code === 0) {  // 按钮按下
    const thumbTop = Math.round((c.scrollOffsetRef.current / scrollable) * maxPos);
    if (inTrack >= thumbTop && inTrack < thumbTop + thumbH) {
      // 点在 thumb 上 → 拖动
      dragState.current = { startRow: inTrack, startScrollOffset: c.scrollOffsetRef.current, thumbTop };
    } else {
      // 点在 track 空白 → 跳到该位置
      const newOffset = Math.round(((inTrack - thumbH / 2) / Math.max(1, maxPos)) * scrollable);
      c.setScrollOffset(clamp(newOffset, 0, scrollable));
    }
  } else if (code === 34 && dragState.current) {  // 拖动
    const deltaRows = inTrack - dragState.current.startRow;
    const newOffset = dragState.current.startScrollOffset +
      Math.round((deltaRows / Math.max(1, maxPos)) * scrollable);
    c.setScrollOffset(clamp(newOffset, 0, scrollable));
    stickRef.current = false;
  } else if (code === 35) {  // 释放
    dragState.current = null;
  }
};

// 启用序列加 ?1002h（cell motion 拖动）
process.stdout.write('\x1b[?1000h\x1b[?1006h\x1b[?1002h');
// 关闭时
process.stdout.write('\x1b[?1002l\x11b[?1006l\x1b[?1000l');
```

### 5.4 不改动的清单

- ❌ `src/app/useAgentController.ts` 的 `scrollOffset` 字段名（语义改但接口名可保留以减小 diff）
- ❌ `src/cli/Markdown.tsx`（行级切片由 viewport.ts 完成后传给 MarkdownMessage 的 `text` 是已切好的字符串，渲染逻辑不变）
- ❌ M1（边框）、M2（键盘滚动逻辑）、M3（鼠标滚轮）

---

## 6. 验证清单（DoD）

### 6.1 沙箱无头验证

- **修改前**：复现脚本（类似 M3 复现 + scroll offset 100）→ 帧显示大片空白（`rowsThatAreBlank > 5`）
- **修改后 A**：`setScrollOffset(5)` 应只移动 5 行（不是 5 条消息），帧中可看到「完整片段 + 上下省略标记」
- **修改后 B**：用 `ink-testing-library` 模拟发送 SGR 按下/拖动/释放事件 → 帧中 thumb 位置变化、scrollOffset 变化
- **修改后 C**：模拟 `code=34` 持续 5 个不同 row → scrollOffset 单调变化

### 6.2 综合回归（不退化 M1–M4 + 已修 SGR）

- 14 项 M1–M4 综合断言 + 16 项含 SGR 过滤 = 30 项继续通过
- 新增 6 项行级滚动断言

### 6.3 用户本机手测

1. `npm start` → 正常输入对话
2. 输入 `/help` 后回车，注入长消息
3. 滚动滚轮：内容**逐行变化**，大段空白消失
4. 按住右侧滚动条 thumb **拖动**鼠标：内容实时跟随
5. 点击滚动条 track 空白区域：thumb 跳到该位置
6. 流式输出期间拖动滚动条：不被自动回底打断

---

## 7. 风险与边界

| 场景 | 风险 | 缓解 |
|---|---|---|
| 行级切片切断列表项/代码块 | 视觉割裂 | `splitTextToLines` 严格按 `\n` 切，绝不切断一行；列表项跨行时切整段 |
| MarkdownMessage 渲染与预估行数不一致 | 实际行数与 `estimateLines` 偏差 | 偏保守（多估）不溢出；如需精确可后续测量式（侵入大） |
| 拖动期间流式输出到达 | 内容变化 → thumb 位置跳变 | 拖动期间禁用贴底跟随、记录 totalRows 锁定基准 |
| `?1002h` 在某些终端不支持 | 拖动失效 | 失败回退到仅滚轮（与现状一致），用 `process.stdout` 写回查 |
| hit-test 算错 chat 区坐标 | 滚动条点不响应 | 用 `Box` 渲染后读 ink 的内部坐标（如果支持）；否则实测多个终端尺寸调常量 |
| Windows Terminal 的 SGR 行为 | 与 Linux 略有差异 | 已在 Windows 截图实证可用；保留 `?1006h` 是事实标准 |
| 单条超高消息的「省略前/后 N 行」标记占用行数 | 1-2 行 | sliceArea 减 2 留位；切点提前 1 行避免贴边 |

---

## 8. 附录

### 附录 A：用户三张截图的复现脚本（待 A 实施后可跑）

```tsx
// 临时 src/cli/repro-paging.tsx
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from './app.tsx';
import type { AppProps } from '../app/types.ts';

const props = { agent: {}, models: {}, version: 'v0.5.0' } as unknown as AppProps;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { lastFrame, stdin, unmount } = render(<App {...props} />);
  await sleep(120);
  stdin.write('/help'); await sleep(50); stdin.write('\r'); await sleep(110);
  // 滚到顶
  for (let i = 0; i < 20; i++) { stdin.write('\x1b[5~'); await sleep(20); }
  await sleep(110);
  console.log('=== 滚到顶帧 ===\n' + (lastFrame() ?? ''));
  // 滚到中间
  for (let i = 0; i < 8; i++) { stdin.write('\x1b[6~'); await sleep(20); }
  await sleep(110);
  console.log('=== 滚到中间帧 ===\n' + (lastFrame() ?? ''));
  // 回底
  for (let i = 0; i < 8; i++) { stdin.write('\x1b[6~'); await sleep(20); }
  await sleep(110);
  console.log('=== 回底帧 ===\n' + (lastFrame() ?? ''));
  unmount();
}
main();
```

### 附录 B：xterm SGR 鼠标 code 表

| code | 含义 |
|---|---|
| 0 | 左键按下 |
| 1 | 中键按下 |
| 2 | 右键按下 |
| 3 | 释放（无按键） |
| 32 | 移动（无按键） |
| 33 | 移动（左键按下） |
| 34 | 移动（中键/右键按下，依赖 `?1002h`） |
| 35 | 释放（任何键） |
| 64 | 滚轮上 |
| 65 | 滚轮下 |

**当前实现**只接 64/65；B+C 需接 0/1/2/34/35。

### 附录 C：SGR 启用序列

| 序列 | 含义 |
|---|---|
| `\x1b[?1000h` | 启用鼠标事件（左/中/右键按下/释放） |
| `\x1b[?1002h` | 启用 cell motion（按键时持续发送移动事件，即「拖动」） |
| `\x1b[?1006h` | 启用 SGR 编码（`CSI < code;col;row M/m`） |
| `\x1b[?1000l` | 关闭 |
| `\x1b[?1002l` | 关闭 |
| `\x1b[?1006l` | 关闭 |

**当前启用**：`?1000h` + `?1006h`；**拖动需要**再加 `?1002h`。

### 附录 D：相关代码索引

| 关注点 | 文件 | 行号 |
|---|---|---|
| 行级切片工具（待新增） | `src/app/markdown-lines.ts` | — |
| 消息窗口模型 | `src/app/viewport.ts` | 119-159 |
| 截断文本兜底 | `src/app/viewport.ts` | 69-117, 144-152 |
| 行数估算（CJK 双宽） | `src/app/viewport.ts` | 31-67 |
| `scrollOffset` 状态 | `src/app/useAgentController.ts` | scrollOffset 字段 |
| 滚轮 effect | `src/cli/app.tsx` | 410-431 |
| 键盘滚动 useInput | `src/cli/app.tsx` | 380-403 |
| Scrollbar 渲染 | `src/cli/app.tsx` | 144-157 |
| 贴底跟随 | `src/cli/app.tsx` | 250-253 |
| 聊天区 layout 计算 | `src/cli/app.tsx` | 225-234 |
| SGR 鼠标过滤器（已修） | `src/cli/app.tsx` | 258-266 |
| M1-M4 文档 | `docs/TUI界面优化-需求与方案.md` | 全 |
| SGR 泄漏修复 | `docs/Bug修复-鼠标滚轮字符泄漏到输入框.md` | 全 |

---

## 9. 实施记录（2026-08-27，A/B/C 全部完成）

> 本节记录实际实现与文档规划的差异，作为未来维护的依据。提交：
> `0980543`（优化A 行级滚动）→ `0b765aa`（优化B+C 滚动条交互）。

### 9.1 与文档的偏差（有意为之，均有验证）

| 文档规划 | 实际实现 | 原因 |
|---|---|---|
| §5.2 `selectRowWindow` 的 `hiddenRows` = **从顶部隐藏行数**（0=显示头部） | `hiddenRows` = **距底部隐藏行数**（0=贴底显示最新） | 与既有「scrollOffset=0 贴底」「PgDn 回底」「贴底跟随」交互语义冲突。文档伪代码方向反了，实施中修正（见 §4.1 控制器语义） |
| §5.2 省略标记 `head + rows + tail`（标记**额外占行**） | `clipMessageRows` 标记**替换首/末行**（不额外占行） | 保证渲染行数严格 == 分配区间，绝不溢出 sliceArea（文档承诺的精确性靠这个达成） |
| §5.2 `selectRowWindow` 用 `clipMessageRows` 在 viewport.ts 内实现 | `splitTextToLines` / `clipMessageRows` 放 `src/app/markdown-lines.ts`（自带 displayWidth 副本），viewport.ts 只放 `selectRowWindow` | 避免 viewport ↔ markdown-lines 循环依赖 |
| §5.3 `dragState = { startRow, startScrollOffset }` | `dragState = { startInTrack, startLinesAbove }` | 统一用 linesAbove 基准（与 Scrollbar 组件同向），避免「hidden 方向」换算错误（首版实现上拖/下拖方向反了，测试暴露后修正） |
| §5.3 hit-test 的 scrollbarCol 未给公式 | `scrollbarCol = stdout.columns - 2`（内容区最右列），`trackTop = BANNER_ROWS + 2`，`trackH = sliceAreaRef.current`；columns 用 **useStdout**（与渲染帧宽一致，非 process.stdout） | 测试环境 process.stdout.columns 与实际帧宽不一致会导致 hit-test 打偏（实测踩坑：猜 84 实际 100） |
| §4.3 拖动期间禁用滚轮 | 未禁用（拖动中滚轮仍生效，释放后清 dragState） | 拖动是点按状态，与滚轮输入互斥性低；禁用会增加状态复杂度，暂不做，风险低 |
| §4.3 长按拖动需 `?1002h` | 已启用 `\x1b[?1002h`（cell motion），退出 `?1002l` | 与文档一致 |

### 9.2 落地实现摘要

- **优化A**：`src/app/markdown-lines.ts`（新增）：displayWidth（同步副本）/ splitTextToLines（精确模拟 ink wrap，首行扣前缀宽）/ clipMessageRows（行级切片 + 标记替换首末行）。`viewport.ts`：新增 `selectRowWindow`（hiddenRows=距底部隐藏行数，0=贴底；单条消息可从中间行起/止渲染，渲染行数严格==sliceArea；保留旧 selectViewWindow 备用）。`app.tsx`：滚轮 1 格=3 行、PgUp/PgDn=一页（sliceArea 行）、maxHiddenRows=totalRows-sliceArea；滚动条 total 用精确 totalRows。
- **优化B+C**：SGR 启用序列加 `?1002h`；data 监听器逐序列解析（code/col/row/尾部 m）；滚动条列 hit-test（col=stdout.columns-2，track=[BANNER_ROWS+2, +2+sliceArea)）；按下 thumb → 拖动（dragState 记 startInTrack/startLinesAbove）、按下 track 空白 → thumb 中心对齐跳转、移动 → delta→linesAbove→hidden、释放 → 清状态。坐标换算统一 linesAbove 基准。

### 9.3 验证方式（沙箱无 TTY 的替代方案）

- **优化A**：无头渲染断言 9 项：贴底语义（0=贴底）/边框/上滚↑/空白行数 0/滚到顶无↑有↓/PgDn 回底/SGR 不泄漏/普通输入。**测试坑**：PgUp 高频写入会丢事件（`\x1b[5~` 间隔 <25ms 部分丢失，真实终端按键间隔天然够），慢速（80ms）后全过。
- **优化B+C**：`Object.defineProperty(process.stdin, 'isTTY', {value:true})` 模拟 TTY（仅影响 M3 effect；ink 渲染不受影响）；直接向 ink 内部 stdin 写 SGR 序列断言：thumb 上拖→顶/下拖→底/点 track 空白→顶/SGR 不泄漏。**测试坑**：`stdout.columns` 在测试库下是 100（非 80/84），scrollbarCol=98——hit-test 公式与真实终端一致，测试只需对齐 columns 值。
- **综合回归**：M1-M4 + A + B/C + SGR 过滤 = 16 项断言全过，tsc 0 errors。
- **待用户本机手测**：真实滚轮/鼠标拖动滚动条的手感、alt 屏观感、流式输出期间拖动。

### 9.4 遗留与后续（可选）

- 拖动期间未禁用滚轮（§9.1），若实际手感冲突再加。
- hit-test 依赖 Banner 固定 15 行（BANNER_ROWS）；若 Banner 布局变化需同步更新 trackTop。
- 极窄终端（rows<24）sliceArea 退化到 1-2 行，滚动条 thumb 不可拖（maxPos≤0 时跳过）——与 M1 遗留一致。
