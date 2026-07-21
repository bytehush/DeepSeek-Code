/**
 * e2e：真实服务里「创建任务 A/B 来回切换，历史聚合恢复」验证。
 *
 * 关键设计（解决此前 Bash 沙箱文件系统隔离问题）：
 *   直接在【同一进程内】 `import` 启动 server.ts（它在模块加载时即 server.listen），
 *   使 Web 服务与测试脚本共享同一文件系统视图 —— 脚本注入的 traces 对服务端可见，
 *   避免了「前台 e2e 与后台服务分处不同沙箱视图」导致服务端 replayAll 读到空目录的假阴性。
 *
 *   同时用独立端口（DSA_WEB_PORT，默认 4199）启动，避免与本机可能残留的旧 4173 服务冲突，
 *   确保测的是当前（含修复的）代码。
 *
 * DeepSeekClient.validate 是真实网络调用（models.list）。为在无有效 Key 时仍走到
 * bootTask 的 replayAll 路径，起一个本地 mock 端点（返回 200 + 模型列表），把测试账号
 * baseURL 指向它 —— 只改测试配置，不动产品代码。
 *
 * 断言：
 *   1. 切回 A → 应聚合恢复「历史消息1/历史回复1/历史消息2/当前消息」全部 4 条历史。
 *   2. 切到 B → 不得泄漏 A 的任何历史（任务隔离）。
 */
process.env.DSA_WEB_PORT = String(Number(process.env.DSA_WEB_PORT ?? 4199));
// 离线/CI 环境跳过本地 BGE 模型加载（NullEmbedder），避免 assemble 在无法下载模型时卡死；
// 仅影响记忆嵌入，不影响本测试要验证的「切任务历史聚合恢复」。
process.env.DSA_EMBEDDER = 'off';
const PORT = Number(process.env.DSA_WEB_PORT);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

import { WebSocket } from 'ws';
import http from 'node:http';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TraceLogger } from './src/context/trace.ts';

const USER = `e2e_${Date.now().toString(36)}`;
const PASS = 'e2e123';
const USER_DIR = join(homedir(), '.dsa', 'users', USER);
const ACCOUNTS_PATH = join(homedir(), '.dsa', 'accounts.json');

/** 清理：删用户目录 + accounts.json 里该账号条目（含其会话） */
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

const wf = writeFileSync;

// ── 1) mock DeepSeek 端点 ──
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

// ── 2) 同进程启动 Web 服务（import 触发 server.listen）──
await import('./src/gui/server.ts');

// 等监听就绪（重试连接）
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

const userLine = (input: string) =>
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'user_input', payload: { input } }) + '\n';
const asstLine = (content: string) =>
  JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant_message', payload: { content } }) + '\n';

function writeTrace(taskId: string, file: string, lines: string[]) {
  const dir = join(USER_DIR, 'threads', taskId, '.dsa', 'traces');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), lines.join(''), 'utf8');
}

const EXPECTED = ['历史消息1', '历史回复1', '历史消息2', '当前消息'];

let exitCode = 2;
try {
  const ws = await connect();

  // 注册 + 登录
  send(ws, { type: 'register', username: USER, password: PASS });
  const auth = await waitMsg(ws, (m) => m.type === 'auth_ok' || m.type === 'auth_error');
  if (auth.type !== 'auth_ok') throw new Error('注册/登录失败: ' + JSON.stringify(auth));

  // 配置 Key（指向本地 mock，validate 通过）
  send(ws, { type: 'setkey', apiKey: 'sk-e2e-test', baseURL: `http://127.0.0.1:${mockPort}/v1` });
  const key = await waitMsg(ws, (m) => m.type === 'key_ok' || m.type === 'key_error');
  if (key.type !== 'key_ok') throw new Error('setkey 失败: ' + JSON.stringify(key));

  // 创建任务 A（只等含 E2E-A 的 task_list，跳过登录后 bootWithUser 发的陈旧列表）
  send(ws, { type: 'new_task', title: 'E2E-A' });
  const tlA = await waitMsg(
    ws,
    (m) =>
      m.type === 'task_list' &&
      Array.isArray((m as { tasks?: unknown[] }).tasks) &&
      ((m as { tasks: Array<{ title: string }> }).tasks).some((t) => t.title === 'E2E-A'),
  );
  const idA = (tlA.tasks as Array<{ id: string; title: string }>).find((t) => t.title === 'E2E-A')!.id;

  // 给 A 写「多 session 文件」模拟「重启/切换后历史」（修复前的 bug 场景）
  writeTrace(idA, 'sess_0001_prev.jsonl', [userLine('历史消息1'), asstLine('历史回复1'), userLine('历史消息2')]);
  writeTrace(idA, 'sess_0002_curr.jsonl', [userLine('当前消息')]);
  await new Promise((r) => setTimeout(r, 300)); // 确保磁盘写入对服务端可见

  // 创建任务 B
  send(ws, { type: 'new_task', title: 'E2E-B' });
  const tlB = await waitMsg(
    ws,
    (m) =>
      m.type === 'task_list' &&
      Array.isArray((m as { tasks?: unknown[] }).tasks) &&
      ((m as { tasks: Array<{ title: string }> }).tasks).some((t) => t.title === 'E2E-B'),
  );
  const idB = (tlB.tasks as Array<{ id: string; title: string }>).find((t) => t.title === 'E2E-B')!.id;

  // 切回 A → 应聚合恢复全部历史（监听在发 switch 之前挂上，避免漏接）
  const captured: Array<{ role: string; text?: string }> = [];
  const hA = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'message') captured.push({ role: m.role as string, text: m.text as string });
  };
  ws.on('message', hA);
  send(ws, { type: 'switch_task', id: idA });
  await waitMsg(ws, (m) => m.type === 'reset'); // bootTask 先 reset
  await new Promise<void>((r) => setTimeout(r, 3000));
  ws.off('message', hA);
  const aTexts = captured.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.text!);
  const historyRecovered = EXPECTED.every((e) => aTexts.includes(e));

  // 切到 B → 不得泄漏 A 的历史（隔离）
  const capB: Array<{ role: string; text?: string }> = [];
  const hB = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'message') capB.push({ role: m.role as string, text: m.text as string });
  };
  ws.on('message', hB);
  send(ws, { type: 'switch_task', id: idB });
  await waitMsg(ws, (m) => m.type === 'reset');
  await new Promise<void>((r) => setTimeout(r, 2500));
  ws.off('message', hB);
  const bTexts = capB.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.text!);
  const noLeak = !EXPECTED.some((e) => bTexts.includes(e));

  console.log('A 恢复的历史:', aTexts);
  console.log('B 显示(应为空/仅欢迎):', bTexts);
  console.log(`\n=== E2E: historyRecovery=${historyRecovered} isolation=${noLeak} ===`);
  exitCode = historyRecovered && noLeak ? 0 : 1;
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
