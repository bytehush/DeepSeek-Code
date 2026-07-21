/**
 * chatarea-render 全链路渲染测试：在 Node 里用 renderToStaticMarkup 真正渲染整个 ChatArea，
 * 验证「数据（thinkings）→ computeOrphans → ThinkingCard」这条浏览器里实际运行的渲染链路。
 *
 * 配合：
 *  - thinkingLayout.test.ts（computeOrphans 落位逻辑）
 *  - thinkingCard-render.test.tsx（ThinkingCard 自身绘制）
 * 本测试补上「ChatArea 把孤儿轮真的画出来」这一最后一段 glue，做到端到端一锤定音。
 *
 * 依赖 css-stub.mjs（把 .css import 桩为空模块）才能 Node 直跑 ChatArea。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatArea } from '../src/gui/web/ChatArea.tsx';
import type { UiMessage } from '../src/app/types.ts';
import type { ThinkingTurn, ThinkingEntry } from '../src/gui/web/App.tsx';

function userMsg(): UiMessage {
  return { id: 1, role: 'user', text: '用中文讲讲闭包' } as UiMessage;
}
function turn(turnId: number, status: ThinkingTurn['status'], entries: ThinkingEntry[]): ThinkingTurn {
  return { turnId, status, collapsed: false, entries };
}
const noop = () => {};

test('孤儿轮（done 无答案气泡）→ ChatArea 仍渲染思考盒', () => {
  const thinkings = [turn(1, 'done', [{ id: 1, kind: 'reason', text: '闭包 = 函数 + 环境', status: 'done' }])];
  const html = renderToStaticMarkup(
    <ChatArea messages={[userMsg()]} busy={false} outputting={false} thinkings={thinkings} onToggleThinking={noop} username="me" />,
  );
  assert.match(html, /闭包 = 函数 \+ 环境/, '孤儿思考文字应出现');
  assert.match(html, /思考过程/, '应渲染思考盒标题');
});

test('已匹配答案气泡的思考轮 → 渲染在气泡上方（含思考文字）', () => {
  const thinkings = [turn(1, 'done', [{ id: 1, kind: 'reason', text: '推理：闭包捕获变量', status: 'done' }])];
  const assistant: UiMessage = { id: 2, role: 'assistant', text: '闭包是函数与其词法环境的组合。', thinkingId: 1 } as UiMessage;
  const html = renderToStaticMarkup(
    <ChatArea messages={[userMsg(), assistant]} busy={false} outputting={false} thinkings={thinkings} onToggleThinking={noop} username="me" />,
  );
  assert.match(html, /推理：闭包捕获变量/, '气泡上方的思考盒应出现');
  assert.match(html, /闭包是函数与其词法环境的组合/, '答案气泡也应出现');
});

test('实时思考中（busy + 无气泡）→ 渲染底部活跃思考卡', () => {
  const thinkings = [turn(9, 'thinking', [{ id: 1, kind: 'reason', text: '正在推导中', status: 'streaming' }])];
  const html = renderToStaticMarkup(
    <ChatArea messages={[userMsg()]} busy={true} outputting={false} thinkings={thinkings} onToggleThinking={noop} username="me" />,
  );
  assert.match(html, /思考中/, '应出现「思考中」活跃卡');
  assert.match(html, /正在推导中/, '实时思考文字应出现');
});

test('多个孤儿轮 → 全部渲染，无丢失', () => {
  const thinkings = [
    turn(1, 'done', [{ id: 1, kind: 'reason', text: '第一轮思考', status: 'done' }]),
    turn(2, 'interrupted', [{ id: 2, kind: 'reason', text: '第二轮中断', status: 'done' }]),
  ];
  const html = renderToStaticMarkup(
    <ChatArea messages={[userMsg()]} busy={false} outputting={false} thinkings={thinkings} onToggleThinking={noop} username="me" />,
  );
  assert.match(html, /第一轮思考/, '第一轮应出现');
  assert.match(html, /第二轮中断/, '第二轮（中断）应出现');
});
