/**
 * e2e：模拟「页面刷新 / 新标签页」——首个连接建任务并写入含思考盒的 trace，
 * 关闭该连接后，用第二个 WS 连接发 resume 重连（与浏览器刷新同语义），
 * 断言刷新后思考盒是否能从服务端磁盘回放恢复（emitThinking=true 旧路径）。
 *
 * 验证目标：bootWithUser（刷新入口）当前使用 replayToUi(replayed, fwd, host)
 * （emitThinking 默认 true，事件流重建），需确认该路径能否在全新前端状态下恢复思考盒。
 */
process.env.DSA_WEB_PORT = String(Number(process.env.DSA_WEB_PORT ?? 4197));
process.env.DSA_EMBEDDER = 'off';
const PORT = Number(process.env.DSA_WEB_PORT);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

import { WebSocket } from 'ws';
import http from 'node:http';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TraceLogger } from './src/context/trace.ts';

const USER = `e2e_rf_${Date.now().toString(36)}`;
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

const FINAL_ANSWER = '闭包（closure）是函数与其词法作用域的组合，使函数能访问外层变量。';

const mockPort = 8732;
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
  // ── 连接 #1：注册、建任务 A、写含思考盒的 trace ──
  const ws1 = await connect();
  send(ws1, { type: 'register', username: USER, password: PASS });
  const auth = await waitMsg(ws1, (m) => m.type === 'auth_ok' || m.type === 'auth_error');
  if (auth.type !== 'auth_ok') throw new Error('注册失败: ' + JSON.stringify(auth));
  const token = String(auth.token);

  send(ws1, { type: 'setkey', apiKey: 'sk-e2e-test', baseURL: `http://127.0.0.1:${mockPort}/v1` });
  const key = await waitMsg(ws1, (m) => m.type === 'key_ok' || m.type === 'key_error');
  if (key.type !== 'key_ok') throw new Error('setkey 失败: ' + JSON.stringify(key));

  send(ws1, { type: 'new_task', title: 'E2E-REFRESH-A' });
  const tl = await waitMsg(
    ws1,
    (m) =>
      m.type === 'task_list' &&
      Array.isArray((m as { tasks?: unknown[] }).tasks) &&
      ((m as { tasks: Array<{ title: string }> }).tasks).some((t) => t.title === 'E2E-REFRESH-A'),
  ) as { tasks: Array<{ id: string; title: string }> };
  const idA = tl.tasks.find((t) => t.title === 'E2E-REFRESH-A')!.id;
  const dirA = join(USER_DIR, 'threads', idA);

  const trace = new TraceLogger({ workspaceDir: dirA });
  await trace.log('user_input', { input: '你好，请介绍一下闭包是什么' });
  await trace.log('thinking_start', { turnId: 1 });
  await trace.log('thinking_entry', { id: 0, kind: 'reason', text: '闭包是函数与其词法作用域的组合。' });
  await trace.log('thinking_update', { id: 0, append: '它能捕获定义时的变量。' });
  await trace.log('thinking_status', { status: 'outputting' });
  await trace.log('assistant_message', { content: FINAL_ANSWER });
  await trace.log('thinking_status', { status: 'done' });
  await trace.log('thinking_end', { turnId: 1 });
  await trace.end();
  await new Promise((r) => setTimeout(r, 300));

  // 关掉连接 #1，模拟用户关闭页面
  ws1.close();
  await new Promise((r) => setTimeout(r, 400));

  // ── 连接 #2：模拟刷新 / 新标签页，用 token resume 重连 ──
  const ws2 = await connect();
  const capThinking: Array<{ type: string; turnId?: number; id?: number; kind?: string; text?: string }> = [];
  const capMessages: Array<{ role: string; text?: string; thinkingId?: number }> = [];
  const capResets: Array<Record<string, unknown>> = [];
  let taskListAfterResume: Array<{ id: string; title: string; active?: boolean }> = [];
  const h2 = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'message') capMessages.push({ role: m.role as string, text: m.text as string, thinkingId: m.thinkingId as number | undefined });
    else if (m.type === 'reset') capResets.push(m);
    else if (m.type === 'thinking_start' || m.type === 'thinking_entry' || m.type === 'thinking_status' || m.type === 'thinking_end')
      capThinking.push({ type: m.type, turnId: m.turnId as number | undefined, id: m.id as number | undefined, kind: m.kind as string | undefined, text: m.text as string | undefined });
    else if (m.type === 'task_list' && Array.isArray(m.tasks)) taskListAfterResume = m.tasks as Array<{ id: string; title: string; active?: boolean }>;
    else if (m.type === 'auth_ok') { /* 记录 token 续期，忽略 */ }
  };
  ws2.on('message', h2);

  send(ws2, { type: 'resume', token, threadId: idA });
  // 等刷新后的历史回放完成
  await new Promise<void>((r) => setTimeout(r, 3000));
  ws2.off('message', h2);

  const activeAfterResume = taskListAfterResume.find((t) => t.active);
  const activeIsCorrect = activeAfterResume?.id === idA;

  const hasThinkingEvents = capThinking.some((t) => t.type === 'thinking_start');
  const resetCarriesThinking = capResets.some(
    (r) =>
      Array.isArray(r.thinkings) &&
      (r.thinkings as Array<Record<string, unknown>>).some(
        (t) => Array.isArray(t.entries) && (t.entries as Array<Record<string, unknown>>).some((e) => String(e.text ?? '').includes('闭包')),
      ),
  );
  const asstBound = capMessages.some((m) => m.role === 'assistant' && m.thinkingId !== undefined);
  const hasAnswer = capMessages.some((m) => m.role === 'assistant' && (m.text ?? '').includes('闭包'));

  console.log('刷新后 thinking 事件数:', capThinking.length, ' 含 thinking_start:', hasThinkingEvents);
  console.log('刷新后 reset 携带 thinking:', resetCarriesThinking);
  console.log('刷新后 assistant 气泡绑定 thinkingId:', asstBound, ' 含答案:', hasAnswer);
  console.log('刷新后激活任务:', activeAfterResume ? `${activeAfterResume.title}(${activeAfterResume.id})` : '无', ' 应为 E2E-REFRESH-A:', activeIsCorrect);
  console.log('刷新后 messages:', capMessages.map((m) => `[${m.role}] ${m.text}` + (m.thinkingId !== undefined ? `(tid=${m.thinkingId})` : '')));

  // 思考盒恢复 = 思考盒数据到达（事件流或 reset 载荷）且气泡已绑定 thinkingId 且答案在
  const thinkingRecovered = (hasThinkingEvents || resetCarriesThinking) && asstBound && hasAnswer;
  console.log(`\n=== REFRESH_E2E: thinkingRecovered=${thinkingRecovered} activeCorrect=${activeIsCorrect} (events=${hasThinkingEvents} resetThinking=${resetCarriesThinking} bound=${asstBound} answer=${hasAnswer}) ===`);
  exitCode = thinkingRecovered ? 0 : 1;
  console.log(exitCode === 0 ? 'REFRESH_OK' : 'REFRESH_FAIL');

  ws2.close();
} catch (e) {
  console.error('REFRESH_E2E_ERROR', e);
  exitCode = 2;
} finally {
  mock.close();
  cleanup();
  process.exit(exitCode);
}
