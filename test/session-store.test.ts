/**
 * 会话持久化测试（SessionStore + 恢复链路）。
 *
 * 锁定的用户可见缺陷：「第一次进页面退出，第二次之前的消息全部没有了」——
 * 根因是仓库里从来没有写盘路径，每次启动 messages 从空数组开始。
 * 这里验的是修复的三条腿：回合末存得下、启动时装得回、坏了不炸启动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore, SESSION_SCHEMA_VERSION, type SessionSnapshot } from '../src/core/session/store.ts';
import { assistantMsg, toolMsg, userMsg, type Msg } from '../src/core/types.ts';
import { eventsFromHistory, foldTranscript } from '../src/app/timeline.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsa-session-'));
}

const sample: Msg[] = [
  userMsg('做一个五子棋'),
  assistantMsg('我先建骨架', [{ type: 'tool_call', id: 'c1', name: 'write_file', args: { path: 'a.ts' } }]),
  toolMsg('c1', 'write_file', '已写入 a.ts'),
  assistantMsg('骨架完成，可运行'),
];

test('往返：save 后 load 得到等价消息列（含 toolCalls 结构）', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore('/tmp/ws-a', { dir });
    assert.equal(store.save(sample), true);
    const back = store.load();
    assert.ok(back, '应能读回');
    assert.equal(back!.length, 4);
    assert.equal(back![1]!.toolCalls?.[0]!.name, 'write_file', '工具调用结构必须原样恢复');
    assert.equal(back![2]!.toolCallId, 'c1', 'tool 结果的 callId 不能丢，否则协议层报错');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('无历史文件：load 返回 null（新会话，不抛）', () => {
  const dir = tmpDir();
  try {
    assert.equal(new SessionStore('/tmp/ws-new', { dir }).load(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('损坏文件与版本不符：load 一律 null，启动永不被历史卡住', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore('/tmp/ws-x', { dir });
    store.save(sample);
    const file = store.path;
    // 半截 JSON（进程被杀的形态）
    writeFileSync(file, readFileSync(file, 'utf-8').slice(0, 40), 'utf-8');
    assert.equal(store.load(), null, '截断的 JSON 不得抛穿启动路径');
    // 版本不符（旧格式）
    store.save(sample);
    const snap = JSON.parse(readFileSync(file, 'utf-8')) as SessionSnapshot;
    writeFileSync(file, JSON.stringify({ ...snap, version: SESSION_SCHEMA_VERSION + 99 }), 'utf-8');
    assert.equal(store.load(), null, 'schema 升级时旧快照按无历史处理');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按工作区归集：A 项目的历史不会出现在 B 项目里', () => {
  const dir = tmpDir();
  try {
    const a = new SessionStore('/tmp/proj-a', { dir });
    const b = new SessionStore('/tmp/proj-b', { dir });
    a.save(sample);
    assert.notEqual(a.path, b.path);
    assert.equal(b.load(), null, '跨工作区不得串上下文');
    assert.equal(readdirSync(dir).length, 1);
    // 同一 workspace 的不同写法（相对/尾斜杠）归一到同一文件
    const same = new SessionStore('/tmp/proj-a/', { dir });
    assert.equal(same.path, a.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clear：删文件而非写空快照，下次启动是真·新会话', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore('/tmp/ws-c', { dir });
    store.save(sample);
    store.clear();
    assert.equal(store.load(), null);
    assert.equal(readdirSync(dir).length, 0, '清空后不应留下文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('存储结构性无密钥：快照里只有对话内容', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore('/tmp/ws-s', { dir });
    store.save(sample);
    const raw = readFileSync(store.path, 'utf-8');
    for (const k of ['apiKey', 'api_key', 'DEEPSEEK', 'authorization', 'sk-']) {
      assert.ok(!raw.toLowerCase().includes(k.toLowerCase()), `快照不得包含 ${k}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save 剔除 system 消息：截断建议等内核提示不进会话文件', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore('/tmp/ws-y', { dir });
    store.save([...sample, { role: 'system', content: '（系统提示：你被截断了）' }]);
    const back = store.load()!;
    assert.equal(back.length, sample.length, 'system 不应持久化');
    assert.ok(!back.some((m) => m.role === 'system'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('转录重放（timeline fold）：system 隐藏、步骤一行、最终答复保留', () => {
  const msgs: Msg[] = [
    ...sample,
    { role: 'system', content: '（系统提示：…）' },
    assistantMsg('', [{ type: 'tool_call', id: 'c9', name: 'bash', args: { command: 'ls' } }]),
    toolMsg('c9', 'bash', 'line1\nline2\nline3'),
  ];
  const ui = foldTranscript(eventsFromHistory(msgs));
  assert.ok(!ui.some((m) => m.text.includes('系统提示')), '内核 system 提示不展示给用户');
  const step = ui.find((m) => m.kind === 'step' && m.text.includes('write_file'))!;
  assert.ok(step.text.includes('✅'), '成功调用应带状态标记');
  assert.ok(!step.text.includes('a.ts\n'), '折叠态一行，不塞满首屏');
  assert.ok(ui.some((m) => m.kind === 'answer' && m.text === '骨架完成，可运行'), '最终答复全文保留');
  // id 必须互不重复（React key 依赖）
  assert.equal(new Set(ui.map((m) => m.id)).size, ui.length);
});

test('恢复全链路：存 → 装载进内核 → 派生转录，等价于"第二次进入还在"', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore('/tmp/ws-e2e', { dir });
    store.save(sample);
    const restored = store.load()!;
    const ui = foldTranscript(eventsFromHistory(restored));
    assert.ok(ui.some((m) => m.role === 'user' && m.text === '做一个五子棋'), '用户原始需求必须可见');
    assert.ok(ui.some((m) => m.role === 'assistant' && m.text === '骨架完成，可运行'), '最终答复必须可见');
    // 装载方向不能丢 tool 消息——那是模型"记得做过什么"的依据
    assert.ok(restored.some((m) => m.role === 'tool'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
