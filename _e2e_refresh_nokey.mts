/**
 * e2e：模拟「未配置 API Key + 刷新」——注册用户、建任务并写入含思考盒的 trace，
 * 但全程不发 setkey（模拟无 Key），关闭后用第二个 WS 连接 resume 重连，
 * 断言即便无 Key，历史记录（含思考盒）仍从磁盘回放恢复，仅额外提示「请配置 Key」。
 *
 * 验证目标：bootWithUser 的历史回放（①）已与 API Key 校验（②）解耦；
 * 无 Key 时不再因提前 return 而丢失历史与思考盒（修复前的真实缺口）。
 */
process.env.DSA_WEB_PORT = String(Number(process.env.DSA_WEB_PORT ?? 4195));
process.env.DSA_EMBEDDER = 'off';
const PORT = Number(process.env.DSA_WEB_PORT);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

import { WebSocket } from 'ws';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TraceLogger } from './src/context/trace.ts';

const USER = `e2e_rf_nk_${Date.now().toString(36)}`;
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
  // ── 连接 #1：注册（故意不发 setkey）、建任务 A、写含思考盒的 trace ──
  const ws1 = await connect();
  send(ws1, { type: 'register', username: USER, password: PASS });
  const auth = await waitMsg(ws1, (m) => m.type === 'auth_ok' || m.type === 'auth_error');
  if (auth.type !== 'auth_ok') throw new Error('注册失败: ' + JSON.stringify(auth));
  const token = String(auth.token);
  // 注意：这里刻意不调用 setkey，模拟「用户尚未配置 API Key」。

  send(ws1, { type: 'new_task', title: 'E2E-NOKEY-A' });
  const tl = await waitMsg(
    ws1,
    (m) =>
      m.type === 'task_list' &&
      Array.isArray((m as { tasks?: unknown[] }).tasks) &&
      ((m as { tasks: Array<{ title: string }> }).tasks).some((t) => t.title === 'E2E-NOKEY-A'),
  ) as { tasks: Array<{ id: string; title: string }> };
  const idA = tl.tasks.find((t) => t.title === 'E2E-NOKEY-A')!.id;
  const dirA = join(USER_DIR, 'threads', idA);

  // 直接写 trace 到磁盘（绕过运行中的内核），模拟「历史已落盘但未配 Key」
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

  // 关掉连接 #1，模拟用户关闭页面（未配 Key）
  ws1.close();
  await new Promise((r) => setTimeout(r, 400));

  // ── 连接 #2：模拟刷新 / 新标签页，用 token resume 重连（无 Key）──
  const ws2 = await connect();
  const capThinking: Array<{ type: string; turnId?: number }> = [];
  const capMessages: Array<{ role: string; text?: string; thinkingId?: number }> = [];
  const capSystems: string[] = [];
  const capResets: Array<Record<string, unknown>> = [];
  const h2 = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'message') {
      capMessages.push({ role: m.role as string, text: m.text as string, thinkingId: m.thinkingId as number | undefined });
      if (m.role === 'system') capSystems.push(String(m.text ?? ''));
    } else if (m.type === 'reset') capResets.push(m);
    else if (m.type === 'thinking_start' || m.type === 'thinking_entry' || m.type === 'thinking_status' || m.type === 'thinking_end')
      capThinking.push({ type: m.type, turnId: m.turnId as number | undefined });
    else if (m.type === 'auth_ok') { /* 忽略 token 续期 */ }
  };
  ws2.on('message', h2);

  send(ws2, { type: 'resume', token, threadId: idA });
  await new Promise<void>((r) => setTimeout(r, 3000));
  ws2.off('message', h2);

  const resetCarriesThinking = capResets.some(
    (r) =>
      Array.isArray(r.thinkings) &&
      (r.thinkings as Array<Record<string, unknown>>).some(
        (t) => Array.isArray(t.entries) && (t.entries as Array<Record<string, unknown>>).some((e) => String(e.text ?? '').includes('闭包')),
      ),
  );
  const asstBound = capMessages.some((m) => m.role === 'assistant' && m.thinkingId !== undefined);
  const hasAnswer = capMessages.some((m) => m.role === 'assistant' && (m.text ?? '').includes('闭包'));
  const sawKeyPrompt = capSystems.some((s) => s.includes('尚未配置 DeepSeek API Key'));

  console.log('无Key·reset 携带 thinking:', resetCarriesThinking);
  console.log('无Key·assistant 气泡绑定 thinkingId:', asstBound, ' 含答案:', hasAnswer);
  console.log('无Key·出现「请配置 Key」提示:', sawKeyPrompt);
  console.log('无Key·messages:', capMessages.map((m) => `[${m.role}] ${m.text}` + (m.thinkingId !== undefined ? `(tid=${m.thinkingId})` : '')));

  // 核心断言：无 Key 时历史（含思考盒）仍恢复，且明确提示需配置 Key
  const historyRestored = resetCarriesThinking && asstBound && hasAnswer;
  const ok = historyRestored && sawKeyPrompt;
  console.log(`\n=== REFRESH_NOKEY_E2E: historyRestored=${historyRestored} sawKeyPrompt=${sawKeyPrompt} ===`);
  exitCode = ok ? 0 : 1;
  console.log(ok ? 'REFRESH_NOKEY_OK' : 'REFRESH_NOKEY_FAIL');

  ws2.close();
} catch (e) {
  console.error('REFRESH_NOKEY_E2E_ERROR', e);
  exitCode = 2;
} finally {
  cleanup();
  process.exit(exitCode);
}
