/**
 * runChatTurn → UI 事件日志 → fold 的集成契约（trace-first 管线的中段）。
 *
 * 单元层（timeline-fold）验折叠规则，e2e 层（kernel-e2e）验内核；
 * 这里补上中间那段此前靠肉眼验证的接线：
 *   用户输入不再是「push 一个气泡」而是 {type:'user_input'} 事件；
 *   内核事件原样入日志（不再命令式映射）；done 后合成 turn_summary；
 *   全程 fold 出的转录符合「结论优先 + 一行进度」。
 * 顺带锁 /clear 的三件套语义（内核列 + 会话文件 + 事件日志同步清零）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelHub, type HubConfig, type ProviderAdapter, type ProviderStreamEvent, type StreamRequest } from '../src/core/provider/hub.ts';
import { OutboundLedger } from '../src/core/provider/ledger.ts';
import { ToolRegistry } from '../src/core/tools/registry.ts';
import { createCoreTools } from '../src/core/tools/atomic.ts';
import { AgentKernel } from '../src/core/loop/kernel.ts';
import { SessionStore } from '../src/core/session/store.ts';
import { runChatTurn, type ChatContext } from '../src/app/chat.ts';
import { foldTranscript, type UiEvent } from '../src/app/timeline.ts';
import type { AppProps } from '../src/app/types.ts';

class ScriptAdapter implements ProviderAdapter {
  id = 'mock';
  models = [{ id: 'mock-actor', label: 'Mock', contextWindow: 100_000, supportsThinking: false }];
  requests: StreamRequest[] = [];
  private cursor = 0;
  constructor(private script: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; args: unknown }> }>) {}
  endpoint(): string {
    return 'https://mock.local/v1/chat/completions';
  }
  serialize(req: StreamRequest): string {
    return JSON.stringify(req.messages);
  }
  async *stream(req: StreamRequest, _key: string, _body: string): AsyncGenerator<ProviderStreamEvent> {
    this.requests.push(req);
    const step = this.script[this.cursor] ?? { text: '(耗尽)' };
    this.cursor++;
    if (step.text) yield { type: 'text_delta', text: step.text };
    yield {
      type: 'message_end',
      toolCalls: step.toolCalls ?? [],
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

/** 收集型 ChatContext：只做两件事——记事件、驱动 fold */
function makeCtx(script: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; args: unknown }> }>) {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-turn-'));
  const ledgerDir = mkdtempSync(join(tmpdir(), 'dsa-ledger-'));
  const hub = new ModelHub(
    {
      routing: {
        actor: { provider: 'mock', model: 'mock-actor' },
        critic: { provider: 'mock', model: 'mock-actor' },
        cheap: { provider: 'mock', model: 'mock-actor' },
      },
      keys: { mock: 'k' },
    } as HubConfig,
    new OutboundLedger({ dir: ledgerDir }),
  );
  const mock = new ScriptAdapter(script);
  hub.register(mock);
  const registry = new ToolRegistry();
  for (const t of createCoreTools()) registry.register(t);
  const kernel = new AgentKernel({ hub, registry, cwd: dir, protectedRoots: [], modelName: () => 'mock' });
  const session = new SessionStore(dir, { dir: join(dir, '.dsa-sessions') });

  const log: UiEvent[] = [];
  const props = { kernel, registry, ledger: new OutboundLedger({ dir: ledgerDir }), session, workspace: dir } as unknown as AppProps;
  const ctx: ChatContext = {
    props,
    cwd: dir,
    uiEv: (ev) => log.push(ev),
    systemText: (text) => log.push({ type: 'system', text }),
    resetEvents: () => {
      log.length = 0;
    },
    setBusy: () => {},
    getState: () => ({ mode: 'execute' as const, planMode: false, outputStyle: 'human' as const }),
    maxIterations: 0,
    setMode: () => {},
    setPlanMode: () => {},
    setOutputStyle: () => {},
    setActiveAbort: () => {},
    abort: () => {},
    requestConfirm: async () => true,
    requestAskText: async () => '',
  };
  return { ctx, log, mock, kernel, session, dir, ledgerDir };
}

test('一轮完整任务：事件日志→fold 呈现「问题 + 一行步骤 + 结论 + 耗时」', async () => {
  const t = makeCtx([
    { text: '我先建个文件', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'a.txt', content: 'hi' } }] },
    { text: '已创建 a.txt，内容为 hi' },
  ]);
  try {
    await runChatTurn('建一个 a.txt', t.ctx);
    const ui = foldTranscript(t.log);
    assert.ok(ui.some((m) => m.kind === 'user' && m.text === '建一个 a.txt'), '用户输入以事件入日志');
    const step = ui.find((m) => m.kind === 'step')!;
    assert.match(step.text, /^#1 🔧 write_file a\.txt ✅/);
    assert.equal(step.text.split('\n').length, 1, '折叠态步骤必须一行');
    assert.ok(!ui.some((m) => m.text === '我先建个文件'), '行动前叙述收起了');
    assert.ok(ui.some((m) => m.kind === 'answer' && m.text.includes('已创建 a.txt')));
    assert.ok(ui.some((m) => m.kind === 'notice' && /耗时/.test(m.text)), 'turn_summary 合成了耗时行');
    // 回合末会话快照落盘（finally 保存点）
    assert.ok(existsSync(t.session.path), '回合结束必须快照内核消息列');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(t.ledgerDir, { recursive: true, force: true });
  }
});

test('/clear 三件套同步清零：内核列 + 会话文件 + 事件日志', async () => {
  const t = makeCtx([{ text: '好的' }, { text: '再来' }]);
  try {
    await runChatTurn('第一问', t.ctx);
    assert.ok(existsSync(t.session.path));
    await runChatTurn('/clear', t.ctx);
    assert.equal(t.kernel.history.length, 0, '内核列清空');
    assert.ok(!existsSync(t.session.path), '会话文件删除');
    assert.equal(t.log.length, 1, '事件日志只剩清空提示一条');
    const ui = foldTranscript(t.log);
    assert.ok(ui[0]!.text.includes('已清空'), '清空反馈可见');
    // 下一轮不带历史
    await runChatTurn('第二问', t.ctx);
    const sent = t.mock.requests[1]!.messages;
    assert.equal(sent.filter((m) => m.role === 'user').length, 1, '清空后上下文归零');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(t.ledgerDir, { recursive: true, force: true });
  }
});

test('/help 与模式切换是事件日志里的 notice，不伪装成对话', async () => {
  const t = makeCtx([]);
  try {
    await runChatTurn('/help', t.ctx);
    await runChatTurn('/mode ask', t.ctx);
    const ui = foldTranscript(t.log);
    assert.equal(ui.length, 2);
    assert.ok(ui.every((m) => m.kind === 'notice'));
    assert.match(ui[1]!.text, /权限模式已切换/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(t.ledgerDir, { recursive: true, force: true });
  }
});
