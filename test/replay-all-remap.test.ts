import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceLogger } from '../src/context/trace.ts';

/**
 * 复现「刷新重连后 thinking turnId 重复」导致前端思考盒错配/丢失的 bug。
 * 两个独立 session 的 trace 文件（各自 turnId 从 1 计）聚合后，
 * 旧实现返回 turnId [1,1]（冲突），新实现应重映射为 [1,2] 且 messages.thinkingId 同步。
 */
function makeSessionJsonl(turnId: number, thinkingText: string, answerText: string): string {
  const ts = '2026-07-24T00:00:00.000Z';
  const lines = [
    { timestamp: ts, type: 'session_start', payload: {} },
    { timestamp: ts, type: 'thinking_start', payload: { turnId } },
    { timestamp: ts, type: 'thinking_entry', payload: { id: 1, kind: 'reason', text: thinkingText } },
    { timestamp: ts, type: 'thinking_end', payload: { turnId } },
    { timestamp: ts, type: 'user_input', payload: { input: '你好' } },
    { timestamp: ts, type: 'assistant_message', payload: { content: answerText, thinkingId: turnId } },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

test('replayAll：多 session 聚合后 thinking turnId 全局唯一且 messages.thinkingId 同步', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-remap-'));
  const tracesDir = join(dir, '.dsa', 'traces');
  await mkdtemp(tracesDir).catch(() => {});
  // 直接用 ensureDir 风格：TraceLogger.replayAll 读 dir/.dsa/traces，故建该目录
  const fs = await import('node:fs/promises');
  await fs.mkdir(tracesDir, { recursive: true });

  // 两个 session：各自 turnId=1（模拟刷新重连复用旧计数）
  await writeFile(join(tracesDir, 'sess_a.jsonl'), makeSessionJsonl(1, 'A 的思考', 'A 的回答'), 'utf8');
  await writeFile(join(tracesDir, 'sess_b.jsonl'), makeSessionJsonl(1, 'B 的思考', 'B 的回答'), 'utf8');

  const r = await TraceLogger.replayAll(dir);
  assert.ok(r, '应返回聚合结果');
  assert.equal(r!.thinking.length, 2, '两个思考轮');
  // 关键：turnId 必须全局唯一，不能都是 1
  const turnIds = r!.thinking.map((t) => t.turnId);
  assert.deepEqual([...new Set(turnIds)].sort(), turnIds.slice().sort(), 'turnId 应无重复');
  assert.deepEqual(turnIds, [1, 2], '应按聚合顺序重映射为 1,2');

  // messages.thinkingId 同步重映射，且各自指向对应思考轮
  const assistantMsgs = r!.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantMsgs.length, 2);
  assert.deepEqual(
    assistantMsgs.map((m) => (m as { thinkingId?: number }).thinkingId),
    [1, 2],
    'assistant 消息的 thinkingId 应同步重映射',
  );
  // 内容关联正确：turnId=1 的 thinking 是 A 的思考，对应 A 的回答
  const aThinking = r!.thinking.find((t) => t.turnId === 1)!;
  assert.equal(aThinking.entries[0].text, 'A 的思考');
  const bThinking = r!.thinking.find((t) => t.turnId === 2)!;
  assert.equal(bThinking.entries[0].text, 'B 的思考');

  await rm(dir, { recursive: true, force: true });
});

test('replayAll：单文件不重映射时仍正常（保持原 turnId）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-single-'));
  const tracesDir = join(dir, '.dsa', 'traces');
  const fs = await import('node:fs/promises');
  await fs.mkdir(tracesDir, { recursive: true });
  await writeFile(join(tracesDir, 'sess_c.jsonl'), makeSessionJsonl(1, 'C 的思考', 'C 的回答'), 'utf8');
  const r = await TraceLogger.replayAll(dir);
  assert.ok(r);
  assert.equal(r!.thinking.length, 1);
  assert.equal(r!.thinking[0].turnId, 1, '单文件保持原 turnId');
  assert.equal((r!.messages.find((m) => m.role === 'assistant') as { thinkingId?: number }).thinkingId, 1);
  await rm(dir, { recursive: true, force: true });
});
