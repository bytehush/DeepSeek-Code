/**
 * M10 crossProcLock 测试：跨进程 advisory lock 防 GUI+CLI 同写一 scope 互盖。
 *
 * 锁定：
 * - FileLock 互斥：两实例无法同时持锁（一持锁另一超时失败，释放后可获取）。
 * - 开：两实例同目录并发 addEntry，磁盘 memories.json 不丢数据（锁序列化临界区 + 持锁后
 *   强制从磁盘重读，杜绝「读陈旧缓存→覆盖对方写入」的丢失更新）。
 * - 关（默认）：不做跨实例原子保证（仅验证基本往返不崩），与现状一致。
 *
 * 隔离：同 backend.test.ts，模块顶层把 HOME 指向临时目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.ts';
import { Embedder } from '../src/memory/embedder.ts';
import { FileLock } from '../src/memory/lock.ts';

const SHARED_HOME = mkdtempSync(join(os.tmpdir(), 'dsa-home-lock-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SHARED_HOME;
process.on('exit', () => {
  process.env.HOME = REAL_HOME;
  rmSync(SHARED_HOME, { recursive: true, force: true });
});

function tmpStore(opts: { async?: boolean; crossProcLock?: boolean }) {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-lock-'));
  const store = new MemoryStore(dir, new Embedder({ mode: 'off' }), opts);
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('FileLock 互斥：持锁期间另一获取超时失败，释放后可获取', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-lockfile-'));
  const lp = join(dir, '.dsa-lock');
  const a = new FileLock(lp);
  const b = new FileLock(lp);
  try {
    assert.equal(await a.acquire(), true, 'a 应获取锁');
    assert.ok(existsSync(lp), '持锁期间锁文件应存在');
    assert.equal(await b.acquire(200, 10), false, 'b 在 a 持锁时应超时失败');
    await a.release();
    assert.equal(await b.acquire(), true, 'a 释放后 b 应获取');
    await b.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crossProcLock 开：两实例同目录并发 addEntry 磁盘不丢数据', async () => {
  const { store: a, dir, cleanup } = tmpStore({ async: true, crossProcLock: true });
  const b = new MemoryStore(dir, new Embedder({ mode: 'off' }), { async: true, crossProcLock: true });
  try {
    const N = 40;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) => a.addEntry(`A${i}`)),
      ...Array.from({ length: N }, (_, i) => b.addEntry(`B${i}`)),
    ]);
    // 磁盘是跨进程真相：锁序列化临界区 + 持锁后强制重读，杜绝丢失更新
    const onDisk = JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8')) as unknown[];
    assert.equal(onDisk.length, 2 * N, `两实例并发写应无丢失，实际 ${onDisk.length}`);
    // 空闲时段锁文件应已释放（锁是每临界区获取/释放，不常驻）
    assert.equal(existsSync(join(dir, '.dsa-lock')), false, '空闲时锁文件应已释放');
  } finally {
    await a.onDispose().catch(() => {});
    await b.onDispose().catch(() => {});
    cleanup();
  }
});

test('crossProcLock 开：单实例基本往返（add/forget/restore）正确', async () => {
  const { store, cleanup } = tmpStore({ async: true, crossProcLock: true });
  try {
    const e = await store.addEntry('受锁保护的记忆');
    assert.equal((await store.list()).length, 1);
    assert.equal(await store.forget(e.id.slice(0, 8)), true);
    assert.equal((await store.list()).length, 0);
    const trash = await store.listTrash();
    assert.equal(trash.length, 1);
    assert.equal(await store.restore(trash[0].trashId), true);
    assert.equal((await store.list()).length, 1);
  } finally {
    await store.onDispose().catch(() => {});
    cleanup();
  }
});

test('crossProcLock 关（默认）：基本往返不崩，锁文件从不创建', async () => {
  const { store, dir, cleanup } = tmpStore({ async: true });
  try {
    await store.addEntry('无锁记忆');
    await store.addEntry('又一条');
    assert.equal((await store.list()).length, 2);
    assert.equal(existsSync(join(dir, '.dsa-lock')), false, '关锁时不应有锁文件');
  } finally {
    await store.onDispose().catch(() => {});
    cleanup();
  }
});
