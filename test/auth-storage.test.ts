import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readToken,
  writeToken,
  clearToken,
  readActiveTask,
  writeActiveTask,
  clearActiveTask,
} from '../src/gui/web/authStorage.ts';

/** 内存版 Storage mock（实现 getItem/setItem/removeItem 最小契约） */
function makeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem(k: string) {
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      map.set(k, String(v));
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  };
}

type StorageLike = ReturnType<typeof makeStorage>;

function install(local: StorageLike | undefined, session: StorageLike | undefined) {
  const prevLocal = (globalThis as { localStorage?: unknown }).localStorage;
  const prevSession = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as { localStorage?: unknown }).localStorage = local;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = session;
  return () => {
    (globalThis as { localStorage?: unknown }).localStorage = prevLocal;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = prevSession;
  };
}

/**
 * 根因修复不变量：token 必须写进 localStorage，而「绝不」写进 sessionStorage。
 * 旧实现用 sessionStorage，关标签重开即清空 → 每次重开回登录。
 */
test('writeToken 落 localStorage 且绝不写 sessionStorage，readToken 可回读', () => {
  const local = makeStorage();
  const session = makeStorage();
  const restore = install(local, session);
  try {
    writeToken('abc.def.ghi');
    assert.equal(readToken(), 'abc.def.ghi');
    assert.equal(local.map.get('dsa_token'), 'abc.def.ghi', 'token 应在 localStorage');
    assert.equal(session.map.has('dsa_token'), false, 'token 绝不应出现在 sessionStorage（旧 bug）');
  } finally {
    restore();
  }
});

test('clearToken 后 readToken 返回 null 且 localStorage 不再含 token', () => {
  const local = makeStorage();
  const session = makeStorage();
  const restore = install(local, session);
  try {
    writeToken('t1');
    clearToken();
    assert.equal(readToken(), null);
    assert.equal(local.map.has('dsa_token'), false);
  } finally {
    restore();
  }
});

test('activeTask 读写/清除往返，且仅落 localStorage', () => {
  const local = makeStorage();
  const session = makeStorage();
  const restore = install(local, session);
  try {
    writeActiveTask('task-xyz');
    assert.equal(readActiveTask(), 'task-xyz');
    assert.equal(local.map.get('dsa_active_task'), 'task-xyz');
    assert.equal(session.map.has('dsa_active_task'), false);
    clearActiveTask();
    assert.equal(readActiveTask(), null);
  } finally {
    restore();
  }
});

test('隐私模式：localStorage 方法抛错时读写不崩溃，readToken 返回 null', () => {
  const throwing = {
    map: new Map<string, string>(),
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
    clear() {},
  };
  const restore = install(throwing, makeStorage());
  try {
    assert.equal(readToken(), null, '隐私模式下读应降级为 null');
    assert.doesNotThrow(() => writeToken('x'), '写不应抛错');
    assert.doesNotThrow(() => clearToken(), '清除不应抛错');
  } finally {
    restore();
  }
});

test('localStorage 不存在（typeof 守卫）时 readToken/readActiveTask 返回 null', () => {
  const prev = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = undefined;
  try {
    assert.equal(readToken(), null);
    assert.equal(readActiveTask(), null);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = prev;
  }
});
