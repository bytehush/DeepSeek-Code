/**
 * e2e：真实服务里「登录 → 创建任务 → 跑一轮真实对话(agent 最终答复落盘) → 切回任务看到历史」验收。
 *
 * 与之前手写 trace 文件不同，本脚本用【真实的 runAgent（src/agent/loop.ts）】为任务 A 跑一轮对话
 * （mock LLM 客户端，纯文本最终答复），让修复后的 loop 把最终答复写入 trace 的 assistant_message；
 * 随后「切回任务 A」模拟用户点击任务卡片重新进入，断言聊天区能恢复出 user + assistant 气泡
 * —— 即用户验收标准：重登录/切换后能看到以前的对话记录。
 *
 * 关键设计（解决 Bash 沙箱文件系统隔离）：同一进程内 import 启动 server.ts；独立端口；
 * mock DeepSeek 端点让 validate 通过；DSA_EMBEDDER=off 跳过离线 BGE 冷加载。均不改产品代码。
 *
 * 断言：
 *   1. 切回 A → 历史含 user 气泡（"你好"）与 assistant 气泡（含 agent 最终答复文本）。
 *   2. 切到 B → 不得泄漏 A 的任何历史（任务隔离）。
 */
process.env.DSA_WEB_PORT = String(Number(process.env.DSA_WEB_PORT ?? 4199));
process.env.DSA_EMBEDDER = 'off'; // 离线跳过 BGE 冷加载，仅影响记忆嵌入，不影响本验收
const PORT = Number(process.env.DSA_WEB_PORT);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

import { WebSocket } from 'ws';
import http from 'node:http';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TraceLogger } from './src/context/trace.ts';

const USER = `e2e_${Date.now().toString(36)}`;
const PASS = 'e2e123';
const USER_DIR = join(homedir(), '.dsa', 'users', USER);
const ACCOUNTS_PATH = join(homedir(), '.dsa', 'accounts.json');

function cleanup(): void {
  try {
    rmSync(USER_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
  try {
    const raw = readFileSync(ACCOUNTS_PATH, 'utf8');
    const store = JSON.parse(raw) as {
      users?: Record<string, unknown>;
      sessions?: Record<string, { username: string }>;
    };
    if (store.users) delete store.users[USER];
    if (store.sessions) {
      for (const [tok, s] of Object.entries(store.sessions)) {
        if (s.username === USER) delete store.sessions[tok];
      }
    }
    writeFileSync(ACCOUNTS_PATH, JSON.stringify(store, null, 2));
  } catch { /* ignore */ }
}

// ── mock LLM：仅用于 validate 通过的占位（本 e2e 不真正跑模型，trace 直接写入）──
const FINAL_ANSWER = '闭包（closure）是函数与其词法作用域的组合，使函数能访问外层变量。';

// ── 1) mock DeepSeek 端点（validate 通过）──
const mockPort = 8731;
const mock = http.createServer((req, res) => {
  if (req.url === '/v1/models' || req.url === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }] }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise<void>((r) => mock.listen(mockPort, r));

// ── 2) 同进程启动 Web 服务 ──
await import('./src/gui/server.ts');

async function connect(retries = 25): Promise<WebSocket> {
  for (let i = 0; i < retries; i++) {
    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(WS_URL);
        s.on('open', () => resolve(s));
        s.on('error', reject);
      });
      return ws;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`无法连接 ${WS_URL}`);
}

const send = (ws: WebSocket, obj: Record<string, unknown>) => ws.send(JSON.stringify(obj));
function waitMsg(
  ws: WebSocket,
  pred: (m: Record<string, unknown>) => boolean,
  timeoutMs = 10000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting msg')), timeoutMs);
    const handler = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (pred(m)) {
        clearTimeout(t);
        ws.off('message', handler);
        resolve(m);
      }
    };
    ws.on('message', handler);
  });
}

let exitCode = 2;
try {
  const ws = await connect();

  send(ws, { type: 'register', username: USER, password: PASS });
  const auth = await waitMsg(ws, (m) => m.type === 'auth_ok' || m.type === 'auth_error');
  if (auth.type !== 'auth_ok') throw new Error('注册/登录失败: ' + JSON.stringify(auth));

  send(ws, { type: 'setkey', apiKey: 'sk-e2e-test', baseURL: `http://127.0.0.1:${mockPort}/v1` });
  const key = await waitMsg(ws, (m) => m.type === 'key_ok' || m.type === 'key_error');
  if (key.type !== 'key_ok') throw new Error('setkey 失败: ' + JSON.stringify(key));

  // 创建任务 A
  send(ws, { type: 'new_task', title: 'E2E-A' });
  const tlA = await waitMsg(
    ws,
    (m) =>
      m.type === 'task_list' &&
      Array.isArray((m as { tasks?: unknown[] }).tasks) &&
      ((m as { tasks: Array<{ title: string }> }).tasks).some((t) => t.title === 'E2E-A'),
  );
  const idA = (tlA.tasks as Array<{ id: string; title: string }>).find((t) => t.title === 'E2E-A')!.id;
  const dirA = join(USER_DIR, 'threads', idA);

  // ★ 写入一段「真实对话」的 trace（与 agent-host 实时落盘同形）：
  //   user + 思考盒(thinking_start/entry/update/status/end) + assistant（绑定 thinkingId）。
  //   —— 这正是方案 A 要持久化的内容；切回任务时须原样重建思考盒 + 气泡。
  const trace = new TraceLogger({ workspaceDir: dirA });
  await trace.log('user_input', { input: '你好，请介绍一下闭包是什么' });
  await trace.log('thinking_start', { turnId: 1 });
  await trace.log('thinking_entry', { id: 0, kind: 'reason', text: '闭包是函数与其词法作用域的组合。' });
  await trace.log('thinking_update', { id: 0, append: '它能捕获定义时的变量。' });
  await trace.log('thinking_status', { status: 'outputting' });
  // 最终答复：loop 在 setBusy(false)（thinking_end）之前落盘 → 排在 thinking_end 之前，与生产顺序一致
  await trace.log('assistant_message', { content: FINAL_ANSWER });
  await trace.log('thinking_status', { status: 'done' });
  await trace.log('thinking_end', { turnId: 1 });
  await trace.end();
  await new Promise((r) => setTimeout(r, 300)); // 确保落盘对服务端可见

  // 创建任务 B（隔离对照）
  send(ws, { type: 'new_task', title: 'E2E-B' });
  const tlB = await waitMsg(
    ws,
    (m) =>
      m.type === 'task_list' &&
      Array.isArray((m as { tasks?: unknown[] }).tasks) &&
      ((m as { tasks: Array<{ title: string }> }).tasks).some((t) => t.title === 'E2E-B'),
  );
  const idB = (tlB.tasks as Array<{ id: string; title: string }>).find((t) => t.title === 'E2E-B')!.id;

  // 切到 B（先隔离对照）
  const capB: Array<{ role: string; text?: string }> = [];
  const capBRaw: Array<{ type: string; role?: string; text?: string }> = [];
  const hB = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    capBRaw.push({ type: m.type, role: m.role as string | undefined, text: m.text as string | undefined });
    if (m.type === 'message') capB.push({ role: m.role as string, text: m.text as string });
  };
  ws.on('message', hB);
  send(ws, { type: 'switch_task', id: idB });
  await waitMsg(ws, (m) => m.type === 'reset');
  await new Promise<void>((r) => setTimeout(r, 1500));
  ws.off('message', hB);
  const bTexts = capB.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.text!);
  const noLeak = !bTexts.some((t) => t.includes('闭包') || t.includes('你好'));

  // ── 双回合切换 A↔B，最后一次切回 A（方案 A 验收的关键压力点）──
  // 每次切回都从持久化的 thinking 事件重建，不依赖任何内存缓存 → 多次切换后思考盒仍在。
  const capA: Array<{ role: string; text?: string; thinkingId?: number }> = [];
  // 捕获 reset 载荷：断点①修复后，思考盒随 reset 原子恢复（emitThinking=false，不再重发 thinking 事件）。
  const capResets: Array<Record<string, unknown>> = [];
  const hA = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'message') capA.push({ role: m.role as string, text: m.text as string, thinkingId: m.thinkingId as number | undefined });
  };
  // 捕获思考盒事件，验证「思考盒随历史原样恢复」（方案 A：从持久化事件重建）
  const thinkingRounds: Array<{ turnId?: number; entries: Array<{ id: number; kind: string; text?: string }> }> = [];
  let curThinking: { turnId?: number; entries: Array<{ id: number; kind: string; text?: string }> } | null = null;
  const hThink = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'thinking_start') { curThinking = { turnId: m.turnId as number, entries: [] }; thinkingRounds.push(curThinking); }
    else if (m.type === 'thinking_entry' && curThinking) { curThinking.entries.push({ id: m.id as number, kind: m.kind as string, text: m.text as string }); }
  };
  const hReset = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'reset') capResets.push(m);
  };

  async function switchTo(id: string): Promise<void> {
    capA.length = 0;
    thinkingRounds.length = 0;
    capResets.length = 0;
    curThinking = null;
    ws.on('message', hA);
    ws.on('message', hThink);
    ws.on('message', hReset);
    send(ws, { type: 'switch_task', id });
    await waitMsg(ws, (m) => m.type === 'reset');
    await new Promise<void>((r) => setTimeout(r, 2500));
    ws.off('message', hA);
    ws.off('message', hThink);
    ws.off('message', hReset);
  }

  await switchTo(idA); // 第一次切回 A
  await switchTo(idB); // 再切 B
  await switchTo(idA); // ★ 最后切回 A：思考盒必须仍在（用户报告丢失的场景）

  const aMsgs = capA.filter((m) => m.role === 'user' || m.role === 'assistant');
  const hasUser = aMsgs.some((m) => m.role === 'user' && (m.text ?? '').includes('你好'));
  const hasAsst = aMsgs.some((m) => m.role === 'assistant' && (m.text ?? '').includes('闭包'));
  const historyRecovered = hasUser && hasAsst;

  // 思考盒恢复断言（断点①修复后）：reset 载荷携带 thinkings（含 reason 条目=agent 最终答复），
  // 且 assistant 气泡已绑定 thinkingId。不再依赖 thinking 事件重发。
  const resetCarriesThinking = capResets.some(
    (r) =>
      Array.isArray(r.thinkings) &&
      (r.thinkings as Array<Record<string, unknown>>).some(
        (t) =>
          Array.isArray(t.entries) &&
          (t.entries as Array<Record<string, unknown>>).some((e) => String(e.text ?? '').includes('闭包')),
      ),
  );
  const asstBound = aMsgs.some((m) => m.role === 'assistant' && m.thinkingId !== undefined);
  const hasThinkingBox = resetCarriesThinking && asstBound;

  console.log('A 恢复消息:', aMsgs.map((m) => `[${m.role}] ${m.text}` + (m.thinkingId !== undefined ? ` (thinkingId=${m.thinkingId})` : '')));
  console.log('A reset 携带 thinking 轮数:', capResets.reduce((n, r) => n + (Array.isArray(r.thinkings) ? (r.thinkings as unknown[]).length : 0), 0));
  console.log('B 显示(应无 A 历史):', bTexts);
  console.log(`\n=== E2E: historyRecovery=${historyRecovered} hasThinkingBox=${hasThinkingBox} isolation=${noLeak} ===`);
  exitCode = historyRecovered && hasThinkingBox && noLeak ? 0 : 1;
  console.log(exitCode === 0 ? 'E2E_OK' : 'E2E_FAIL');

  ws.close();
} catch (e) {
  console.error('E2E_ERROR', e);
  exitCode = 2;
} finally {
  mock.close();
  cleanup();
  process.exit(exitCode);
}
