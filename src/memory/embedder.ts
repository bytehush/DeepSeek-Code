/**
 * 轻量嵌入器：把文本变成向量（对标我们聊过的 Embedding 原理）。
 *
 * ⚠️ 重要事实修正（2026-07-11 端到端验证发现）：
 *   DeepSeek **只有 Chat 接口，根本没有 embeddings 端点**（官方文档明确确认：
 *   "DeepSeek's OpenAI-compatible surface is Chat Completions only. There is no
 *   embeddings endpoint."）。因此本项目不依赖任何远程 embedding API。
 *
 * 改用 **本地 BGE 中文模型**（通过 @huggingface/transformers 在进程内跑 ONNX
 * 推理）：离线、免 key、中文语义强，正好契合项目「无 key 优雅降级」的设计哲学。
 *
 * 设计原则：所有失败都优雅降级——
 *   - mode='off' / 模型未下载 / 网络不可达 / 原生依赖缺失 → embed() 返回 null，
 *     调用方据此退化为「仅常驻事实 + 关键词召回」。
 *   - 模型首次使用时懒下载到本地缓存（~110MB，BGE-base-zh），之后完全离线可用。
 *
 * 这正好对应我们讨论的「轻量 RAG 预取」：只在启动时嵌入一次 query，
 * 记忆条目在写入时嵌入一次并缓存，避免每次检索都重算。
 */

import type { EmbedderBackend } from './embedder-backend.ts';

const LOCAL_MODEL = 'Xenova/bge-base-zh-v1.5';

/**
 * 中科大写像默认地址（M7，修复 L5）。
 * CN 环境直连 huggingface.co 常被墙 → 模型下载失败 → 静默退关键词、语义检索形同虚设。
 * 开启 embedderMirror 后模型下载走此镜像；也可用 env HF_ENDPOINT 覆盖默认镜像。
 */
export const DEFAULT_HF_MIRROR = 'https://hf-mirror.com';

/**
 * 解析 HF 镜像端点（M7）：
 * - env HF_ENDPOINT 优先级最高（用户自定义镜像 / 直接覆盖默认）；
 * - 否则仅在 mirror=true（embedderMirror 开启）时用默认中科大写像；
 * - 两者皆无 → 返回 undefined，调用方不动 transformers.js 的 env（维持 baseline 直连 HF 的
 *   逐字节一致行为）。
 */
export function resolveHfEndpoint(mirror: boolean): string | undefined {
  const fromEnv = process.env.HF_ENDPOINT;
  if (fromEnv) return fromEnv;
  return mirror ? DEFAULT_HF_MIRROR : undefined;
}

export type EmbedMode = 'local' | 'off' | 'remote';

export interface BgeEmbedderOpts {
  mode?: EmbedMode;
  /** 是否启用 HF 镜像（M7 embedderMirror）。开启时模型下载走镜像，CN 环境可用。 */
  mirror?: boolean;
}

export class BgeEmbedder implements EmbedderBackend {
  private mode: EmbedMode;
  private mirror: boolean;
  private extractorPromise: Promise<unknown> | null = null;

  constructor(opts?: BgeEmbedderOpts) {
    const fromEnv = process.env.EMBEDDING_MODE as EmbedMode | undefined;
    this.mode = opts?.mode ?? fromEnv ?? 'local';
    this.mirror = opts?.mirror ?? false;
  }

  /** 懒加载 transformers.js 的特征抽取管线（只加载一次）。 */
  private getExtractor(): Promise<unknown> {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        // 用变量说明符做动态 import：即便依赖未安装也能通过 tsc 类型检查，
        // 运行时若已 npm install 则正常加载。
        const spec = '@huggingface/transformers';
        const mod = (await import(spec)) as {
          pipeline: (task: string, model: string) => Promise<unknown>;
          env: { allowLocalModels: boolean; cacheDir?: string; HF_ENDPOINT?: string };
        };
        // 仅从 HuggingFace Hub 下载（本地无模型文件），允许离线后复用缓存
        mod.env.allowLocalModels = false;
        // M7: 镜像支持。env HF_ENDPOINT 优先；flag 开启时用默认中科大写像。
        // 两者皆无则不动 env（维持 baseline 直连 HF 的逐字节一致行为）。
        const endpoint = resolveHfEndpoint(this.mirror);
        if (endpoint) mod.env.HF_ENDPOINT = endpoint;
        return await mod.pipeline('feature-extraction', LOCAL_MODEL);
      })();
    }
    return this.extractorPromise;
  }

  /** 文本 → 向量（长度 768）；失败 / 离线 / 关闭 → 返回 null。 */
  async embed(text: string): Promise<number[] | null> {
    if (this.mode === 'off') return null;
    try {
      const extractor = (await this.getExtractor()) as (
        input: string,
        opts: object,
      ) => Promise<{ data: Float32Array }>;
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      const vec = Array.from(out.data) as number[];
      return vec.length > 0 ? vec : null;
    } catch {
      // 模型未下载 / 网络不可达 / 原生依赖缺失 → 降级关键词召回
      return null;
    }
  }
}

/** 关闭嵌入：embed 恒返回 null，调用方据此退化为关键词召回。供后续阶段经工厂注入。 */
export class NullEmbedder implements EmbedderBackend {
  async embed(_text: string): Promise<number[] | null> {
    return null;
  }
}

/**
 * 远程嵌入器（M7，可选）：
 * - 当配置了远程 embeddings 端点（env `DSA_EMBEDDING_URL` + `DSA_EMBEDDING_KEY`，或构造传入）
 *   时，走 OpenAI 兼容 `/embeddings` 接口；
 * - 任何失败（未配置 / 网络错误 / 非 2xx）都降级到本地 `BgeEmbedder`（再降级关键词召回），
 *   符合项目「无 key 优雅降级」哲学。未配 key 时与本地 BGE 行为完全一致。
 *
 * ⚠️ 注意：项目设计上 DeepSeek 仅有 Chat 接口、无 embeddings 端点，故远程走用户自配的
 *   第三方 OpenAI 兼容 embeddings 服务（如自建/其他厂商）。无配置即纯本地，零额外依赖。
 */
export interface RemoteEmbedderOpts {
  /** 是否让「本地降级」也走 HF 镜像（透传给 BgeEmbedder）。 */
  mirror?: boolean;
  url?: string;
  key?: string;
  model?: string;
}

export class RemoteEmbedder implements EmbedderBackend {
  private local: BgeEmbedder;
  private url?: string;
  private key?: string;
  private model: string;

  constructor(opts?: RemoteEmbedderOpts) {
    this.local = new BgeEmbedder({ mirror: opts?.mirror });
    this.url = opts?.url ?? process.env.DSA_EMBEDDING_URL;
    this.key = opts?.key ?? process.env.DSA_EMBEDDING_KEY;
    this.model = opts?.model ?? process.env.DSA_EMBEDDING_MODEL ?? LOCAL_MODEL;
  }

  async embed(text: string): Promise<number[] | null> {
    if (this.url && this.key) {
      try {
        return await this.callRemote(text);
      } catch {
        // 远程失败：降级本地 BGE（仍可能离线 → 再降级关键词召回）
        return this.local.embed(text);
      }
    }
    return this.local.embed(text);
  }

  private async callRemote(text: string): Promise<number[] | null> {
    const resp = await fetch(`${this.url}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!resp.ok) throw new Error(`remote embed http ${resp.status}`);
    const json = (await resp.json()) as { data?: { embedding: number[] }[] };
    const vec = json.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length > 0 ? vec : null;
  }
}

/** 兼容别名：保留旧名 Embedder，避免大范围改调用方（M1 零行为变更）。 */
export { BgeEmbedder as Embedder };
