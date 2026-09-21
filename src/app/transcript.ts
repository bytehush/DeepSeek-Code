/**
 * 转录推导 —— UI 消息列由内核消息列（Msg[]）现场推导，绝不另存一份。
 *
 * 会话恢复（"第二次进入之前的消息全没了"的修复）的关键设计：
 * 持久化只有内核 Msg[] 这一个事实源，展示层是它的纯函数派生。
 * 两份数据必然漂移，一份不会——与「注册表即 system prompt 唯一来源」同一类纪律。
 *
 * 这是 step 3（trace-first TUI）的雏形：届时 UI 整体变成 CoreEvent 流的回放，
 * 恢复 = 重放事件，展示 = 消费事件，同一机制。此处先把「派生而非存储」立住。
 */
import type { Msg } from '../core/types.ts';
import type { UiMessage } from './types.ts';

/** 单行截断（恢复场景里工具结果可能很长，首屏不需要全文；全文仍在内核） */
function oneLine(text: string, max: number): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/**
 * 内核消息列 → UI 转录。
 *
 * 保真度是刻意的「结论优先」而非逐字节还原：system 提示类消息（截断建议、
 * 内核干预）本就不该给用户看；工具气泡只恢复首行——恢复会话是为了让模型
 * 记得做过什么、用户看得见做过什么，不是为了重放当时的每一个字符。
 */
export function transcriptReplay(msgs: readonly Msg[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;
    const ts = m.ts;
    if (m.role === 'user') {
      out.push({ id: out.length, role: 'user', text: m.content, ts });
    } else if (m.role === 'assistant') {
      const content = m.content.trim();
      const text = content
        ? content
        : m.toolCalls?.length
          ? `（调用了 ${m.toolCalls.map((t) => t.name).join('、')}）`
          : '…';
      out.push({ id: out.length, role: 'assistant', text, phase: 'final', ts });
    } else if (m.role === 'tool') {
      out.push({ id: out.length, role: 'tool', text: `🔧 ${m.name ?? m.toolCallId ?? 'tool'}：${oneLine(m.content, 160)}`, ts });
    }
  }
  return out;
}
