import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceLogger } from '../src/context/trace.ts';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-trace-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readTrace(dir: string): Promise<string> {
  const traceDir = join(dir, '.dsa', 'traces');
  const files = await readdir(traceDir);
  const jsonls = files.filter((f) => f.endsWith('.jsonl'));
  assert.ok(jsonls.length >= 1, '应至少有一个 trace 文件');
  return readFile(join(traceDir, jsonls[0]), 'utf8');
}

test('flush 写出缓冲事件到磁盘（默认异步缓冲不落盘）', async () => {
  await withTempDir(async (dir) => {
    const tl = new TraceLogger({ workspaceDir: dir, enabled: true });
    await tl.log('user_input', { input: 'hi' });
    await tl.log('assistant_message', { content: 'hello' });
    // 未 flush 前缓冲不应落盘——验证“500ms 异步窗口”真实存在
    let pre = '';
    try {
      pre = await readTrace(dir);
    } catch {
      pre = '';
    }
    assert.ok(!pre.includes('hi'), 'flush 前不应落盘');
    await tl.flush();
    const content = await readTrace(dir);
    assert.ok(content.includes('hi'), 'flush 后应有 user_input');
    assert.ok(content.includes('hello'), 'flush 后应有 assistant_message');
  });
});

test('显式 flush 即使 500ms 定时器未触发也落盘（切任务前强一致）', async () => {
  await withTempDir(async (dir) => {
    const tl = new TraceLogger({ workspaceDir: dir, enabled: true });
    await tl.log('user_input', { input: 'fast-switch' });
    // 立即 flush（远小于 500ms 阈值），模拟“切走再切回”前强制落盘
    await tl.flush();
    const content = await readTrace(dir);
    assert.ok(content.includes('fast-switch'), '显式 flush 应无视定时器立即落盘');
  });
});

test('并发 flush 不重复写、不丢数据', async () => {
  await withTempDir(async (dir) => {
    const tl = new TraceLogger({ workspaceDir: dir, enabled: true });
    await tl.log('user_input', { input: 'a' });
    await tl.log('user_input', { input: 'b' });
    await Promise.all([tl.flush(), tl.flush()]);
    const content = await readTrace(dir);
    const lines = content.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 2, '两次 flush 不应重复写缓冲');
    assert.ok(content.includes('"a"') && content.includes('"b"'), '两条事件都不应丢');
  });
});
