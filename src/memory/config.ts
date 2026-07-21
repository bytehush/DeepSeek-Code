import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 记忆系统 feature flag 载体（M3 起引入，分阶段灰度）。
 *
 * 优先级（后者覆盖前者）：
 *   1. 代码默认值（DEFAULTS）
 *   2. 文件 `~/.dsa/memory-config.json`（JSON，布尔字段）
 *   3. 环境变量 `DSA_MEMORY_FLAGS`（CSV，如 `useOrchestrator,factScopeUser=true`；
 *      只写键名等价于 true，`key=false` 显式关）
 *
 * 各 flag 含义与默认：
 * - `memoryInterfaces`  M1 接口抽象（默认 true，no-op 迁移开关）
 * - `useOrchestrator`   M3 用 MemoryOrchestrator 替代 MemoryManager（默认 false = 旧路径）
 * - `factScopeUser`     M4 fact 写用户级全局（默认 false = 项目级）
 * - `perTurnCompose`    M5 每轮重算语义召回（默认 false = 仅启动预取）
 * - `sharedGuiBackend`  M6 GUI 复用同一后端实例（默认 false = 独立实例）
 * - `embedderMirror`    M7 embedder 走中科大写像/远程（默认 false = 直连 HF）
 * - `asyncBackend`      M8 记忆库异步 I/O（默认 true = fs/promises 不阻塞事件循环；
 *                        false = 同步 fs 回退，输出逐字节一致，作安全锚点）
 * - `vectorIndex`       M9 向量化检索（默认 false = 线性扫描现状；true = 预计算归一化矩阵
 *                        + 版本门控缓存 + query 向量缓存，召回结果与 cosine 等价、延迟更低）
 *
 * 默认全 false（除 memoryInterfaces / asyncBackend），保证每个行为变更阶段在 flag 关闭时
 * 与旧路径逐字节一致，可作安全回退锚点。asyncBackend 默认 true 是因为它只改变 I/O 实现、
 * 不改变可观察行为，M8 的全部收益（不阻塞事件循环 / 批量嵌入 / 预热）都来自异步路径。
 * vectorIndex 默认 false 因它改变召回实现路径（虽结果等价），先以 flag 关作安全锚点。
 */
export interface MemoryConfig {
  memoryInterfaces: boolean;
  useOrchestrator: boolean;
  factScopeUser: boolean;
  perTurnCompose: boolean;
  sharedGuiBackend: boolean;
  embedderMirror: boolean;
  asyncBackend: boolean;
  vectorIndex: boolean;
}

const DEFAULTS: MemoryConfig = {
  memoryInterfaces: true,
  useOrchestrator: false,
  factScopeUser: false,
  perTurnCompose: false,
  sharedGuiBackend: false,
  embedderMirror: false,
  asyncBackend: true,
  vectorIndex: false,
};

const ENV_KEY = 'DSA_MEMORY_FLAGS';

/** 读取 flag：默认 → 文件 → 环境变量，逐级覆盖。任一来源损坏均安全回落默认。 */
export function loadMemoryConfig(): MemoryConfig {
  const cfg: MemoryConfig = { ...DEFAULTS };

  // 1) 文件 ~/.dsa/memory-config.json
  try {
    const path = join(homedir(), '.dsa', 'memory-config.json');
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoryConfig>;
      for (const key of Object.keys(DEFAULTS) as (keyof MemoryConfig)[]) {
        if (typeof raw[key] === 'boolean') {
          (cfg as Record<keyof MemoryConfig, boolean>)[key] = raw[key];
        }
      }
    }
  } catch {
    /* 配置损坏：忽略，回落默认 */
  }

  // 2) 环境变量 DSA_MEMORY_FLAGS（CSV）
  const env = process.env[ENV_KEY];
  if (env) {
    for (const part of env.split(',')) {
      const tok = part.trim();
      if (!tok) continue;
      const eq = tok.split('=');
      const key = eq[0].trim() as keyof MemoryConfig;
      if (!(key in DEFAULTS)) continue;
      const val = eq[1]?.trim();
      (cfg as Record<keyof MemoryConfig, boolean>)[key] = val === undefined ? true : val === 'true' || val === '1';
    }
  }

  return cfg;
}
