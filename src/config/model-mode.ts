// 模型模式：控制 Agent「主推理环 + 所有工具」使用哪一类模型。
//
// 设计背景（2026-07-26 架构重设计）：
//   早期「双核自动路由」由系统按复杂度自动判断 Flash/PRO，实测不可靠（短句误判、
//   绕开工具、死循环）。本次改为**用户手动切换**——主动权交回用户。
//
// 两种模式（中文展示名，命令 token 仍是 flash / pro）：
//   flash —— Flash（日常/轻量）：主模型 deepseek-v4-flash，不触发思考。
//            用于快速问答、解释代码、简单改错、跑命令看输出、成本敏感多轮。
//   pro   —— PRO（开发/严肃工程）：推理模型 deepseek-v4-pro，触发思考（reasoning）。
//            用于架构设计、跨文件重构、深度审查、依赖审计、多步规划、需深度推理的生成。
//
// 关键约定：
//   - 「日常」不是「非开发」，而是「轻量交互」——coding agent 里几乎所有事都是开发，
//     区别在你要不要动用强推理。
//   - 模式为「会话级 + 持久化」：整个会话一个模式，可随时切换；写入 <cwd>/.dsa/model-mode.json，
//     下次启动沿用。默认 flash。
//   - 显式 modelOverride（如 history/memory 系统任务固定用 primaryModel）始终优先于模式。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ModelMode = 'flash' | 'pro';

const VALID: ModelMode[] = ['flash', 'pro'];
const DEFAULT_MODE: ModelMode = 'flash';

// 模块级单例：CLI / GUI 共享同一进程内的当前模式。
let currentMode: ModelMode = DEFAULT_MODE;
let initialized = false;

function modeFile(cwd: string): string {
  return join(cwd, '.dsa', 'model-mode.json');
}

/** 启动时从磁盘加载（缺省 flash）。CLI 与 GUI 在构造 client 前应调用一次。 */
export function initModelMode(cwd: string): ModelMode {
  try {
    const raw = readFileSync(modeFile(cwd), 'utf8');
    const parsed = JSON.parse(raw) as { mode?: unknown };
    if (typeof parsed.mode === 'string' && (VALID as string[]).includes(parsed.mode)) {
      currentMode = parsed.mode as ModelMode;
    }
  } catch {
    // 文件不存在或解析失败 → 保持默认 flash
  }
  initialized = true;
  return currentMode;
}

/**
 * 读取当前模式。
 * 若尚未 init（调用方忘记启动加载），则惰性从 process.cwd() 加载一次，避免重复读盘。
 */
export function getMode(): ModelMode {
  if (!initialized) initModelMode(process.cwd());
  return currentMode;
}

/** 设置并持久化模式（目录自动创建）。写入失败不阻断会话。 */
export function setMode(cwd: string, mode: ModelMode): void {
  currentMode = mode;
  const fp = modeFile(cwd);
  try {
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify({ mode }), 'utf8');
  } catch {
    // 写入失败不阻断会话（仅丢失偏好持久化）
  }
  initialized = true;
}

/** 校验用户输入的模式字符串是否合法。 */
export function parseMode(input: string): ModelMode | null {
  const v = input.trim().toLowerCase();
  return (VALID as string[]).includes(v) ? (v as ModelMode) : null;
}

/** 模式中文标签（用于状态栏 / 提示）。 */
export function modeLabel(mode: ModelMode): string {
  return mode === 'flash' ? 'Flash（日常）' : 'PRO（开发）';
}

/**
 * 根据模式解析实际使用的模型与思考配置。
 * - flash：主模型，不触发思考；
 * - pro：推理模型（未配置则回退 deepseek-v4-pro），触发思考（reasoning）。
 *
 * @param mode  当前模式
 * @param creds 提供 model / reasonerModel 两个可配置身份
 */
export function resolveModelConfig(
  mode: ModelMode,
  creds: { model: string; reasonerModel?: string },
): { model: string; reasoning?: 'low' | 'medium' | 'high' } {
  if (mode === 'pro') {
    return { model: creds.reasonerModel || 'deepseek-v4-pro', reasoning: 'high' };
  }
  return { model: creds.model };
}
