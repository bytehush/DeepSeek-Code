/**
 * M9 检索性能基准：N=1000 条记忆下，对比 vectorIndex 关（线性扫描默认）与开（归一化矩阵）的 retrieve 延迟。
 * 用法：node --import tsx scripts/bench-retrieve.ts
 * 约定：确定性 FakeEmbedder（无网络）；sync 后端避免异步链干扰计时。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.ts';
import type { EmbedderBackend } from '../src/memory/embedder-backend.ts';

const N = 1000; // 记忆条目数
const M = 200; // 检索轮数（用不同 query，避免 query 缓存主导）

class FakeEmbedder implements EmbedderBackend {
  async embed(text: string): Promise<number[] | null> {
    // 确定性 256 维向量（贴近真实嵌入维度，让「预计算模长」的收益在计时上可观测）
    const v = new Array(256).fill(0);
    for (let i = 0; i < text.length; i++) v[(i * 7) % 256] += text.charCodeAt(i) * (i + 1);
    return v;
  }
  async warmup(): Promise<void> {}
}

function buildStore(vectorIndex: boolean): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(os.tmpdir(), `bench-ret-${vectorIndex ? 'on' : 'off'}-`));
  const store = new MemoryStore(dir, new FakeEmbedder(), { async: false, vectorIndex });
  return { store, dir };
}

async function timeRetrieves(store: MemoryStore): Promise<{ ms: number; total: number }> {
  const t0 = Date.now();
  for (let i = 0; i < M; i++) {
    await store.retrieve(`检索查询编号 ${i} 关于前端工程实践`, 5);
  }
  return { ms: Date.now() - t0, total: M };
}

async function main(): Promise<void> {
  console.log(`\n检索基准：N=${N} 条记忆，跑 M=${M} 轮 retrieve（sync + 确定性嵌入）\n`);

  const TARGET = '前端工程与构建工具'; // 一致性校验用的「清晰赢家」query

  const off = buildStore(false);
  for (let i = 0; i < N; i++) await off.store.addEntry(`记忆条目 ${i} 内容关于前端工程与构建工具`);
  const offAnchor = (await off.store.addEntry(TARGET)).id; // 锚点：内容与 query 完全一致 → 向量近乎重合，清晰最高分
  await off.store.onDispose();

  const on = buildStore(true);
  for (let i = 0; i < N; i++) await on.store.addEntry(`记忆条目 ${i} 内容关于前端工程与构建工具`);
  const onAnchor = (await on.store.addEntry(TARGET)).id;
  await on.store.onDispose();

  const rOff = await timeRetrieves(off.store);
  const rOn = await timeRetrieves(on.store);

  // 正确性：query 与某条内容完全一致时，两种路径都应把它（各自的锚点条目）召回为 top-1。
  // 两 store 是独立实例、锚点 uuid 不同，故分别比对各自锚点，而非跨 store 比 id。
  const qOff = (await off.store.retrieve(TARGET, 1))[0]?.id;
  const qOn = (await on.store.retrieve(TARGET, 1))[0]?.id;
  const sameTop1 = qOff === offAnchor && qOn === onAnchor && qOff !== undefined && qOn !== undefined;

  const avgOff = rOff.ms / rOff.total;
  const avgOn = rOn.ms / rOn.total;
  const speedup = avgOff / avgOn;

  console.log('路径          总耗时(ms)  平均(ms/retrieve)  相对');
  console.log('───────────  ──────────  ────────────────  ──────');
  console.log(`关(线性扫描)  ${String(rOff.ms).padStart(9)}  ${String(avgOff.toFixed(2)).padStart(15)}  ${'█'.repeat(10)}`);
  console.log(
    `开(矩阵)      ${String(rOn.ms).padStart(9)}  ${String(avgOn.toFixed(2)).padStart(15)}  ${'█'.repeat(Math.max(1, Math.round((rOn.ms / rOff.ms) * 10)))}`,
  );
  console.log(`\n平均加速：${speedup.toFixed(2)}×`);
  console.log(`top-1 一致性（开 vs 关）：${sameTop1 ? '一致 ✅' : '❌ 不一致'}`);

  rmSync(off.dir, { recursive: true, force: true });
  rmSync(on.dir, { recursive: true, force: true });

  console.log('\n结论：');
  if (avgOn > avgOff * 1.2) {
    console.log('⚠ 开路径明显慢于关路径（应 ≤ 1.2×），请检查矩阵实现');
    process.exit(1);
  }
  if (!sameTop1) {
    console.log('⚠ 开路径 top-1 与关路径不一致，向量化召回结果异常');
    process.exit(1);
  }
  console.log(`- vectorIndex 开路径无回退（${avgOn.toFixed(2)} ≤ ${avgOff.toFixed(2)}×1.2）；召回结果与线性扫描一致。`);
  console.log(`- 矩阵在版本不变时仅构建一次，稳态单轮召回≈一次矩阵-向量点积（O(N) 但常数更低）。\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
