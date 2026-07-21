/**
 * replayAll 聚合回放测试（修复「切任务/重启后历史丢失」）。
 *
 * 锁定行为：
 * - replayAll 读取目录下【全部】 *.jsonl（按文件名升序=时间序）并拼接，返回 { messages, thinking }。
 * - 旧 replay 仍只读最新单文件，CLI 的 replayMeta/断点续跑不受影响（回归防护）。
 * - 单文件任务：replayAll.messages 与 replay 一致，无行为退化。
 * - 空目录：replayAll 返回 null。
 * - 思考盒事件（thinking_*）随消息同形持久化并重建：思考轮次 + assistant 绑定 thinkingId。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { TraceLogger, type TraceEventType } from '../src/context/trace.ts';

function tmpTraceDir(): { dir: string; traces: string; cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-trace-replay-'));
  const traces = join(dir, '.dsa', 'traces');
  mkdirSync(traces, { recursive: true });
  return { dir, traces, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function line(type: TraceEventType, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
}
const userLine = (input: string) => line('user_input', { input });
const assistantLine = (content: string, toolCalls?: unknown) =>
  line('assistant_message', toolCalls ? { content, toolCalls } : { content });

test('replayAll 聚合全部 session 文件，且顺序正确（核心修复）', async () => {
  const { dir, traces, cleanup } = tmpTraceDir();
  try {
    writeFileSync(join(traces, 'sess_a_old.jsonl'), userLine('老消息1') + assistantLine('回复1') + userLine('老消息2'));
    writeFileSync(join(traces, 'sess_b_new.jsonl'), userLine('新消息'));

    const all = await TraceLogger.replayAll(dir);
    assert.ok(all, 'replayAll 应返回非 null');
    assert.equal(all!.messages.length, 4, '应聚合两个文件共 4 条消息');
    assert.equal(all!.messages[0].content, '老消息1');
    assert.equal(all!.messages[1].content, '回复1');
    assert.equal(all!.messages[2].content, '老消息2');
    assert.equal(all!.messages[3].content, '新消息');
  } finally {
    cleanup();
  }
});

test('旧 replay 仍只读最新单文件（CLI 回归防护）', async () => {
  const { dir, traces, cleanup } = tmpTraceDir();
  try {
    writeFileSync(join(traces, 'sess_a_old.jsonl'), userLine('老消息1') + assistantLine('回复1') + userLine('老消息2'));
    writeFileSync(join(traces, 'sess_b_new.jsonl'), userLine('新消息'));

    const latest = await TraceLogger.replay(dir);
    assert.ok(latest, 'replay 应返回非 null');
    assert.equal(latest!.length, 1, '旧 replay 只应返回最新文件的 1 条');
    assert.equal(latest![0].content, '新消息');
  } finally {
    cleanup();
  }
});

test('单文件任务：replayAll.messages 与 replay 结果一致（无退化）', async () => {
  const { dir, traces, cleanup } = tmpTraceDir();
  try {
    writeFileSync(join(traces, 'sess_only.jsonl'), userLine('唯一1') + assistantLine('唯一回1') + userLine('唯一2'));

    const all = await TraceLogger.replayAll(dir);
    const latest = await TraceLogger.replay(dir);
    assert.deepEqual(all!.messages, latest, '单文件时两者应完全相同');
    assert.equal(all!.messages.length, 3);
  } finally {
    cleanup();
  }
});

test('空 traces 目录：replayAll 返回 null', async () => {
  const { dir, cleanup } = tmpTraceDir();
  try {
    const all = await TraceLogger.replayAll(dir);
    assert.equal(all, null, '无 jsonl 时应返回 null');
  } finally {
    cleanup();
  }
});

test('思考盒随消息同形持久化并重建：思考轮次 + assistant 绑定 thinkingId（方案 A）', async () => {
  const { dir, traces, cleanup } = tmpTraceDir();
  try {
    // 一段真实的思考过程（与 agent-host 实时 emit 同形），交织在最终答复之前
    const content =
      userLine('什么是闭包？') +
      line('thinking_start', { turnId: 1 }) +
      line('thinking_entry', { id: 0, kind: 'reason', text: '闭包是函数与其词法作用域的组合。' }) +
      line('thinking_update', { id: 0, append: '它能捕获定义时的变量。' }) +
      line('thinking_status', { status: 'outputting' }) +
      // 最终答复：loop 在 setBusy(false) 之前落盘 → 排在 thinking_end 之前，activeTurn 仍有效
      assistantLine('闭包（closure）是函数与其词法作用域的组合，能捕获定义时的变量。') +
      line('thinking_status', { status: 'done' }) +
      line('thinking_end', { turnId: 1 });

    writeFileSync(join(traces, 'sess_think.jsonl'), content);

    const all = await TraceLogger.replayAll(dir);
    assert.ok(all, 'replayAll 应返回非 null');
    assert.equal(all!.messages.length, 2, 'user + assistant 共 2 条');
    assert.equal(all!.messages[0].role, 'user');
    assert.equal(all!.messages[1].role, 'assistant');

    // 思考轮次被完整重建
    assert.equal(all!.thinking.length, 1, '应有 1 个思考轮次');
    const turn = all!.thinking[0];
    assert.equal(turn.turnId, 1);
    assert.equal(turn.status, 'done', '最终状态应为 done（thinking_end 后的末次 status）');
    assert.equal(turn.entries.length, 1, 'reason 条目合并 update 后应只有 1 条');
    assert.equal(turn.entries[0].kind, 'reason');
    assert.equal(
      turn.entries[0].text,
      '闭包是函数与其词法作用域的组合。它能捕获定义时的变量。',
      'thinking_update 增量应拼接到 thinking_entry 之后',
    );

    // assistant 消息绑定到该思考轮次
    assert.equal((all!.messages[1] as { thinkingId?: number }).thinkingId, 1, 'assistant 应绑定 thinkingId=1');
  } finally {
    cleanup();
  }
});

test('工具轮：思考盒含 tool/tool_result 条目，最终答复绑定思考轮次', async () => {
  const { dir, traces, cleanup } = tmpTraceDir();
  try {
    const content =
      userLine('帮我算 3!') +
      line('thinking_start', { turnId: 7 }) +
      line('thinking_entry', { id: 0, kind: 'reason', text: '我来实现一个阶乘函数。' }) +
      line('thinking_entry', { id: 1, kind: 'tool', title: 'write_file', text: '' }) +
      line('thinking_entry', { id: 2, kind: 'tool_result', title: 'write_file', text: '已创建文件: factorial.py' }) +
      // 工具轮 assistant（带 tool_calls）：loop 在 setBusy(false) 前落盘
      assistantLine('好的，我来创建 factorial.py。', [{ id: 'c1', name: 'write_file', arguments: '{}' }]) +
      // 最终答复（无 tool_calls）：绑定 thinkingId=7（activeTurn 仍有效）
      assistantLine('已创建 factorial.py，包含递归阶乘实现。') +
      line('thinking_status', { status: 'done' }) +
      line('thinking_end', { turnId: 7 });

    writeFileSync(join(traces, 'sess_tool.jsonl'), content);

    const all = await TraceLogger.replayAll(dir);
    assert.ok(all);
    // messages: user + 工具轮 assistant(tool_calls) + 最终答复 = 3 条（工具轮保留给 LLM 上下文）
    assert.equal(all!.messages.length, 3);
    assert.equal((all!.messages[1] as { thinkingId?: number }).thinkingId, undefined, '工具轮 assistant 不应绑定 thinkingId');
    assert.equal((all!.messages[2] as { thinkingId?: number }).thinkingId, 7, '最终答复绑定 thinkingId=7');

    assert.equal(all!.thinking.length, 1);
    const turn = all!.thinking[0];
    assert.equal(turn.entries.length, 3);
    assert.equal(turn.entries[0].kind, 'reason');
    assert.equal(turn.entries[1].kind, 'tool');
    assert.equal(turn.entries[2].kind, 'tool_result');
    assert.equal(turn.entries[2].text, '已创建文件: factorial.py');
  } finally {
    cleanup();
  }
});
