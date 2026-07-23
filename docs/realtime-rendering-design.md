# 助手消息实时渲染修复方案

## 1. 问题定性

当前现象（见 2026-07-24 截图）：用户发送“你好”后，**助手头像、名字、思考过程、输出结果在整轮生成期间全部不可见**，回合结束后才一次性出现。

这不是“后端没发数据”——`agent-host.ts` 已经按流式推送 `thinking_start/entry/update`、`message`（空气泡）、`update`（文本增量）。
问题在**前端落位逻辑把活跃思考轮抑制掉了**，加上思考卡默认折叠、空气泡与首块 update 的时序存在被 React 18 批处理合并的风险。

---

## 2. 根因分析

### 2.1 主因：computeOrphans 把 ongoing conversation 的活跃思考轮删掉了

`src/gui/web/thinkingLayout.ts:36`：

```ts
const live = busy && messages.filter((m) => m.role === 'assistant').length === 0
  ? orphans.find((t) => t.status === 'thinking' || t.status === 'outputting')
  : undefined;
```

- 首次对话没有 assistant 气泡时，条件成立，能显示底部“思考中…”卡片。
- **一旦历史里有任何 assistant 消息**，`messages.filter(assistant).length > 0`，条件永远失败。
- 新思考轮开始（`thinking_start`）后，它是 orphan（还没有答案气泡挂 `thinkingId`），但 `live` 被强制置 `undefined`。
- 结果：**思考阶段没有任何助手头像/名字/思考卡**，用户只看到输入框在转。

这是一个“过度防御”回归：之前修复 [overlap] 时为了避免 live 卡与旧气泡重叠，把 guard 写成了“只要存在 assistant 消息就不显示 live 卡”，范围过大。

### 2.2 次因：思考卡默认折叠

`App.tsx:603`：

```ts
setThinkings((t) => [...t, { turnId: msg.turnId, status: 'thinking', collapsed: true, entries: [] }], evTaskId);
```

用户要求“思考过程实时渲染出来”，但 `collapsed: true` 意味着思考卡默认只显示一行标题，内容被隐藏。即便 live 卡出现，用户也看不到推理文字在增长。

### 2.3 风险：空答案气泡 + 首块 update 仍可能被批处理合并

当前对空 assistant 气泡用了 `flushSync`（`App.tsx:592`），能打破一次批处理。但后端有两种进入最终答案的路径：

| 路径 | 代码位置 | 行为 |
|------|----------|------|
| A. 直接答复（无 tool_use） | `agent-host.ts:264 prometeThinkingToFinal` | 先发空 `message`，`120ms` 后再发第一块 `update` |
| B. 最终答案流式输出 | `agent-host.ts:220 appendStreaming`（`phase==='final'` 或 `this.inFinal`） | **空 `message` 与第一块 `update` 同步连续 emit** |

路径 B 中，浏览器可能在同一个事件循环内连续收到 `message` + `update`。
`flushSync` 会让空气泡立即 commit，但如果 `update` 在 flush 的 commit 完成前到达，React 18 仍可能把两次 setState 合并成一次 render，导致气泡直接显示完整文本，没有中间态。

另外，`update` handler 自身没有 `flushSync`，多个 `update` 事件如果落在同一宏任务内会被 React 自动批处理，表现为“逐字不流畅”或“末尾一次性出现”。

### 2.4 其他已验证非主因

- `useTypewriter` 初始 `shown=0` 已落地，逻辑正确。
- `ChatArea.css` 已加 `.bubble { min-height: 36px; }`。
- 路线 B 独立 host + `taskId` 路由已落地，消息能正确抵达当前任务。
- 用户乐观渲染正常，说明 WS 通路没问题。

---

## 3. 修复方案

### 3.1 修复 computeOrphans（P0）

**目标**：让“当前正在进行的思考轮”只要还没有被答案气泡认领，就显示为 live 卡，不受历史 assistant 消息影响。

**设计**：

```ts
export function computeOrphans(thinkings: ThinkingTurn[], messages: UiMessage[], busy: boolean): OrphanLayout {
  const matchedTurnIds = new Set(
    messages
      .filter((m) => m.role === 'assistant' && typeof m.thinkingId === 'number')
      .map((m) => m.thinkingId as number),
  );
  const orphans = thinkings.filter((t) => !matchedTurnIds.has(t.turnId));

  // 只有“最新的孤儿思考轮”且仍处于活跃态时才渲染 live 卡，
  // 避免多个历史 orphan 同时被当成 live。
  const latestOrphan = orphans[orphans.length - 1];
  const live =
    busy && latestOrphan && (latestOrphan.status === 'thinking' || latestOrphan.status === 'outputting')
      ? latestOrphan
      : undefined;

  const history = orphans.filter((t) => t !== live);
  return { live, history };
}
```

**防回退**：原 `thinkingLayout.test.ts` 已覆盖 overlap 场景，修改后需保证旧用例仍通过；同时新增用例：
- 历史存在 assistant 消息时，新的 thinking 轮仍应作为 live 返回。
- 当前轮已有匹配答案气泡（`thinkingId` 对上）时，不应再返回 live。
- done/interrupted 的 orphan 轮应进入 history。

### 3.2 活跃思考轮默认展开（P1）

**目标**：用户发送消息后，立刻看到助手头像、名字、思考卡，且推理文字实时增长。

**设计**：

- `thinking_start` 创建新 turn 时，`collapsed` 设为 `false`。
- 已经 done/interrupted 的历史思考轮保持 `collapsed: true`（避免刷新后把所有历史思考过程展开，造成视觉噪音）。
- 仅对“当前活跃轮”展开：可以在 `thinking_end` 时把该轮设为 `collapsed: true`，或者维持展开但加视觉提示。

**推荐实现**：

```ts
case 'thinking_start':
  setOutputting(false);
  setThinkings(
    (t) => [
      ...t,
      { turnId: msg.turnId, status: 'thinking', collapsed: false, entries: [] },
    ],
    evTaskId,
  );
  break;
```

并在 `thinking_end` 时：

```ts
setThinkings((t) => {
  const idx = t.findIndex((x) => x.turnId === msg.turnId);
  if (idx === -1) return t;
  const next = t.slice();
  next[idx] = { ...next[idx], status: 'done', collapsed: true };
  return next;
});
```

这样“实时思考过程可见”，回合结束后自动收起。

### 3.3 空答案气泡 + 首块 update 时序保险（P2）

**目标**：确保空气泡先被用户看到，再逐字填充，不被 React 18 批处理一口吞。

**方案 A（推荐，改动最小，前端保险）**：

在 `App.tsx` 的 `update` handler 中，对“目标消息当前 text 为空”的第一次 update 用 `flushSync`：

```ts
case 'update': {
  const isFirstChunk = (() => {
    const list = messagesByTask[evTaskId ?? activeTaskIdRef.current ?? ''] ?? [];
    const target = list.find((x) => x.id === msg.id);
    return target && target.text.trim() === '';
  })();
  if (isFirstChunk) {
    flushSync(() => {
      setMessages(/* ... */);
    });
  } else {
    setMessages(/* ... */);
  }
  break;
}
```

**方案 B（后端时序保险）**：

在 `agent-host.ts appendStreaming` 创建空 `finalBubbleId` 后，不要立即 `appendTo`，而是像 `prometeThinkingToFinal` 一样，`setTimeout(..., 16~120ms)` 后再发第一块，给浏览器 paint 留出窗口。

**建议**：两个方案都做。方案 A 保证前端一定有可见中间态；方案 B 消除后端“message+update 连发”的时序风险。

### 3.4 思考更新同步提交（P3，可选）

当前 `thinking_update` 已改为同步 `setThinkings`。如果仍感觉“思考文字一顿一顿”，可对第一个 `thinking_update` 也使用 `flushSync`，后续更新保持同步但不必 flush。

```ts
case 'thinking_update': {
  const isFirstThinkUpdate = /* 检查该 entry 是否第一次收到 append */;
  if (isFirstThinkUpdate) {
    flushSync(() => setThinkings(/* ... */));
  } else {
    setThinkings(/* ... */);
  }
  break;
}
```

### 3.5 视觉层级统一

当前 live orphan 卡已经渲染 `row assistant`（含头像、名字），修复 computeOrphans 后思考阶段会自然出现头像+名字。

额外小优化：
- live 思考卡加 `.active` 样式（已有），让它在视觉上与历史思考卡区分。
- 思考卡展开时，内部 `ThinkingStep` 用 `useTypewriter` 逐字显示 `streaming` 条目，保持与最终答案一致的“实时感”。

---

## 4. 验证方案

### 4.1 单元测试

| 测试文件 | 覆盖点 |
|----------|--------|
| `test/thinking-layout.test.ts` | 新增：历史有 assistant 消息时，新 thinking 轮返回 live；有匹配气泡时不返回 live；done orphan 进 history |
| `test/flushSync-condition.test.ts` | 新增：空 assistant 气泡后的第一次 `update` 走 flushSync |
| `test/thinkings-by-task.test.ts` | 新增：`thinking_start` 默认 `collapsed=false`；`thinking_end` 后 `collapsed=true` |
| `test/useTypewriter-init.test.ts` | 已覆盖 live 从 0 起步 |

### 4.2 渲染测试（Node 环境）

用 `renderToStaticMarkup` 验证：
- 给定 `busy=true` + 一个 `status='thinking'` 的 orphan turn，渲染出含头像、名字、展开思考卡的 HTML。
- 给定空 text 的 assistant message + `outputting=true`，渲染出“输出中…”占位。

### 4.3 浏览器冒烟

- `npm run web` 重新构建并启动。
- 在已有历史的任务中发一条新消息。
- 观察：
  1. 发送后立刻出现助手头像 + “DeepSeek 助手” + 思考卡（展开）。
  2. 思考卡内文字实时增长。
  3. 进入输出阶段后，答案气泡出现并逐字填充。
  4. 回合结束后思考卡自动收起，答案气泡完整显示。

### 4.4 回归检查

- 切任务后首条消息 UI 正常（已有 e2e `_e2e_switch_history.mts`）。
- 思考盒持久化（已有 `test/thinking-persist.test.ts`）。
- 无工具调用时的直接答复（`prometeThinkingToFinal` 路径）逐字可见。
- 有工具调用时，工具结果实时进入思考卡。

---

## 5. 改动范围

- `src/gui/web/thinkingLayout.ts`：修改 `computeOrphans`。
- `src/gui/web/App.tsx`：
  - `thinking_start` 默认 `collapsed: false`。
  - `thinking_end` 设置 `collapsed: true`。
  - `update` handler 对空气泡首块使用 `flushSync`。
  - （可选）`thinking_update` 首块 `flushSync`。
- `src/gui/agent-host.ts`：
  - `appendStreaming` 创建空 `finalBubbleId` 后，`setTimeout` 延迟首块发送（16~120ms，与 `prometeThinkingToFinal` 对齐取 120ms）。
- 测试文件：`test/thinking-layout.test.ts`、`test/flushSync-condition.test.ts`、`test/thinkings-by-task.test.ts`。

---

## 6. 待确认问题

1. **思考卡自动收起时机**：回合结束后立即收起，还是保留展开让用户继续看？
   - 建议：立即收起，减少新回合开始时的视觉噪音；用户可手动点开回看。
2. **最终答案延迟 120ms 是否可接受**：`prometeThinkingToFinal` 已是 120ms，`appendStreaming` 对齐后，用户会感到“发送后有一小段空窗期才出现第一个字”。是否改 60ms/30ms？
   - 建议：先统一 120ms 保证稳定可见；若用户觉得慢，再降到 60ms。
3. **是否要在设置里加“自动展开思考过程”开关**：
   - 建议：第一阶段不做开关，按用户当前诉求默认展开活跃轮；后续如用户反馈可再加。

---

## 7. 实施顺序

1. 改 `computeOrphans` + 补测试（影响最大，立竿见影）。
2. 改 `thinking_start/thinking_end` 折叠行为 + 补测试。
3. 加 `update` 首块 `flushSync` + 后端 `appendStreaming` 首块延迟 + 补测试。
4. `tsc --noEmit` + 全量 `npm test` + 浏览器冒烟。
5. 每个逻辑改动独立 commit。
