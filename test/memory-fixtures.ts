/**
 * 记忆子系统单测样本数据。
 *
 * 设计要点：中英混排、贴近真实使用场景；纯数据、无逻辑。
 * 被 backend.test.ts / 后续 extractor·intent 单测复用，作为可重复断言的基准。
 */

/** 用户级常驻事实样本（~/.dsa/memory，跨项目共享的偏好）。 */
export const SAMPLE_USER_FACTS = [
  '偏好使用 pnpm 而非 npm 管理依赖',
  '喜欢深色主题的代码编辑器',
];

/** 项目级常驻事实样本（<cwd>/.dsa/memory，仅当前项目有效）。 */
export const SAMPLE_PROJECT_FACTS = [
  '本项目使用 TypeScript + Node 构建',
  '记忆系统采用轻量 RAG 双轨架构',
];

/** 语义记忆样本（写入 memories.json，带 embedding 缓存）。 */
export const SAMPLE_ENTRIES = [
  '今天和 AI 一起重构了记忆子系统的抽象层',
  '用户要求每个逻辑改动都必须独立 commit 并打 tag',
];

/** 含显式记忆指令的对话片段，供 intent / extractor 单测使用。 */
export const SAMPLE_TRANSCRIPT_WITH_MEMORY = [
  '用户: 记一下，我偏好用 pnpm',
  '助手: 好的，已记住你偏好 pnpm',
];
