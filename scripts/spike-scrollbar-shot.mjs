// 实测 Scrollbar 在 linesAbove=216 / 0 / 33 (截图 1/2/3) 时的输出
// 同时实测 chat 区 Box 布局：左消息区 flexGrow=1, 右 Scrollbar <Text> 自然宽
import { render, Box, Text } from 'ink';
import React from 'react';

function Scrollbar({ linesAbove, total, area }) {
  const track = Math.max(1, area);
  const content = Math.max(1, total);
  const thumbH = Math.max(1, Math.round((area / content) * track));
  const maxPos = Math.max(0, track - thumbH);
  const scrollable = Math.max(1, total - area);
  const pos = Math.min(maxPos, Math.round((linesAbove / scrollable) * maxPos));
  const lines = [];
  for (let i = 0; i < track; i++) lines.push(i >= pos && i < pos + thumbH ? '\u2588' : ' ');
  console.log('[mk] linesAbove=' + linesAbove + ' thumbH=' + thumbH + ' pos=' + pos + ' track=' + track);
  return React.createElement(Text, { color: '#185FA5' }, lines.join('\n'));
}

// Chat 区三个 branch 各跑一遍：截图 1 (216) / 截图 2 (291 底部，linesAbove=0) / 截图 3 (33)
for (const [name, linesAbove] of [['shot1', 216], ['shot2', 0], ['shot3', 33]]) {
  console.log('=====', name, 'linesAbove=', linesAbove, '=====');
  const App = () =>
    React.createElement(Box, { flexDirection: 'row', height: 24, borderStyle: 'round', paddingX: 1, width: 80 },
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1, borderStyle: 'single', borderColor: 'gray' },
        React.createElement(Text, null, 'msg line 1'),
        React.createElement(Text, null, 'msg line 2'),
        React.createElement(Text, null, 'msg line 3 aaa'.repeat(20)),
      ),
      React.createElement(Scrollbar, { linesAbove, total: 291, area: 24 }),
    );
  const { unmount, waitUntilExit } = render(React.createElement(App), { exitOnCtrlC: false, debug: true });
  await waitUntilExit();
  unmount();
}
process.exit(0);
