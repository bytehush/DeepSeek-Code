import os from 'node:os';
import { join } from 'node:path';
import type { MemoryEntry, TrashItem } from './types.ts';
import { createMemoryBackend } from './backend.ts';
import type { MemoryBackend } from './backend.ts';
import type { EmbedderBackend } from './embedder-backend.ts';
import { composeSystemPrompt } from './composer.ts';
import type { ScoredMemory } from './retriever.ts';
import type { MemoryService } from './service.ts';
import { MemoryPipeline } from './pipeline.ts';
import { extractUserMemories } from './extractor.ts';
import { reviseMemories, type ReviseResult } from './revise.ts';
import type { DeepSeekClient } from '../llm/deepseek.ts';
import type { ConversationHistory } from '../context/history.ts';

/**
 * 记忆编排器（M3 · 解决 L1「模块级守卫」）。
 *
 * 与 `MemoryManager` 同实现 `MemoryService`，聚合 user/project 两层 `MemoryBackend`，
 * 对外 API 完全镜像 `MemoryManager`。唯一行为差异：抽取/整理的「只跑一次」守卫从
 * chat.ts 的**模块级**变量上移到**本实例级**字段（`_extracted`/`_revised`），从而：
 *   - 长驻 GUI 进程每任务（每 kernel 实例）独立守卫，不再被旧模块级守卫「全局只跑一次」
 *     拖垮（旧 chat.ts 在 GUI 长驻时抽取/整理只触发一次后永不跑）；
 *   - 子 Agent 各自隔离实例，互不污染；
 *   - `onDispose()` 置 `_disposed`，释放后任何抽取/整理都安全降级为 0/null。
 *
 * 聚合逻辑与 `MemoryManager` 逐字一致（含 compose 的 VECTOR_MIN_SCORE 阈值），
 * 由影子比对单测守护两者等价（flag=false 走 Manager 逐字节一致）。
 */
export class MemoryOrchestrator implements MemoryService {
  readonly user: MemoryBackend;
  readonly project: MemoryBackend;

  /** 实例级守卫：抽取/整理只跑一次（替代旧 chat.ts 模块级守卫）。 */
  private _extracted = false;
  private _revised = false;
  /** 资源已释放标记：onDispose 后置位，阻止后续任何抽取/整理。 */
  private _disposed = false;

  /** 每轮语义召回管线（M5 · P2a 修复 L2 boot-only 冻结）。 */
  private readonly pipeline = new MemoryPipeline(this);

  constructor(cwd: string, embedder: EmbedderBackend) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
    this.user = createMemoryBackend(join(home, '.dsa', 'memory'), embedder);
    this.project = createMemoryBackend(join(cwd, '.dsa', 'memory'), embedder);
  }

  loadFacts(): { user: string; project: string } {
    return { user: this.user.loadFacts(), project: this.project.loadFacts() };
  }

  addFact(text: string, scope: 'user' | 'project' = 'project'): void {
    (scope === 'user' ? this.user : this.project).addFact(text);
  }

  async addEntry(content: string, tags?: string[], scope: 'user' | 'project' = 'project'): Promise<MemoryEntry> {
    return (scope === 'user' ? this.user : this.project).addEntry(content, tags);
  }

  list(): Array<{ scope: 'user' | 'project'; entry: MemoryEntry }> {
    return [
      ...this.project.list().map((entry) => ({ scope: 'project' as const, entry })),
      ...this.user.list().map((entry) => ({ scope: 'user' as const, entry })),
    ];
  }

  forget(idPrefix: string, scope: 'user' | 'project'): boolean {
    return (scope === 'user' ? this.user : this.project).forget(idPrefix);
  }

  listTrash(): Array<{ scope: 'user' | 'project'; item: TrashItem }> {
    return [
      ...this.project.listTrash().map((item) => ({ scope: 'project' as const, item })),
      ...this.user.listTrash().map((item) => ({ scope: 'user' as const, item })),
    ];
  }

  restore(trashId: string, scope: 'user' | 'project'): boolean {
    return (scope === 'user' ? this.user : this.project).restore(trashId);
  }

  purgeTrash(scope?: 'user' | 'project'): void {
    if (!scope || scope === 'user') this.user.purgeTrash();
    if (!scope || scope === 'project') this.project.purgeTrash();
  }

  async retrieve(query: string, k = 5): Promise<MemoryEntry[]> {
    const [u, p] = await Promise.all([this.user.retrieve(query, k), this.project.retrieve(query, k)]);
    return [...p, ...u].slice(0, k);
  }

  async queryScored(query: string, k = 5): Promise<ScoredMemory[]> {
    const [u, p] = await Promise.all([this.user.queryScored(query, k), this.project.queryScored(query, k)]);
    return [...p, ...u];
  }

  async isDuplicate(content: string): Promise<boolean> {
    return (await this.user.isDuplicate(content)) || (await this.project.isDuplicate(content));
  }

  async compose(base: string, query: string, k = 5): Promise<string> {
    const facts = this.loadFacts();
    if (!query) return composeSystemPrompt(base, facts.user, facts.project, []);
    const scored = await this.queryScored(query, k);
    const VECTOR_MIN_SCORE = 0.3;
    const retrieved = scored
      .filter((s) => s.mode === 'keyword' || s.score >= VECTOR_MIN_SCORE)
      .map((s) => s.entry);
    return composeSystemPrompt(base, facts.user, facts.project, retrieved);
  }

  /** 每轮重算语义召回（M5 · P2a 修复 L2 boot-only 冻结）。 */
  async composeForTurn(base: string, query: string, k = 5): Promise<string> {
    return this.pipeline.composeForTurn(base, query, k);
  }

  /** 会话结束自动抽取用户偏好（幂等实例守卫；释放后不再抽取）。 */
  async extractAtTurnEnd(history: ConversationHistory, client: DeepSeekClient): Promise<number> {
    if (this._disposed || this._extracted || !client) return 0;
    this._extracted = true;
    return extractUserMemories(client, history, this).catch(() => 0);
  }

  /**
   * 会话结束自动整理记忆（陈旧性治理，带节流 + 幂等实例守卫）。
   * `force=true` 跳过守卫与节流（/dream 手动整理用）；否则守卫保证自动路径只跑一次。
   * 释放后返回 null。
   */
  async revise(
    client: DeepSeekClient,
    opts: { recentContext?: string; force?: boolean } = {},
  ): Promise<ReviseResult | null> {
    if (this._disposed) return null;
    if (!opts.force) {
      if (this._revised || !client) return null;
      this._revised = true;
    }
    return reviseMemories(client, this, { recentContext: opts.recentContext, force: opts.force }).catch(() => null);
  }

  /** 资源释放：置 disposed，阻止后续抽取/整理（M8 异步 I/O 阶段扩展落盘 flush）。 */
  onDispose(): void {
    this._disposed = true;
  }
}
