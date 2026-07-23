import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';
import { test, afterEach } from 'node:test';
import { TaskStore } from '../src/gui/thread-store.ts';

let userDir: string;
let store: TaskStore;

afterEach(() => {
  try {
    rmSync(userDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function fresh(): void {
  userDir = mkdtempSync(join(tmpdir(), 'dsa-thread-cascade-'));
  store = new TaskStore(userDir);
}

/** 在任务目录内写入各类关联数据（meta / traces / memory / sessions） */
function seedTaskFiles(id: string): void {
  const dir = store.dir(id);
  mkdirSync(join(dir, '.dsa', 'traces'), { recursive: true });
  mkdirSync(join(dir, '.dsa', 'memory'), { recursive: true });
  mkdirSync(join(dir, '.dsa', 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, title: 't' }));
  writeFileSync(join(dir, '.dsa', 'traces', 'sess_x.jsonl'), '{"t":1}\n');
  writeFileSync(join(dir, '.dsa', 'memory', 'MEMORY.md'), '# m\n');
  writeFileSync(join(dir, '.dsa', 'sessions', 's1.json'), '{}');
}

test('级联删除：任务目录内全部关联数据被完整清除、目录消失', async () => {
  fresh();
  const id = await store.create('任务A');
  seedTaskFiles(id);
  assert.ok(existsSync(store.dir(id)), '前置：任务目录应存在');
  await store.remove(id);
  assert.ok(!existsSync(store.dir(id)), '任务目录（含 meta/traces/memory/sessions）应被完整删除');
});

test('级联删除后 list() 不再包含该任务，其余不受影响', async () => {
  fresh();
  const a = await store.create('A');
  const b = await store.create('B');
  await store.remove(a);
  const list = await store.list();
  assert.ok(!list.some((t) => t.id === a), '已删任务不应出现在列表');
  assert.ok(list.some((t) => t.id === b), '其他任务应不受影响');
});

test('删除标记持久化：物理目录被外力恢复时卡片仍不复活（跨实例）', async () => {
  fresh();
  const id = await store.create('A');
  seedTaskFiles(id);
  await store.remove(id);
  // 模拟极端竞态：外力把目录重新建回来（rm 成功后目录又被恢复）
  mkdirSync(store.dir(id), { recursive: true });
  writeFileSync(join(store.dir(id), 'meta.json'), JSON.stringify({ id, title: '复活' }));
  // 新实例（模拟重连/重启）应仍排除该任务
  const reopened = new TaskStore(userDir);
  const list = await reopened.list();
  assert.ok(!list.some((t) => t.id === id), '删除标记跨实例生效，卡片不复活');
});

test('越界守卫：拒绝路径穿越，不误删/泄漏基目录之外的数据', async () => {
  fresh();
  // 在 threads/ 之外放一份「敏感」数据，模拟不应被删除的目录
  const victim = join(userDir, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'secret.txt'), 'TOPSECRET');
  // 尝试用 ../victim 越界删除
  await store.remove('../victim');
  assert.ok(existsSync(join(victim, 'secret.txt')), '越界目标目录应完好无损');
  // 删除标记不应记录越界 id
  const deletedPath = join(userDir, 'threads', '.deleted.json');
  if (existsSync(deletedPath)) {
    const raw = readFileSync(deletedPath, 'utf8');
    assert.ok(!raw.includes('victim'), '.deleted.json 不应包含越界 id');
  }
});
