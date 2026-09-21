/**
 * 内核装配 —— 把五子系统组装成一个可运行的 AgentKernel（取代旧 app/assemble.ts）。
 *
 * P0 迁移期约定：
 *   - 旧的 /model flash|pro 语义映射为 actor 角色的两个模型身份
 *     （flash→v4-flash 不思考；pro→v4-pro 思考 high），交互零改动；
 *   - critic/cheap 角色默认与 actor 同配置（P2 引入异厂商路由后由配置文件覆盖）；
 *   - API Key 显式传参进 ModelHub，**不再写 process.env**；
 *   - bash 子进程 env 已做凭证剥离（tools/atomic.ts scrubEnv）。
 */
import { createRequire } from 'node:module';
import { ModelHub, type HubConfig } from './provider/hub.ts';
import { OutboundLedger } from './provider/ledger.ts';
import { createOpenAICompatAdapter } from './provider/openai-compat.ts';
import { ToolRegistry } from './tools/registry.ts';
import { createCoreTools } from './tools/atomic.ts';
import { AgentKernel } from './loop/kernel.ts';
import { TraceSink } from './trace/sink.ts';
import { getMode } from '../config/model-mode.ts';
import type { Credentials } from '../auth/credentials.ts';

const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-flash', label: 'Flash（日常）', contextWindow: 128_000, supportsThinking: false },
  { id: 'deepseek-v4-pro', label: 'PRO（深度推理）', contextWindow: 128_000, supportsThinking: true },
];

export interface AssembledApp {
  kernel: AgentKernel;
  hub: ModelHub;
  registry: ToolRegistry;
  ledger: OutboundLedger;
  trace: TraceSink;
  version: string;
  workspace: string;
  modelName: string;
}

export async function assembleKernel(
  creds: Credentials,
  opts: { workspace: string; protectedRoots: string[] },
): Promise<AssembledApp> {
  const workspace = opts.workspace;
  const ledger = new OutboundLedger();
  const trace = new TraceSink();
  trace.start({ workspace, version: pkgVersion() });

  const baseURL = creds.baseURL || 'https://api.deepseek.com/v1';
  const hub = new ModelHub(
    hubConfig(creds, baseURL),
    ledger,
  );
  hub.register(
    createOpenAICompatAdapter({
      id: 'deepseek',
      baseURL,
      models: DEEPSEEK_MODELS,
    }),
  );

  const registry = new ToolRegistry();
  for (const t of createCoreTools()) registry.register(t);

  const kernel = new AgentKernel({
    hub,
    registry,
    cwd: workspace,
    protectedRoots: opts.protectedRoots,
    trace,
    // 惰性：/model 切换后下一轮的提示词与路由即反映新模型
    modelName: currentActorLabel,
  });

  return {
    kernel,
    hub,
    registry,
    ledger,
    trace,
    version: pkgVersion(),
    workspace,
    modelName: currentActorLabel(),
  };
}

/** 当前模式 → actor 模型身份（flash/pro 沿用旧 /model 语义） */
function actorBinding(creds: Credentials): { model: string; thinking: 'off' | 'high' } {
  const mode = getMode();
  if (mode === 'pro') {
    return { model: creds.reasonerModel || 'deepseek-v4-pro', thinking: 'high' };
  }
  return { model: creds.model || 'deepseek-v4-flash', thinking: 'off' };
}

function currentActorLabel(): string {
  const m = getMode();
  return m === 'pro' ? 'deepseek-v4-pro（PRO 深度推理）' : 'deepseek-v4-flash（Flash 日常）';
}

function hubConfig(creds: Credentials, baseURL: string): HubConfig {
  const actor = actorBinding(creds);
  const primary = { provider: 'deepseek', model: actor.model, thinking: actor.thinking };
  return {
    routing: {
      actor: primary,
      // P0：三角色同绑；P2 由 ~/.dsa/config.json 覆盖为异厂商 critic / 低价 cheap
      critic: primary,
      cheap: { provider: 'deepseek', model: creds.model || 'deepseek-v4-flash', thinking: 'off' },
    },
    keys: { deepseek: creds.apiKey },
  };
}

function pkgVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string };
    return `v${pkg.version ?? '0.0.0'}`;
  } catch {
    return 'v0.0.0';
  }
}
