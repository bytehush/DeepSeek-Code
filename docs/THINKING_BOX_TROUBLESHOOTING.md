# 思考盒（Thinking Box）排查与运维手册

> 使用者向。说明「思考过程卡片在刷新 / 切换任务后丢失」这一类问题的排查思路、已修复项，以及**最重要的一条运维铁律：重启服务器 ≠ 重建前端**。

---

## 0. 一句话结论

思考盒的持久化链路本身早已修好（数据落盘 → 回放 → 前端渲染，全部测试通过）。如果你本机「刷新 / 切换后还是丢」，99% 是**跑的是旧的前端 bundle**——你只重启了 server，没重新 `vite build`。

---

## 1. 为什么会有「重启 ≠ 重建」

项目其实是**两套独立的源码、两条不同的生效路径**：

| 部分 | 文件 | 怎么跑 | 要不要构建 |
|---|---|---|---|
| 后端（服务器） | `src/gui/server.ts` / `agent-host.ts` / `trace.ts` | `tsx` 直接执行 TypeScript | **免构建**，重启即生效 |
| 前端（浏览器） | `src/gui/web/*.tsx` | 必须先 `vite build` 编译成 `dist/gui/*.js` | **必须构建** |

关键点：`server.ts` 第 52 行

```ts
const DIST = resolve(here, '../../dist/gui');
```

服务器只是把 `dist/gui` 里的静态文件**原样发给浏览器**。所以：

> **浏览器的行为由 `dist/gui` 决定，而不是由 `src/gui/web/*` 的源码决定。**
> 你改了前端源码，只要没重新 build，浏览器加载的永远是旧 JS。

---

## 2. 两条命令（最关键的区别）

`package.json` 里：

```json
"web:build": "vite build",
"web:start": "tsx src/gui/server.ts",
"web":       "npm run web:build && npm run web:start"
```

| 命令 | 实际执行 | 后果 |
|---|---|---|
| `npm run web:start` | 仅 `tsx src/gui/server.ts` | 只重启服务器，**复用旧 `dist/gui`** → 前端修复不生效 |
| `npm run web` | `vite build` + 启动 | 重新编译前端进 `dist/gui` + 启动 → 全部修复生效 |

**铁律：改了 `src/gui/web/*` 之后，必须用 `npm run web`（先 build 再 start）。只 `web:start` 等于没改前端。**

> 这也是「刷新服务器」和「重建（前端）」的区别：重启 server 是「刷新」，build 才是「重建」。两者不是一回事。

---

## 3. 已修复的 6 处断点（供回溯）

思考盒的丢失是 5 层管道上不同位置的断点累积，从数据层一路查到 UI 层：

| # | 层 | 断点 | 修复 | 验证 |
|---|---|---|---|---|
| 1 | 数据层 | 思考盒没落盘 / 没回放 | 方案A：`trace` 落盘 + `parseReplay` + `replayToUi` 原样重建 | e2e `hasThinkingBox=true` |
| 2 | 状态层 | `reset` 无条件 `setThinkings([])`，思考盒 100% 依赖「清空后等事件重发」脆弱链 | 服务端 `pushReset(thinkings)` 原子携带 + 前端 `reset` 原子恢复 | e2e `E2E_OK` |
| 3 | 渲染层 | `ChatArea` 无 `key`，跨任务 msgId 碰撞导致行组件复用、盒子不重建 | `ChatArea key={activeTaskId}` + 抽 `computeOrphans` 纯函数 | 单测 + 渲染测试 |
| 4 | 刷新导航 | 刷新后 `bootWithUser` 总落到空默认任务，用户当时看的任务没加载 | 前端持久化 `dsa_active_task` + `resume` 带回 `threadId` 校验激活 | 刷新 e2e `REFRESH_OK` |
| 5 | 无 Key 历史 | `bootWithUser` 先校验 Key，无 Key 直接 `return` 连历史都不回放 | 历史回放提到 Key 校验之前，解耦 | 无 Key 刷新 e2e `REFRESH_NOKEY_OK` |
| 6 | 孤儿思考轮 | 已 `done`/`interrupted` 但无答案气泡的思考轮，恢复历史时无处渲染 | `computeOrphans` 把孤儿轮也渲染成底部独立卡 | 单测 6 用例 |

全部修复在源码层面于第 6 轮完成（commit `7c7342a`，tag `stable-2026-07-21-orphan-thinking`），后续「沙箱渲染验证」轮未新增修复，仅抽 `ThinkingCard` + 加渲染测试（131/131）做端到端证真。

---

## 4. 浏览器端自检三步（DevTools）

如果你本机「还是丢」，先别改代码，用 DevTools 三秒定位是不是旧包：

1. **Network → WS**：刷新后发出的 `resume` 帧，JSON 里**有没有 `"threadId"` 字段**？（旧包没有 → 说明跑的是旧前端）
2. **Application → Local Storage**：有没有 `dsa_active_task` 这个 key？（旧包不会写）
3. 看 `index-*.js` 的文件名 hash 是不是最新一次 build 的产物（对照终端 build 输出）。

如果 1/2 不满足，直接 `npm run web` 重建即可，不要动代码。

---

## 5. 验证盲区（给开发者的警告）

本项目的 e2e / 单测 / 渲染测试，验的是**源码与协议层**：

- e2e 验「服务端有没有把 thinkings 通过 WS 发给前端」
- 渲染测试验「给定 thinkings 数据，React 组件画不画得出来」

它们全绿，**不代表浏览器加载的是新包**。只要 `dist/gui` 是旧的，用户看到的仍是 bug。

→ **任何前端修改，验收的最后一步必须是：重建 bundle + 真实浏览器点一遍。** 只靠源码层测试通过就宣布「修好了」，会漏掉这类运行期问题。

---

## 6. 复现与最小验证

- **刷新场景**：进某个任务对话几轮 → **在该任务内**按 F5 → 应完整显示含思考盒的历史（若从任务列表 / 首页刷新，不会恢复，这是预期行为）。
- **切换场景**：A↔B 来回切换，各自历史与思考盒独立、不串、不丢。
- **无 Key 场景**：未配置 API Key 时刷新，历史仍显示，仅提示「请配置 Key」。

---

## 7. 快速排查决策树

```
刷新后思考盒丢了？
├─ 先看 DevTools：resume 带 threadId？Local Storage 有 dsa_active_task？
│  ├─ 都没有 → 跑的是旧前端 → npm run web 重建（不要改代码）
│  └─ 都有   → 继续往下
├─ 服务端日志：bootTask 是否发 reset 且携带 thinkings？
│  ├─ 没携带 → server.ts 问题（但已修复，确认是否旧 server 进程）
│  └─ 携带了 → 前端没画 → 看 computeOrphans / ThinkingCard（已渲染测试证真）
└─ 仍异常 → 把 DevTools 三样现象发维护者，定位未覆盖场景
```
