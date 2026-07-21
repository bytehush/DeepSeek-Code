/**
 * 方案 A 写入侧验收：AgentHost 的思考事件应随对话落盘（traceThink）。
 *
 * 直接驱动 AgentHost 的 ChatContext 思考通道（setBusy/appendStreaming/endStreaming/
 * prometeThinkingToFinal），用真实 TraceLogger 记录，再 replayAll 断言：
 * - 思考轮次（thinking_start/entry/update/end）已落盘并重建；
 * - 最终答复 assistant_message 绑定 thinkingId（与实时同形）。
 *
 * 这锁定「思考盒真正持久化」这一根因修复，而非方案 B 的运行时反推。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { AgentHost } from '../src/gui/agent-host.ts';
import { TraceLogger } from '../src/context/trace.ts';
import type { AppProps } from '../src/app/types.ts';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-think-persist-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FINAL_ANSWER = '闭包（closure）是函数与其词法作用域的组合，使函数能访问外层变量。';

test('AgentHost 思考事件随对话落盘，且最终答复绑定 thinkingId（方案 A）', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const trace = new TraceLogger({ workspaceDir: dir });
    const props = {
      client: { primaryModel: 'mock' },
      history: {
        addUser: () => {},
        addAssistant: () => {},
        getMessages: () => [],
        compact: async () => {},
        estimateTotalTokens: () => 0,
      },
      cfg: { apiKey: '', baseURL: '', model: 'mock' },
      traceLogger: trace,
      memoryStore: {},
    } as unknown as AppProps;

    const host = new AgentHost(props);

    // 模拟一轮 agent 工作（不真正跑模型，直接驱动 ChatContext 思考通道）
    host.setBusy(true); // thinking_start + status 'thinking'
    host.appendStreaming('闭包是函数与其词法作用域的组合。', 'thought'); // 首段 reason → thinking_entry
    host.appendStreaming('它能捕获定义时的变量。', 'thought'); // 续段 → thinking_update（增量）
    host.endStreaming('final'); // status 'outputting'
    host.prometeThinkingToFinal(); // 把 reason 晋升为最终答案气泡（thinkingId 绑定）

    // 模拟 loop 在 setBusy(false) 之前落盘最终答复（与实时顺序一致：assistant_message 早于 thinking_end）
    await trace.log('assistant_message', { content: FINAL_ANSWER });

    host.setBusy(false); // thinking_status 'done' + thinking_end
    await trace.end();

    const all = await TraceLogger.replayAll(dir);
    assert.ok(all, 'replayAll 应返回非 null');

    // ── 思考轮次已落盘并重建 ──
    assert.equal(all!.thinking.length, 1, '应落盘 1 个思考轮次');
    const turn = all!.thinking[0];
    assert.equal(turn.turnId, 1);
    assert.equal(turn.status, 'done', '最终状态应为 done');
    assert.equal(turn.entries.length, 1, 'reason 条目合并 update 后应只有 1 条');
    assert.equal(turn.entries[0].kind, 'reason');
    assert.ok(
      turn.entries[0].text === '闭包是函数与其词法作用域的组合。它能捕获定义时的变量。',
      'thinking_update 增量应拼接到 thinking_entry 之后',
    );

    // ── 最终答复绑定 thinkingId（与实时同形）──
    const asst = all!.messages.find((m) => m.role === 'assistant');
    assert.ok(asst, '应存在 assistant 消息');
    assert.equal((asst as { thinkingId?: number }).thinkingId, 1, 'assistant 应绑定 thinkingId=1');
    assert.equal(asst!.content, FINAL_ANSWER);
  } finally {
    cleanup();
  }
});
