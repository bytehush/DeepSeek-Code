# TUI 界面优化 — 需求分析与实施方案

> 面向 AI 实现者的结构化规格文档。
> 输入：用户截图 + 用户诉求 + `src/cli/app.tsx`、`useAgentController.ts`、`chat.ts`、`Markdown.tsx`、`main.ts` 现状。
> 目标：让 TUI 达到「固定顶栏 + 可滚动聊天区 + 固定输入栏」的现代聊天终端标准布局；启动无残留；流式期间交互不卡；滚动（含鼠标）顺滑。

---

## 1. 用户诉求（汇总表）

| # | 诉求 | 类别 | 当前是否满足 |
|---|---|---|---|
| A | 启动 `npm start` 后清除 `> ... start` / `> tsx ...` 等前置输出，仅保留 TUI 画面 | 启动行为 | ❌ 截图顶部仍可见三行残留 |
| B | 聊天区域（"对话框"）用边框包围、实时撑满 Banner 与 InputBar 之间空间 | 布局 | ❌ 中部 Box 无 `borderStyle` |
| C | 顶部 Banner 固定不随内容滚动 | 布局 | ✅ 已满足（根 Box `column height=100%`，Banner 在最前） |
| D | 聊天区随对话长度**可滚动**（含鼠标滚轮），流式追加时默认贴底 | 交互 | ❌ 无视口、无滚动状态、无鼠标绑定 |
| E | 流式输出时鼠标与键盘仍可响应（怀疑 I/O 阻塞） | 性能/交互 | ⚠ 异步正确，但每 token 一次 `setMessages` + 无 `memo` 导致主观阻塞感 |
| F | 输入框固定在底部 | 布局 | ✅ 已满足（InputBar 在 column 末尾） |

> 名词约定：本文档中**「对话框」= Banner 与 InputBar 之间的聊天消息区域**（即 `src/cli/app.tsx:297` 那个 Box）。

---

## 2. 现状与症状（截图 + 代码双重锚定）

### 2.1 截图观察（`屏幕截图 2026-08-27 004632.png`）
- 终端顶部**仍可见**：
  - `> deepseek-code-agent@0.5.0 start`
  - `> tsx src/cli/main.ts`
  - `[auth] 使用已保存的 API Key（****1eea）`
  → **A 失败**：ink 未进入 alt 屏、未清屏。
- Banner（蓝单线框 + 鲸鱼像素画 + 提示面板）正常渲染。
- Banner **下沿到输入框**之间：聊天内容（`你> 你好`、`Agent> 我是...`）**无任何边框**，直接贴 Banner 下沿、延伸到输入框。
  → **B 失败**：中部 Box 无 `borderStyle`、无可视边界。
- 无滚动指示、无视口，长对话表现不可控 → **D 失败**。
- 输入框有蓝虚线上下边 + 居中光标 → **F 满足**。

### 2.2 代码锚点（精确到文件 + 行号）

| 锚点 | 文件 : 行 | 现状 |
|---|---|---|
| 主布局根 | `src/cli/app.tsx:295` | `<Box flexDirection="column" height="100%">` ✅ |
| Banner | `src/cli/app.tsx:296` | 固定渲染在最前 ✅ |
| **中部消息 Box** | `src/cli/app.tsx:297` | `<Box flexGrow={1} flexDirection="column" paddingX={1}>` ❌ **无 `borderStyle`、无 `overflow`** |
| 消息 map | `src/cli/app.tsx:298-322` | `c.messages.map(...)` 全量渲染 ❌ 无视口切片 |
| 流式指示 | `src/cli/app.tsx:323` | `{c.busy && <ThinkingIndicator/>}` ✅ |
| InputBar | `src/cli/app.tsx:335-341` | 在 column 末尾 ✅ |
| `useInput`（键盘） | `src/cli/app.tsx:147-252` | 仅键盘映射 ❌ **无鼠标捕获/滚轮解析** |
| `startApp` / `render` | `src/cli/app.tsx:347-351` | `render(<App/>, { exitOnCtrlC:false })` ❌ **未进入 alt 屏、未清屏、无退出清理** |
| `main()` | `src/cli/main.ts` | 直接 `await startApp(props)`，无前置清屏 |
| `appendStreaming` | `src/app/useAgentController.ts:84-95` | 每个 token 一次 `setMessages` ❌ **无批处理** |
| `push` / `endStreaming` | `src/app/useAgentController.ts:74-105` | 同上，每次事件 `setMessages` |
| `MarkdownMessage` | `src/cli/Markdown.tsx:152-177` | `useMemo` 缓存了 `blocks` ✅，但**组件未 `React.memo`** → 父级 setState 仍全量重渲染 |

---

## 3. 根因分析

| 问题 | 根因 |
|---|---|
| **A 启动残留** | `startApp` 未进入备用屏幕缓冲（`\x1b[?1049h`）也未清屏（`\x1b[2J\x1b[H`）。ink 默认 `stdoutMode='wrap'`，覆盖普通屏幕，npm/tsx 历史留在滚动缓冲与上方空白处。 |
| **B 无边框不撑满** | `app.tsx:297` 消息 Box 无 `borderStyle`；`flexGrow={1}` 虽能撑满剩余高度，但**没有可视边界**，用户感受不到"区域"。 |
| **D 不可滚动** | ink 无原生滚动容器；当前全量渲染消息，溢出靠终端 scrollback，无视口、无指示器、无键盘/鼠标绑定。 |
| **E 流式卡顿** | 代码本身是 async（`runAgent` 是 async generator，`for await`），并非真"同步阻塞"。卡顿来自：(1) 每个 token 一次 `setMessages` → React 全列表 reconcile；(2) 消息组件无 `React.memo`，父级 setState 全部重渲染；(3) 未批处理，事件循环在高频 setState + ink stdout 同步写出下被占满，主观感觉"鼠标/键盘被阻塞"。** |
| **C/F 顶/底固定** | 根 `Box height=100%` + 列布局 + Banner 固定高 + InputBar 固定高 + 中部 `flexGrow=1`，天然满足，无需改动。 |

---

## 4. 改动清单（精确到文件 + 行号）

| # | 文件 : 行 | 改动 |
|---|---|---|
| 1 | `src/cli/app.tsx:295-343` | 主布局：中部 Box 加 `borderStyle="round"` + `borderColor="#2f6fb0"`；引入视口/滚动状态 |
| 2 | `src/cli/app.tsx:347-351` | `startApp`：进入 alt 屏 + 清屏 + 隐光标；注册退出清理（恢复光标 + 离开 alt 屏） |
| 3 | `src/cli/app.tsx:147-252` 及新增 | `useInput` 增加键盘滚动绑定（PgUp/PgDn/↑↓/Home/End）；新增鼠标捕获与滚轮解析（T2） |
| 4 | `src/cli/app.tsx:298-322` | 消息渲染改为"按视口切片"（仅 T2 视口虚拟化时需要） |
| 5 | `src/cli/Markdown.tsx:152` | `MarkdownMessage` 用 `React.memo` 包裹导出；非 assistant 文本消息也 memo |
| 6 | `src/app/useAgentController.ts:74-105` | `push` / `appendTo` / `appendStreaming` 增加 **microtask 批处理**：同一 tick 内的多次调用合并为一次 `setMessages` |
| 7 | `src/cli/app.tsx`（新增组件） | `ScrollIndicator`：右下角渲染 `↑ N 行以上 / ● 已贴底` |
| 8 | `src/app/useAgentController.ts:24-47` | 控制器返回值新增 `scrollOffset`、`setScrollOffset`、`messagesAreaHeight` 状态供 TUI 使用 |

---

## 5. 推荐方案（分层落地）

### Tier 1（必做，≈半个工作日）

覆盖 A、B、C、D（键盘部分）、E、F 中除鼠标外的全部诉求。

#### 5.1 启动清屏 + alt 屏（改动 2）
在 `src/cli/app.tsx:347-351` `startApp` 开头：
```
写入: \x1b[?1049h\x1b[?25l\x1b[2J\x1b[H
  // 进 alt 屏 + 隐光标 + 清屏 + 光标回原点
注册退出清理（双保险）：
  - process.on('exit', () => process.stdout.write('\x1b[?25h\x1b[?1049l'))
  - useApp().exit 回调（已在 App 内）同样写
```
任何退出路径（`/exit`、Ctrl+C、异常）都能恢复主屏幕与光标。

#### 5.2 聊天区加边框 + 撑满（改动 1）
`src/cli/app.tsx:297`：
```
<Box
  flexGrow={1}
  flexDirection="column"
  borderStyle="round"
  borderColor="#2f6fb0"
  paddingX={1}
  overflow="hidden"   // 防止内容溢出破坏边框（ink 7 支持）
>
```
注：ink 的 `overflow` 仅控制"超出父盒时不绘制到外侧"，**不提供原生滚动**，仍需配合 T2 视口切片。

#### 5.3 键盘滚动 + 贴底（改动 3 部分）
控制器（`useAgentController.ts`）新增：
- `scrollOffset: number` — 距离底部的行数；`0` = 贴底。
- `setScrollOffset(n: number)` — clamp 到 `[0, maxScroll]`。
- `messagesAreaHeight: number` — 由 TUI 测量后注入（Banner/InputBar 固定高 + 终端总高算出）。

`useInput` 增补（在现有 `useInput` 同 callback 内或新增第二个）：
- `PgUp` → `scrollOffset += messagesAreaHeight`
- `PgDn` → `scrollOffset = max(0, scrollOffset - messagesAreaHeight)`
- `↑` → `scrollOffset += 1`；`↓` → `scrollOffset = max(0, scrollOffset - 1)`
- `Home` → `scrollOffset = Infinity`（取 maxScroll）；`End` → `scrollOffset = 0`（贴底）

`appendStreaming` 在每次"合并 flush"前：
- 若 `scrollOffset === 0`（用户贴底）→ 自动保持贴底，新内容追加后仍 `scrollOffset=0`；
- 若 `scrollOffset > 0`（用户向上滚了在读历史）→ 不抢焦点，`scrollOffset` 随新内容增加，让用户看到稳定的历史位置（标准聊天客户端行为）。

#### 5.4 流式批处理（改动 6）
`useAgentController.ts` 中所有 `setMessages` 调用统一过批处理器：

```ts
// 伪代码
let pending: UiMessage[] | null = null;
let scheduled = false;
function scheduleSetMessages(producer: (prev: UiMessage[]) => UiMessage[]) {
  pending = producer;          // 合并：最后一个 producer 覆盖
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => {
      const p = pending!;
      pending = null; scheduled = false;
      setMessages(p);          // 一次 setMessages
    });
  }
}
```
收益：同一 microtask tick 内多个 token 只触发**一次** React 渲染；事件循环空闲出来处理 stdin → 键盘/鼠标立刻有响应。

附：对 `appendTo(streamingId, chunk)` 可进一步做"字符级缓冲"（同一 microtask 内的多次 appendTo 合成一次 `map`），收益同。

#### 5.5 React.memo（改动 5）
`src/cli/Markdown.tsx`:
```
export const MarkdownMessage = React.memo(
  function MarkdownMessage(props) { ... },
  (a, b) => a.text === b.text && a.role === b.role && a.phase === b.phase
);
```
非 assistant 的 `<Text>` 消息也用 `React.memo` 小函数包裹，避免 `messages.map` 全列表重渲染。

#### 5.6 滚动指示（改动 7）
中部 Box 右下角（用 `flexDirection="column" justifyContent="flex-end"` + 右下角 Text）渲染：
- 贴底：`● 已贴底`（灰）
- 偏离：`↑ N 行以上`（蓝）+ 提示"按 End 回到最新"

**Tier 1 验收**：A、B、C、D（键盘部分）、E、F 达成；鼠标滚轮待 T2。

---

### Tier 2（进阶，≈1 个工作日）

#### 5.7 鼠标捕获与滚轮（改动 3 续）
**启用序列**（写入 stdout 一次）：
```
\x1b[?1000h   // 启用鼠标点击+滚轮事件
\x1b[?1006h   // SGR 编码模式（推荐，Windows Terminal 支持）
```
**关闭序列**（退出前）：
```
\x1b[?1006l\x1b[?1000l
```
**解析**（用 `useStdin()` 拿原始流，附加 `'data'` 监听器，**只解析不消费**）：
- xterm SGR 滚轮事件形如 `\x1b[<65;x;yM`（下滚 wheel down）与 `\x1b[<64;x;yM`（上滚 wheel up）。
- 命中：上滚 → `scrollOffset += 3`，下滚 → `scrollOffset = max(0, scrollOffset - 3)`。
- 非鼠标字节**完全不动**，让 ink 的 `useInput` 继续解析键盘。

风险与缓解（详见 §6）：
- 监听器与 ink 的 stdin 解析并发；只要我们不消费/pause 流，键盘不会被破坏。
- 极少数终端不支持 SGR → 启动时检测 `DA` 报告，失败则跳过鼠标绑定并降级。

#### 5.8 视口虚拟化渲染（改动 4）
**测量**：
- `terminalRows` ← `useStdout().stdout.rows ?? 24`
- `messagesAreaHeight = terminalRows - bannerHeight - inputBarHeight - 2`（边框各 1）

**估算每条消息行数**（保守偏多估，留 1-2 行 buffer）：
```
function estimateLines(msg: UiMessage, innerWidth: number): number {
  let lines = 0;
  for (const ln of msg.text.split('\n')) {
    lines += Math.max(1, Math.ceil(ln.length / Math.max(1, innerWidth - prefixWidth)));
  }
  return lines + 1;  // 消息间空行
}
```

**切片**：
- 给每条消息算累计起止行；维护 `scrollOffset`（顶可见行号）。
- 仅渲染与 `[scrollOffset, scrollOffset + messagesAreaHeight]` 相交的消息；不渲染的用占位 `<Box height={N}/>` 维持滚动条总高。
- 流式消息（`phase==='progress'`）每次 flush 批处理后重算并触发切片重渲染。

**滚动条**（右侧 1 列）：
```
fillRatio = messagesAreaHeight / totalMessageLines
thumbPos = (scrollOffset / maxScroll) * (messagesAreaHeight - thumbSize)
thumb = '█'; track = '│'
```

**Tier 2 验收**：D 完整（鼠标滚轮 + 滚动条）；长对话（1000+ 条）滚动帧时 <16ms。

---

## 6. 风险与边界

| 风险 | 缓解 |
|---|---|
| 鼠标捕获与 ink `useInput` 共存可能干扰键盘 | 监听器**不消费**非鼠标字节、不 pause 流；如发现键盘异常，T2 鼠标捕获提供 feature flag（默认关闭，README 标注启用方法） |
| 视口虚拟化估算行数与真实渲染偏差 → 底部留白/裁切 | 用 `split('\n').length` 作下限 + wrap 宽系数 1.05~1.1 上限；首版保守偏多估 1-2 行；长消息按字符估算 |
| alt 屏在某些老旧终端失效 | 启动时检测 DA 报告（`\x1b[c` + 解析），失败则降级为"启动时 `\x1b[2J\x1b[H` 清屏一次"，接受 scrollback 残留 |
| 流式批处理改变事件顺序观感 | microtask 合并，每 chunk 最迟下一 microtask 落屏，体感延迟 <1ms；测试对照确认无回退 |
| `React.memo` 误命中导致 streaming 不刷新 | memo 比较函数显式比较 `text`/`role`/`phase`；streaming 消息 text 必然变化，自动更新 |
| Windows 终端兼容性 | 所用 ANSI 序列（alt 屏、SGR 鼠标、清屏）在 Windows Terminal / ConEmu / PowerShell 7 全部支持；备用降级路径已设计 |

---

## 7. 实施步骤（建议顺序）

| 里程碑 | 内容 | 验证 |
|---|---|---|
| **M1** Tier 1 视觉 | alt 屏/清屏 + 边框 + flex + `React.memo` + 批处理 | 截图无残留；流式打字不卡；`tsc` 0 错 |
| **M2** Tier 1 滚动 | 键盘滚动 + 贴底自动跟随 + 滚动指示 | 长对话可滚；贴底行为符合预期 |
| **M3** Tier 2 鼠标 | SGR 鼠标捕获 + 滚轮解析 | 流式期间滚轮仍可滚；键盘未坏 |
| **M4** Tier 2 视口 | 行数估算 + 切片渲染 + 滚动条 | 1000+ 条消息滚动帧时 <16ms |

每步独立 commit（`type(scope): why` 格式），`tsc --noEmit` 0 错误 + 截图/手测回归后才进下一步。

---

## 8. 验收清单（DoD）

- [ ] `npm start` 后终端**无任何 npm/tsx 残留**，仅 TUI
- [ ] 聊天区四周有蓝圆角边框，撑满 Banner 与 InputBar 之间空间
- [ ] 长对话（>终端高度）可通过 PgUp/PgDn/↑↓/Home/End 滚动，有指示
- [ ] 流式输出期间键盘打字、命令响应主观无卡（<50ms）
- [ ] T2：流式期间鼠标滚轮可滚动聊天区
- [ ] T2：右侧有可视滚动条
- [ ] `/exit`、Ctrl+C、异常退出均能恢复光标与主屏幕，终端不"卡住"
- [ ] `npx tsc --noEmit` 0 错误；`git status` 工作树干净

---

## 附录 A：关键实现片段（伪代码）

### A.1 startApp 启动/退出
```ts
export async function startApp(props: AppProps): Promise<void> {
  // 1. 进 alt 屏 + 清屏 + 隐光标
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
  // 2. 退出双保险（任何路径都恢复）
  const restore = = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.on('exit', restore);
  // 3. ink 接管
  const { waitUntilExit } = render(<App {...props} onExit={restore} />, {
    exitOnCtrlC: false,
  });
  await waitUntilExit();
}
```

### A.2 流式批处理
```ts
// useAgentController.ts
let pending: ((prev: UiMessage[]) => UiMessage[]) | null = null;
let scheduled = false;
function batchedSetMessages(producer: (p: UiMessage[]) => UiMessage[]) {
  pending = producer;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    const p = pending!; pending = null; scheduled = false;
    setMessages(p);
  });
}
```
`push` / `appendTo` / `appendStreaming` / `endStreaming` 全部走 `batchedSetMessages`。

### A.3 SGR 滚轮解析
```ts
// 在 App 内（启用后注册一次）
useEffect(() => {
  process.stdout.write('\x1b[?1000h\x1b[?1006h');
  return () => process.stdout.write('\x1b[?1006l\x1b[?1000l');
}, []);

const { stdin } = useStdin();
useEffect(() => {
  const onData = (buf: Buffer) => {
    const s = buf.toString('utf8');
    // SGR wheel: ESC [ < 64/65 ; x ; y M
    const m = /\x1b\[<(\d+);(\d+);(\d+)[Mm]/.exec(s);
    if (!m) return; // 不消费，让 ink 继续
    const code = Number(m[1]);
    if (code === 64) setScrollOffset(o => o + 3);          // wheel up
    else if (code === 65) setScrollOffset(o => Math.max(0, o - 3)); // wheel down
  };
  stdin.on('data', onData);
  return () => stdin.off('data', onData);
}, [stdin]);
```

### A.4 行数估算 + 切片
```ts
function estimateLines(text: string, innerW: number, prefixW = 4): number {
  let n = 0;
  for (const line of text.split('\n')) {
    n += Math.max(1, Math.ceil((prefixW + line.length) / innerW));
  }
  return n + 1;
}

// 在 App 内
const visibleMsgs = useMemo(() => {
  const innerW = (process.stdout.columns ?? 80) - 4; // 边框+内边距
  let cumStart = 0;
  const out: { msg: UiMessage; topRel: number; height: number }[] = [];
  for (const m of messages) {
    const h = estimateLines(m.text, innerW);
    const topRel = cumStart;
    cumStart += h;
    // 与 [scrollOffset, scrollOffset+areaHeight] 相交？
    if (cumStart > scrollOffset && topRel < scrollOffset + areaHeight) {
      out.push({ msg: m, topRel, height: h });
    }
  }
  return { out, total: cumStart };
}, [messages, scrollOffset, areaHeight]);
```

---

> 文档版本：v1.0（基于截图 `屏幕截图 2026-08-27 004632.png` + 当前 `master` 分支源码）。
> 下一步：等用户确认 Tier 1 范围后开工，每里程碑独立 commit。
---

## 9. 实施记录（2026-08-27，M1-M4 全部完成）

> 本节记录实际实现与文档规划的差异，作为未来维护的依据。四个里程碑独立提交：
> `3049f0e`(M1) → `222a5a6`(M2) → `8df02d6`(M3) → `4c3c7c5`(M4)。

### 9.1 与文档的偏差（有意为之，均有验证）

| 文档规划 | 实际实现 | 原因 |
|---|---|---|
| 滚动键含 ↑↓=±1 | **仅 PgUp/PgDn**（↑↓ 保留给输入历史导航） | ↑↓ 已被「命令历史翻页」占用，抢键会破坏既有功能 |
| `scrollOffset` = 距底**行数**（line-based） | `scrollOffset` = 距底端隐藏的**消息条数**（message-window） | ink 无法对单条消息做行级裁剪（Box 无 overflow、Text 不可按行切片）；消息窗口模型只需处理「单条超高截断」一个边界 case，稳健且简单 |
| 中部 Box `overflow="hidden"` 防溢出 | **尾窗贪心选择**（`selectViewWindow`）：只渲染「估高总和 ≤ sliceArea」的消息；单条超高时 `clipTextToLines` 截断其文本保留尾部行 | ink 7 的 Box **不支持 overflow 属性**（类型层面就没有），必须从渲染源头避免溢出 |
| 鼠标滚轮步进 ±3 行 | ±(当前可见条数/3) 条（≈1/3 页） | 与消息窗口模型一致，滚动体感更顺 |
| 控制器暴露 `areaHeight` | 未暴露（TUI 自行计算 sliceArea） | 无消费方，避免死状态；实际由 `computeAreaHeight(rows)` 在视图层计算 |

### 9.2 落地实现摘要

- **M1** `src/app/viewport.ts`（新增）：`displayWidth`（CJK 双宽）/ `estimateLines` / `clipTextToLines` / `selectViewWindow` / `computeAreaHeight` / `prefixWidthOf`。`src/cli/app.tsx`：startApp 进 alt 屏+清屏+exit 双保险；消息区圆角边框+flexGrow；渲染尾窗。`useAgentController.ts`：push/appendTo/appendStreaming/endStreaming/beginTool 全部 microtask 批处理。`Markdown.tsx`：React.memo。
- **M2** 控制器新增 `scrollOffset`/`setScrollOffset`/`scrollOffsetRef`；独立滚动 useInput（isActive 恒真，流式期间可翻历史）；贴底跟随（stickRef）；`ScrollIndicator`（● 已贴底 / ↑ N 行 / ↓ N 行 · PgDn 回底部）。
- **M3** `\x1b[?1000h\x1b[?1006h` 鼠标捕获 + useStdin data 监听器解析 `<64`/`<65` 滚轮；仅 `process.stdin.isTTY` 时启用，卸载关闭。
- **M4** 右侧比例滚动条（track `┊` / thumb `█`）；消息列 flexGrow + 滚动条 1 列；行数估算 innerW 预留滚动条宽度。

### 9.3 验证方式（沙箱无 TTY 的替代方案）

- 每个里程碑：`npx tsc --noEmit` 0 错误。
- **无头渲染回归**：用 `ink-testing-library` 直接渲染 `<App/>`（绕过 startApp 的 alt 屏写入），断言帧文本：边框字符（╭╰）、尾窗内容（/quit）、指示器（已贴底/↑/↓）、滚动条（┊）、/clear 恢复、无 TTY 不写鼠标序列。M1:10 项、M2:13 项、M3:5 项、M4:11 项、综合:14 项，全部通过。
- 已知测试坑：`stdin.write('/help')` 与 `write('\r')` 需间隔 ≥50ms，否则 return 闭包读到空 input（React 未及重渲染）——真实终端按键天然有间隔，非应用 bug。
- **待用户本机手测**：alt 屏全屏接管观感、鼠标滚轮手感、流式真实对话下的滚动体验。

### 9.4 遗留与后续（可选）

- 鼠标捕获与 ink 键盘解析共存：已按「只解析不消费」实现，若个别终端出现键盘异常，可用环境变量开关关闭鼠标（暂未实现开关，按需加）。
- `sliceArea` 在极窄/极矮终端（rows<24）会退化为 1-2 行，聊天区极小——可考虑极窄时自动隐藏 Banner 的一部分（后续按需）。
- 行数估算对「代码块/列表」等 Markdown 结构只按文本宽度估算，实际渲染行数可能略多（偏保守，不溢出）；如需精确可后续改为测量式。
