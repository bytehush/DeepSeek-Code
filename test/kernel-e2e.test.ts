/**
 * 内核端到端测试（无网络、无密钥）。
 *
 * 用 MockAdapter 注入 ModelHub，驱动 AgentKernel 走完
 * 「模型请求工具 → 权限闸门 → 工具执行 → 结果回灌 → 最终答复」全链路，
 * 锁定 P0 的核心不变式：
 *   1. 事件契约：done 收尾、reactPhase 标签、tool_call/tool_result 成对；
 *   2. 失败即回灌：工具 throw → 错误文本进 tool 消息，模型能自我纠正；
 *   3. 权限：explore 拦写、ask 确认、destructive 强制确认、拒绝即回灌；
 *   4. 出站记账：每次模型调用在 ledger 留一条可审计记录（不可绕过）；
 *   5. 重复调用检测 → repeat_loop 退出；
 *   6. 中断 → user_abort 退出且工具不执行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelHub, type HubConfig, type ProviderAdapter, type ProviderStreamEvent, type StreamRequest } from '../src/core/provider/hub.ts';
import { OutboundLedger } from '../src/core/provider/ledger.ts';
import { ToolRegistry } from '../src/core/tools/registry.ts';
import { createCoreTools } from '../src/core/tools/atomic.ts';
import { AgentKernel, type KernelRunOptions } from '../src/core/loop/kernel.ts';
import { SessionStore } from '../src/core/session/store.ts';
import type { CoreEvent } from '../src/core/loop/events.ts';
import { userMsg, type Msg } from '../src/core/types.ts';

/** 一次脚本化响应：文本 + 工具调用 */
interface Scripted {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  reasoning?: string;
  finishReason?: string;
}

class MockAdapter implements ProviderAdapter {
  id = 'mock';
  models = [{ id: 'mock-actor', label: 'Mock', contextWindow: 100_000, supportsThinking: false }];
  /** 收到的请求（断言 system/messages/tools 用） */
  readonly requests: Array<StreamRequest & { apiKey: string }> = [];
  private cursor = 0;

  constructor(private script: Scripted[]) {}

  endpoint(): string {
    return 'https://mock.local/v1/chat/completions';
  }

  serialize(req: StreamRequest): string {
    return JSON.stringify({ model: req.modelId, messages: req.messages, tools: req.tools });
  }

  async *stream(req: StreamRequest, apiKey: string, _body: string): AsyncGenerator<ProviderStreamEvent> {
    this.requests.push({ ...req, apiKey });
    const step = this.script[this.cursor] ?? { text: '(脚本耗尽)' };
    this.cursor++;
    if (step.reasoning) yield { type: 'reasoning_delta', text: step.reasoning };
    if (step.text) yield { type: 'text_delta', text: step.text };
    yield {
      type: 'message_end',
      toolCalls: step.toolCalls ?? [],
      finishReason: step.finishReason ?? (step.toolCalls ? 'tool_calls' : 'stop'),
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

function makeHub(script: Scripted[]): { hub: ModelHub; mock: MockAdapter; ledger: OutboundLedger } {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-ledger-'));
  const ledger = new OutboundLedger({ dir });
  const cfg: HubConfig = {
    routing: {
      actor: { provider: 'mock', model: 'mock-actor' },
      critic: { provider: 'mock', model: 'mock-actor' },
      cheap: { provider: 'mock', model: 'mock-actor' },
    },
    keys: { mock: 'test-key-never-from-env' },
  };
  const hub = new ModelHub(cfg, ledger);
  const mock = new MockAdapter(script);
  hub.register(mock);
  return { hub, mock, ledger };
}

function makeKernel(
  script: Scripted[],
  opts?: { protectedRoots?: string[] },
): { kernel: AgentKernel; mock: MockAdapter; ledger: OutboundLedger; hub: ModelHub; registry: ToolRegistry; dir: string } {
  const { hub, mock, ledger } = makeHub(script);
  const registry = new ToolRegistry();
  for (const t of createCoreTools()) registry.register(t);
  const dir = mkdtempSync(join(tmpdir(), 'dsa-ws-'));
  const kernel = new AgentKernel({
    hub,
    registry,
    cwd: dir,
    protectedRoots: opts?.protectedRoots ?? [],
    modelName: () => 'mock-actor',
  });
  return { kernel, mock, ledger, hub, registry, dir };
}

const base: Omit<KernelRunOptions, 'permission'> = {
  planMode: false,
};

async function collect(
  gen: AsyncGenerator<CoreEvent>,
): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('全链路：工具调用 → 执行 → 回灌 → 最终答复，事件序列与契约一致', async () => {
  const { kernel, mock, ledger, dir } = makeKernel([
    { text: '我先看目录', toolCalls: [{ id: 't1', name: 'list_files', args: {} }] },
    { text: '已完成，一切正常' },
  ]);
  try {
    const evs = await collect(kernel.prompt('列一下文件', { ...base, permission: 'execute' }));

    // 事件形状
    assert.equal(evs[0].type, 'assistant_text');
    assert.equal(evs.find((e) => e.type === 'tool_call')?.toolName, 'list_files');
    const result = evs.find((e) => e.type === 'tool_result');
    assert.ok(result?.result, 'tool_result 应带结果文本');
    assert.equal(evs.find((e) => e.type === 'assistant_text' && e.reactPhase === 'thought'), undefined);
    const done = evs.at(-1)!;
    assert.equal(done.type, 'done');
    assert.equal(done.reason, 'model_stop');
    assert.deepEqual(done.usage, { inputTokens: 20, outputTokens: 10 }, '两次调用用量累计');

    // 工具真实执行：list_files 读了工作区
    assert.ok(mock.requests[1], '第二轮带工具结果再问模型');
    const toolMsg = mock.requests[1]!.messages.find((m) => m.role === 'tool')!;
    assert.equal(toolMsg.toolCallId, 't1');
    assert.match(toolMsg.content, /\[details\]|无输出|\.\//, '工具返回内容非空');

    // 出站记账：两次调用两条记录，且含真实网络体字节数与哈希
    const recs = ledger.read();
    assert.equal(recs.length, 2);
    assert.equal(recs[0]!.provider, 'mock');
    assert.ok(recs[0]!.bytes > 100 && /^[0-9a-f]{64}$/.test(recs[0]!.payloadSha256!));
    assert.equal(recs[0]!.endpoint, 'https://mock.local/v1/chat/completions');
    assert.equal(recs[0]!.toolCount, 6, '六工具全量下发');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('密钥不从 process.env 读取：adapter 收的是 hub 配置里的显式 key', async () => {
  const { kernel, mock, dir } = makeKernel([{ text: 'ok' }]);
  process.env.DEEPSEEK_API_KEY = 'env-key-should-not-be-used';
  try {
    await collect(kernel.prompt('hi', { ...base, permission: 'execute' }));
    assert.equal(mock.requests[0]!.apiKey, 'test-key-never-from-env');
    assert.notEqual(mock.requests[0]!.apiKey, 'env-key-should-not-be-used');
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工具单一事实源：wireSpecs 即全部，提示词不再复制第二份清单', async () => {
  const { kernel, mock, dir } = makeKernel([{ text: 'ok' }]);
  try {
    await collect(kernel.prompt('hi', { ...base, permission: 'execute' }));
    const req = mock.requests[0]!;
    const registered = ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files', 'bash'];
    // 硬约束：provider 只认 tools 字段里的名字，它必须与注册表逐项相等
    assert.deepEqual(
      (req.tools ?? []).map((t) => t.name).sort(),
      [...registered].sort(),
      'wireSpecs 必须与注册表完全一致（不多不少）',
    );
    // 每个工具都带 JSON Schema，描述只此一份
    for (const t of req.tools ?? []) {
      assert.ok(t.description.length > 0, `${t.name} 缺描述`);
      assert.equal(typeof t.parameters, 'object', `${t.name} 缺参数 schema`);
    }
    // 第二份清单已删除：提示词里不得再出现工具签名列表
    assert.ok(!/可用工具（/.test(req.system), 'system 不得再复制工具清单');
    // 但必须把「能力边界在 tools 字段」这件事告诉模型，否则删清单就是削弱约束
    assert.match(req.system, /tools 字段/, 'system 须指向 tools 字段作为唯一工具来源');
    // 环境段跟随真实 OS（旧版写死 win32）
    assert.ok(
      /当前操作系统为 (Linux|macOS|Windows)/.test(req.system),
      '环境段应为运行时探测结果',
    );
    assert.ok(!/Windows（win32）/.test(req.system), '不得再写死 win32');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('收尾轮撤掉工具时，提示词不得仍承诺有工具', async () => {
  const { kernel, mock, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'f1', name: 'read_file', args: { path: 'm1.ts' } }] },
    { text: '', toolCalls: [{ id: 'f2', name: 'read_file', args: { path: 'm2.ts' } }] },
    { text: '', toolCalls: [{ id: 'f3', name: 'read_file', args: { path: 'm3.ts' } }] },
    { text: '三次都失败，需要你确认路径' },
  ]);
  try {
    await collect(kernel.prompt('读这些文件', { ...base, permission: 'execute' }));
    const wrap = mock.requests[3]!;
    assert.equal(wrap.tools, undefined, '收尾轮不提供工具');
    // 一致性：无工具的请求里，模型不该被要求"必须调用 tools 字段里的工具"却看到空字段
    assert.match(
      wrap.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
      /不要再尝试任何操作/,
      '收尾轮由一次性反馈明确交代「不要再操作」，与撤工具保持一致',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('权限 explore：写工具被结构性拦截并把拒绝原因回灌模型', async () => {
  const { kernel, mock, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'a.txt', content: 'x' } }] },
    { text: '改为只说明' },
  ]);
  try {
    const evs = await collect(kernel.prompt('写个文件', { ...base, permission: 'explore' }));
    assert.ok(evs.some((e) => e.type === 'permission' && e.granted === false));
    const toolMsg = mock.requests[1]!.messages.find((m) => m.role === 'tool')!;
    assert.match(toolMsg.content, /权限拦截|封锁/);
    assert.equal(evs.at(-1)!.reason, 'model_stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('权限 ask：确认通过才执行；用户拒绝则拒绝原因回灌', async () => {
  const script: Scripted[] = [
    { text: '', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'a.txt', content: 'hi' } }] },
    { text: '好' },
  ];
  const a = makeKernel(script);
  try {
    await collect(a.kernel.prompt('写文件', { ...base, permission: 'ask', ask: async () => true }));
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(join(a.dir, 'a.txt')), '确认后应真实写入');
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }

  const script2: Scripted[] = [
    { text: '', toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'b.txt', content: 'hi' } }] },
    { text: '明白' },
  ];
  const b = makeKernel(script2);
  try {
    await collect(b.kernel.prompt('写文件', { ...base, permission: 'ask', ask: async () => false }));
    const { existsSync } = await import('node:fs');
    assert.ok(!existsSync(join(b.dir, 'b.txt')), '拒绝后不得写入');
    const toolMsg = b.mock.requests[1]!.messages.find((m) => m.role === 'tool')!;
    assert.match(toolMsg.content, /用户拒绝/);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('安全底线：execute 模式下破坏性命令仍强制确认', async () => {
  const { kernel, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'rm -rf /' } }] },
    { text: '不执行' },
  ]);
  let asked = '';
  try {
    await collect(
      kernel.prompt('删库', {
        ...base,
        permission: 'execute',
        ask: async (p) => {
          asked = p;
          return false;
        },
      }),
    );
    assert.match(asked, /疑似破坏性操作/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('受保护目录：写自身源码根被拒（错误回灌，不崩溃）', async () => {
  const srcRoot = mkdtempSync(join(tmpdir(), 'dsa-src-'));
  const evilPath = join(srcRoot, 'evil.ts');
  const { kernel, mock, dir } = makeKernel(
    [
      { text: '', toolCalls: [{ id: 'p1', name: 'write_file', args: { path: evilPath, content: 'x' } }] },
      { text: '已改用工作区路径' },
    ],
    { protectedRoots: [srcRoot] },
  );
  try {
    const evs = await collect(kernel.prompt('改一下你自己的代码', { ...base, permission: 'execute' }));
    const toolMsg = mock.requests[1]!.messages.find((m) => m.role === 'tool')!;
    assert.match(toolMsg.content, /受保护目录/);
    assert.equal(evs.at(-1)!.reason, 'model_stop');
    const { existsSync } = await import('node:fs');
    assert.ok(!existsSync(evilPath), '受保护目录不得落盘');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(srcRoot, { recursive: true, force: true });
  }
});

test('失败即回灌：工具抛错时错误文本作为 tool 结果给模型，循环继续', async () => {
  const { kernel, mock, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'nope.ts' } }] },
    { text: '文件不存在，我换个路径' },
  ]);
  try {
    const evs = await collect(kernel.prompt('读不存在的文件', { ...base, permission: 'execute' }));
    const toolMsg = mock.requests[1]!.messages.find((m) => m.role === 'tool')!;
    assert.match(toolMsg.content, /文件不存在/);
    assert.equal(evs.at(-1)!.reason, 'model_stop');
    assert.ok(!evs.some((e) => e.type === 'error'), '工具失败不是内核错误，是回灌内容');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('幻觉工具名：未注册工具不崩溃，回灌提示', async () => {
  const { kernel, mock, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'x1', name: 'review_code', args: {} }] },
    { text: '我没有这个工具' },
  ]);
  try {
    const evs = await collect(kernel.prompt('审查代码', { ...base, permission: 'execute' }));
    assert.match(mock.requests[1]!.messages.find((m) => m.role === 'tool')!.content, /不存在于注册表/);
    assert.equal(evs.at(-1)!.type, 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('参数校验：非法参数回灌校验错误，不执行工具', async () => {
  const { kernel, mock, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'v1', name: 'read_file', args: { offset: -3 } }] },
    { text: '改正' },
  ]);
  try {
    await collect(kernel.prompt('读文件', { ...base, permission: 'execute' }));
    assert.match(mock.requests[1]!.messages.find((m) => m.role === 'tool')!.content, /参数校验失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空转防护：同工具同参数连续 3 次 → repeat_loop 退出', async () => {
  const call = { id: 'l1', name: 'read_file', args: { path: 'loop.ts' } };
  const { kernel, dir } = makeKernel([
    { text: '', toolCalls: [call] },
    { text: '', toolCalls: [{ ...call, id: 'l2' }] },
    { text: '', toolCalls: [{ ...call, id: 'l3' }] },
    { text: '', toolCalls: [{ ...call, id: 'l4' }] },
  ]);
  try {
    const evs = await collect(kernel.prompt('读', { ...base, permission: 'execute' }));
    assert.equal(evs.at(-1)!.reason, 'repeat_loop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('中断：运行中 abort → user_abort 收尾；预算已 abort 则零外发', async () => {
  // 场景 1：ask 挂起期间用户中断（write_file 在 ask 模式必过确认），返回 true 但信号已断
  const ac = new AbortController();
  const { kernel, mock, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'i1', name: 'write_file', args: { path: 'x.txt', content: 'x' } }] },
  ]);
  try {
    const evs = await collect(
      kernel.prompt('写', {
        ...base,
        permission: 'ask',
        signal: ac.signal,
        ask: async () => {
          ac.abort();
          return true;
        },
      }),
    );
    assert.equal(evs.at(-1)!.reason, 'user_abort');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 场景 2：进入前信号已断 → 一次模型调用都不发出（每步可暂停的极端形态）
  const ac2 = new AbortController();
  ac2.abort();
  const b = makeKernel([{ text: '不该被调用' }]);
  try {
    const evs = await collect(b.kernel.prompt('hi', { ...base, permission: 'execute', signal: ac2.signal }));
    assert.equal(evs.at(-1)!.reason, 'user_abort');
    assert.equal(b.mock.requests.length, 0, '已中断则零外发');
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('clear()：内核消息列清空，下一轮不再带历史', async () => {
  const { kernel, mock, dir } = makeKernel([{ text: '一' }, { text: '二' }]);
  try {
    await collect(kernel.prompt('第一问', { ...base, permission: 'execute' }));
    assert.equal(kernel.history.length, 2);
    kernel.clear();
    assert.equal(kernel.history.length, 0);
    await collect(kernel.prompt('第二问', { ...base, permission: 'execute' }));
    const userMsgs = mock.requests[1]!.messages.filter((m) => (m as Msg).role === 'user');
    assert.equal(userMsgs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P0.1 反地转修复：截断回灌 / 无进展 / 周期检测 / 步数上限 ──

test('截断回灌：finish_reason=length 时不执行残缺调用，改为回灌分块建议', async () => {
  const big = 'x'.repeat(200);
  const { kernel, mock, dir } = makeKernel([
    { text: '我来写整个五子棋', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'gobang.ts', content: big } }], finishReason: 'length' },
    { text: '明白，我先写骨架再分块补全' },
  ]);
  try {
    const evs = await collect(kernel.prompt('设计一个五子棋', { ...base, permission: 'execute' }));
    // 第二次请求里必须有"被截断/分块"的明示，而不是含糊的"参数校验失败"
    const sys = mock.requests[1]!.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    assert.match(sys, /截断/);
    assert.match(sys, /未执行/);
    assert.match(sys, /edit_file/);
    // 残缺调用不得进入工具层（不产生 tool 消息，也不落盘）
    assert.equal(mock.requests[1]!.messages.find((m) => m.role === 'tool'), undefined, '截断调用不应被执行并产生 tool 结果');
    const { existsSync } = await import('node:fs');
    assert.ok(!existsSync(join(dir, 'gobang.ts')), '被截断的 write_file 不得落盘');
    assert.equal(evs.at(-1)!.reason, 'model_stop', '改策略后正常收尾');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('截断有上限：连续截断达次数后以 token_limit 收尾，不无限重试', async () => {
  const call = (id: string) => ({ id, name: 'write_file', args: { path: 'a.ts', content: 'y'.repeat(100) } });
  const { kernel, mock, dir } = makeKernel([
    { text: '一', toolCalls: [call('t1')], finishReason: 'length' },
    { text: '二', toolCalls: [call('t2')], finishReason: 'length' },
    { text: '三', toolCalls: [call('t3')], finishReason: 'length' },
    { text: '四', toolCalls: [call('t4')], finishReason: 'length' },
  ]);
  try {
    const evs = await collect(kernel.prompt('写文件', { ...base, permission: 'execute' }));
    assert.equal(evs.at(-1)!.reason, 'token_limit');
    // TRUNCATION_RECOVERIES=2 → 前两次给改策略机会，第三次即停：共 3 次外发
    assert.equal(mock.requests.length, 3, '截断改策略机会应受限，不得无限重试');
    assert.ok(evs.some((e) => e.type === 'system' && /分块续写/.test(e.text ?? '')), '用户应看到截断处置提示');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('无进展：连续 3 次工具执行失败 → 停止供工具并交付现状总结（no_progress）', async () => {
  // 参数各不相同 → 绕开周期检测，专门考察 no_progress 这条路径
  const { kernel, mock, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'f1', name: 'read_file', args: { path: 'miss1.ts' } }] },
    { text: '', toolCalls: [{ id: 'f2', name: 'read_file', args: { path: 'miss2.ts' } }] },
    { text: '', toolCalls: [{ id: 'f3', name: 'read_file', args: { path: 'miss3.ts' } }] },
    { text: '我卡在读取文件上，三次都失败，需要你确认路径' },
  ]);
  try {
    const evs = await collect(kernel.prompt('读这些文件', { ...base, permission: 'execute' }));
    assert.equal(mock.requests.length, 4, '失败 3 次后应再走一轮产出总结');
    assert.equal(mock.requests[3]!.tools, undefined, '收尾轮不得再提供工具');
    const done = evs.at(-1)!;
    assert.equal(done.reason, 'no_progress');
    assert.match(done.text ?? '', /失败/, '用户必须拿到现状总结而非静默消失');
    assert.ok(evs.some((e) => e.type === 'system' && /连续 3 次工具执行失败/.test(e.text ?? '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 内核一次性反馈：消费即弃，绝不进历史。
 *
 * 修复前的缺陷：截断建议 / 无进展交代被 push 进 this.messages，于是
 * 后续每一步、甚至用户换话题后的下一个回合，模型仍在读「不要再尝试任何操作」。
 * 那是正确性缺陷（过期指令持续约束模型），省那 0.3K 是次要的。
 */
test('一次性反馈进得了下一步请求，但绝不进历史', async () => {
  const big = 'x'.repeat(200);
  const { kernel, mock, dir } = makeKernel([
    { text: '我来写', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'g.ts', content: big } }], finishReason: 'length' },
    { text: '改为先写骨架', toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'g.ts', content: 'export const a = 1;' } }] },
    { text: '完成' },
  ]);
  try {
    await collect(kernel.prompt('设计一个五子棋', { ...base, permission: 'execute' }));
    // 第 2 次请求必须带上截断改策略建议（否则「失败即回灌」又断了）
    const second = mock.requests[1]!.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(second, /截断/, '建议必须送达下一步');
    // 但它不属于历史：内核持久列里一条 system 都不能有
    assert.ok(
      kernel.history.every((m) => m.role !== 'system'),
      '内核一次性反馈不得进入 this.messages',
    );
    // 第 3 次请求里该建议必须已消失（消费即弃，不是永久占位）
    const third = mock.requests[2]!.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.ok(!/截断/.test(third), '过期建议不得继续投递给模型');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('换回合不再残留上一回合的内核指令', async () => {
  const big = 'y'.repeat(200);
  const { kernel, mock, dir } = makeKernel([
    { text: '先写', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'a.ts', content: big } }], finishReason: 'length' },
    { text: '已改小' },
    { text: '新话题的回答' },
  ]);
  try {
    await collect(kernel.prompt('写个大文件', { ...base, permission: 'execute' }));
    const before = mock.requests.length;
    await collect(kernel.prompt('换个话题，这里有哪些文件', { ...base, permission: 'execute' }));
    const fresh = mock.requests.slice(before);
    const leaked = fresh.flatMap((r) => r.messages.filter((m) => m.role === 'system' && /系统提示/.test(m.content)));
    assert.equal(leaked.length, 0, '新回合不得携带上一回合的一次性指令');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('无进展交代同样不入历史，且收尾轮确实收到它', async () => {
  const { kernel, mock, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'f1', name: 'read_file', args: { path: 'm1.ts' } }] },
    { text: '', toolCalls: [{ id: 'f2', name: 'read_file', args: { path: 'm2.ts' } }] },
    { text: '', toolCalls: [{ id: 'f3', name: 'read_file', args: { path: 'm3.ts' } }] },
    { text: '我三次都失败，需要你确认路径' },
  ]);
  try {
    await collect(kernel.prompt('读这些文件', { ...base, permission: 'execute' }));
    const last = mock.requests[3]!.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(last, /不要再尝试任何操作/, '交代要求必须送达收尾轮');
    assert.ok(kernel.history.every((m) => m.role !== 'system'), '交代不得进历史');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('权限拒绝不算失败：用户说 no 是闸门正常工作，不得误判 no_progress', async () => {
  const { kernel, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'd1', name: 'write_file', args: { path: 'p1.txt', content: 'a' } }] },
    { text: '', toolCalls: [{ id: 'd2', name: 'write_file', args: { path: 'p2.txt', content: 'b' } }] },
    { text: '', toolCalls: [{ id: 'd3', name: 'write_file', args: { path: 'p3.txt', content: 'c' } }] },
    { text: '你拒绝了这几次写入，那我们换个方案' },
  ]);
  try {
    const evs = await collect(kernel.prompt('写三个文件', { ...base, permission: 'ask', ask: async () => false } as KernelRunOptions));
    const done = evs.at(-1)!;
    assert.equal(done.reason, 'model_stop', '连续被拒只是用户意愿，不是无进展');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('周期检测：A/B 交替调用 ≥3 轮 → repeat_loop（旧判据抓不到的形态）', async () => {
  // 两次调用都读**真实存在且内容不同**的文件 → 均成功 → failStreak 恒为 0，
  // 从而隔离出周期检测：证明它抓的是"调用模式在转圈"，而非"工具在报错"。
  const { kernel, dir } = makeKernel([
    { text: '', toolCalls: [{ id: '1', name: 'read_file', args: { path: 'a.ts' } }] },
    { text: '', toolCalls: [{ id: '2', name: 'read_file', args: { path: 'b.ts' } }] },
    { text: '', toolCalls: [{ id: '3', name: 'read_file', args: { path: 'a.ts' } }] },
    { text: '', toolCalls: [{ id: '4', name: 'read_file', args: { path: 'b.ts' } }] },
    { text: '', toolCalls: [{ id: '5', name: 'read_file', args: { path: 'a.ts' } }] },
    { text: '', toolCalls: [{ id: '6', name: 'read_file', args: { path: 'b.ts' } }] },
  ]);
  writeFileSync(join(dir, 'a.ts'), 'A\n', 'utf-8');
  writeFileSync(join(dir, 'b.ts'), 'B\n', 'utf-8');
  try {
    const evs = await collect(kernel.prompt('看看这两个文件', { ...base, permission: 'execute' }));
    assert.equal(evs.at(-1)!.reason, 'repeat_loop', '交替地转必须被抓住');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('参数键序归一化：同义调用（键顺序不同）也判定为重复', async () => {
  const { kernel, dir } = makeKernel([
    { text: '', toolCalls: [{ id: 'k1', name: 'search_files', args: { query: 'foo', dir: 'src' } }] },
    { text: '', toolCalls: [{ id: 'k2', name: 'search_files', args: { dir: 'src', query: 'foo' } }] },
    { text: '', toolCalls: [{ id: 'k3', name: 'search_files', args: { query: 'foo', dir: 'src' } }] },
  ]);
  try {
    const evs = await collect(kernel.prompt('搜 foo', { ...base, permission: 'execute' }));
    assert.equal(evs.at(-1)!.reason, 'repeat_loop', '换键序不得逃出重复检测');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('步数上限生效：maxIterations 传入内核后真正拦截无限循环', async () => {
  const { kernel, mock, dir } = makeKernel(
    Array.from({ length: 10 }, (_, i) => ({
      text: '',
      toolCalls: [{ id: `s${i}`, name: 'read_file', args: { path: `f${i}.ts` } }],
    })),
  );
  try {
    const evs = await collect(kernel.prompt('一直读', { ...base, permission: 'execute', maxIterations: 3 }));
    assert.equal(evs.at(-1)!.reason, 'max_iterations');
    assert.equal(mock.requests.length, 3, 'maxIterations=3 → 恰好外发 3 次，第 4 步在调用前被拦');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 会话持久化（step 2）：存 → 重启 → 装回内核 → 模型仍记得上次做到哪 ──

test('重启续谈：loadHistory 后新请求携带完整历史（含工具结果）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-ws-'));
  const sessDir = mkdtempSync(join(tmpdir(), 'dsa-sess-'));
  try {
    // ── 第一次会话：走一轮真实的 工具调用 → 结果 → 答复 ──
    const a = makeKernel([
      { text: '先建文件', toolCalls: [{ id: 'k1', name: 'write_file', args: { path: 'x.txt', content: 'hello' } }] },
      { text: 'x.txt 已建好' },
    ]);
    try {
      await collect(a.kernel.prompt('建个文件', { ...base, permission: 'execute' }));
      const store = new SessionStore(dir, { dir: sessDir });
      assert.ok(store.save(a.kernel.history), '回合末快照应写盘成功');

      // ── "重启"：全新内核 + 装载历史 → 问一个只有靠历史才答得出的问题 ──
      const { hub, mock } = makeHub([{ text: '刚才建的是 x.txt，内容是 hello' }]);
      const registry = new ToolRegistry();
      for (const t of createCoreTools()) registry.register(t);
      const b = new AgentKernel({
        hub,
        registry,
        cwd: dir,
        protectedRoots: [],
        modelName: () => 'mock-actor',
      });
      b.loadHistory(store.load()!);
      await collect(b.prompt('刚才建的是什么文件？', { ...base, permission: 'execute' }));

      const sent = mock.requests[0]!.messages;
      assert.ok(sent.some((m) => m.role === 'user' && m.content === '建个文件'), '上次的用户输入要带回去');
      assert.ok(sent.some((m) => m.role === 'tool' && m.content.includes('x.txt')), '工具结果也要带回去——模型记得的依据');
      assert.ok(sent.some((m) => m.role === 'assistant' && m.content === 'x.txt 已建好'), '上次的答复要带回去');
      // 注意：MockAdapter 存的是 messages 引用，回合结束后内核还会往里追加
      // assistant——所以按"发出时刻的前缀"断言，而非按末位断言。
      assert.equal(sent[4]!.role, 'user');
      assert.equal(sent[4]!.content, '刚才建的是什么文件？', '本次提问应紧跟在恢复的历史之后');
      assert.ok(!sent.slice(0, 4).some((m) => m.role === 'system'), 'system 提示不进历史');
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sessDir, { recursive: true, force: true });
  }
});

test('loadHistory 拒绝 system 注入：旧系统提示不得混进恢复的历史', () => {
  const { kernel, dir } = makeKernel([{ text: 'ok' }]);
  try {
    kernel.loadHistory([
      { role: 'system', content: '（旧的持久化 system，必须被丢弃）' },
      userMsg('还在吗'),
    ]);
    assert.equal(kernel.history.length, 1);
    assert.equal(kernel.history[0]!.role, 'user');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
