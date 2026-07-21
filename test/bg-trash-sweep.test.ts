/**
 * M10 bgTrashSweep 后台回收站清理测试。
 *
 * 锁定两种模式行为：
 * - 关（默认）：读时清理现状——listTrash 过滤超期项，且读后磁盘 trash.json 立即只剩未超期项。
 * - 开：读路径只过滤、不内联重写（后台做）；手动 sweepTrash() 与后台 setInterval 都会清理超期项。
 *
 * 隔离：同 backend.test.ts，模块顶层把 HOME 指向临时目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.ts';
import { Embedder } from '../src/memory/embedder.ts';
import type { MemoryEntry, TrashItem } from '../src/memory/types.ts';

const SHARED_HOME = mkdtempSync(join(os.tmpdir(), 'dsa-home-sweep-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SHARED_HOME;
process.on('exit', () => {
  process.env.HOME = REAL_HOME;
  rmSync(SHARED_HOME, { recursive: true, force: true });
});

const TTL = 30 * 24 * 60 * 60 * 1000;

function tmpStore(opts: { async?: boolean; bgTrashSweep?: boolean }) {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-sweep-'));
  const store = new MemoryStore(dir, new Embedder({ mode: 'off' }), opts);
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function entry(id: string): MemoryEntry {
  return { id, content: `记忆-${id}`, createdAt: Date.now(), updatedAt: Date.now() };
}

function makeTrashFile(dir: string, items: TrashItem[]): void {
  writeFileSync(join(dir, 'trash.json'), JSON.stringify(items, null, 2), 'utf8');
}

function readTrashOnDisk(dir: string): TrashItem[] {
  const raw = readFileSync(join(dir, 'trash.json'), 'utf8');
  const arr = JSON.parse(raw);
  return Array.isArray(arr) ? arr : [];
}

const expiredEntryTrash: TrashItem = {
  trashId: 'a'.repeat(8),
  kind: 'entry',
  deletedAt: Date.now() - TTL - 1000,
  entry: entry('expired'),
};
const freshEntryTrash: TrashItem = {
  trashId: 'b'.repeat(8),
  kind: 'entry',
  deletedAt: Date.now(),
  entry: entry('fresh'),
};

test('bgTrashSweep 关（默认）：读时清理——listTrash 返回未超期，且磁盘立即只剩未超期项', async () => {
  const { store, dir, cleanup } = tmpStore({ bgTrashSweep: false });
  try {
    makeTrashFile(dir, [expiredEntryTrash, freshEntryTrash]);
    const listed = await store.listTrash();
    assert.equal(listed.length, 1, '应只返回未超期项');
    assert.equal(listed[0].trashId, freshEntryTrash.trashId);
    const onDisk = readTrashOnDisk(dir);
    assert.equal(onDisk.length, 1, '磁盘应已内联清理超期项（现状）');
    assert.equal(onDisk[0].trashId, freshEntryTrash.trashId);
  } finally {
    cleanup();
  }
});

test('bgTrashSweep 开：读路径只过滤不重写；sweepTrash 清理超期项', async () => {
  const { store, dir, cleanup } = tmpStore({ bgTrashSweep: true });
  try {
    makeTrashFile(dir, [expiredEntryTrash, freshEntryTrash]);
    const listed = await store.listTrash();
    assert.equal(listed.length, 1, '读应过滤超期项');
    assert.equal(listed[0].trashId, freshEntryTrash.trashId);

    // 开后读路径不得内联重写磁盘
    const onDiskAfterRead = readTrashOnDisk(dir);
    assert.equal(onDiskAfterRead.length, 2, '开后读时不应重写磁盘');
    assert.ok(onDiskAfterRead.some((t) => t.trashId === expiredEntryTrash.trashId));

    // 手动 sweep 清理超期
    const removed = await store.sweepTrash();
    assert.equal(removed, 1, 'sweep 应清理 1 条超期');
    const onDiskAfterSweep = readTrashOnDisk(dir);
    assert.equal(onDiskAfterSweep.length, 1, 'sweep 后磁盘只剩未超期项');
    assert.equal(onDiskAfterSweep[0].trashId, freshEntryTrash.trashId);
  } finally {
    cleanup();
  }
});

test('bgTrashSweep 开：后台 setInterval 周期清理超期项', async () => {
  const { store, dir, cleanup } = tmpStore({ bgTrashSweep: true });
  try {
    makeTrashFile(dir, [expiredEntryTrash]);
    store.startBackgroundSweep(40);
    // 轮询等待后台清理（最多 ~1s）
    let cleaned = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if (readTrashOnDisk(dir).length === 0) {
        cleaned = true;
        break;
      }
    }
    assert.ok(cleaned, '后台 sweep 应在周期内清理超期项');
  } finally {
    cleanup();
  }
});

test('bgTrashSweep 开：stopBackgroundSweep 后不再后台清理', async () => {
  const { store, dir, cleanup } = tmpStore({ bgTrashSweep: true });
  try {
    makeTrashFile(dir, [expiredEntryTrash]);
    store.startBackgroundSweep(40);
    store.stopBackgroundSweep();
    // 停止后等待一个周期，磁盘应仍含超期项
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(readTrashOnDisk(dir).length, 1, '停止后不应再后台清理');
    // 手动 sweep 仍可用
    assert.equal(await store.sweepTrash(), 1);
  } finally {
    cleanup();
  }
});
