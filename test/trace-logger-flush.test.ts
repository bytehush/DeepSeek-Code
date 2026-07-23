import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceLogger } from '../src/context/trace.ts';

/**
 * 服务器重启后历史渲染状态（思考盒）丢失的根因机制：
 * TraceLogger.log 仅写入内存缓冲并调度 500ms 定时器批量刷盘，不在调用时落盘。
 * 若进程退出 / WS 断开 / 登出时未主动 flush，缓冲中的思考事件随进程丢失，
 * 重启后 replayAll 读不到 → thinking 为空 → UI 不渲染。
 *
 * 下方测试复现该机制，并验证「关闭前 flush」可完整恢复。
 */

test('未 flush 的 trace 事件在重放时丢失（复现重启丢渲染状态的根因）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-trace-'));
  const tl = new TraceLogger({ workspaceDir: dir, enabled: true });
  await tl.log('thinking_start', { turnId: 1 });
  await tl.log('thinking_entry', { id: 0, kind: 'reason', text: '推理内容' });
  await tl.log('thinking_end', { turnId: 1 });
  // log 仅入缓冲、调度 500ms 定时器，不立即落盘
  const replayed = await TraceLogger.replayAll(dir);
  assert.strictEqual(replayed, null, '未 flush 时磁盘无 trace → 重放应为 null（复现 bug）');
});

test('flush 后 trace 完整落盘，重放可恢复思考轮次（修复后行为）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-trace-'));
  const tl = new TraceLogger({ workspaceDir: dir, enabled: true });
  await tl.log('thinking_start', { turnId: 1 });
  await tl.log('thinking_entry', { id: 0, kind: 'reason', text: '推理内容' });
  await tl.log('thinking_end', { turnId: 1 });
  await tl.flush();
  const replayed = await TraceLogger.replayAll(dir);
  assert.ok(replayed, 'flush 后应能重放');
  assert.strictEqual(replayed.thinking.length, 1, '思考轮次应完整恢复');
  assert.strictEqual(replayed.thinking[0].status, 'done');
  assert.strictEqual(replayed.thinking[0].entries.length, 1);
  assert.strictEqual(replayed.thinking[0].entries[0].text, '推理内容');
});

test('多批次 log+flush 追加写入且重放聚合完整', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-trace-'));
  const tl = new TraceLogger({ workspaceDir: dir, enabled: true });
  await tl.log('thinking_start', { turnId: 1 });
  await tl.log('thinking_end', { turnId: 1 });
  await tl.flush();
  await tl.log('thinking_start', { turnId: 2 });
  await tl.log('thinking_end', { turnId: 2 });
  await tl.flush();
  const replayed = await TraceLogger.replayAll(dir);
  assert.ok(replayed);
  assert.strictEqual(replayed.thinking.length, 2, '两轮思考都应恢复');
});

test('log 后文件尚未创建（证明缓冲未立即落盘）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-trace-'));
  const tl = new TraceLogger({ workspaceDir: dir, enabled: true });
  await tl.log('thinking_start', { turnId: 1 });
  // 构造前 flush 已确保缓冲，但此处未 flush：目录不应存在 .dsa/traces 文件
  const replayed = await TraceLogger.replayAll(dir);
  assert.strictEqual(replayed, null, 'flush 前磁盘无文件 → 重放为 null');
});
