/**
 * useAgentController —— CLI（ink）端对 ChatContext 的实现（trace-first 版）。
 *
 * 状态模型（step 3 TUI 重做的落点）：唯一可变事实源是一条 **事件日志**
 * （UiEvent[]，与内核 CoreEvent / trace 落盘 / eval 记录同一契约），
 * 屏幕消息列 = foldTranscript(事件日志) 的纯函数派生。
 *
 * 旧版是命令式的（push/appendTo/beginTool/endStreaming 手工改数组元素）——
 * 消息丢失、id 重号、半截气泡、"第二次进入什么都没了"全源于那套可变气泡树。
 * 播放器模型下：渲染 = 消费事件，恢复 = 重放事件（与 eval 共用数据面），
 * 任何画面 bug 都能用当时的事件流复现。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { PermissionMode } from '../core/permission/engine.ts';
import type { OutputStyle } from '../core/loop/output-style.ts';
import { loadStyle } from '../core/loop/output-style.ts';
import { runChatTurn, type ChatContext } from './chat.ts';
import { eventsFromHistory, foldTranscript, type UiEvent } from './timeline.ts';
import type { AppProps, UiMessage } from './types.ts';

export interface UseAgentControllerOptions {
  /** /exit 退出行为（CLI 传 process.exit，网页后端用不到） */
  onExit?: () => void;
}

export interface AgentController {
  messages: UiMessage[];
  busy: boolean;
  busyRef: MutableRefObject<boolean>;
  mode: PermissionMode;
  planMode: boolean;
  outputStyle: OutputStyle;
  confirm: { prompt: string } | null;
  askTextPrompt: string | null;
  showKeyModal: boolean;
  setShowKeyModal: (v: boolean) => void;
  /** 过程细节展开态（Ctrl+O）：折叠=结论优先，展开=逐工具明细 */
  detail: boolean;
  toggleDetail: () => void;
  /** 滚动：距顶部隐藏的行数（0=贴底显示最新，行级滚动模型）；由 TUI 视图层驱动 */
  scrollOffset: number;
  setScrollOffset: (n: number) => void;
  scrollOffsetRef: MutableRefObject<number>;
  submit: (text: string) => void;
  resolveConfirm: (yes: boolean) => void;
  resolveAskText: (text: string) => void;
  abort: () => void;
  setMode: (m: PermissionMode) => void;
  setPlanMode: (b: boolean) => void;
  setOutputStyle: (s: OutputStyle) => void;
  /** 终端专属逻辑（中断提示、Key 保存反馈）直接追加一行系统事件 */
  systemText: (text: string) => void;
}

export function useAgentController(props: AppProps, opts?: UseAgentControllerOptions): AgentController {
  // 事件日志：启动时用内核历史重放填充——恢复与实时渲染走同一个 fold，
  // 不存在第二份会漂移的"转录存储"。
  const [events, setEvents] = useState<UiEvent[]>(() => eventsFromHistory(props.kernel.history));
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const [detail, setDetail] = useState(false);
  const [mode, setMode] = useState<PermissionMode>('execute');
  const [planMode, setPlanMode] = useState(false);
  const [outputStyle, setOutputStyle] = useState<OutputStyle>(() => loadStyle(process.cwd()));
  const [confirm, setConfirm] = useState<{ prompt: string } | null>(null);
  const [askTextPrompt, setAskTextPrompt] = useState<string | null>(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  /** 滚动状态：距顶部隐藏的行数（0=贴底显示最新，行级滚动模型） */
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollOffsetRef = useRef(0);
  scrollOffsetRef.current = scrollOffset;

  const activeAbort = useRef<AbortController | null>(null);
  const confirmRef = useRef<{ prompt: string; resolve: (b: boolean) => void } | null>(null);
  const askTextRef = useRef<{ prompt: string; resolve: (t: string) => void } | null>(null);

  const appendEvent = useCallback((ev: UiEvent) => {
    setEvents((prev) => [...prev, ev]);
  }, []);

  // 消息列 = 事件流的纯折叠。live=busy：流式尾部过程文本/未完成步骤要可见。
  const messages: UiMessage[] = useMemo(
    () => foldTranscript(events, { detail, live: busy }),
    [events, detail, busy],
  );

  const systemText = useCallback(
    (text: string) => appendEvent({ type: 'system', text }),
    [appendEvent],
  );

  const setBusy = useCallback((b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  }, []);

  const requestConfirm = useCallback(
    (prompt: string) =>
      new Promise<boolean>((resolve) => {
        confirmRef.current = { prompt, resolve };
        setConfirm({ prompt });
      }),
    [],
  );
  const resolveConfirm = useCallback((yes: boolean) => {
    const r = confirmRef.current?.resolve;
    confirmRef.current = null;
    setConfirm(null);
    r?.(yes);
  }, []);

  const requestAskText = useCallback(
    (prompt: string) =>
      new Promise<string>((resolve) => {
        askTextRef.current = { prompt, resolve };
        setAskTextPrompt(prompt);
      }),
    [],
  );
  const resolveAskText = useCallback((text: string) => {
    const r = askTextRef.current?.resolve;
    askTextRef.current = null;
    setAskTextPrompt(null);
    r?.(text);
  }, []);

  const abort = useCallback(() => {
    activeAbort.current?.abort();
  }, []);
  const setActiveAbort = useCallback((ac: AbortController | null) => {
    activeAbort.current = ac;
  }, []);

  const toggleDetail = useCallback(() => setDetail((d) => !d), []);

  // 组装稳定的 ChatContext（构造一次，所有方法均为稳定引用）
  const ctxRef = useRef<ChatContext | null>(null);
  if (!ctxRef.current) {
    ctxRef.current = {
      props,
      // 配置读写根（/style、/model、/rollback）跟随工作空间，而非启动目录——
      // 避免在源码目录启动时把配置写进源码（docs/UX优化-工作空间路径规划与源码目录保护.md）
      cwd: props.workspace,
      uiEv: appendEvent,
      systemText,
      resetEvents: () => setEvents([]),
      setBusy,
      getState: () => stateRef.current,
      maxIterations: 0, // 0 → chat.ts 回退 DEFAULT_MAX_ITERATIONS(30)，不再是"无上限"
      setMode,
      setPlanMode,
      setOutputStyle,
      setActiveAbort,
      abort,
      requestConfirm,
      requestAskText,
      requestKeyChange: () => setShowKeyModal(true),
      onExit: opts?.onExit,
    };
  }

  // 让 getState 始终读到最新 state（避免 runChatTurn 闭包过期）
  const stateRef = useRef({ mode, planMode, outputStyle });
  stateRef.current = { mode, planMode, outputStyle };

  const submit = useCallback((text: string) => {
    void runChatTurn(text, ctxRef.current!);
  }, []);

  return {
    messages,
    busy,
    busyRef,
    mode,
    planMode,
    outputStyle,
    confirm,
    askTextPrompt,
    showKeyModal,
    setShowKeyModal,
    detail,
    toggleDetail,
    scrollOffset,
    setScrollOffset,
    scrollOffsetRef,
    submit,
    resolveConfirm,
    resolveAskText,
    abort,
    setMode,
    setPlanMode,
    setOutputStyle,
    systemText,
  };
}
