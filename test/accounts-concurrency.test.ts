import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

describe('accounts.json 并发安全（修复刷新回登录的根因）', () => {
  async function withTempHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const originalHome = homedir();
    const dir = await mkdtemp(join(tmpdir(), 'dsa-accts-'));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir; // Windows  fallback
    try {
      return await fn(dir);
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalHome;
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('并发 issueToken 后所有 token 都能 verifyToken（无 race 丢失）', async () => {
    await withTempHome(async () => {
      // 动态 import 让 ACCOUNTS_PATH 使用临时 HOME
      const { issueToken, verifyToken } = await import('../src/auth/accounts.ts');
      const N = 30;
      const tokens = await Promise.all(
        Array.from({ length: N }, (_, i) => issueToken(`u_${i}`)),
      );
      const verified = await Promise.all(tokens.map((t) => verifyToken(t)));
      assert.strictEqual(
        verified.filter(Boolean).length,
        N,
        `并发签发的 ${N} 个 token 必须全部可验证，否则说明 accounts.json 写冲突导致丢失`,
      );
    });
  });

  test('并发 issueToken + verifyToken 不损坏 accounts.json', async () => {
    await withTempHome(async (dir) => {
      const { issueToken, verifyToken } = await import('../src/auth/accounts.ts');
      const N = 20;

      // 先签发一批 token
      const tokens = await Promise.all(
        Array.from({ length: N }, (_, i) => issueToken(`mix_${i}`)),
      );

      // 同时并发：再签发新 token + 验证旧 token（模拟登录与刷新 resume 并发）
      await Promise.all([
        ...Array.from({ length: N }, (_, i) => issueToken(`extra_${i}`)),
        ...tokens.map((t) => verifyToken(t)),
      ]);

      // 关键断言：accounts.json 必须是合法 JSON
      const fs = await import('node:fs/promises');
      const path = join(dir, '.dsa', 'accounts.json');
      const txt = await fs.readFile(path, 'utf8');
      let parsed: Record<string, unknown>;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(txt);
      }, 'accounts.json 在并发读写后必须是合法 JSON，否则说明 writeFile 发生重叠损坏');

      const sessions = (parsed! as { sessions?: Record<string, unknown> }).sessions ?? {};
      assert.strictEqual(Object.keys(sessions).length, N * 2, '应保留全部 2N 个会话');

      // 旧 token 仍可验证
      const reVerified = await Promise.all(tokens.map((t) => verifyToken(t)));
      assert.strictEqual(reVerified.filter(Boolean).length, N, '旧 token 在并发后仍应全部有效');
    });
  });

  test('并发 issueToken 不会产生孤儿 accounts.json.lock 文件', async () => {
    await withTempHome(async (dir) => {
      const { issueToken } = await import('../src/auth/accounts.ts');
      await Promise.all(Array.from({ length: 10 }, (_, i) => issueToken(`lock_${i}`)));
      const lockPath = join(dir, '.dsa', 'accounts.json.lock');
      await assert.rejects(
        access(lockPath),
        '锁应在操作完成后释放并删除，不能残留',
      );
    });
  });
});
