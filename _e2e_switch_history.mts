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
import { runAgent } from './src/agent/loop.ts';
import type { DeepSeekClient, ChatMessage } from './src/llm/deepseek.ts';
import type { ConversationHistory } from './src/context/history.ts';

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

// ── mock LLM：纯文本最终答复（不调工具）→ 走 loop 的 !gotToolUse 最终答复路径 ──
const FINAL_ANSWER = '闭包（closure）是函数与其词法作用域的组合，使函数能访问外层变量。';
function e2eMockClient(text: string): DeepSeekClient {
  return {
    primaryModel: 'mock-model',
    async *streamChat() {
      yield { type: 'content', text } as unknown as { type: string; text?: string };
    },
  } as unknown as DeepSeekClient;
}
function e2eMockHistory(): ConversationHistory {
  const store: ChatMessage[] = [];
  return {
    addUser: (c: string) => store.push({ role: 'user', content: c }),
    addAssistant: (c: string) => store.push({ role: 'assistant', content: c }),
    getMessages: () => store.map((m) => ({ ...m })),
    compact: async () => {},
    estimateTotalTokens: () => 0,
  } as unknown as ConversationHistory;
}

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

  // ★ 真实跑一轮对话（mock LLM），让修复后的 loop 把最终答复写入 A 的 trace
  const trace = new TraceLogger({ workspaceDir: dirA });
  for await (const _ev of runAgent('你好，请介绍一下闭包是什么', {
    client: e2eMockClient(FINAL_ANSWER),
    history: e2eMockHistory(),
    permission: 'execute',
    cwd: dirA,
    ask: async () => false,
    tools: [],
    autoPlan: false,
    trace,
  })) {
    /* drain */
  }
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
  const hB = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'message') capB.push({ role: m.role as string, text: m.text as string });
  };
  ws.on('message', hB);
  send(ws, { type: 'switch_task', id: idB });
  await waitMsg(ws, (m) => m.type === 'reset');
  await new Promise<void>((r) => setTimeout(r, 2000));
  ws.off('message', hB);
  const bTexts = capB.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.text!);
  const noLeak = !bTexts.some((t) => t.includes('闭包') || t.includes('你好'));

  // 切回 A（模拟点击任务卡片重新进入）→ 应恢复 user + assistant 历史 + 思考盒
  const capA: Array<{ role: string; text?: string; thinkingId?: number }> = [];
  const hA = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'message') capA.push({ role: m.role as string, text: m.text as string, thinkingId: m.thinkingId as number | undefined });
  };
  // 同时捕获思考盒事件，验证「思考盒随历史原样恢复」（方案 B：纯问答也重建 thinking 卡）
  const thinkingRounds: Array<{ turnId?: number; entries: Array<{ id: number; kind: string; text?: string }> }> = [];
  let curThinking: { turnId?: number; entries: Array<{ id: number; kind: string; text?: string }> } | null = null;
  const hThink = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'thinking_start') { curThinking = { turnId: m.turnId as number, entries: [] }; thinkingRounds.push(curThinking); }
    else if (m.type === 'thinking_entry' && curThinking) { curThinking.entries.push({ id: m.id as number, kind: m.kind as string, text: m.text as string }); }
  };
  ws.on('message', hA);
  ws.on('message', hThink);
  send(ws, { type: 'switch_task', id: idA });
  await waitMsg(ws, (m) => m.type === 'reset');
  await new Promise<void>((r) => setTimeout(r, 3000));
  ws.off('message', hA);
  ws.off('message', hThink);
  const aMsgs = capA.filter((m) => m.role === 'user' || m.role === 'assistant');
  const hasUser = aMsgs.some((m) => m.role === 'user' && (m.text ?? '').includes('你好'));
  const hasAsst = aMsgs.some((m) => m.role === 'assistant' && (m.text ?? '').includes('闭包'));
  const historyRecovered = hasUser && hasAsst;

  // 思考盒恢复断言：存在 reason 条目(文本=agent 最终答复) 且 assistant 气泡已绑定 thinkingId
  const reasonEntry = thinkingRounds.flatMap((r) => r.entries).find((e) => e.kind === 'reason' && (e.text ?? '').includes('闭包'));
  const asstBound = aMsgs.some((m) => m.role === 'assistant' && m.thinkingId !== undefined);
  const hasThinkingBox = !!reasonEntry && asstBound;

  console.log('A 恢复消息:', aMsgs.map((m) => `[${m.role}] ${m.text}` + (m.thinkingId !== undefined ? ` (thinkingId=${m.thinkingId})` : '')));
  console.log('A 思考盒 reason 条目数:', thinkingRounds.flatMap((r) => r.entries).filter((e) => e.kind === 'reason').length);
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
