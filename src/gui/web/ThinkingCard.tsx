/**
 * ThinkingCard — 单轮「思考过程」卡片（自包含，无 css / 无 markdown / 无 window 依赖）
 *
 * 从 ChatArea.tsx 抽出为独立模块，便于在 Node 环境下用 renderToStaticMarkup
 * 真实渲染验证（沙箱无法跑浏览器时，这是验证「思考盒是否被画出来」的唯一手段）。
 *
 * 使用方：
 *  - 气泡上方（ChatArea 的 AssistantRow 内，thinkingId 命中时）
 *  - 底部独立卡（实时活跃轮 / 孤儿思考轮，由 thinkingLayout.computeOrphans 决定）
 */
import { memo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { ThinkingTurn, ThinkingEntry } from './App.tsx';
import { useTypewriter } from './useTypewriter.ts';

/** 小图标：完成对勾 */
function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}
/** 小图标：工具（扳手） */
function ToolIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.5 2.5a3 3 0 0 0-4 4L3 10a2 2 0 0 0 3 3l3.5-3.5a3 3 0 0 0 4-4l-2.5 2.5-1.5-1.5z" />
    </svg>
  );
}
/** 小图标：停止（方块）— 用于「生成中断」徽章 */
function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/** 单条观察（推理 / 工具 / 工具结果） */
const ThinkingStep = memo(function ThinkingStep({ entry }: { entry: ThinkingEntry }) {
  // 流式条目（status==='streaming'）逐字揭示；已完成/历史条目立即完整显示
  const live = entry.status === 'streaming';
  const shown = useTypewriter(entry.text, live);
  if (entry.kind === 'tool') {
    return (
      <div className="think-step tool">
        <div className="think-step-head">
          <ToolIcon />
          <span className="think-tool-name">{entry.title}</span>
        </div>
        {entry.text.trim() && <pre className="think-text">{shown.trim()}</pre>}
      </div>
    );
  }
  if (entry.kind === 'tool_result') {
    return (
      <div className="think-step result">
        <div className="think-step-label">↳ 工具结果</div>
        <pre className="think-text muted">{shown.trim()}</pre>
      </div>
    );
  }
  return (
    <div className="think-step reason">
      <pre className="think-text">{shown.trim()}</pre>
    </div>
  );
});

/** 一轮对话的「思考过程」卡片：可折叠，展开显示全部观察条目 */
const ThinkingCard = memo(function ThinkingCard({ turn, onToggle }: { turn: ThinkingTurn; onToggle: (id: number) => void }) {
  const isActive = turn.status === 'thinking' || turn.status === 'outputting';
  const isInterrupted = turn.status === 'interrupted';
  const stepCount = turn.entries.length;
  return (
    <div className={`thinking-card ${turn.collapsed ? 'collapsed' : ''} ${isActive ? 'active' : ''} ${isInterrupted ? 'interrupted' : ''}`}>
      <button className="thinking-head" onClick={() => onToggle(turn.turnId)} aria-expanded={!turn.collapsed}>
        <span className="thinking-ico" aria-hidden>
          {isActive ? <span className="spinner" /> : isInterrupted ? <StopIcon /> : <CheckIcon />}
        </span>
        <span className="thinking-title">{isActive ? '思考中…' : isInterrupted ? '生成中断' : `思考过程 · ${stepCount} 步`}</span>
        <span className="thinking-count">{stepCount}</span>
        <span className="thinking-caret" aria-hidden>{turn.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {!turn.collapsed && stepCount > 0 && (
        <div className="thinking-body">
          {turn.entries.map((e) => (
            <ThinkingStep key={e.id} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
});

export { ThinkingCard, ThinkingStep };
