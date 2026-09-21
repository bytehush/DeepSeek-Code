/**
 * timeline fold 测试 —— trace-first 渲染内核的纯函数契约。
 *
 * UI = foldTranscript(事件流)：这里锁定「结论优先 + 一行进度」的全部呈现规则，
 * 尤其是旧命令式气泡模型反复出问题的地方：
 *  - 流式增量归并（同 step 的 assistant_text 必须归成一条，不能一 token 一气泡）；
 *  - 行动前叙述在回合结束自动收起（刷屏元凶），最终答复永远保留；
 *  - 工具行单行化 + 状态图标；展开态补明细；
 *  - id 随事件追加保持稳定（React key 依赖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { foldTranscript, eventsFromHistory, resultStatus, type UiEvent } from '../src/app/timeline.ts';
import { assistantMsg, toolMsg, userMsg } from '../src/core/types.ts';

const ev = (e: UiEvent) => e;

test('流式增量：同 step 的多个 text_delta 归并为一条消息', () => {
  const ui = foldTranscript([
    ev({ type: 'user_input', text: '你好' }),
    ev({ type: 'assistant_text', text: '你', step: 1 }),
    ev({ type: 'assistant_text', text: '好呀', step: 1 }),
    ev({ type: 'assistant_phase', phase: 'final', step: 1 }),
    ev({ type: 'done', reason: 'model_stop' }),
  ]);
  const answers = ui.filter((m) => m.kind === 'answer');
  assert.equal(answers.length, 1, '两个增量必须归成一条');
  assert.equal(answers[0]!.text, '你好呀');
});

test('一行进度：折叠态下每个工具调用只占一条单行消息，带状态图标', () => {
  const events: UiEvent[] = [
    ev({ type: 'user_input', text: '看下 README' }),
    ev({ type: 'assistant_text', text: '我先读一下文件', step: 1, reactPhase: 'progress' }),
    ev({ type: 'tool_call', toolName: 'read_file', args: { path: 'README.md' }, step: 1 }),
    ev({ type: 'tool_result', toolName: 'read_file', result: '# DeepSeek Code\n第二行内容', step: 1 }),
    ev({ type: 'assistant_text', text: 'README 是一个项目说明文件', step: 2, reactPhase: 'final' }),
    ev({ type: 'done', reason: 'model_stop' }),
  ];
  const collapsed = foldTranscript(events, { detail: false, live: false });
  const steps = collapsed.filter((m) => m.kind === 'step');
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.text.split('\n').length, 1, '步骤行不得多行');
  assert.match(steps[0]!.text, /^#1 🔧 read_file README\.md ✅ # DeepSeek Code/);
  // 行动前叙述收起（结论已在步骤行里），最终答复保留
  assert.ok(!collapsed.some((m) => m.text === '我先读一下文件'), '过程叙述折叠态不占屏');
  assert.ok(collapsed.some((m) => m.kind === 'answer' && m.text.includes('项目说明文件')));
});

test('展开态（Ctrl+O）：步骤行下补参数与结果明细', () => {
  const events: UiEvent[] = [
    ev({ type: 'tool_call', toolName: 'bash', args: { command: 'npm test' }, step: 1 }),
    ev({ type: 'tool_result', toolName: 'bash', result: 'pass 3\nfail 0', step: 1 }),
    ev({ type: 'tool_progress', text: '> deepseek-code-agent@0.5.0 test' }),
    ev({ type: 'done', reason: 'model_stop' }),
  ];
  const [step] = foldTranscript(events, { detail: true }).filter((m) => m.kind === 'step');
  assert.ok(step!.text.includes('参数 {"command":"npm test"}'));
  assert.ok(step!.text.includes('pass 3'));
  assert.ok(step!.text.includes('> deepseek-code-agent'), '实时输出以 > 前缀呈现（ASCII，防歧义宽度）');
});

test('流式期间（live）：尾部过程文本保持可见，回合结束自动收起', () => {
  const events: UiEvent[] = [
    ev({ type: 'user_input', text: '做个工具' }),
    ev({ type: 'assistant_text', text: '我先创建文件', step: 1, reactPhase: 'progress' }),
    ev({ type: 'tool_call', toolName: 'write_file', args: { path: 'a.ts' }, step: 1 }),
  ];
  // 正在执行：过程文本可见 + 未完成步骤带 ...
  const live = foldTranscript(events, { live: true });
  assert.ok(live.some((m) => m.text === '我先创建文件'), '流式尾部过程文本要让用户看到动静');
  assert.ok(live.some((m) => m.kind === 'step' && m.text.endsWith('...')), '未出结果的步骤带进行标记');
  // 结果回来后收尾：折叠掉过程文本
  const done = foldTranscript([...events, ev({ type: 'tool_result', result: '已写入', step: 1 }), ev({ type: 'done', reason: 'model_stop' })]);
  assert.ok(!done.some((m) => m.text === '我先创建文件'), '回合结束，行动前叙述收起');
  assert.ok(done.some((m) => m.kind === 'step' && m.text.includes('✅')));
});

test('最终答复判定：reactPhase=final 或「后面没有工具调用」都算结论', () => {
  // 无 final 标记，但它是回合末段（后面没有调用）→ 仍是答复
  const ui = foldTranscript([
    ev({ type: 'assistant_text', text: '这就是结论', step: 2 }),
    ev({ type: 'done', reason: 'model_stop' }),
  ]);
  assert.equal(ui[0]!.kind, 'answer');
});

test('失败与拒绝的图标区分：❌ 执行失败 / 🔐 权限拒绝 / - 内核旁白', () => {
  assert.equal(resultStatus('工具执行失败：ENOENT'), 'fail');
  assert.equal(resultStatus('参数校验失败：path: Required'), 'fail');
  assert.equal(resultStatus('权限拦截：explore 模式禁止写'), 'denied');
  assert.equal(resultStatus('用户拒绝了本次操作'), 'denied');
  assert.equal(resultStatus('（系统干预：重复调用已中止）'), 'neutral');
  assert.equal(resultStatus('正常输出'), 'ok');
});

test('错误事件 → 友好提示气泡（分类文案，不裸抛报文）', () => {
  const ui = foldTranscript([ev({ type: 'error', error: 'HTTP 401 Authentication Fails, Your api key: *abcd is invalid', errorCategory: 'auth' })]);
  const err = ui.find((m) => m.kind === 'error')!;
  assert.match(err.text, /API Key 无效/);
  assert.match(err.text, /abcd/, '脱敏尾号要透传给用户帮助定位');
});

test('回合收尾：耗时行 + 非正常退出的交代文案', () => {
  const ui = foldTranscript([
    ev({ type: 'done', reason: 'repeat_loop' }),
    ev({ type: 'turn_summary', durationSec: 75.5, label: '⚠️ 检测到周期性重复调用，疑似空转，已提前结束' }),
  ]);
  const notice = ui.find((m) => m.kind === 'notice')!;
  assert.match(notice.text, /1分15秒/);
  assert.match(notice.text, /空转/);
});

test('id 稳定性：事件只追加，已渲染消息的 id 不漂移（React key 前提）', () => {
  const e1: UiEvent[] = [
    ev({ type: 'user_input', text: 'q1' }),
    ev({ type: 'assistant_text', text: '先看看', step: 1, reactPhase: 'progress' }),
    ev({ type: 'tool_call', toolName: 'list_files', args: {}, step: 1 }),
  ];
  const before = foldTranscript(e1, { live: true });
  const after = foldTranscript(
    [...e1, ev({ type: 'tool_result', result: 'a.ts', step: 1 }), ev({ type: 'done', reason: 'model_stop' })],
  );
  const byUser = (ms: typeof before) => ms.find((m) => m.kind === 'user')!;
  assert.equal(byUser(after).id, byUser(before).id, '用户气泡 id 必须跨帧不变');
});

test('恢复重放：eventsFromHistory 的折叠与实时折叠结论一致（同一管线）', () => {
  const liveFold = foldTranscript([
    ev({ type: 'user_input', text: '建文件' }),
    ev({ type: 'assistant_text', text: '我来建', step: 1, reactPhase: 'progress' }),
    ev({ type: 'tool_call', toolName: 'write_file', args: { path: 'a.txt' }, step: 1 }),
    ev({ type: 'tool_result', toolName: 'write_file', result: '已写入 a.txt', step: 1 }),
    ev({ type: 'assistant_text', text: '完成', step: 2, reactPhase: 'final' }),
    ev({ type: 'done', reason: 'model_stop' }),
  ]);
  const replayFold = foldTranscript(
    eventsFromHistory([
      userMsg('建文件'),
      assistantMsg('我来建', [{ type: 'tool_call', id: 'c1', name: 'write_file', args: { path: 'a.txt' } }]),
      toolMsg('c1', 'write_file', '已写入 a.txt'),
      assistantMsg('完成'),
    ]),
  );
  assert.deepEqual(
    replayFold.map((m) => ({ kind: m.kind, text: m.text })),
    liveFold.map((m) => ({ kind: m.kind, text: m.text })),
    '重启后看到的必须和当时看到的一致',
  );
});

test('system 事件（内核旁白/干预提示）作为 notice 呈现且仅一行标题', () => {
  const ui = foldTranscript([
    ev({ type: 'system', text: '✂ 输出被截断，已要求分块续写（第 1/2 次）', step: 1 }),
  ]);
  assert.equal(ui[0]!.kind, 'notice');
  assert.match(ui[0]!.text, /截断/);
});
