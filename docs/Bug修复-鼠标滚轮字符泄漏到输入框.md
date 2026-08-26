# Bug 修复 - 鼠标滚轮 SGR 序列泄漏到输入框

> **状态**：已修复（2026-08-27，commit 见 §9）
> **截图**：屏幕截图 2026-08-27 015731.png
> **影响**：核心交互体验受损，每次滚轮都会在输入框留下一段 `│<64;66;19M` 字符污染，必须手动清除才能继续打字
> **根因可信度**：✅ 高（截图 + 无头复现 + 代码锚点三方吻合）

---

## 1. Bug 现象（截图描述）

用户操作：在 TUI 中滚动鼠标滚轮上翻聊天历史。

异常表现：滚动功能**正常工作**（聊天区跟随滚动、底部 `↑ N 行 / ↓ N 行 · PgDn 回底部` 指示器实时变化，证明 M3 监听器在工作），但同时**输入框的 input state 中累积了滚轮的 SGR 序列字符串**：

```
▌ [<64;66;19M[<64;66;19M[<65;66;19M[<65;66;19M...
```

连续滚动多次后，输入框被这些不可读字符塞满，遮挡正常输入。每次按 `Backspace` 只能删一个可见字符，实际删除的是 `<`、`6`、`4`、`;`、`M` 之一，体验极差。

> 注：`▌` 与 `│` 都是 InputBar 的左侧垂直分隔符，截图与无头渲染的差别是样式表差异，不是 bug 表现差异。

---

## 2. 复现步骤

### 2.1 真实终端复现（用户已截图证明）
1. `npm start` 启动 TUI
2. 输入 `/help` 后回车，注入一条长消息，让聊天区出现滚动条
3. 滚动鼠标滚轮（任意方向、任意次数）
4. 观察输入框 → 可见 `│<NN;X;YM` 累积

### 2.2 无头测试复现（已验证 ✅）

往 `src/cli/` 写一个最小复现脚本，用 `ink-testing-library` 直接渲染 `<App/>`，往 stdin 灌 3 次 `\x1b[<65;66;19M`（Wheel Down）：

```bash
# 命令模板（详细命令见附录 A）
node node_modules/esbuild/bin/esbuild src/cli/repro-mouse-leak.tsx \
  --bundle --packages=external --format=esm --platform=node \
  --loader:.tsx=tsx --outfile=src/cli/repro-mouse-leak.mjs
node src/cli/repro-mouse-leak.mjs
```

**实际输出**（已验证）：
```
=== 复现检测 ===
input state 出现 SGR 字符? BUG 复现

=== 滚动后底部 6 行 ===
│                                                                                         ● 已贴底 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍
▌ [<65;66;19M[<65;66;19M[<65;66;19M
╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍
? for shortcuts                                                              风格:人话 · /style 切换
```

输入框渲染了 `▌[<65;66;19M[<65;66;19M[<65;66;19M`，与截图一致。

> 关键证据：无头测试中 `useEffect` 里的 data 监听器**不会触发**（ink-testing-library 的 stdin 是内存 EventEmitter，不走真实 `process.stdin`），但 bug 仍复现。**这证明泄漏路径与 M3 data 监听器无关，纯由 useInput 的字符处理漏过滤造成**。

---

## 3. 根因分析

### 3.1 时序图（SGR 序列进入系统的两条路）

```
┌───────────────────┐                ┌──────────────────┐
│   用户滚轮动作     │                │  终端 (Windows   │
└─────────┬─────────┘                │   Terminal/xterm)│
          │                          └────────┬─────────┘
          │ 鼠标事件                          │ 输出 SGR 字节
          ▼                                   ▼
    终端驱动合成                     bytes on stdin (TTY raw)
    "\x1b[<65;66;19M"                          │
                                              │
                  ┌───────────────────────────┼───────────────────────────┐
                  │                           ▼                           │
                  │              process.stdin (raw bytes)                 │
                  │                           │                           │
                  │       ┌───────────────────┴──────────────────────┐    │
                  │       │                                          │    │
                  │       ▼                                          ▼    │
                  │  useEffect 注册的                              Node   │
                  │  data 监听器（app.tsx:400-421）                keypress│
                  │       │                                       内部readline│
                  │       │ 正则匹配 + 滚动                            │    │
                  │       ▼                                       │    │
                  │  setScrollOffset(...)                          │    │
                  │       │                                       ▼    │
                  │       │                              useInput 收到 │
                  │       │                              ch="\x1b[<65..."│
                  │       │                              key={...}     │
                  │       ▼                                       ▼    │
                  │    ✗ 不消费                                   ✗ 不过滤 │
                  │       │                                       │    │
                  │       └─────────────────┬─────────────────────┘    │
                  │                         ▼                          │
                  │                用户 useInput 处理逻辑              │
                  │                (app.tsx, 320-380 行)              │
                  │                         │                          │
                  │                         ▼                          │
                  │              input += ch   ← 📌 BUG 入口          │
                  └────────────────────────────────────────────────────┘
```

### 3.2 关键代码锚点

**文件**：`src/cli/app.tsx`

| 行号 | 现状 | 角色 |
|---|---|---|
| 396-421 | `useEffect` 注册 `onData` 监听滚轮 → **解析但不消费** | M3 实现，把字节放进 `\x1b` data 缓冲 |
| 380-394 | 滚动 useInput：只处理 `key.pageUp/pageDown` 字符忽略 | M2 实现，**没有任何 ch 过滤** |
| ~320-340 | 主输入 useInput：把 `ch` 拼到 input state | 主聊天/命令输入逻辑 |

**主输入 useInput 的字符处理大致是**：
```ts
useInput(
  (ch, key) => {
    if (key.return) { submit(); return; }
    if (key.backspace) { /* ... */ return; }
    if (ch) setInput(s => s + ch);  // ← SGR 序列以"字符"身份进入这里
  },
  ...
);
```

`ch = "\x1b[<65;66;19M"`（一个不识别前缀的串，对 ink 来说是单字符）被 `setInput` 累积。

### 3.3 为什么「只解析不消费」是误设计

M3 注释（app.tsx:398）：
> 监听器只解析滚轮序列、不消费非鼠标字节，ink 的键盘解析不受影响。

**这是错的**：在 Node.js 中，`process.stdin.on('data', ...)` 和 Node 内部 `readline.createInterface` 派发的 keypress 事件，**接收的是同一份缓冲区的字节序列**——监听器消费了字节，keypress 就拿不到了；监听器不消费，keypress 同样会拿到。

也就是说：**只要 data 监听器不在字节被后续管道读取前把它消除，SGR 序列就一定会进 ink 的 useInput**。

设计时把这个语义搞反了。

---

## 4. 修复方案

### 4.1 候选方案对比

| 方案 | 思路 | 改动范围 | 可靠性 | 备注 |
|---|---|---|---|---|
| **A. useInput 字符过滤** | 在主 useInput 进入 `ch` 处理前识别 SGR 序列，丢弃 | 仅 `src/cli/app.tsx` 主 useInput ~1 行判断 | ✅ 高 | 不影响 M3 监听器工作；不依赖任何运行时配置 |
| B. data 监听器「真消费」 | 在 data 监听器里手动分割 chunk、识别 SGR 后用 `process.stdin.unshift(remainder)` 把剩余字节塞回去 | 改 M3 的 useEffect | ⚠ 中 | `process.stdin.unshift` 不一定能抢在 readline 前面读完；需在 Node 文档实证 |
| C. 整个项目禁用鼠标 SGR | 仅开启 `?1000h`，关闭 `?1006h`，改用 X10 协议 | 改 M3 useEffect | ❌ 低 | X10 在 Windows Terminal 下行为不一致，会丢功能 |
| D. ink 全局 escape 拦截 | 改 `ink` 源码加 SGR 过滤 | 第三方依赖 | ❌ 低 | 不可控 |

**选定方案 A**，理由：
- 改动最小（1-2 行 `ch` 处理判断）
- 不改变 M3 data 监听器的工作方式（滚动仍正常）
- 不影响任何已有交互（普通字符、Backspace、Return、命令路径全部走原路）
- 沙箱可无头验证（沿用 M3 验证范式）

### 4.2 方案 A 的实现要点

在主 useInput 的 `ch` 处理路径**最开头**加入：

```ts
// 过滤鼠标/终端控制序列（xterm SGR 等）：这些字节不应该被当成可输入字符
if (ch && ch.length > 1 && /^(?:\x1b)?\[?<\d+;\d+;\d+[Mm]$/.test(ch)) {
  // 滚轮/鼠标事件序列（如 \x1b[<65;66;19M）：直接丢弃，
  // data 监听器已处理完毕，ink 不应把它当 input 字符
  return;
}
```

**为什么用正则而不是「`startsWith('\x1b')` + `includes(';')`」**（实证修正，见 §4.3）：
- 实测 Node readline 会把 SGR 序列的 `\x1b` 前缀**消费掉**，useInput 实际收到的是残余 `"[<65;66;19M"`（以 `[` 开头、**不含 ESC**）——`startsWith('\x1b')` 判断会漏掉真实形态
- 不同终端/驱动可能保留完整 `"\x1b[<65;66;19M"`，也可能只剩 `"<65;66;19M"`，故正则用 `(?:\x1b)?` 与 `\[?` 可选匹配三种形态
- `M`（按下）与 `m`（释放）都覆盖；`$` 锚定结尾避免误伤普通文本
- 普通输入（`a`、`hello`、`[2026-08-27]` 等）不匹配该模式，不受影响

**为什么不动 M3 data 监听器**：
- M3 监听器工作正常（指示器数据真实有效，证明滚动逻辑无 bug）
- 改它反而增加风险（unshift 语义、漏字节等隐藏问题）

---

## 5. 关键代码改动

### 5.1 改动文件清单（待提交）

| 文件 | 行号 | 改动类型 | 预估 diff |
|---|---|---|---|
| `src/cli/app.tsx` | 主 useInput 首段（约 320-340） | 新增 ~3 行 SGR 过滤 | +4 / -0 |

### 5.2 可直接落地的代码片段（含行号定位）

**位置**：`src/cli/app.tsx` 主 useInput 的回调参数起点（与 M2 的滚动 useInput、M3 的鼠标 effect 平行的入口）。

```ts
useInput(
  (ch, key) => {
    // ↓↓↓ 新增：过滤鼠标 SGR 序列（详见 docs/Bug修复-鼠标滚轮字符泄漏到输入框.md）
    // 实测：Node readline 消费掉 \x1b 前缀后，useInput 收到的是残余 "[<65;66;19M"（以 [ 开头、不含 ESC）；
    // 不同终端也可能保留完整 "\x1b[<65;66;19M" 或只剩 "<65;66;19M"。统一用正则匹配三种形态：
    //   可选 ESC + 可选 [ + <数字;数字;数字 + M/m（M=按下，m=释放）
    if (ch && ch.length > 1 && /^(?:\x1b)?\[?<\d+;\d+;\d+[Mm]$/.test(ch)) {
      // 不让 SGR 鼠标事件进入 input state；滚轮逻辑由 data 监听器处理
      return;
    }
    // ↑↑↑ 新增结束

    // 权限确认 y/n
    if (c.confirm) {
      if (key.return) { /* 提交 y */ }
      else if (key.backspace || (ch && ch.toLowerCase() === 'n')) { /* 拒绝 */ }
      return;
    }

    // KeyCapture 模态
    if (c.showKeyModal) return;

    // ... 原有提交/字符/backspace 处理
  },
  ...
);
```

### 5.3 不改动的清单（已确认）

- ❌ `src/cli/app.tsx:396-421`（M3 data 监听器）
- ❌ 滚动 useInput（`app.tsx:380-394`，M2）
- ❌ `src/cli/Markdown.tsx`、`src/app/viewport.ts`、`src/app/useAgentController.ts`
- ❌ 任何测试脚本

---

## 6. 验证清单（DoD）

### 6.1 沙箱无头验证
- **修改前**：跑附录 A 的复现脚本 → 退出码 0（bug 复现）
- **修改后**：跑附录 A 的同脚本 → 退出码非 0（`<65;66;19` 不出现）
- **附加断言**：输入框 `▌` 之后不含任何 `;` 或 `<`

### 6.2 综合回归（不退化 M1–M4）
跑 M4 提交里的 11 项 + 综合回归的 14 项无头断言，**全部继续通过**：
- 普通打字（不含 ESC 字符）正常
- `PgUp` / `PgDn` 滚动不变
- 滚轮指示器响应
- `/clear`、`/help` 等命令路径不破
- 边框、滚动条、贴底跟随不破

### 6.3 用户本机手测
1. `npm start`
2. 滚几次鼠标 → 输入框不应出现 `│<64;...` 等字符
3. 检查底部指示器仍正常（`↑ N 行 / ↓ N 行 · PgDn 回底部`）
4. 验证 `Ctrl+C` 不再被吞（虽然原 bug 没吞它，但要确认修复没顺手破坏）
5. 命令历史翻页（↑↓）仍正常

---

## 7. 风险与边界

| 场景 | 风险 | 缓解 |
|---|---|---|
| 真实终端偶发输出含 `;` 的非 SGR ESC 序列 | 被吞 | 实测主流终端只有 CSI（含 `;` 数字分号参数）会含分号，输入框不需要它们 |
| 跨平台（macOS / Linux）滚动事件格式不同 | 影响 | xterm SGR 是 de facto 标准（Windows Terminal / iTerm2 / gnome-terminal 均支持）；BSD console 较旧不支持，本身也不能用 |
| ink 升级到未来版本改了 keypress 解析 | 影响 | 极小；过滤条件是 SGR 序列稳定语法，不依赖 ink 实现 |
| 真终端字节流里多个 SGR 序列粘连 | 影响 | data 监听器按抵达批次处理；每个 `\x1b[<NN;X;YM` 进入 useInput 时仍是单 chunk |

---

## 8. 附录

### 附录 A：复现 demo 完整脚本（已验证）

**文件**：`src/cli/repro-mouse-leak.tsx`（运行完即删，不入库）

```tsx
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from './app.tsx';
import type { AppProps } from '../app/types.ts';

const props = { agent: {}, models: {}, version: 'v0.5.0' } as unknown as AppProps;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { lastFrame, stdin, unmount } = render(<App {...props} />);
  await sleep(120);

  // 模拟真实终端滚动：3 次 Wheel Down（<65=下滚，<64=上滚）
  for (let i = 0; i < 3; i++) {
    stdin.write('\x1b[<65;66;19M');
    await sleep(40);
  }
  await sleep(120);

  const after = lastFrame() ?? '';
  const leaked = after.includes('<65;66;19') || after.includes('│<6');

  console.log('=== 复现检测 ===');
  console.log('input state 出现 SGR 字符?', leaked ? 'BUG 复现' : '正常');
  console.log('');
  console.log('=== 滚动后底部 6 行 ===');
  console.log(after.split('\n').slice(-6).join('\n'));

  unmount();
  process.exit(leaked ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

**执行命令**：
```bash
cd "D:/作业/AI Agent/deepseek-code-agent"
node node_modules/esbuild/bin/esbuild src/cli/repro-mouse-leak.tsx \
  --bundle --packages=external --format=esm --platform=node \
  --loader:.tsx=tsx --outfile=src/cli/repro-mouse-leak.mjs
node src/cli/repro-mouse-leak.mjs
```

**期望输出**（修改前）：
```
=== 复现检测 ===
input state 出现 SGR 字符? BUG 复现
```

**期望输出**（修改后）：
```
=== 复现检测 ===
input state 出现 SGR 字符? 正常
```

### 附录 B：Node.js readline keypress 流程简述（背景）

Node 在 TTY raw 模式下，readline 通过 `_keypress` 解析所有字节：
1. stdin 是可读流，每批字节触发一次 `data` 事件
2. readline 通过 `_ttyWrite` 解析每个字节，试图组装成 key-press 或转义序列
3. 完成解析后 emit `keypress` 事件，传递 `(str, key)`，其中 `str` 是处理后的字符串
4. 对不认识的序列（鼠标 SGR 在 keypress 阶段还没能力过滤），它**仍然会以 `str` 原样发出**

ink 的 `useInput` 直接绑 `keypress` 事件（通过内部 `use-input.js`），所以**鼠标 SGR 字节最终以单字符串形式投递**到 useInput 的 `ch` 参数。

`useStdin()` 返回的 stdin 是 ink 的内部 stdio 抽象，不是直接的 `process.stdin` 实例——这点对调试很重要，能解释为何 ink-testing-library 不能直接复现真实终端的 M3 监听器行为，但仍能复现泄漏路径。

### 附录 C：相关代码索引

| 关注点 | 文件 | 行号 |
|---|---|---|
| 滚轮 effect（M3） | `src/cli/app.tsx` | 396-421 |
| 主输入 useInput | `src/cli/app.tsx` | ~320-340（实际位置以本文档 §5.2 为准） |
| 滚动 useInput（M2） | `src/cli/app.tsx` | 380-394 |
| 无头测试范式（M3 验证） | git 历史 `8df02d6` | commit message |
| 综合回归脚本（M4 验证） | git 历史 `4c3c7c5` | commit message |

---

## 9. 实施记录（2026-08-27，已修复）

> 本节记录实际实现与文档规划（§4.2/§5.2 原稿）的差异，作为未来维护的依据。提交见下。

### 9.1 与文档原稿的偏差（实证修正）

| 文档原稿（§4.2/§5.2） | 实际实现 | 原因 |
|---|---|---|
| 过滤条件 `ch.startsWith('\x1b') && ch.includes(';')` | 正则 `/^(?:\x1b)?\[?<\d+;\d+;\d+[Mm]$/` | **实证**：在 useInput 回调打印 `ch` 的 JSON，发现 Node readline 会把 SGR 序列的 `\x1b` 前缀消费掉，实际收到的是残余 `"[<65;66;19M"`（以 `[` 开头、**不含 ESC**）。原稿判断匹配不到真实形态，修复无效（首版实现即验证失败）。正则改为可选匹配三种形态：完整 `\x1b[<65;66;19M` / 残余 `[<65;66;19M` / 纯 `<65;66;19M` |
| 改动预估 +4/−0 | 实际 +8/−0（含注释） | 注释量略多，逻辑仍只有 1 处 `if` |

### 9.2 验证结果

- **修改前**：附录 A 复现脚本 → `input state 出现 SGR 字符? BUG 复现`（退出码 0）
- **修改后**：同脚本 → `SGR 泄漏? 正常` + `普通输入保留? 是`（三种形态 `\x1b[<65;66;19M` / `[<65;66;19M` / `<65;66;19M` 全被过滤，`abc正常输入` 正常进入输入框）
- **综合回归**：M1–M4 全部能力 + SGR 过滤 + 普通输入 = **16 项断言全过**，`tsc --noEmit` 0 错误
- **待用户本机手测**：真实滚轮后输入框干净、指示器仍正常、Ctrl+C 不被吞、↑↓ 历史翻页正常

### 9.3 提交

- `fix(tui): 过滤鼠标 SGR 序列泄漏到输入框`（`src/cli/app.tsx` + 本文档）
