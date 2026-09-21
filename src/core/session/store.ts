/**
 * 会话持久化（SessionStore）。
 *
 * 解决的真实缺陷：此前整个仓库除 credentials / output-style 外没有任何写盘路径，
 * CLI 每次启动 messages 都从空数组开始——跑完几十步的长任务一关终端，上下文全丢。
 * 这不是渲染 bug，是能力缺失（原 GUI 时代有历史回放，`6ed6596` 砍 GUI 时一并没了）。
 *
 * 设计取舍：
 *  - **只持久化内核消息列（Msg[]），不另存一份 UI 转录**。转录由事件重放
 *    现场推导（app/timeline.ts：Msg[] → events → fold，与实时渲染同一管线）。
 *    两份数据必然漂移，一份不会——与「注册表即事实源」同一类纪律。
 *  - 按工作区归集（sha1(workspace) 作文件名），在 A 项目里不会看到 B 项目的上下文。
 *  - 回合结束后整份快照落盘（非逐 token 写），一次任务几十次写盘变成一次。
 *  - 写失败降级为「不阻断会话，仅丢失持久化」，与 output-style 同策略。
 *  - 结构上不含任何密钥：只存对话内容与工具结果。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Msg } from '../types.ts';

export const SESSION_SCHEMA_VERSION = 1;

export interface SessionSnapshot {
  version: number;
  workspace: string;
  savedAt: string;
  /** 对话消息列（system 不入列——每轮现场生成，本就无需持久化） */
  messages: Msg[];
}

function baseDir(): string {
  const env = process.env.DSA_SESSION_DIR;
  return resolve(env ?? join(homedir(), '.dsa', 'sessions'));
}

function fileFor(workspace: string, dir = baseDir()): string {
  const key = createHash('sha1').update(resolve(workspace)).digest('hex').slice(0, 16);
  return join(dir, `${key}.json`);
}

export class SessionStore {
  private dir: string;
  private file: string;
  private workspace: string;

  constructor(workspace: string, opts?: { dir?: string }) {
    this.workspace = resolve(workspace);
    this.dir = opts?.dir ?? baseDir();
    this.file = fileFor(workspace, this.dir);
  }

  get path(): string {
    return this.file;
  }

  /** 读取上次会话；文件缺失/损坏/版本不符 → null（不抛，启动永不被历史文件卡住） */
  load(): Msg[] | null {
    try {
      const snap = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<SessionSnapshot>;
      if (snap.version !== SESSION_SCHEMA_VERSION || !Array.isArray(snap.messages)) return null;
      return snap.messages as Msg[];
    } catch {
      return null;
    }
  }

  /**
   * 快照当前消息列（system 一律剔除：内核列里本不该有，但恢复装载时也不依赖这一点）。
   * 失败静默——持久化是增强，不是前置条件。
   */
  save(messages: readonly Msg[]): boolean {
    const snap: SessionSnapshot = {
      version: SESSION_SCHEMA_VERSION,
      workspace: this.workspace,
      savedAt: new Date().toISOString(),
      messages: messages.filter((m) => m.role !== 'system').map((m) => ({ ...m })),
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      // 先写临时文件再 rename：进程中途被杀不会留下半截 JSON
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(snap), 'utf-8');
      renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }

  /** 删除历史文件（/clear 语义 = 彻底忘掉，下次启动也是新会话） */
  clear(): void {
    try {
      rmSync(this.file, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}
