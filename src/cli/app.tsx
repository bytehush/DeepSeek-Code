import { Box, Text, render, useInput, useApp, useStdout, useStdin } from 'ink';
import { useState, useCallback, useRef, useEffect, memo, useMemo } from 'react';
import type { ReactNode } from 'react';
import { WHALE_ART, WHALE_EYES } from './whaleArt.ts';
import { ThinkingIndicator } from './thinkingIndicator.tsx';
import { MarkdownMessage } from './Markdown.tsx';
import { saveCredentials } from './auth.ts';
import { KeyCapture } from './login.tsx';
import { styleLabel } from '../agent/output-style.ts';
import { getMode, modeLabel } from '../config/model-mode.ts';
import type { AppProps, UiMessage } from '../app/types.ts';
import { useAgentController } from '../app/useAgentController.ts';
import { computeAreaHeight, estimateLines, prefixWidthOf, selectRowWindow } from '../app/viewport.ts';

/** Abyssal Pixel 风格 Banner */
function Banner(props: { version: string; model: string; cwd: string }) {
  const cwdShow =
    props.cwd.length > 40 ? '…/' + props.cwd.split(/[\\/]/).slice(-2).join('/') : props.cwd;
  return (
    <Box borderStyle="single" borderColor="#2f6fb0" paddingX={1} flexDirection="row">
      <Box flexDirection="column" flexGrow={1} flexBasis={0} paddingRight={2}>
        <Text color="#2f6fb0" bold>{`DeepSeek Agent ${props.version}`}</Text>
        <Text color="#7ec8e3">欢迎回来！</Text>
        <WhaleMascot compact />
        <Text color="#7ec699">{props.model}</Text>
        <Text>
          <Text color="#7ec699">/model</Text>
          <Text dimColor> 当前：</Text>
          <Text color="#7ec8e3">{modeLabel(getMode())}</Text>
        </Text>
        <Text dimColor>{cwdShow}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexBasis={0}>
        <Text color="#2f6fb0" bold>提示</Text>
        <Text>
          <Text color="#7ec699">/mode</Text>
          <Text dimColor> 执行   -&gt; 自动批准工具</Text>
        </Text>
        <Text>
          <Text color="#7ec699">/plan</Text>
          <Text dimColor>      -&gt; 预览后再运行</Text>
        </Text>
        <Text dimColor>输入：&quot;review src/&quot;</Text>
        <Text> </Text>
        <Text color="#2f6fb0" bold>命令</Text>
        <Text>
          <Text color="#7ec8e3">/help</Text>
          <Text dimColor> 查看全部 · </Text>
          <Text color="#7ec8e3">/exit</Text>
          <Text dimColor> 退出</Text>
        </Text>
      </Box>
    </Box>
  );
}

/** 蓝鲸 ASCII 吉祥物 */
function WhaleMascot(props: { compact?: boolean }) {
  return (
    <Box flexDirection="column" paddingX={props.compact ? 0 : 1}>
      {WHALE_ART.map((line, r) => {
        const segs: ReactNode[] = [];
        let i = 0;
        let k = 0;
        while (i < line.length) {
          const ch = line[i];
          if (ch === ' ') {
            segs.push(<Text key={k++}> </Text>);
            i++;
            continue;
          }
          const isEye = WHALE_EYES.has(`(${i},${r})`);
          let j = i;
          while (j < line.length) {
            const c2 = line[j];
            if (c2 === ' ') break;
            if (WHALE_EYES.has(`(${j},${r})`) !== isEye) break;
            j++;
          }
          segs.push(
            <Text key={k++} color={isEye ? 'black' : '#2f6fb0'}>
              {'█'.repeat(j - i)}
            </Text>,
          );
          i = j;
        }
        return <Text key={r}>{segs}</Text>;
      })}
    </Box>
  );
}

/** 非 assistant 消息（user/tool/system/error）的纯文本行，memo 防长会话全列表重渲染 */
const PlainTextMessage = memo(
  function PlainTextMessage({ m, text }: { m: UiMessage; text: string }) {
    const color =
      m.role === 'user'
        ? '#7ec8e3'
        : m.role === 'error'
          ? '#ff6b6b'
          : m.role === 'tool'
            ? '#d98cff'
            : m.role === 'system'
              ? '#9aa0a6'
              : '#e8e8e8';
    const prefix = m.role === 'user' ? '你> ' : m.role === 'assistant' ? 'Agent> ' : '';
    return (
      <Text wrap="wrap">
        <Text color={color}>{prefix}</Text>
        <Text>{text}</Text>
      </Text>
    );
  },
  (a, b) => a.text === b.text && a.m.id === b.m.id && a.m.role === b.m.role,
);

/** 底部滚动指示：贴底显示「● 已贴底」；有历史/新消息时显示两侧行数 */
function ScrollIndicator(props: { linesAbove: number; linesBelow: number }) {
  const { linesAbove, linesBelow } = props;
  const left = linesAbove > 0 ? `↑ ${linesAbove} 行` : '';
  const right = linesBelow > 0 ? `↓ ${linesBelow} 行 · PgDn 回底部` : '● 已贴底';
  if (!left) {
    return (
      <Box flexDirection="row" justifyContent="flex-end" width="100%">
        <Text color="#9aa0a6" dimColor>
          {right}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%">
      <Text color="#4aa3e0" dimColor>
        {left}
      </Text>
      <Text color="#4aa3e0" dimColor>
        {right}
      </Text>
    </Box>
  );
}

/** 右侧比例滚动条：track=消息区行数，thumb 高度/位置按「上方隐藏行数 / 总行数」比例 */
function Scrollbar(props: { linesAbove: number; total: number; area: number }) {
  const { linesAbove, total, area } = props;
  const track = Math.max(1, area);
  const content = Math.max(1, total);
  const thumbH = Math.max(1, Math.round((area / content) * track));
  const maxPos = Math.max(0, track - thumbH);
  const scrollable = Math.max(1, total - area);
  const pos = Math.min(maxPos, Math.round((linesAbove / scrollable) * maxPos));
  const lines: string[] = [];
  for (let i = 0; i < track; i++) {
    lines.push(i >= pos && i < pos + thumbH ? '█' : '┊');
  }
  return <Text color="#4aa3e0">{lines.join('\n')}</Text>;
}

/** 底部输入框 */
function InputBar(props: {
  input: string;
  cursor: number;
  mode: string;
  model: string;
  leftHint?: ReactNode;
  rightHint?: ReactNode;
}) {
  const { input, cursor, mode, model, leftHint, rightHint } = props;
  const columns = (process.stdout as { columns?: number }).columns ?? 80;
  const width = columns ?? 80;
  const before = input.slice(0, cursor);
  const at = input[cursor] ?? ' ';
  const after = input.slice(cursor + 1);
  const dashedLine = '╍'.repeat(width);
  return (
    <Box flexDirection="column" width="100%">
      <Text color="#4aa3e0">{dashedLine}</Text>
      <Text>
        <Text color="cyan">▌ </Text>
        <Text>{before}</Text>
        <Text backgroundColor="#4aa3e0" color="#ffffff">{at}</Text>
        <Text>{after}</Text>
      </Text>
      <Text color="#4aa3e0">{dashedLine}</Text>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text dimColor>{leftHint ?? '? for shortcuts'}</Text>
        <Text dimColor>
          {rightHint ?? (
            <>
              {`● ${mode} mode · `}
              <Text color="#7ec699">{model}</Text>
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}

export function App(props: AppProps) {
  const c = useAgentController(props, {
    onExit: () => process.exit(0),
  });

  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const { exit } = useApp();

  const modelShort = getMode() === 'pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash';

  // ── 视口：消息区（圆角边框盒内部）可用行数 + 行数布局 + 尾窗切片 ──
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  // 切片行数 = 消息区可用行数 - 指示器 1 行 - (busy ? 思考指示 1 行)
  const areaHeight = computeAreaHeight(rows);
  const sliceArea = Math.max(1, areaHeight - 1 - (c.busy ? 1 : 0));
  // 边框 2 + paddingX 2 + 滚动条/间距预留 2
  const innerW = Math.max(10, cols - 6);

  // 消息行数布局：每条消息的估高（消息/宽度变化才重算）
  const layout = useMemo(() => {
    const items: { msg: UiMessage; start: number; height: number }[] = [];
    let total = 0;
    for (const m of c.messages) {
      const h = estimateLines(m.text, innerW, prefixWidthOf(m.role, m.phase));
      items.push({ msg: m, start: total, height: h });
      total += h;
    }
    return { items, total };
  }, [c.messages, innerW]);

  // 行级窗口选择：scrollOffset 为距顶部隐藏的行数（0=贴底显示最新；滚动键/滚轮驱动）
  const window = useMemo(
    () => selectRowWindow(layout.items, sliceArea, c.scrollOffset, innerW),
    [layout.items, sliceArea, c.scrollOffset, innerW],
  );

  // ── 滚动引用（useInput 闭包内读取最新值，避免陈旧闭包）──
  const sliceAreaRef = useRef(sliceArea);
  sliceAreaRef.current = sliceArea;
  const windowRef = useRef(window);
  windowRef.current = window;
  // 最大可隐藏行数（行级）：总行数 - 视口行数；0 = 内容不足一屏
  const maxHiddenRowsRef = useRef(Math.max(0, window.totalRows - sliceArea));
  maxHiddenRowsRef.current = Math.max(0, window.totalRows - sliceArea);
  // 贴底跟随：true = 新内容到达时自动回到底部（用户在底部时滚动不打断）
  const stickRef = useRef(true);
  useEffect(() => {
    if (stickRef.current) c.setScrollOffset(0);
  }, [layout.total]);

  // ══ 终端输入处理（按键→动作映射，聊天逻辑走控制器）══
  useInput(
    (ch, key) => {
      // ↓↓↓ 新增：过滤鼠标 SGR 序列（详见 docs/Bug修复-鼠标滚轮字符泄漏到输入框.md）
      // 实测：Node readline 消费掉 \x1b 前缀后，useInput 收到的是残余 "[<65;66;19M"（以 [ 开头、不含 ESC）；
      // 不同终端也可能保留完整 "\x1b[<65;66;19M" 或只剩 "<65;66;19M"。统一用正则匹配三种形态：
      //   可选 ESC + 可选 [ + <数字;数字;数字 + M/m（M=按下，m=释放）
      if (ch && ch.length > 1 && /^(?:\x1b)?\[?<\d+;\d+;\d+[Mm]$/.test(ch)) {
        // 不让 SGR 鼠标事件进入 input state；滚轮逻辑由 data 监听器处理
        return;
      }
      // ↑↑↑ 新增结束

      // 权限确认 y/n
      if (c.confirm) {
        if (ch === 'y' || ch === 'Y') {
          c.resolveConfirm(true);
          return;
        }
        if (ch === 'n' || ch === 'N') {
          c.resolveConfirm(false);
          return;
        }
        return;
      }
      // awaitUser 文本输入
      if (c.askTextPrompt) {
        if (key.return && !key.shift) {
          c.resolveAskText(input.trim());
          setInput('');
          setCursor(0);
          return;
        }
        if (ch && !key.ctrl && !key.meta && !key.backspace && !key.delete && !key.leftArrow && !key.rightArrow && !key.upArrow && !key.downArrow && !key.home && !key.end) {
          setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
          setCursor((cu) => cu + ch.length);
        } else if (key.backspace || key.delete) {
          if (cursor > 0) {
            setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
            setCursor((cu) => cu - 1);
          }
        } else if (key.leftArrow) {
          setCursor((cu) => Math.max(0, cu - 1));
        } else if (key.rightArrow) {
          setCursor((cu) => Math.min(input.length, cu + 1));
        } else if (key.home) {
          setCursor(0);
        } else if (key.end) {
          setCursor(input.length);
        }
        return;
      }
      if (c.busyRef.current) return;
      // Enter = 提交（不写换行）
      if (key.return && !key.shift) {
        const raw = input;
        setHistory((h) => [...h, raw]);
        c.submit(input);
        setInput('');
        setCursor(0);
        setHistoryIdx(-1);
        return;
      }
      // 普通可打印字符：在光标处插入
      if (ch && !key.ctrl && !key.meta) {
        setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
        setCursor((cu) => cu + ch.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
          setCursor((cu) => cu - 1);
        }
        return;
      }
      if (key.leftArrow) {
        setCursor((cu) => Math.max(0, cu - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((cu) => Math.min(input.length, cu + 1));
        return;
      }
      if (key.home) {
        setCursor(0);
        return;
      }
      if (key.end) {
        setCursor(input.length);
        return;
      }
      if (key.upArrow) {
        if (history.length === 0) return;
        const ni = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(ni);
        setInput(history[ni] ?? '');
        setCursor(history[ni]?.length ?? 0);
        return;
      }
      if (key.downArrow) {
        if (history.length === 0 || historyIdx < 0) return;
        const ni = historyIdx + 1;
        if (ni >= history.length) {
          setHistoryIdx(-1);
          setInput('');
          setCursor(0);
        } else {
          setHistoryIdx(ni);
          setInput(history[ni] ?? '');
          setCursor(history[ni]?.length ?? 0);
        }
        return;
      }
    },
    { isActive: (!c.busyRef.current || c.confirm !== null || c.askTextPrompt !== null) && !c.showKeyModal },
  );

  // 专用 Ctrl+C 中断处理器
  useInput(
    (input, key) => {
      if (c.showKeyModal) return;
      if (key.ctrl && input === '\u0003') {
        if (c.busyRef.current) {
          c.abort();
          c.push('system', '⏹ 已发送中断信号，正在停止当前请求...');
        } else {
          c.push('system', '💡 输入 /exit 可退出程序（Ctrl+C 不绑定退出）');
        }
      }
    },
    { isActive: true },
  );

  // 聊天区滚动（独立 useInput、isActive 恒真：流式输出期间也能翻历史）
  // 行级滚动：PgUp/PgDn = 一页（sliceArea 行）；↑↓ 保留给输入历史导航
  useInput(
    (_ch, key) => {
      if (c.showKeyModal) return;
      if (!key.pageUp && !key.pageDown) return;
      const cur = c.scrollOffsetRef.current;
      const max = maxHiddenRowsRef.current;
      const page = Math.max(1, windowRef.current.rendered.length);
      let next = cur;
      if (key.pageUp) next = Math.min(max, cur + page);
      else if (key.pageDown) next = Math.max(0, cur - page);
      stickRef.current = next === 0;
      c.setScrollOffset(next);
    },
    { isActive: true },
  );

  // 鼠标滚轮滚动（xterm SGR 编码：\x1b[?1000h + \x1b[?1006h）
  // 仅真实 TTY 启用（headless 测试 / 管道 / CI 环境 process.stdin.isTTY=false 自动跳过）。
  // 监听器只解析滚轮序列、不消费非鼠标字节，ink 的键盘解析不受影响。
  const { stdin: ttyStdin } = useStdin();
  useEffect(() => {
    if (!process.stdin.isTTY) return;
    process.stdout.write('\x1b[?1000h\x1b[?1006h');
    const onData = (buf: Buffer | string) => {
      const s = typeof buf === 'string' ? buf : buf.toString('utf8');
      const m = /\x1b\[<(\d+);\d+;\d+[Mm]/.exec(s);
      if (!m) return;
      const code = Number(m[1]);
      if (code !== 64 && code !== 65) return; // 仅滚轮：64=上滚 65=下滚
      const cur = c.scrollOffsetRef.current;
      const max = maxHiddenRowsRef.current;
      const page = 3; // 行级滚动：滚轮一格 = 3 行（连续滑动的体感粒度）
      const next = code === 64 ? Math.min(max, cur + page) : Math.max(0, cur - page);
      stickRef.current = next === 0;
      c.setScrollOffset(next);
    };
    ttyStdin?.on('data', onData);
    return () => {
      ttyStdin?.off('data', onData);
      process.stdout.write('\x1b[?1006l\x1b[?1000l');
    };
  }, [ttyStdin]);

  // 更换 API Key 遮罩：开启时不渲染主界面，由 KeyCapture 独占输入
  if (c.showKeyModal) {
    return (
      <Box flexDirection="column" height="100%" justifyContent="center" alignItems="center">
        <Box borderStyle="round" borderColor="#2f6fb0" paddingX={2} paddingY={1} flexDirection="column" width={68}>
          <Text color="#2f6fb0" bold>更换 API Key</Text>
          <Text> </Text>
          <KeyCapture
            label="输入新的 DeepSeek API Key（保存后下次启动生效）："
            onSubmit={async (apiKey) => {
              await saveCredentials({ apiKey });
              c.setShowKeyModal(false);
              c.push('system', '已保存新 API Key ✅ 下次启动自动使用（当前会话仍用旧 Key）');
            }}
            onCancel={() => {
              c.setShowKeyModal(false);
              c.push('system', '已取消更换');
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Banner version={props.version} model={modelShort} cwd={process.cwd()} />
      <Box
        flexGrow={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="#2f6fb0"
        paddingX={1}
      >
        <Box flexDirection="row" height={sliceArea}>
          <Box flexDirection="column" flexGrow={1}>
            {window.rendered.map((it) =>
              it.msg.role === 'assistant' && !it.isClipped ? (
                <MarkdownMessage
                  key={it.msg.id}
                  text={it.text}
                  role={it.msg.role}
                  phase={it.msg.phase}
                />
              ) : (
                <PlainTextMessage key={it.msg.id} m={it.msg} text={it.text} />
              ),
            )}
            {c.busy && <ThinkingIndicator />}
          </Box>
          {window.linesAbove > 0 || window.linesBelow > 0 ? (
            <Scrollbar linesAbove={window.linesAbove} total={window.totalRows} area={sliceArea} />
          ) : null}
        </Box>
        <Box flexGrow={1} />
        <ScrollIndicator linesAbove={window.linesAbove} linesBelow={window.linesBelow} />
      </Box>
      {c.confirm && (
        <Box paddingX={1}>
          <Text color="#f0b569">🔐 {c.confirm.prompt} (y/n)</Text>
        </Box>
      )}
      {c.askTextPrompt && (
        <Box paddingX={1}>
          <Text color="#7ec699">💬 Agent 问你: {c.askTextPrompt}（输入回复后回车）</Text>
        </Box>
      )}
      <InputBar
        input={input}
        cursor={cursor}
        mode={c.mode}
        model={modelShort}
        rightHint={`风格:${styleLabel(c.outputStyle)} · /style 切换`}
      />
    </Box>
  );
}

/** 引导入口：由 main.ts 调用，接管整个终端渲染 */
export async function startApp(props: AppProps): Promise<void> {
  // 进入备用屏幕缓冲 + 隐藏光标 + 清屏：清除 npm start / tsx / [auth] 等前置输出，
  // 只保留 TUI 画面（等价于 vim/less 的全屏接管行为）。
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
  // 退出恢复：显示光标 + 离开备用屏幕（任何退出路径都恢复，避免终端"卡住"）
  const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.on('exit', restore);

  // 禁用 ink 默认的 Ctrl+C 退出；退出程序统一走 /exit 命令。
  const { waitUntilExit } = render(<App {...props} />, { exitOnCtrlC: false });
  try {
    await waitUntilExit();
  } finally {
    restore();
    process.removeListener('exit', restore);
  }
}
