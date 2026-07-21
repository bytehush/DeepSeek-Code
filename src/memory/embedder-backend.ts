import type { EmbedMode } from './embedder.ts';
import { BgeEmbedder, NullEmbedder, RemoteEmbedder } from './embedder.ts';

/**
 * 嵌入器后端接口（M1 架构抽象 · 解决 L7「无接口抽象」）。
 *
 * 唯一职责：文本 → 向量（或优雅降级为 null）。
 * 当前唯一实现是 BgeEmbedder（进程内本地 BGE 中文模型）；
 * 后续阶段可加 RemoteEmbedder（API）、FakeEmbedder（测试）等。
 */
export interface EmbedderBackend {
  /** 文本 → 向量（长度 768）；失败 / 离线 / 关闭 → 返回 null。 */
  embed(text: string): Promise<number[] | null>;
}

export interface CreateEmbedderOpts {
  /** 是否启用 HF 镜像（透传给 BgeEmbedder / RemoteEmbedder 的本地降级路径）。 */
  mirror?: boolean;
}

/**
 * 工厂：按模式 + flag 构造嵌入器。作为依赖注入点，调用方统一经此创建，
 * 后续阶段替换实现时调用方零改动（解决 L7 可替换性）。
 * - mode 'off'   → NullEmbedder（恒 null，关键词召回）
 * - mode 'remote'→ RemoteEmbedder（有 key 走远程，否则降级本地 BGE）
 * - 其他（'local'/undefined）→ BgeEmbedder（默认本地 BGE）
 */
export function createEmbedder(mode?: EmbedMode, opts?: CreateEmbedderOpts): EmbedderBackend {
  if (mode === 'off') return new NullEmbedder();
  if (mode === 'remote') return new RemoteEmbedder({ mirror: opts?.mirror });
  return new BgeEmbedder({ mode, mirror: opts?.mirror });
}
