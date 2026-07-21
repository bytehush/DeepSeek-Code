/**
 * replayAll 聚合回放测试（修复「切任务/重启后历史丢失」）。
 *
 * 锁定行为：
 * - replayAll 读取目录下【全部】 *.jsonl（按文件名升序=时间序）并拼接，返回完整历史。
 * - 旧 replay 仍只读最新单文件，CLI 的 replayMeta/断点续跑不受影响（回归防护）。
 * - 单文件任务：replayAll 结果与 replay 一致，无行为退化。
 * - 空目录：replayAll 返回 null。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { TraceLogger } from '../src/context/trace.ts';

function tmpTraceDir(): { dir: string; traces: string; cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-trace-replay-'));
  const traces = join(dir, '.dsa', 'traces');
  mkdirSync(traces, { recursive: true });
  return { dir, traces, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function userLine(input: string): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'user_input', payload: { input } }) + '\n';
}
function assistantLine(content: string): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant_message', payload: { content } }) + '\n';
}

test('replayAll 聚合全部 session 文件，且顺序正确（核心修复）', async () => {
  const { dir, traces, cleanup } = tmpTraceDir();
  try {
    // 旧会话文件（切走前产生，3 条消息）
    writeFileSync(join(traces, 'sess_a_old.jsonl'), userLine('老消息1') + assistantLine('回复1') + userLine('老消息2'));
    // 新会话文件（切回后新建，1 条消息）—— 时间戳/文件名晚于旧文件
    writeFileSync(join(traces, 'sess_b_new.jsonl'), userLine('新消息'));

    const all = await TraceLogger.replayAll(dir);
    assert.ok(all, 'replayAll 应返回非 null');
    assert.equal(all!.length, 4, '应聚合两个文件共 4 条消息');
    assert.equal(all![0].content, '老消息1');
    assert.equal(all![1].content, '回复1');
    assert.equal(all![2].content, '老消息2');
    assert.equal(all![3].content, '新消息');
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

test('单文件任务：replayAll 与 replay 结果一致（无退化）', async () => {
  const { dir, traces, cleanup } = tmpTraceDir();
  try {
    writeFileSync(join(traces, 'sess_only.jsonl'), userLine('唯一1') + assistantLine('唯一回1') + userLine('唯一2'));

    const all = await TraceLogger.replayAll(dir);
    const latest = await TraceLogger.replay(dir);
    assert.deepEqual(all, latest, '单文件时两者应完全相同');
    assert.equal(all!.length, 3);
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
