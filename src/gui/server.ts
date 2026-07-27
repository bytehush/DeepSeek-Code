/**
 * 网页后端：Node HTTP 静态服务 + WebSocket 桥接（账户密码登录 + 每账号独立版）。
 *
 * 与之前 BYOK 版的核心区别：
 *   1. 身份与配置解耦——先「账户密码登录」（本地账号库，scrypt 哈希），登录后才装配内核；
 *      API Key 不再充当登录密钥，而是登录后在「设置」里按账号配置的 provider 密钥。
 *   2. 每账号隔离——每个账号的内核数据落盘到 ~/.dsa/users/<username>/（任务/历史/记忆/日志），
 *      各自独立的 API Key，互不可见。内核按账号缓存，改 Key 时按账号失效重建。
 *   3. 多任务——每个账号可新建/切换/删除多个任务线程；每个任务拥有独立的 dataDir 与上下文。
 *   4. 产物侧边栏——工具输出以 artifact 事件推送到前端，在右栏实时展示。
 *   5. 会话 token——登录成功签发 token，浏览器存 sessionStorage，刷新可免登录。
 *
 * 启动：npm run web （先 vite build 前端，再 tsx 启动本服务），打开 http://localhost:4173
 */
import { createServer } from 'node:http';
import os from 'node:os';
import { readFile, stat, readdir, writeFile, mkdir, open } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, dirname, relative, resolve, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { assembleAppProps } from '../app/assemble.ts';
import { AgentHost } from './agent-host.ts';
import {
  loadUserCredentials,
  saveUserCredentials,
  userDataDir,
  type Credentials,
} from '../auth/credentials.ts';
import { getMode, setMode, parseMode, modeLabel } from '../config/model-mode.ts';
import {
  register as registerAccount,
  verify as verifyAccount,
  issueToken,
  verifyToken,
  revokeToken,
} from './accounts.ts';
import { TaskStore } from './thread-store.ts';
import { DeepSeekClient, type ChatMessage } from '../llm/deepseek.ts';
import { TraceLogger, type ReplayedConversation, type ReplayedMessage, type ReplayedThinkingTurn } from '../context/trace.ts';
import { createMemoryBackend } from '../memory/backend.ts';
import type { MemoryBackend } from '../memory/backend.ts';
import { Embedder } from '../memory/embedder.ts';
import { loadMemoryConfig } from '../memory/config.ts';
import { SkillManager } from '../skills/loader.ts';
import { BrowserTelemetryHub } from './telemetry-hub.ts';
import type { BrowserTelemetryEvent } from './telemetry-types.ts';
import type { AppProps, UiMessage, MsgRole } from '../app/types.ts';
import { JsonlConversationStore, type ConversationStore } from './storage.ts';

const PORT = Number(process.env.DSA_WEB_PORT ?? 4173);
const here = fileURLToPath(new URL('.', import.meta.url));
const DIST = resolve(here, '../../dist/gui');

/** 润色输入框文本的系统提示词：把口语化/随意表达改成专业、有逻辑、有步骤、有目的的结构化文本 */
const POLISH_SYSTEM_PROMPT = [
  '你是文本优化器。你的任务是把用户输入的自然语言改写成更专业、更有逻辑、更清晰、更有步骤和目的的表达。',
  '',
  '改写规则：',
  '1. 保持用户的原始意图和目标不变',
  '2. 拆解为清晰的步骤（用「1. 2. 3.」编号）',
  '3. 每步明确「做什么」和「为什么」',
  '4. 使用专业、准确的技术术语（不要过度口语化）',
  '5. 去除歧义和模糊表达',
  '6. 开头顶格写目标概述（一句话说明要达成什么）',
  '',
  '只输出改写后的文本，不要加任何前缀、解释或引号。',
].join('\n');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

// ── 按 dataDir 缓存已装配的内核；改 Key 时按账号失效 ──
const kernels = new Map<string, { creds: Credentials; promise: Promise<AppProps> }>();

/**
 * 浏览器遥测集线器注册表：token → 该连接的 BrowserTelemetryHub。
 * 供 HTTP POST /api/telemetry（外部浏览器页面经 token 上报）按 token 找到对应连接，
 * 与 WS 通道互补。连接关闭时由下方清理逻辑移除。
 */
const telemetryHubs = new Map<string, BrowserTelemetryHub>();

function kernelKey(username: string, dataDir: string, workspace: string | null): string {
  return `${username}::${dataDir}::${workspace ?? '∅'}`;
}

function ensureKernel(
  username: string,
  dataDir: string,
  creds: Credentials,
  workspace: string | null,
): Promise<AppProps> {
  const key = kernelKey(username, dataDir, workspace);
  const ex = kernels.get(key);
  if (ex && ex.creds.apiKey === creds.apiKey && (ex.creds.baseURL ?? '') === (creds.baseURL ?? '')) {
    return ex.promise;
  }
  const promise = assembleAppProps(creds, { dataDir, workspace: workspace ?? undefined }).catch((e) => {
    // 装配失败（如内核初始化异常）时删除缓存，避免永久缓存 rejected promise 导致后续启动永远失败
    kernels.delete(key);
    throw e;
  });
  kernels.set(key, { creds, promise });
  return promise;
}

function resetKernelsForUser(username: string): void {
  for (const key of kernels.keys()) {
    if (key.startsWith(`${username}::`)) kernels.delete(key);
  }
}

/**
 * 任务隔离守卫：确保某任务的 dataDir 严格落在 当前用户 的 threads/ 之下，
 * 杜绝路径穿越导致不同用户/任务的上下文（对话、记忆、历史）串味。
 * 返回 true 表示隔离有效。
 */
function isTaskIsolated(dataDir: string, username: string): boolean {
  const base = resolve(userDataDir(username), 'threads');
  const rel = relative(base, resolve(dataDir));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

// ── 文件资源浏览器：只读浏览「工作空间」下的资源，防御路径穿越 ──
// 工作空间由 GUI 设置（gui-settings.json 的 workspaceRoot）指定；【未配置时返回 null】——
// 绝不回退到 server cwd（即 deepseek-code-agent 工具自身源码），否则会泄露 agent 内部实现。
// 未配置时右侧面板与 agent 工作区都应显式提示用户去设置，而非暴露工具源码；
// 且 agent 会在对话中主动询问用户选择工作空间（候选路径由磁盘分类 × 工作文件夹命名组合而成）。
const MAX_FILE_READ = 200 * 1024; // 单文件预览上限 200KB

/** 每用户 GUI 设置（含工作空间 workspaceRoot）。存于 ~/.dsa/users/<u>/gui-settings.json。 */
interface GuiSettings {
  workspaceRoot?: string;
}
function guiSettingsPath(username: string): string {
  return join(userDataDir(username), 'gui-settings.json');
}
async function loadGuiSettings(username: string): Promise<GuiSettings> {
  try {
    const raw = await readFile(guiSettingsPath(username), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GuiSettings> & { projectRoot?: string };
    // 兼容旧字段 projectRoot（历史数据迁移）
    const root = parsed.workspaceRoot ?? parsed.projectRoot;
    return root ? { workspaceRoot: root } : {};
  } catch {
    return {};
  }
}
async function saveGuiSettings(username: string, patch: GuiSettings): Promise<GuiSettings> {
  const dir = userDataDir(username);
  await mkdir(dir, { recursive: true });
  const next: GuiSettings = { ...(await loadGuiSettings(username)), ...patch };
  await writeFile(guiSettingsPath(username), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 当前生效的「项目目录」。
 * - 已配置且为存在的目录 → 返回该绝对路径（右侧面板与 agent 工作区都指向它）。
 * - 未配置 / 配置值无效 → 返回 null（不回退到工具源码，避免泄露 agent 内部实现）。
 *   调用方须据此：文件面板显示提示、agent 工作区落到每任务沙盒而非工具源码。
 */
function fileRoot(settings: GuiSettings): string | null {
  const root = settings.workspaceRoot;
  if (root && existsSync(root)) {
    try {
      if (statSync(root).isDirectory()) return root;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** 把前端传来的相对路径解析为项目目录内的绝对路径；越界返回 null。 */
function resolveInsideRoot(relPath: string, root: string): string | null {
  const safe = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = resolve(root, safe);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}

/**
 * 枚举本机所有可用磁盘，供「工作空间」目录选择器作为「此电脑」根视图，
 * 让用户能根据自己电脑的磁盘种类自由选择任意盘（C:/D:/E:/网络盘…）。
 * - Windows：逐一探测 A:–Z: 根是否可访问（本地盘 / 已挂载的网络盘）。
 * - macOS：/Volumes 下各卷 + 系统根 /。
 * - Linux：仅系统根 /。
 */
async function listDrives(): Promise<Array<{ name: string; type: 'drive' }>> {
  const drives: Array<{ name: string; type: 'drive' }> = [];
  if (process.platform === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = `${letter}:\\`;
      try {
        if (existsSync(p)) drives.push({ name: p, type: 'drive' });
      } catch {
        /* 忽略不可访问 / 未就绪的盘 */
      }
    }
  } else if (process.platform === 'darwin') {
    try {
      const vols = await readdir('/Volumes');
      for (const v of vols) {
        if (v !== 'Macintosh HD') drives.push({ name: `/Volumes/${v}`, type: 'drive' });
      }
    } catch {
      /* 忽略 */
    }
    drives.unshift({ name: '/', type: 'drive' });
  } else {
    drives.push({ name: '/', type: 'drive' });
  }
  return drives;
}

/** 特殊路径 token：代表「此电脑 / 所有磁盘」根视图 */
const DRIVES_TOKEN = '::DRIVES::';

interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
}

/** 列出某相对路径下的条目（目录优先、名称排序），自动跳过重型/内部目录。 */
async function handleFileTree(
  relPath: string,
  root: string,
): Promise<{ path: string; entries: FileEntry[] }> {
  const abs = resolveInsideRoot(relPath, root);
  if (!abs) return { path: relPath, entries: [] };
  let info;
  try {
    info = await stat(abs);
  } catch {
    return { path: relPath, entries: [] };
  }
  const dir = info.isDirectory() ? abs : dirname(abs);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { path: relPath, entries: [] };
  }
  const SKIP = new Set(['node_modules', '.git', '.dsa']);
  // ✅ 性能：并行 stat 所有文件条目，避免顺序 await 导致的 N 次往返延迟
  const results = await Promise.all(
    names
      .filter((name) => !SKIP.has(name))
      .map(async (name) => {
        try {
          const s = await stat(join(dir, name));
          return { name, type: s.isDirectory() ? 'dir' as const : 'file' as const, size: s.isDirectory() ? 0 : s.size };
        } catch {
          return null;
        }
      }),
  );
  const entries: FileEntry[] = results.filter((e): e is FileEntry => e !== null);
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const normRel = relative(root, dir).replace(/\\/g, '/');
  return { path: normRel === '' ? '' : normRel, entries };
}

/**
 * 任务记忆沉淀：把某任务的「任务级记忆」复制提升到用户级长期记忆（~/.dsa/memory），
 * 使其跨任务共享、被未来任务自动召回。
 *
 * - 非破坏性：任务级记忆原样保留，用户级只是多一份副本。
 * - 去重：用用户级 isDuplicate 判定（语义向量 / 关键词降级），已存在则跳过，避免重复堆积。
 * - 离线模式 Embedder（mode='off'）：与记忆管理一致，只做文件读写，不依赖模型。
 */
async function promoteTaskMemories(
  store: TaskStore,
  taskId: string,
  username: string,
  userBackend?: MemoryBackend,
  projBackend?: MemoryBackend,
): Promise<{ title: string; facts: number; entries: number }> {
  const meta = await store.get(taskId);
  if (!meta) throw new Error('任务不存在');
  if (!isTaskIsolated(store.dir(taskId), username)) throw new Error('任务隔离校验失败');
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  // 优先复用调用方注入的共享后端（sharedGuiBackend），否则构建离线模式独立实例（旧行为）。
  const userStore =
    userBackend ?? createMemoryBackend(join(home, '.dsa', 'memory'), new Embedder({ mode: 'off' }));
  const projStore =
    projBackend ??
    createMemoryBackend(join(store.dir(taskId), '.dsa', 'memory'), new Embedder({ mode: 'off' }));
  let facts = 0;
  let entries = 0;
  // 常驻事实
  const factLines = (await projStore.loadFacts())
    .split('\n')
    .map((l) => l.replace(/^- /, '').trim())
    .filter(Boolean);
  for (const f of factLines) {
    if (!(await userStore.isDuplicate(f))) {
      await userStore.addFact(f);
      facts++;
    }
  }
  // 语义记忆
  for (const e of await projStore.list()) {
    if (!(await userStore.isDuplicate(e.content))) {
      await userStore.addEntry(e.content, e.tags);
      entries++;
    }
  }
  return { title: meta.title, facts, entries };
}

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // ── 浏览器遥测接收端点（供「外部浏览器页面」经 token 上报）──
  // 与 WS 通道互补：GUI 自身经 WS 上报；用户正在调试的网页可注入一段脚本 POST 到这里。
  if (req.method === 'POST' && urlPath === '/api/telemetry') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw) as { token?: string; events?: BrowserTelemetryEvent[] };
      const hub = body.token ? telemetryHubs.get(body.token) : undefined;
      const evs = Array.isArray(body.events) ? body.events : [];
      if (hub && evs.length) {
        const norm = evs.map((e) => ({ ...e, timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now() }));
        hub.pushMany(norm);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, received: hub ? evs.length : 0, registered: Boolean(hub) }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid body' }));
    }
    return;
  }

  // ── 模型模式端点（手动切换 Flash/PRO 主推理模型）──
  if (urlPath === '/api/model-mode') {
    if (req.method === 'GET') {
      const mode = getMode();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode, label: modeLabel(mode) }));
      return;
    }
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try {
        const body = JSON.parse(raw) as { mode?: string };
        const m = parseMode(body.mode ?? '');
        if (!m) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'mode 必须是 flash 或 pro' }));
          return;
        }
        setMode(process.cwd(), m);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: m, label: modeLabel(m) }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid body' }));
      }
      return;
    }
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = join(DIST, urlPath);
  // 防目录穿越：用 relative 做跨平台比较（Windows 反斜杠不能直接与 '/' 比较）
  const rel = relative(DIST, filePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    // 缓存策略：
    //  - HTML 入口必须 no-cache，否则浏览器缓存旧 index.html → 指向已删除的旧 hash 资源导致 404。
    //  - assets 下的 JS/CSS 文件名自带内容 hash，可长期强缓存（immutable）。
    const cacheControl =
      ext === '.html'
        ? 'no-cache'
        : rel.startsWith('assets')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end('Server error');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // ✅ 安全：验证 Origin 头，仅允许本地连接，防止跨站 WebSocket 劫持
  const origin = req.headers.origin ?? '';
  if (origin && !origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:')) {
    ws.close(4001, 'Forbidden origin');
    return;
  }

  const fwd = (type: string, payload: Record<string, unknown> = {}): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...payload }));
  };

  const hosts = new Map<string, AgentHost>(); // 每任务独立 host 实例，切任务不销毁
  connectionHostMaps.add(hosts); // 注册到全局集合，供进程级优雅关闭时 flush
  /** 获取主机：taskId 显式指定则查路由表；否则取当前活跃主机 */
  function getHost(taskId?: string): AgentHost | undefined {
    return taskId ? hosts.get(taskId) : (activeTaskId ? hosts.get(activeTaskId) : undefined);
  }
  let username: string | null = null;
  let activeToken: string | null = null;
  let authed = false;
  let taskStore: TaskStore | null = null;
  let conversationStore: ConversationStore | null = null;
  let activeTaskId: string | null = null;
  /** 内核是否正忙（由 host 的 state 事件同步），避免上传时与正在进行的生成交错 */
  let busy = false;
  let serverMsgId = 1000000; // 服务端直接推送的系统消息 ID 池（与 host 的 0-based id 不冲突）
  let guiSettings: GuiSettings = {}; // 当前连接的 GUI 设置（workspaceRoot 等），登录后加载
  /** 每连接唯一 id：用作文火限速键，避免多个连接共享同一限速桶（原 auth_${ws.readyState} 恒为 auth_1，导致限速全局共享、可被多连接绕过） */
  const connId = randomUUID();

  /** 服务端直接往中间对话区推一条系统提示（不依赖内核）。 */
  function pushSystem(text: string): void {
    fwd('message', { id: serverMsgId++, role: 'system', text });
  }

  /**
   * 权威清空当前对话区（不依赖 host 是否装配）。   * 切换/新建/复制任务时先调用它，保证对话页面只显示目标任务的记录：
   * - 目标任务有历史 → 随后 host.setMessages() 会再发一次 reset 覆盖为历史；
   * - 目标任务为空 / 未配 Key → 保持清空后再追加欢迎语或提示，不残留旧任务消息。
   */


  /**
   * 用当前「项目目录」作为 agent 工作区构造 AgentHost（覆盖默认 process.cwd()，避免改到工具源码）。
   * 未配置项目目录时，落到【每任务沙盒目录】(task dataDir) —— 隔离、非工具源码、非用户真实文件，
   * 既保证工具可用，又不泄露 agent 内部实现，也不动用户的其它项目。
   */
  function makeHost(props: AppProps): AgentHost {
    const h = new AgentHost(props);
    const root = fileRoot(guiSettings);
    h.cwd = root ?? (taskStore && activeTaskId ? taskStore.dir(activeTaskId) : os.tmpdir());
    // 每连接一个遥测集线器，供浏览器报错回灌进调试循环
    h.telemetryHub = new BrowserTelemetryHub();
    return h;
  }

  /**
   * 强制刷新指定 host 的 trace 缓冲到磁盘（切任务前防止丢失在途事件）。
   * 不再 abort host——每任务独立实例，切走不销毁。
   */
  async function flushHostTrace(taskId: string): Promise<void> {
    const h = hosts.get(taskId);
    if (!h || !h.props.traceLogger) return;
    await h.props.traceLogger.flush();
    await new Promise((r) => setTimeout(r, 30));
    await h.props.traceLogger.flush();
  }

  /** 清理所有 host（登出 / 重连 / 连接关闭时）：先 flush 在途 trace 再销毁，
   *  防止进程退出 / 浏览器刷新时缓冲未落盘，导致重启后思考盒等渲染状态丢失。 */
  async function cleanupHosts(): Promise<void> {
    for (const h of hosts.values()) {
      try {
        await h.props.traceLogger?.flush();
      } catch {
        /* 忽略写入失败，不阻塞清理 */
      }
      h.abort();
    }
    hosts.clear();
  }

  /**
   * 装配并启动某任务的内核：清空对话区 → 校验 Key/隔离 → 装配内核（工作区=当前工作空间）
   * → 有历史则 replay，否则欢迎语。供 switch_task 与 set_settings（工作空间变更后即时生效）复用。
   */
  async function bootTask(id: string): Promise<void> {
    if (!taskStore || !username) return;
    const meta = await taskStore.get(id);
    if (!meta) return;
    activeTaskId = id;
    if (hosts.has(id)) await flushHostTrace(id);
    await sendTaskList();
    const replayed = await conversationStore!.load(id);
    // 原子发送完整历史（task_history）
    const historyMsgs: UiMessage[] = [];
    let hid = 0;
    for (const m of (replayed?.messages ?? [])) {
      if (m.role === 'system') continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = typeof m.content === 'string' ? m.content : '';
      if (text || m.role === 'assistant') {
        historyMsgs.push({ id: hid++, role: m.role as MsgRole, text, ts: m.ts, thinkingId: m.thinkingId });
      }
    }
    fwd('task_history', { taskId: id, messages: historyMsgs, thinkings: replayed?.thinking ?? [] });
    const creds = await loadUserCredentials(username);
    if (!creds) {
      pushSystem(`已切换到「${meta.title}」。你尚未配置 DeepSeek API Key，点击顶栏 ⚙ API 配置后即可继续对话。`);
      return;
    }
    const v = await DeepSeekClient.validate({ apiKey: creds.apiKey, baseURL: creds.baseURL });
    if (!v.ok) {
      pushSystem(`已切换到「${meta.title}」，但当前 API Key 无效：${v.error}。请打开 ⚙ API 重新配置。`);
      return;
    }
    if (!isTaskIsolated(taskStore.dir(id), username)) {
      fwd('task_error', { message: '任务隔离校验失败' });
      return;
    }
    // 已有 host → 复用（msgId 保持连续，不创建新实例）
    if (hosts.has(id)) {
      hosts.get(id)!.push('system', `已切换回「${meta.title}」，共 ${replayed?.messages.filter(m => m.role !== 'system').length ?? 0} 条历史消息`);
      return;
    }
    const props = await ensureKernel(username, taskStore.dir(id), creds, fileRoot(guiSettings));
    const newHost = makeHost(props);
    hosts.set(id, newHost);
    if (activeToken && newHost.telemetryHub) telemetryHubs.set(activeToken, newHost.telemetryHub);
    wireHost(newHost, id);
    if (replayed && replayed.messages.length > 0) {
      props.history.loadMessages(replayed.messages as never);
      props.client.resetUsage();
      newHost.setMessagesSilent(replayedToUiSimple(replayed.messages));
      newHost.push('system', `已切换到「${meta.title}」，共 ${replayed.messages.filter(m => m.role !== 'system').length} 条历史消息`);
    } else {
      newHost.welcome();
    }
  }

  /**
   * 构造用户级 / 项目级两个记忆库，供 Web 记忆管理使用。
   * 与 API Key 解耦——记忆管理登录即可用，不依赖内核是否装配。
   * 用离线模式 Embedder（mode='off'）避免触碰模型下载，仅做文件读删。
   */
  /**
   * 解析某作用域的「真实记忆后端」（M6 · 修复 L3 GUI 脱节实例）。
   * - sharedGuiBackend=true 且内核已装配：复用 agent-host 的同一 MemoryService 实例的
   *   user/project 后端，使 GUI 记忆 UI 与 agent 共享同一实例（写入即时互通、带真实嵌入）。
   * - 否则（默认）：构建离线模式 Embedder 的独立 MemoryStore，与旧路径逐字节一致。
   * - project 作用域仅当 taskDir 与当前活跃任务目录一致（或省略=当前活跃）时才复用实例，
   *   避免把非活跃任务的记忆错配到活跃任务后端。
   */
  function backendAt(scope: 'user' | 'project', taskDir?: string): MemoryBackend | null {
    const cfg = loadMemoryConfig();
    const h = getHost();
    if (cfg.sharedGuiBackend && h?.props.memoryStore) {
      if (scope === 'user') return h.props.memoryStore.user;
      const activeDir = taskStore && activeTaskId ? taskStore.dir(activeTaskId) : undefined;
      if (taskDir === undefined || taskDir === activeDir) return h.props.memoryStore.project;
    }
    // 回退：离线模式独立实例（旧行为，逐字节一致）
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
    if (scope === 'user') {
      return createMemoryBackend(join(home, '.dsa', 'memory'), new Embedder({ mode: 'off' }));
    }
    if (!taskDir) return null;
    return createMemoryBackend(join(taskDir, '.dsa', 'memory'), new Embedder({ mode: 'off' }));
  }

  function makeStores(): { user: MemoryBackend; project: MemoryBackend | null } {
    return { user: backendAt('user')!, project: backendAt('project') };
  }

  /** 按作用域返回对应 MemoryBackend；未知作用域 / 任务级无活动任务返回 null。 */
  function pickStore(scope: string): MemoryBackend | null {
    if (scope === 'user') return backendAt('user');
    if (scope === 'project') return backendAt('project');
    return null;
  }

  /** 记忆导出包：把单作用域的常驻事实 + 语义记忆打包为可携带 JSON。 */
  interface MemoryExportBundle {
    kind: 'dsa-memory-export';
    version: number;
    scope: 'user' | 'project';
    exportedAt: string;
    facts: string;
    entries: Array<{ content: string; tags?: string[] }>;
  }

  /** 构造导出包：读 MEMORY.md 原文 + memories.json 语义记忆（不含回收站，回收站为临时态不导出）。 */
  async function buildExportBundle(store: MemoryBackend, scope: 'user' | 'project'): Promise<MemoryExportBundle> {
    return {
      kind: 'dsa-memory-export',
      version: 1,
      scope,
      exportedAt: new Date().toISOString(),
      facts: await store.loadFacts(),
      entries: (await store.list()).map((e) => ({ content: e.content, tags: e.tags })),
    };
  }

  /** 应用导入包：把事实逐行、语义记忆逐条写入目标作用域；已存在（isDuplicate）的跳过，非破坏性。 */
  async function applyImportBundle(
    store: MemoryBackend,
    bundle: MemoryExportBundle,
  ): Promise<{ factsAdded: number; entriesAdded: number; skipped: number }> {
    let factsAdded = 0;
    let entriesAdded = 0;
    let skipped = 0;
    // 导入采用精确归一化去重：仅当与已有事实/记忆逐字相同时跳过，
    // 避免 isDuplicate 的模糊匹配把用户刻意新增的近相似项静默丢弃。
    const norm = (s: string): string => s.replace(/^- /, '').trim();
    const existingFacts = new Set((await store.loadFacts()).split('\n').map(norm).filter(Boolean));
    const existingEntries = new Set((await store.list()).map((e) => norm(e.content)));
    const factLines = (bundle.facts ?? '')
      .split('\n')
      .map(norm)
      .filter(Boolean);
    for (const f of factLines) {
      if (existingFacts.has(f)) {
        skipped++;
        continue;
      }
      await store.addFact(f);
      existingFacts.add(f);
      factsAdded++;
    }
    for (const e of bundle.entries ?? []) {
      const content = norm(e?.content ?? '');
      if (!content) {
        skipped++;
        continue;
      }
      if (existingEntries.has(content)) {
        skipped++;
        continue;
      }
      await store.addEntry(content, e?.tags);
      existingEntries.add(content);
      entriesAdded++;
    }
    return { factsAdded, entriesAdded, skipped };
  }

  /** 读取两层记忆清单并向前端推送（MEMORY.md 事实 + memories.json 语义记忆）。 */
  async function sendMemoryList(): Promise<void> {
    const { user, project } = makeStores();
    const normFacts = (s: string): string[] =>
      s
        .split('\n')
        .map((l) => l.replace(/^- /, '').trim())
        .filter(Boolean);
    fwd('memory_list', {
      data: {
        user: { facts: normFacts(await user.loadFacts()), entries: await user.list() },
        project: project
          ? { facts: normFacts(await project.loadFacts()), entries: await project.list() }
          : { facts: [], entries: [] },
      },
    });
  }

  /** 读取两层回收站并推送前端（软删除的记忆，可恢复）。 */
  async function sendTrashList(): Promise<void> {
    const { user, project } = makeStores();
    fwd('trash_list', {
      data: {
        user: await user.listTrash(),
        project: project ? await project.listTrash() : [],
      },
    });
  }

  /** 把 AgentHost 的内核事件桥接到本连接的 WebSocket。 */
  function wireHost(h: AgentHost, taskId: string): void {
    // 每个事件都打上闭包捕获的 taskId（切换瞬间不会错），前端据此过滤在途事件，
    // 防止「切到 B 后 A 的遗留流式事件」污染 B（修复点⑤：单连接多路复用下的串任务）。
    const tag = (p: Record<string, unknown>) => ({ ...p, taskId });
    h.on('message', (m) => fwd('message', tag(m as Record<string, unknown>)));
    h.on('update', (u) => fwd('update', tag(u as Record<string, unknown>)));
    h.on('state', (s) => {
      busy = Boolean((s as Record<string, unknown>).busy);
      fwd('state', tag(s as Record<string, unknown>));
    });
    h.on('confirm', (prompt: string) => fwd('confirm', { prompt, taskId }));
    h.on('asktext', (prompt: string) => fwd('asktext', { prompt, taskId }));
    h.on('exit', () => fwd('exit', { taskId }));
    h.on('reset', (ms: UiMessage[]) => fwd('reset', { messages: ms, taskId }));
    h.on('keychange', () => fwd('need_key', { reason: 'change', taskId }));
    h.on('artifact', (a) => fwd('artifact', tag(a as Record<string, unknown>)));
    h.on('artifact_update', (a) => fwd('artifact_update', tag(a as Record<string, unknown>)));
    // 思考盒通道：把 agent 本轮的观察（推理/工具/结果）与状态转发给前端
    h.on('thinking_start', (p) => fwd('thinking_start', tag(p as Record<string, unknown>)));
    h.on('thinking_entry', (p) => fwd('thinking_entry', tag(p as Record<string, unknown>)));
    h.on('thinking_update', (p) => fwd('thinking_update', tag(p as Record<string, unknown>)));
    h.on('thinking_status', (p) => fwd('thinking_status', tag(p as Record<string, unknown>)));
    h.on('gen_interrupted', (p) => fwd('gen_interrupted', tag(p as Record<string, unknown>)));
    h.on('thinking_end', (p) => fwd('thinking_end', tag(p as Record<string, unknown>)));
  }

  /** 把当前 host 的技能列表（名称+描述+作用域）推给前端（用于底部上拉菜单）。
   *  即便没有 host（用户没配 API Key）也能工作——用当前 cwd + 临时 SkillManager 读盘。 */
  async function sendSkillsList(): Promise<void> {
    let metas: Array<{ name: string; description: string; scope: 'project' | 'global' }>;
    let info: { includeGlobal: boolean; allow: string[] | null; source: 'constructor' | 'env' | 'config' | 'all' | 'off' };
    let description: string;
    const h = getHost();
    if (h) {
      const mgr = h.props.skillManager;
      metas = mgr.listMeta();
      info = mgr.getFilterInfo();
      description = mgr.filterDescription();
    } else {
      // 无 host（用户未配 Key）：用 cwd 临时建一个 SkillManager 读项目级 + 全局目录
      const cwd = guiSettings?.workspaceRoot ?? process.cwd();
      const mgr = new SkillManager(cwd);
      await mgr.init(); // 扫描是异步的，必须等
      metas = mgr.listMeta();
      info = mgr.getFilterInfo();
      description = mgr.filterDescription();
    }
    fwd('skills_list', {
      metas,
      filter: {
        includeGlobal: info.includeGlobal,
        allow: info.allow,
        source: info.source,
        description,
      },
    });
  }

  /** 登录/恢复后的启动：任务列表始终可用；API Key 只影响内核是否装配。
   *  若未配置 Key，只在对话区给出提醒，不阻塞界面。 */
  async function bootWithUser(u: string, threadId?: string): Promise<void> {
    // 先初始化任务存储（即使没配 Key，也应展示任务列表）
    taskStore = new TaskStore(userDataDir(u));
    conversationStore = new JsonlConversationStore(taskStore);
    // 激活任务优先级：指定 threadId（刷新前持久化的上次激活任务）→ default → 第一个现存任务 → 兜底强制重建 default。
    // 这样刷新后能回到用户上次正在看的对话（含思考盒），而非落到空默认任务。
    // threadId 须经 taskStore.get 校验归属当前用户，避免客户端伪造他人任务 id。
    activeTaskId =
      (threadId && (await taskStore.get(threadId)) ? threadId : undefined) ??
      (await taskStore.ensureDefault()) ??
      (await taskStore.firstExisting()) ??
      (await taskStore.ensureDefault(true));
    await sendTaskList();

    const activeId = activeTaskId;
    if (!activeId) return;

    // ① 历史回放（展示层，与 API Key 解耦）：无论是否配 Key，都把「消息 + 思考盒」推给前端。
    //    无 Key / Key 失效时刷新，历史记录（含思考盒）仍完整显示，仅不能真正发起对话。
    const replayed = await conversationStore!.load(activeId);
    if (replayed && replayed.messages.length > 0) {
      const hMsgs: UiMessage[] = [];
      let hid = 0;
      for (const m of replayed.messages) {
        if (m.role === 'system') continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const text = typeof m.content === 'string' ? m.content : '';
        if (text || m.role === 'assistant') {
          hMsgs.push({ id: hid++, role: m.role as MsgRole, text, ts: m.ts, thinkingId: m.thinkingId });
        }
      }
      fwd('task_history', { taskId: activeId, messages: hMsgs, thinkings: replayed.thinking });
      const activeMeta = await taskStore.get(activeId);
      pushSystem(`已恢复「${activeMeta?.title ?? '默认任务'}」的 ${replayed.messages.filter((m) => m.role !== 'system').length} 条历史消息，可继续对话`);
    }

    // ② API Key 校验：仅决定内核是否装配（能否真正对话），不再阻断上面的历史展示。
    const creds = await loadUserCredentials(u);
    if (!creds) {
      pushSystem('你尚未配置 DeepSeek API Key。点击顶栏 ⚙ API 进行配置后，即可开始对话。');
      return;
    }
    const v = await DeepSeekClient.validate({ apiKey: creds.apiKey, baseURL: creds.baseURL });
    if (!v.ok) {
      pushSystem(`当前保存的 API Key 无效：${v.error}。请打开顶栏 ⚙ API 重新配置。`);
      return;
    }

    try {
      const props = await ensureKernel(u, taskStore.dir(activeId), creds, fileRoot(guiSettings));
      const resumeHost = makeHost(props);
      hosts.set(activeId, resumeHost);
      wireHost(resumeHost, activeId);
      // 内核装配后把历史灌入
      if (replayed && replayed.messages.length > 0) {
        props.history.loadMessages(replayed.messages as never);
        props.client.resetUsage();
        resumeHost.setMessagesSilent(replayedToUiSimple(replayed.messages));
      } else {
        resumeHost.welcome();
      }
      // 内核就绪后立刻把技能清单推给前端（用于底部上拉菜单）
      void sendSkillsList();
    } catch (e) {
      pushSystem(`启动内核失败：${e instanceof Error ? e.message : String(e)}。请检查 ⚙ API 设置。`);
    }
  }

  /** 向前端推送当前任务列表（含状态与目标，供任务区渲染） */
  async function sendTaskList(): Promise<void> {
    if (!taskStore) return;
    const tasks = await taskStore.list();
    fwd('task_list', {
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        active: t.id === activeTaskId,
        status: t.status,
        goal: t.goal,
        updatedAt: t.updatedAt,
      })),
    });
  }

  /** ✅ 安全：登录/注册速率限制 — 每个连接每分钟最多 5 次尝试，防止暴力破解。 */
  const rateLimit = new Map<string, { count: number; resetAt: number }>();
  function checkRateLimit(clientKey: string): boolean {
    const now = Date.now();
    const entry = rateLimit.get(clientKey);
    if (!entry || now > entry.resetAt) {
      rateLimit.set(clientKey, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= 5) return false;
    entry.count++;
    return true;
  }

  /** 处理首个消息：登录 / 注册 / 恢复任务。 */
  async function handleAuth(msg: Record<string, unknown>): Promise<void> {
    // ✅ 安全：速率限制 — 登录/注册 1 分钟最多 5 次尝试
    const clientKey = connId;
    if ((msg.type === 'login' || msg.type === 'register') && !checkRateLimit(clientKey)) {
      fwd('auth_error', { message: '登录尝试过于频繁，请 1 分钟后再试' });
      return;
    }

    if (msg.type === 'login') {
      const ok = await verifyAccount(String(msg.username ?? ''), String(msg.password ?? ''));
      if (!ok) {
        // ✅ 安全：登录失败加延迟 800ms，减慢暴力破解速度
        await new Promise((r) => setTimeout(r, 800));
        fwd('auth_error', { message: '用户名或密码错误' });
        return;
      }
      username = String(msg.username);
    } else if (msg.type === 'register') {
      const r = await registerAccount(String(msg.username ?? ''), String(msg.password ?? ''));
      if (!r.ok) {
        fwd('auth_error', { message: r.error ?? '注册失败' });
        return;
      }
      username = String(msg.username);
    } else if (msg.type === 'resume') {
      // token 免密自动登录（与 /resume 命令无关，这是认证机制）
      const u = await verifyToken(String(msg.token ?? ''));
      if (!u) {
        fwd('auth_error', { message: '登录已过期，请重新登录' });
        return;
      }
      username = u;
    } else {
      fwd('auth_error', { message: '请先登录' });
      return;
    }
    authed = true;
    const token = await issueToken(username!);
    activeToken = token; // 供 /api/telemetry（外部浏览器）按 token 找到本连接集线器
    guiSettings = await loadGuiSettings(username); // 加载本项目目录等 GUI 设置
    fwd('auth_ok', { token, username: username });
    void bootWithUser(username!, msg.threadId ? String(msg.threadId) : undefined);
  }

  ws.on('message', async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // 忽略畸形消息
    }
    const type = String(msg.type ?? '');

    // 未登录：首个消息必须是 auth 类
    if (!authed) {
      if (type === 'login' || type === 'register' || type === 'resume') {
        await handleAuth(msg);
      } else {
        fwd('auth_error', { message: '请先登录' });
      }
      return;
    }

    // 登出：吊销 token，断开本连接的内核
    if (type === 'logout') {
      if (msg.token) await revokeToken(String(msg.token)).catch(() => {});
      authed = false;
      username = null;
      await cleanupHosts();
      taskStore = null;
      activeTaskId = null;
      return;
    }

    // 设置/更换 API Key（登录后随时可发）
    if (type === 'setkey') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const nc: Credentials = {
        apiKey: String(msg.apiKey ?? '').trim(),
        baseURL: (msg.baseURL ? String(msg.baseURL).trim() : undefined) || undefined,
        model: (msg.model ? String(msg.model).trim() : undefined) || undefined,
        reasonerModel: (msg.reasonerModel ? String(msg.reasonerModel).trim() : undefined) || undefined,
      };
      const v = await DeepSeekClient.validate({ apiKey: nc.apiKey, baseURL: nc.baseURL });
      if (!v.ok) {
        fwd('key_error', { error: v.error });
        return;
      }
      await saveUserCredentials(username, nc).catch(() => {});
      resetKernelsForUser(username);
      await cleanupHosts();
      fwd('key_ok');
      void bootWithUser(username);
      return;
    }

    // ── 任务（线程）管理 ──
    if (type === 'list_tasks') {
      await sendTaskList();
      return;
    }

    // ── 技能清单（前端底部上拉菜单按需刷新） ──
    if (type === 'get_skills') {
      void sendSkillsList();
      return;
    }

    if (type === 'new_task') {
      if (!taskStore || !username) return;
      const title = String(msg.title ?? '新任务').slice(0, 80) || '新任务';
      const goal = String(msg.goal ?? '').slice(0, 200);
      const id = await taskStore.create(title, goal);
      activeTaskId = id;
      await flushHostTrace(id);
      await sendTaskList();
      fwd('task_history', { taskId: id, messages: [], thinkings: [] }); // 新任务：空对话区
      // 若已配 Key 则装配内核开始对话；否则只在对话区提醒
      const creds = await loadUserCredentials(username);
      if (!creds) {
        pushSystem('新任务已创建。你尚未配置 DeepSeek API Key，点击顶栏 ⚙ API 配置后即可对话。');
        return;
      }
      const v = await DeepSeekClient.validate({ apiKey: creds.apiKey, baseURL: creds.baseURL });
      if (!v.ok) {
        pushSystem(`新任务已创建，但当前 API Key 无效：${v.error}。请打开 ⚙ API 重新配置。`);
        return;
      }
      if (!isTaskIsolated(taskStore.dir(id), username)) {
        fwd('task_error', { message: '任务隔离校验失败' });
        return;
      }
      const props = await ensureKernel(username, taskStore.dir(id), creds, fileRoot(guiSettings));
      const ntHost = makeHost(props);
      hosts.set(id, ntHost);
      wireHost(ntHost, id);
      ntHost.welcome();
      return;
    }

    /** 复制任务：复制目标/状态，但新任务从空白上下文开始（保持隔离）。复制后自动切换到新任务。 */
    if (type === 'duplicate_task') {
      if (!taskStore || !username) return;
      const srcId = String(msg.id ?? '');
      const newId = await taskStore.duplicate(srcId);
      if (!newId) {
        fwd('task_error', { message: '复制失败：源任务不存在' });
        return;
      }
      activeTaskId = newId;
      await flushHostTrace(newId);
      await sendTaskList();
      fwd('task_history', { taskId: newId, messages: [], thinkings: [] }); // 复制新任务：空白上下文
      const creds = await loadUserCredentials(username);
      if (!creds) {
        pushSystem('已复制任务（独立上下文）。你尚未配置 DeepSeek API Key，配置后即可对话。');
        return;
      }
      const v = await DeepSeekClient.validate({ apiKey: creds.apiKey, baseURL: creds.baseURL });
      if (!v.ok) {
        pushSystem(`已复制任务，但当前 API Key 无效：${v.error}。请打开 ⚙ API 重新配置。`);
        return;
      }
      if (!isTaskIsolated(taskStore.dir(newId), username)) {
        fwd('task_error', { message: '任务隔离校验失败' });
        return;
      }
      const props = await ensureKernel(username, taskStore.dir(newId), creds, fileRoot(guiSettings));
      const dupHost = makeHost(props);
      hosts.set(newId, dupHost);
      wireHost(dupHost, newId);
      dupHost.welcome();
      return;
    }

    /** 拖拽重排：按前端传回的完整 id 顺序写回各任务的 order 权重 */
    if (type === 'reorder_tasks') {
      if (!taskStore) return;
      const ids = Array.isArray(msg.ids) ? (msg.ids as unknown[]).map((x) => String(x)) : [];
      if (ids.length > 0) {
        await taskStore.reorder(ids);
        await sendTaskList();
      }
      return;
    }

    // ── 润色输入框文本：不经过 agent loop，直接调 LLM 格式化 ──
    if (type === 'polish_input') {
      const text = String(msg.text ?? '').trim();
      if (!text) { fwd('polish_result', { text: '' }); return; }
      const creds = username ? await loadUserCredentials(username) : null;
      if (!creds) { fwd('polish_result', { text: '' }); return; }
      try {
        const client = new DeepSeekClient({
          apiKey: creds.apiKey,
          baseURL: creds.baseURL ?? 'https://api.deepseek.com',
          model: creds.model ?? 'deepseek-v4-flash',
          reasonerModel: creds.reasonerModel,
        });
        let out = '';
        for await (const ev of client.streamChat(
          [
            { role: 'system', content: POLISH_SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          [],
          { timeoutMs: 60_000 },
        )) {
          if (ev.type === 'content' && ev.text) out += ev.text;
          else if (ev.type === 'error') {
            fwd('polish_result', { text: '' });
            return;
          }
        }
        const polished = out.trim();
        fwd('polish_result', { text: polished || '' });
      } catch {
        fwd('polish_result', { text: '' });
      }
      return;
    }

    if (type === 'switch_task') {
      if (!taskStore || !username) return;
      const id = String(msg.id ?? '');
      await bootTask(id);
      return;
    }

    if (type === 'update_task') {
      if (!taskStore) return;
      const id = String(msg.id ?? '');
      const patch: Partial<import('./thread-store.ts').TaskMeta> = {};
      if (typeof msg.status === 'string') {
        patch.status = msg.status as import('./thread-store.ts').TaskStatus;
      }
      if (typeof msg.goal === 'string') patch.goal = msg.goal.slice(0, 200);
      if (Object.keys(patch).length === 0) return;
      await taskStore.update(id, patch);
      await sendTaskList();
      return;
    }

    if (type === 'delete_task') {
      if (!taskStore || !username) return;
      const id = String(msg.id ?? '');
      if (!(await taskStore.get(id))) return; // 任务不存在，忽略
      // 清掉该任务的内核缓存（键含数据目录，按前缀删除所有变体），避免历史在内存残留串味
      const prefix = `${username}::${taskStore.dir(id)}::`;
      for (const k of kernels.keys()) if (k.startsWith(prefix)) kernels.delete(k);
      // 递归删除任务目录：对话/记忆/历史/会话文件随目录一并清除（每个任务上下文严格独立）
      await taskStore.remove(id);
      if (id === activeTaskId) {
        // 删除的是当前正在使用的任务：自动切换到剩余任务的第一个（无则建默认任务），
        // 保证界面始终有可用任务，且新任务的上下文与前任务完全隔离。
        const remaining = (await taskStore.list()).filter((t) => t.id !== id);
        const nextId =
          remaining[0]?.id ?? (await taskStore.ensureDefault()) ?? (await taskStore.ensureDefault(true));
        await bootTask(nextId); // 内部重建内核 + replay 历史 + 广播 task_list（标记新激活任务）
      } else {
        await sendTaskList();
      }
      return;
    }

    // ── 记忆管理（与 API Key 解耦，登录即可用）──
    if (type === 'list_memories') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      await sendMemoryList();
      return;
    }

    if (type === 'delete_memory') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const store = pickStore(String(msg.scope));
      if (!store) {
        fwd('memory_error', { message: '任务级记忆不可用（当前没有活动任务）' });
        return;
      }
      const ok = await store.forget(String(msg.id ?? ''));
      if (!ok) fwd('memory_error', { message: '未找到该记忆条目' });
      else {
        await sendMemoryList();
        await sendTrashList();
      }
      return;
    }

    if (type === 'clear_memories') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const store = pickStore(String(msg.scope));
      if (!store) {
        fwd('memory_error', { message: '任务级记忆不可用（当前没有活动任务）' });
        return;
      }
      await store.clear();
      await sendMemoryList();
      await sendTrashList();
      return;
    }

    if (type === 'delete_fact') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const store = pickStore(String(msg.scope));
      if (!store) {
        fwd('memory_error', { message: '任务级记忆不可用（当前没有活动任务）' });
        return;
      }
      const ok = await store.forgetFact(String(msg.content ?? ''));
      if (!ok) fwd('memory_error', { message: '未找到该事实' });
      else {
        await sendMemoryList();
        await sendTrashList();
      }
      return;
    }

    // ── 记忆导入 / 导出（数据可携带，与 API Key 解耦，登录即可用）──
    if (type === 'export_memory') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const scope = String(msg.scope ?? '');
      if (scope !== 'user' && scope !== 'project') {
        fwd('memory_error', { message: '未知作用域' });
        return;
      }
      const store = pickStore(scope);
      if (!store) {
        fwd('memory_error', { message: '任务级记忆不可用（当前没有活动任务）' });
        return;
      }
      const bundle = await buildExportBundle(store, scope as 'user' | 'project');
      fwd('memory_export', { scope, bundle });
      return;
    }

    if (type === 'import_memory') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const scope = String(msg.scope ?? '');
      if (scope !== 'user' && scope !== 'project') {
        fwd('memory_error', { message: '未知作用域' });
        return;
      }
      const store = pickStore(scope);
      if (!store) {
        fwd('memory_error', { message: '任务级记忆不可用（当前没有活动任务）' });
        return;
      }
      const raw = msg.bundle;
      if (
        !raw ||
        typeof raw !== 'object' ||
        (raw as Record<string, unknown>).kind !== 'dsa-memory-export'
      ) {
        fwd('memory_error', { message: '不是有效的记忆导出文件' });
        return;
      }
      try {
        const r = await applyImportBundle(store, raw as MemoryExportBundle);
        fwd('memory_imported', {
          scope,
          factsAdded: r.factsAdded,
          entriesAdded: r.entriesAdded,
          skipped: r.skipped,
        });
        await sendMemoryList();
        await sendTrashList();
      } catch (e) {
        fwd('memory_error', { message: e instanceof Error ? e.message : '导入失败' });
      }
      return;
    }

    // ── 回收站（软删除 / 恢复） ──
    if (type === 'list_trash') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      sendTrashList();
      return;
    }

    if (type === 'restore_memory') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const store = pickStore(String(msg.scope));
      if (!store) {
        fwd('memory_error', { message: '任务级记忆不可用（当前没有活动任务）' });
        return;
      }
      const ok = await store.restore(String(msg.trashId ?? ''));
      if (!ok) fwd('memory_error', { message: '未找到该回收项（可能已恢复或超期清理）' });
      else {
        await sendMemoryList();
        await sendTrashList();
      }
      return;
    }

    if (type === 'purge_trash') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const { user, project } = makeStores();
      const scope = String(msg.scope ?? '');
      if (scope === 'user') await user.purgeTrash();
      else if (scope === 'project') await project?.purgeTrash();
      else {
        await user.purgeTrash();
        await project?.purgeTrash();
      }
      await sendTrashList();
      return;
    }

    // 任务记忆沉淀：把某任务的记忆提升到用户级长期记忆（跨任务共享）。
    if (type === 'promote_task_memory') {
      if (!username || !taskStore) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const taskId = String(msg.taskId ?? '');
      try {
        // sharedGuiBackend：注入 agent 同一实例的后端，使沉淀走真实嵌入；非活跃任务不复用（防错配）。
        const svc = getHost(taskId)?.props.memoryStore;
        const shared = svc && loadMemoryConfig().sharedGuiBackend;
        const userBackend = shared ? svc.user : undefined;
        const projBackend =
          shared && taskId === activeTaskId ? svc.project : undefined;
        const r = await promoteTaskMemories(taskStore, taskId, username, userBackend, projBackend);
        fwd('memory_promoted', { taskId, title: r.title, facts: r.facts, entries: r.entries });
        // 刷新记忆清单（用户级新增了沉淀项）与回收站（保持同步）
        sendMemoryList();
        sendTrashList();
      } catch (e) {
        fwd('memory_error', { message: e instanceof Error ? e.message : '记忆沉淀失败' });
      }
      return;
    }

    // 整理记忆（Dreaming 式陈旧性治理）—— 两步式：先预览方案、用户确认后再应用。
    // 需要内核（含 API Key）才能调用模型。
    if (type === 'revise_preview') {
      const revHost = getHost();
      if (!revHost) {
        fwd('revise_proposal', {
          proposal: { actions: [], summary: '', skipped: true, reason: '整理记忆需要 API Key，请先在设置中配置' },
        });
        return;
      }
      const proposal = await revHost.proposeRevise();
      fwd('revise_proposal', { proposal });
      return;
    }

    if (type === 'revise_apply') {
      const revHost = getHost();
      if (!revHost) {
        fwd('revise_result', {
          deleted: 0,
          merged: 0,
          summary: '',
          skipped: true,
          reason: '整理记忆需要 API Key，请先在设置中配置',
        });
        return;
      }
      const r = await revHost.applyRevise();
      fwd('revise_result', {
        deleted: r.deleted,
        merged: r.merged,
        summary: r.summary,
        skipped: r.skipped,
        reason: r.reason ?? '',
      });
      // 应用后刷新记忆清单与回收站（删除的条目进回收站，可撤销）
      sendMemoryList();
      sendTrashList();
      return;
    }

    // ── 文件资源浏览器（只读，限定在「项目目录」之内，登录可用）──
    if (type === 'file_tree' || type === 'file_read') {
      if (!username) {
        fwd('auth_error', { message: '请先登录' });
        return;
      }
      const root = fileRoot(guiSettings);
      // 未配置项目目录：绝不回退到工具源码（防泄露）。直接返回空 / 报错，由前端提示去设置。
      if (!root) {
        if (type === 'file_tree') {
          fwd('file_tree_result', { path: '', entries: [], unconfigured: true });
        } else {
          fwd('file_error', { message: '尚未配置项目目录，请在 ⚙ 设置 → 📁 项目目录 中指定' });
        }
        return;
      }
      if (type === 'file_tree') {
        const r = await handleFileTree(String(msg.path ?? ''), root);
        fwd('file_tree_result', r);
        return;
      }
      // file_read
      const abs = resolveInsideRoot(String(msg.path ?? ''), root);
      if (!abs) {
        fwd('file_error', { message: '非法或越界的文件路径' });
        return;
      }
      try {
        const s = await stat(abs);
        if (s.isDirectory()) {
          fwd('file_error', { message: '这是一个目录，无法预览内容' });
          return;
        }
        if (s.size > MAX_FILE_READ) {
          // ✅ 修复 OOM：只读取前 MAX_FILE_READ 字节，绝不把整个大文件读进内存再截断
          const fh = await open(abs, 'r');
          try {
            const tmp = Buffer.alloc(MAX_FILE_READ);
            const { bytesRead } = await fh.read(tmp, 0, MAX_FILE_READ, 0);
            const content = tmp.subarray(0, bytesRead).toString('utf8');
            fwd('file_read_result', {
              path: String(msg.path ?? ''),
              content,
              truncated: true,
              size: s.size,
            });
          } finally {
            await fh.close();
          }
          return;
        }
        const content = await readFile(abs, 'utf8');
        fwd('file_read_result', { path: String(msg.path ?? ''), content, truncated: false, size: s.size });
      } catch (e) {
        fwd('file_error', { message: e instanceof Error ? e.message : '读取文件失败' });
      }
      return;
    }

    // ── GUI 设置：工作空间（agent 编辑 & 右侧文件面板指向的代码项目）──
    if (type === 'get_settings') {
      fwd('settings', {
        workspaceRoot: guiSettings.workspaceRoot ?? null,
        effectiveRoot: fileRoot(guiSettings),
      });
      return;
    }
    if (type === 'set_settings') {
      const patch: GuiSettings = {};
      if ('workspaceRoot' in msg) {
        const v = msg.workspaceRoot;
        patch.workspaceRoot = v === null || v === '' ? undefined : String(v);
      }
      guiSettings = await saveGuiSettings(username!, patch);
      fwd('settings', {
        workspaceRoot: guiSettings.workspaceRoot ?? null,
        effectiveRoot: fileRoot(guiSettings),
      });
      // 工作空间变更后，若已启动任务则即时以新工作区重启内核，agent 立即指向新项目
      if (activeTaskId) await bootTask(activeTaskId);
      return;
    }

    // ── 目录浏览（供设置里「选择项目文件夹」用）：列子目录，可在本机任意位置导航 ──
    if (type === 'dir_browse') {
      const requested = String(msg.path ?? '');
      // 特殊 token：列出本机所有磁盘（「此电脑」根视图），让工作空间可选任意磁盘
      if (requested === DRIVES_TOKEN) {
        const drives = await listDrives();
        fwd('dir_list', { path: DRIVES_TOKEN, parent: null, entries: drives, isDrives: true });
        return;
      }
      // 未配置项目目录时，目录选择器从用户主目录开始导航（绝不回退到工具源码）。
      const start = requested && requested.trim() ? resolve(requested) : (fileRoot(guiSettings) ?? os.homedir());
      // ✅ 安全：拒绝浏览敏感系统目录，防止通过文件浏览器泄露系统信息
      const SENSITIVE_DIRS = ['/etc', '/sys', '/proc', '/dev', '/boot', '/root', '/var/log'];
      const isSensitive = SENSITIVE_DIRS.some((d) => start === d || start.startsWith(d + '/')) ||
        /^[A-Z]:\\(Windows|Program Files|Program Data|System Volume)/i.test(start);
      if (isSensitive) {
        fwd('dir_list', { path: start, parent: null, entries: [], error: '出于安全考虑，不允许浏览系统目录' });
        return;
      }
      let info;
      try {
        info = await stat(start);
      } catch {
        fwd('dir_list', { path: start, parent: null, entries: [], error: '目录不存在或无权限访问' });
        return;
      }
      if (!info.isDirectory()) {
        fwd('dir_list', { path: start, parent: null, entries: [], error: '这不是一个目录' });
        return;
      }
      let names: string[] = [];
      try {
        names = await readdir(start);
      } catch {
        fwd('dir_list', { path: start, parent: null, entries: [], error: '无法列出目录内容' });
        return;
      }
      const entries: { name: string; type: 'dir' | 'drive' }[] = [];
      for (const name of names) {
        try {
          const s = await stat(join(start, name));
          if (s.isDirectory()) entries.push({ name, type: 'dir' });
        } catch {
          /* 忽略 */
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      // 盘符根（如 C:\）的「上一级」指向磁盘列表，而非停在自己身上（Windows dirname 不变）。
      const isDriveRoot = /^([A-Za-z]:[\\/]?)$/.test(start) || start === '/';
      const parent = isDriveRoot ? DRIVES_TOKEN : dirname(start);
      fwd('dir_list', { path: start, parent, entries });
      return;
    }

    // ── 上传文档：独立于内核是否就绪，只要活动任务存在即可保存（host 为空时仅保存 + 提示）──
    if (type === 'upload') {
      if (!taskStore || !activeTaskId) {
        pushSystem('当前没有活动任务，无法上传文档。');
        return;
      }
      const name = String(msg.name ?? '').slice(0, 200);
      const mime = String(msg.mime ?? 'application/octet-stream');
      const data = String(msg.data ?? '');
      if (!name || !data) {
        pushSystem('上传失败：文件为空或缺少名称。');
        return;
      }
      // 安全文件名：仅保留 basename，去除路径分隔符，避免穿越
      const safeBase = (basename(name).replace(/[\\/]/g, '_').slice(0, 120)) || 'document';
      const uploadDir = join(taskStore.dir(activeTaskId), 'uploads');
      await mkdir(uploadDir, { recursive: true });
      const finalPath = await uniqueUploadPath(join(uploadDir, safeBase));
      await writeFile(finalPath, Buffer.from(data, 'base64'));
      const savedName = basename(finalPath);
      // 仅保存 + 回复 upload_ok，由前端暂存为「待发送附件」；
      // 不在这里 host.send 自动触发 agent，而是等用户发送下一条消息时随消息一并提交。
      pushSystem(`📎 已添加附件：${savedName}（将在你发送下一条消息时一并提交）`);
      fwd('upload_ok', { name: savedName, path: finalPath });
      return;
    }

    // 其余消息需内核就绪
    const curHost = getHost();
    if (!curHost || !taskStore || !activeTaskId) {
      if (type === 'input') {
        pushSystem('你还没有配置 DeepSeek API Key，无法发送消息。请先点击顶栏 ⚙ API 进行配置。');
      }
      return;
    }

    // 浏览器遥测
    if (type === 'telemetry') {
      const hub = curHost.telemetryHub;
      const evs = Array.isArray(msg.events) ? (msg.events as BrowserTelemetryEvent[]) : [];
      if (hub && evs.length) {
        const norm = evs.map((e) => ({
          ...e,
          timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now(),
        }));
        hub.pushMany(norm);
        fwd('telemetry', { events: norm });
      }
      return;
    }

    if (type === 'input') {
      // 路由到目标任务的 host（允许多任务并行处理）
      const taskId = String(msg.taskId ?? '');
      const targetHost = getHost(taskId);
      if (!targetHost) {
        pushSystem('该任务尚未初始化，请重新切换或创建任务。');
        return;
      }
      const text = String(msg.text ?? '').trim();
      const attachments = Array.isArray(msg.attachments) ? (msg.attachments as Array<{ name?: string; path?: string }>) : [];
      // 首次用户消息：标题为默认时用前几个字作为任务标题；目标为空时用首条消息作为任务目标
      if (text) {
        const meta = await taskStore.get(activeTaskId);
        if (meta && (meta.title === '新任务' || meta.title === '默认任务' || meta.title === '新会话' || meta.title === '默认会话')) {
          await taskStore.update(activeTaskId, { title: text.slice(0, 30) || '新任务' });
          await sendTaskList();
        }
        const meta2 = await taskStore.get(activeTaskId);
        if (meta2 && !meta2.goal) {
          await taskStore.update(activeTaskId, { goal: text.slice(0, 80) });
          await sendTaskList();
        }
      }
      // 把本批附件拼进这条消息，让 agent 在处理该消息时一并读取（而非上传时自动触发）
      let fullText = text;
      const valid = attachments.filter((a) => a && a.path);
      if (valid.length) {
        const list = valid.map((a) => `- ${a.name || basename(a.path!)}：${a.path}`).join('\n');
        fullText += `\n\n[用户附件] 用户随本条消息上传了以下文档，请在回答前先读取并理解其内容：\n${list}`;
      }
      targetHost.send(fullText);
    } else if (type === 'confirm') curHost.resolveConfirm(Boolean(msg.yes));
    else if (type === 'asktext') curHost.resolveAskText(String(msg.text ?? ''));
    else if (type === 'abort') curHost.abort();
    else if (type === 'set_limit') {
      const limit = Number(msg.limit);
      if (Number.isFinite(limit) && limit >= 0) {
        curHost.setMaxIterations(limit);
      }
    }
  });

  ws.on('close', async () => {
    await cleanupHosts();
    connectionHostMaps.delete(hosts);
    if (activeToken) telemetryHubs.delete(activeToken);
    rateLimit.delete(connId);
  });
});

// ── 全局连接 host 注册表：进程级优雅关闭时遍历所有连接的 host flush 在途 trace ──
const connectionHostMaps = new Set<Map<string, AgentHost>>();

/** flush 所有连接的所有 host 的 trace 缓冲（不抛错，单个失败不拖累整体） */
async function flushAllTraces(): Promise<void> {
  for (const hm of connectionHostMaps) {
    for (const h of hm.values()) {
      try {
        await h.props.traceLogger?.flush();
      } catch {
        /* 忽略写入失败 */
      }
    }
  }
}

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[web] 收到 ${signal}，正在刷新所有 trace 缓冲后退出...`);
  await flushAllTraces();
  server.close(() => process.exit(0));
  // 兜底：若 server.close 回调未触发，2s 后强制退出
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[web] DeepSeek Agent 网页版已启动 → http://localhost:${PORT} （三栏式 / 账户密码登录 / 每账号独立）`);
});

/** 生成不覆盖既有文件的唯一路径：若存在同名则追加 -1 / -2 … */
async function uniqueUploadPath(p: string): Promise<string> {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const base = p.slice(0, p.length - ext.length);
  let i = 1;
  let cand = `${base}-${i}${ext}`;
  while (existsSync(cand)) {
    i += 1;
    cand = `${base}-${i}${ext}`;
  }
  return cand;
}

/**
 * 把 trace replay 的 ChatMessage[] 推送给前端，同时重建思考卡片。
 *
 * 按 user 消息边界切分 turns：
 *   用户 → 助理（含 tool_calls + 推理文字）→ 工具结果 → 助理（最终回答）
 * 复合轮次：重建思考卡（thinking_start/entry/end），最终回答气泡挂 thinkingId。
 * 简单 QA 轮次：直接以普通气泡渲染。
 */
type FwdFn = (type: string, payload: Record<string, unknown>) => void;

/** 旧数据回放（无持久化思考盒）：从 assistant_message.tool_calls + 后续 tool 消息重建思考卡。 */
/** 简化版：只转 UiMessage[]，不重建思考卡（供 setMessagesSilent 回填用） */
function replayedToUiSimple(messages: ReplayedMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  let id = 0;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (text) out.push({ id: id++, role: m.role as MsgRole, text });
  }
  return out;
}
