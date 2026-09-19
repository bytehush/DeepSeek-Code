// 实测 Scrollbar 在 chats 区 Box 内布局 + 多种 scroll state 下的渲染
// 模拟：左列放 24 行宽 80 的可见消息（每行长 wrap），右列 1 char 宽 Scrollbar
import { render, Box, Text } from 'ink';
import React from 'react';

function Scrollbar({ linesAbove, total, area }) {
  const track = Math.max(1, area);
  const content = Math.max(1, total);
  const thumbH = Math.max(1, Math.round((area / content) * track));
  const maxPos = Math.max(0, track - thumbH);
  const scrollable = Math.max(1, total - area);
  // ⚠️ 现状公式
  const pos = Math.min(maxPos, Math.round((linesAbove / scrollable) * maxPos));
  // 期望公式：贴底(thumb 在底)⇔ linesAbove=0；滚顶(拇指在顶)⇔ linesAbove=scrollable
  //   → 应当 pos = maxPos - round(linesAbove/scrollable * maxPos)
  const lines = [];
  for (let i = 0; i < track; i++) lines.push(i >= pos && i < pos + thumbH ? '\u2588' : ' ');
  console.log('[mk] linesAbove=' + linesAbove + ' thumbH=' + thumbH + ' pos=' + pos + ' track=' + track + ' maxPos=' + maxPos);
  console.log('[mk] expected-correct pos (贴底在底) = ' + (maxPos - pos));
  return React.createElement(Text, { color: '#185FA5' }, lines.join('\n'));
}

// 24 行宽 80 的 chat 视图，每行用左对齐文本来占用
function ChatView({ label, linesAbove, total, area }) {
  const msgs = [];
  for (let i = 0; i < area; i++) {
    msgs.push(React.createElement(Text, null, `L${String(i).padStart(2)} |` + 'x'.repeat(50)));
  }
  return React.createElement(Box, { flexDirection: 'column', height: area + 2, borderStyle: 'round', paddingX: 1, width: 84 },
    React.createElement(Box, { flexDirection: 'row', height: area },
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1 }, msgs),
      React.createElement(Scrollbar, { linesAbove, total, area }),
    ),
    React.createElement(Text, null, label + ' linesAbove=' + linesAbove),
  );
}

// 4 个状态对比：贴底（0）、滚顶（maxHidden）、中间（截图 1 的 216）、滚到看最末后单步（3）
const cases = [
  ['贴底', 0, 291, 24],
  ['滚顶', 267, 291, 24],
  ['图1（216）', 216, 291, 24],
  ['图3（高）', 258, 291, 24],
];
for (const [name, linesAbove, total, area] of cases) {
  console.log('\n===== ' + name + ' =====');
  const App = () => React.createElement(ChatView, { label: name + ' →', linesAbove, total, area });
  const { unmount, waitUntilExit } = render(React.createElement(App), { exitOnCtrlC: false, debug: true });
  await waitUntilExit();
  unmount();
}
process.exit(0);
