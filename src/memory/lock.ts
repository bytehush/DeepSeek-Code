import { openSync, writeSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { open, unlink, stat } from 'node:fs/promises';

/**
 * M10 crossProcLock：跨进程 advisory lock（文件锁）。
 *
 * 为什么不用 fcntl/flock：GUI 与 CLI 同跑在 Windows 上，Node 无内建 flock/fcntl，且本环境
 * 规避原生依赖。故采用「独占创建锁文件」的跨平台锁文件方案：
 * - 获取 = 以 `wx`（exclusive create）原子创建 `.dsa-lock`；成功即持锁，写入 pid+时间戳。
 * - 释放 = unlink 锁文件。
 * - 过期恢复：若锁文件 mtime 早于 staleMs（如持锁进程崩溃未释放），获取前先 break 掉，
 *   避免死锁。
 *
 * 同步 / 异步双实现：记忆后端 async 模式（默认）用异步 acquire/release；sync 回退模式用
 * 同步 acquireSync/releaseSync（忙等短歇）。同一临界区只在一端生效，不会重复加锁。
 *
 * 注意：锁文件在每次「读-改-写」临界区前后创建/删除，会多两次文件 I/O；属边缘场景优化
 * （仅 GUI+CLI 同写一 scope 时才有意义），默认关闭（crossProcLock=false）零开销。
 */
export class FileLock {
  private held = false;

  constructor(
    private readonly lockPath: string,
    /** 锁文件被视为过期的时间阈值（ms），用于崩溃恢复。 */
    private readonly staleMs = 30_000,
  ) {}

  private isStaleSync(): boolean {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs > this.staleMs;
    } catch {
      return false; // 不存在或不可读 → 视为无锁
    }
  }

  private async isStale(): Promise<boolean> {
    try {
      const st = await stat(this.lockPath);
      return Date.now() - st.mtimeMs > this.staleMs;
    } catch {
      return false;
    }
  }

  private async breakStale(): Promise<void> {
    if (await this.isStale()) await unlink(this.lockPath).catch(() => {});
  }

  private breakStaleSync(): void {
    if (this.isStaleSync()) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 异步获取锁；超时未获返回 false。获取成功返回 true（之后须 release）。 */
  async acquire(timeoutMs = 10_000, retryMs = 25): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      await this.breakStale();
      try {
        const fh = await open(this.lockPath, 'wx');
        await fh.write(`${process.pid}:${Date.now()}`);
        await fh.close();
        this.held = true;
        return true;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'EEXIST') {
          if (Date.now() > deadline) return false;
          await new Promise((r) => setTimeout(r, retryMs));
          continue;
        }
        throw e;
      }
    }
  }

  /** 同步获取锁（sync 回退模式用）；超时未获返回 false。 */
  acquireSync(timeoutMs = 2_000, retryMs = 10): boolean {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      this.breakStaleSync();
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeSync(fd, `${process.pid}:${Date.now()}`);
        closeSync(fd);
        this.held = true;
        return true;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'EEXIST') {
          if (Date.now() > deadline) return false;
          // 忙等短歇（sync 模式为安全回退，锁争用极少见）
          const end = Date.now() + retryMs;
          while (Date.now() < end) {
            /* spin */
          }
          continue;
        }
        throw e;
      }
    }
  }

  /** 异步释放锁。 */
  async release(): Promise<void> {
    if (!this.held) return;
    await unlink(this.lockPath).catch(() => {});
    this.held = false;
  }

  /** 同步释放锁。 */
  releaseSync(): void {
    if (!this.held) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* 忽略 */
    }
    this.held = false;
  }
}
