/**
 * 内核装配（CLI 共用的「组装」逻辑）。
 *
 * 极简模式：只装配「Pi 持久化 Agent + 4 个 stock-Pi 原子工具 + DeepSeek Models」，
 * 不接记忆 / 技能 / 多 Agent 会话 / Trace / 账户体系。UI 形态（TUI）直接消费本结果。
 */
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { SYSTEM_PROMPT } from '../agent/system-prompt.ts';
import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAtomicTools } from '../agent/pi-tools.ts';
import { getMode } from '../config/model-mode.ts';
import type { Credentials } from '../auth/credentials.ts';
import type { AppProps } from './types.ts';

/**
 * 装配一份最小 AppProps（内核服务已初始化，可直接交给 TUI）。
 *
 * @param creds    DeepSeek 凭证（apiKey 等）
 * @param opts.workspace  agent 真正「编辑/浏览」的代码项目目录（文件工具、bash 的工作根）。
 *                       - 不传 → process.cwd()（CLI 直接在该目录运行）。
 */
export async function assembleAppProps(
  creds: Credentials,
  opts?: { workspace?: string },
): Promise<AppProps> {
  const workspace = opts?.workspace ?? process.cwd();

  // 凭证注入 Pi 所需的 DEEPSEEK_API_KEY 环境变量（deepseekProvider 走 envApiKeyAuth）
  process.env.DEEPSEEK_API_KEY = creds.apiKey;

  const models = createModels();
  models.setProvider(deepseekProvider());
  const modelId = getMode() === 'pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
  const piModel = models.getModel('deepseek', modelId);
  if (!piModel) {
    throw new Error(`Pi 模型未找到: deepseek/${modelId}`);
  }

  // 持久化 Agent：跨轮累积上下文；工具 = stock-Pi 4 原子工具，操作 workspace。
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: piModel,
      thinkingLevel: 'off',
      tools: createAtomicTools({ cwd: workspace }),
    },
    streamFn: models.streamSimple.bind(models),
    toolExecution: 'sequential',
  });

  const version = `v${(createRequire(import.meta.url)('../../package.json').version as string) ?? '0.1.0'}`;

  return { agent, models, version };
}
