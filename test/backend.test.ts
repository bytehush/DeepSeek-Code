/**
 * 记忆库行为回归测试（M0 测试脚手架核心）。
 *
 * 作用：锁定 MemoryStore 的公开契约（落盘格式 / 回收站 / 去重阈值 / 双层聚合），
 * 使 M1「抽三接口 + 重命名 + 兼容别名」成为纯零行为变更重构——
 * 改名后 MemoryStore 是 FileMemoryBackend 的别名，本测试 import 不变、断言不变。
 *
 * 约定：所有用例使用 off 模式 embedder（无网络、embedding 为 undefined、确定性）。
 *
 * 隔离：node --test 每个测试文件在独立子进程运行，故在模块顶层把 HOME 指向临时目录，
 * 使 MemoryManager 的 user 层不会写到真实 ~/.dsa/memory。
 *
 * 注意（M8）：FileMemoryBackend 全部方法转 async。本脚手架默认以同步回退模式
 * （new MemoryStore 不带 async:true 选项）构造，验证「输出逐字节一致」；
 * 末尾另加 async 模式往返用例，验证异步 I/O 路径行为等价。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.ts';
import { Embedder } from '../src/memory/embedder.ts';
import { MemoryManager } from '../src/memory/manager.ts';
import type { MemoryEntry } from '../src/memory/types.ts';
import { SAMPLE_USER_FACTS, SAMPLE_PROJECT_FACTS } from './memory-fixtures.ts';

const SHARED_HOME = mkdtempSync(join(os.tmpdir(), 'dsa-home-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SHARED_HOME;
process.on('exit', () => {
  process.env.HOME = REAL_HOME;
  rmSync(SHARED_HOME, { recursive: true, force: true });
});

function tmpStore(asyncMode = false): { store: MemoryStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-store-'));
  const store = new MemoryStore(dir, new Embedder({ mode: 'off' }), { async: asyncMode });
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('addFact 写入 MEMORY.md 且 loadFacts 可读回', async () => {
  const { store, dir, cleanup } = tmpStore();
  try {
    await store.addFact(SAMPLE_USER_FACTS[0]);
    const facts = await store.loadFacts();
    assert.ok(facts.includes(SAMPLE_USER_FACTS[0]), `应含事实，实际: ${facts}`);
    const raw = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    assert.ok(raw.startsWith('- '), `格式应为 '- ' 列表，实际: ${raw}`);
  } finally {
    cleanup();
  }
});

test('addFact 多次追加不丢历史、行数正确', async () => {
  const { store, cleanup } = tmpStore();
  try {
    await store.addFact('A');
    await store.addFact('B');
    const facts = await store.loadFacts();
    assert.ok(facts.includes('A') && facts.includes('B'));
    assert.equal(facts.split('\n').filter((l) => l.startsWith('- ')).length, 2);
  } finally {
    cleanup();
  }
});

test('addEntry 落盘到 memories.json（off 模式 embedding 为 undefined）', async () => {
  const { store, dir, cleanup } = tmpStore();
  try {
    const entry = await store.addEntry('今天重构了记忆模块');
    assert.equal(entry.embedding, undefined);
    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].content, '今天重构了记忆模块');
    const parsed = JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8'));
    assert.ok(Array.isArray(parsed) && parsed.length === 1);
  } finally {
    cleanup();
  }
});

test('addEntries 批量写入单次落盘（M8 批量嵌入复用）', async () => {
  const { store, dir, cleanup } = tmpStore();
  try {
    const entries = await store.addEntries(['记忆一', '记忆二', '记忆三']);
    assert.equal(entries.length, 3);
    assert.ok(entries.every((e) => typeof e.id === 'string' && e.id.length > 0));
    const all = await store.list();
    assert.equal(all.length, 3);
    const parsed = JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8')) as MemoryEntry[];
    assert.equal(parsed.length, 3);
  } finally {
    cleanup();
  }
});

test('forget → 进回收站 → restore 恢复', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const entry = await store.addEntry('待删除的记忆');
    const ok = await store.forget(entry.id.slice(0, 8));
    assert.equal(ok, true);
    assert.equal((await store.list()).length, 0, 'forget 后 list 应为空');
    const trash = await store.listTrash();
    assert.equal(trash.length, 1);
    const restored = await store.restore(trash[0].trashId);
    assert.equal(restored, true);
    assert.equal((await store.list()).length, 1, 'restore 后应恢复');
  } finally {
    cleanup();
  }
});

test('purgeTrash 永久清空回收站', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const entry = await store.addEntry('将被永久删除');
    await store.forget(entry.id.slice(0, 8));
    assert.equal((await store.listTrash()).length, 1);
    await store.purgeTrash();
    assert.equal((await store.listTrash()).length, 0);
  } finally {
    cleanup();
  }
});

test('isDuplicate: 关键词高度重叠判定为重复', async () => {
  const { store, cleanup } = tmpStore();
  try {
    await store.addEntry('项目使用 TypeScript 与 React 构建前端');
    const dup = await store.isDuplicate('本项目用 TypeScript 和 React 做前端');
    assert.equal(dup, true);
    const notDup = await store.isDuplicate('今天午餐吃了牛肉面');
    assert.equal(notDup, false);
  } finally {
    cleanup();
  }
});

test('isDuplicate: 常驻事实也参与去重判断', async () => {
  const { store, cleanup } = tmpStore();
  try {
    await store.addFact(SAMPLE_USER_FACTS[0]); // '偏好使用 pnpm 而非 npm 管理依赖'
    // 高重叠近义句，Dice 关键词相似度应 ≥ 0.6 阈值
    const dup = await store.isDuplicate('偏好使用 pnpm 管理依赖');
    assert.equal(dup, true);
    // 低重叠应判为非重复
    const notDup = await store.isDuplicate('今天天气晴朗适合散步');
    assert.equal(notDup, false);
  } finally {
    cleanup();
  }
});

test('getMeta/setMeta 元数据读写', async () => {
  const { store, cleanup } = tmpStore();
  try {
    assert.deepEqual(await store.getMeta(), {});
    await store.setMeta({ lastReviseAt: 123 });
    assert.equal((await store.getMeta()).lastReviseAt, 123);
  } finally {
    cleanup();
  }
});

test('updateEntry 保留 id、刷新 updatedAt', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const entry = await store.addEntry('旧内容');
    const ok = await store.updateEntry(entry.id, '新内容');
    assert.equal(ok, true);
    const updated = (await store.list()).find((e) => e.id === entry.id)!;
    assert.equal(updated.content, '新内容');
    assert.ok(updated.updatedAt! >= entry.updatedAt!);
  } finally {
    cleanup();
  }
});

test('MemoryManager: user/project 双层 facts 经 compose 进入系统提示词', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-mgr-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const mgr = new MemoryManager(dir, new Embedder({ mode: 'off' }));
    await mgr.addFact(SAMPLE_USER_FACTS[0], 'user');
    await mgr.addFact(SAMPLE_PROJECT_FACTS[0], 'project');
    const prompt = await mgr.compose('你是助手', '关于构建工具', 5);
    assert.ok(prompt.includes(SAMPLE_USER_FACTS[0]), '应包含 user 事实');
    assert.ok(prompt.includes(SAMPLE_PROJECT_FACTS[0]), '应包含 project 事实');
  } finally {
    cleanup();
  }
});

test('MemoryManager.retrieve 合并 user/project 两层（off 模式关键词召回）', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsa-mgr2-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const mgr = new MemoryManager(dir, new Embedder({ mode: 'off' }));
    await mgr.addEntry('用户层：喜欢用 pnpm', [], 'user');
    await mgr.addEntry('项目层：用 TypeScript 写', [], 'project');
    const hits = await mgr.retrieve('pnpm 包管理器', 5);
    const contents = hits.map((h: MemoryEntry) => h.content);
    assert.ok(contents.some((c) => c.includes('pnpm')), `应召回 pnpm 条目，实际: ${contents}`);
  } finally {
    cleanup();
  }
});

test('M8 异步模式：addFact/addEntry/forget/list/restore 往返等价（单 store）', async () => {
  const { store, cleanup } = tmpStore(true);
  try {
    await store.addFact('偏好使用 pnpm');
    assert.ok((await store.loadFacts()).includes('偏好使用 pnpm'), '异步 addFact 应落盘可读回');

    const e = await store.addEntry('正在准备前端实习', ['实习']);
    assert.equal((await store.list()).length, 1, '异步 addEntry 应入列');
    assert.equal((await store.list())[0].content, '正在准备前端实习');

    // 批量写入（M8 新增）：一次调用落多条
    const batch = await store.addEntries(['记忆甲', '记忆乙']);
    assert.equal(batch.length, 2);
    assert.equal((await store.list()).length, 3);

    // forget → 进回收站 → restore
    const ok = await store.forget(e.id.slice(0, 8));
    assert.equal(ok, true);
    assert.equal((await store.list()).length, 2, 'forget 后剩 2 条');
    assert.equal((await store.listTrash()).length, 1, 'forget 应进回收站');
    const restored = await store.restore((await store.listTrash())[0].trashId);
    assert.equal(restored, true);
    assert.equal((await store.list()).length, 3, 'restore 后恢复为 3 条');

    await store.onDispose();
  } finally {
    cleanup();
  }
});
