/**
 * Spike: 实证 BGE embedding 是否启动。
 * 直接调用 createEmbedder('local').embed('测试')，观察返回：
 *  - 返回 number[] → BGE 模型已加载，语义向量可用；
 *  - 返回 null     → 模型未下载 / 网络不可达 → embed() 优雅降级返回 null，
 *                    retriever 退化为关键词召回（语义检索形同虚设）。
 * 运行：先 esbuild 转 .mjs 再 node（tsx 解析不了 Pi 的 exports，这里虽不用 Pi 也统一走 esbuild）。
 */
import { createEmbedder } from '../src/memory/embedder-backend.ts';

async function main(): Promise<void> {
  console.log('[spike-bge] mode=local, calling embed("测试") ...');
  const embedder = createEmbedder('local', { mirror: false });
  const t0 = Date.now();
  const vec = await embedder.embed('测试');
  const dt = Date.now() - t0;
  if (vec && Array.isArray(vec) && vec.length > 0) {
    console.log(`[spike-bge] RESULT: vector (len=${vec.length}) — BGE 已启动，语义召回可用`);
  } else {
    console.log(`[spike-bge] RESULT: null (耗时 ${dt}ms) — embed() 降级，retriever 仅关键词召回`);
  }
}

main().catch((e) => {
  console.error('[spike-bge] ERROR:', e);
  process.exit(1);
});
