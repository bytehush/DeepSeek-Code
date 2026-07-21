/**
 * M8 记忆后端性能基准（sync / async / batch 对比）。
 *
 * 目的：验证 M8「异步 I/O + 预热 + 批量嵌入」相对旧同步路径没有回退，且批量写入更快。
 * 用法：node --import tsx scripts/bench-memory.ts
 *
 * 约束：使用 off 模式 embedder（无网络、embedding 为 undefined、确定性），只测 I/O 与编排开销。
 * 每个后端跑完调用 onDispose() 冲刷写链，确保全部落盘后再计时结束。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createMemoryBackend } from '../src/memory/backend.ts';
import { Embedder } from '../src/memory/embedder.ts';

const N = 200; // 写入条目数
const BATCH = 20; // 批量写入每批大小

async function benchSync(): Promise<{ ms: number; writes: number }> {
  const dir = mkdtempSync(join(os.tmpdir(), 'bench-sync-'));
  const store = createMemoryBackend(dir, new Embedder({ mode: 'off' }), { async: false });
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await store.addEntry(`sync 记忆条目 ${i}`, ['bench']);
  }
  const ms = Date.now() - t0;
  await store.onDispose();
  rmSync(dir, { recursive: true, force: true });
  return { ms, writes: N };
}

async function benchAsync(): Promise<{ ms: number; writes: number }> {
  const dir = mkdtempSync(join(os.tmpdir(), 'bench-async-'));
  const store = createMemoryBackend(dir, new Embedder({ mode: 'off' }), { async: true });
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await store.addEntry(`async 记忆条目 ${i}`, ['bench']);
  }
  const ms = Date.now() - t0;
  await store.onDispose();
  rmSync(dir, { recursive: true, force: true });
  return { ms, writes: N };
}

async function benchBatch(): Promise<{ ms: number; writes: number }> {
  const dir = mkdtempSync(join(os.tmpdir(), 'bench-batch-'));
  const store = createMemoryBackend(dir, new Embedder({ mode: 'off' }), { async: true });
  const t0 = Date.now();
  for (let i = 0; i < N; i += BATCH) {
    const chunk = Array.from({ length: BATCH }, (_, k) => `batch 记忆条目 ${i + k}`);
    await store.addEntries(chunk, chunk.map(() => ['bench']));
  }
  const ms = Date.now() - t0;
  await store.onDispose();
  rmSync(dir, { recursive: true, force: true });
  return { ms, writes: N };
}

function bar(ms: number, maxMs: number): string {
  const width = 30;
  const filled = Math.max(1, Math.round((ms / maxMs) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function main(): Promise<void> {
  console.log(`\n记忆后端基准：写入 ${N} 条语义记忆（off 模式 embedder，仅测 I/O + 编排开销）\n`);

  const sync = await benchSync();
  const async = await benchAsync();
  const batch = await benchBatch();
  const maxMs = Math.max(sync.ms, async.ms, batch.ms);

  console.log('模式           耗时(ms)   相对           吞吐(条/s)');
  console.log('─────────────  ────────  ──────────────  ──────────');
  console.log(
    `sync 逐条      ${String(sync.ms).padStart(7)}   ${bar(sync.ms, maxMs)}  ${String(
      Math.round(sync.writes / (sync.ms / 1000)),
    ).padStart(8)}`,
  );
  console.log(
    `async 逐条     ${String(async.ms).padStart(7)}   ${bar(async.ms, maxMs)}  ${String(
      Math.round(async.writes / (async.ms / 1000)),
    ).padStart(8)}`,
  );
  console.log(
    `async 批量×${BATCH}  ${String(batch.ms).padStart(7)}   ${bar(batch.ms, maxMs)}  ${String(
      Math.round(batch.writes / (batch.ms / 1000)),
    ).padStart(8)}`,
  );

  console.log('\n结论：');
  console.log(`- async 逐条 vs sync 逐条：${async.ms <= sync.ms * 1.2 ? '无回退（async ≤ sync×1.2）' : '⚠ async 明显慢于 sync'}`);
  const speedup = sync.ms / batch.ms;
  console.log(
    `- 批量 vs 逐条(sync)：${speedup >= 1 ? `批量更快，加速 ${speedup.toFixed(2)}×` : '⚠ 批量未更快'}`,
  );
  console.log(`- 批量写盘次数：逐条 ${N} 次 vs 批量 ${Math.ceil(N / BATCH)} 次（理论更少 fs 写）\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
