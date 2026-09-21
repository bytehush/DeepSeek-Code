/**
 * Timeline —— trace-first 渲染内核（TUI 重做·方案 B 的落点）。
 *
 * 设计：UI 不再命令式地拼气泡（beginTool/appendStreaming/endStreaming 那套
 * 「手工改数组元素」的逻辑正是历次渲染 bug 的温床——消息丢失、id 重号、
 * 半截气泡全部源于它）。消息列改为对事件流的**纯折叠**：
 *
 *   UiMessage[] = foldTranscript(UiEvent[], {detail, live})
 *
 * 同一条 CoreEvent 流：内核产出 = trace 落盘 = eval 记录 = 屏幕渲染。
 * UI 从此是事件的播放器；想复现任何画面，重放事件即可（与 eval 共用数据面）。
 *
 * 视觉语言「结论优先 + 一行进度」（对应用户反馈的"刷屏看不到重点"）：
 *  - 折叠态（默认）：每个工具调用一行 `#步 🔧 名 参数 ✅/❌ 结果头`；
 *    行动前的过程叙述不占屏（它的结论已经在那一行里）；最终答复全文渲染。
 *  - 展开态（Ctrl+O）：步行下补参数、结果节选、工具实时输出。
 *
 * 会话恢复走同一管线：内核 Msg[] → eventsFromHistory → 同一个 fold。
 * 「恢复后看到的」和「当时看到的」由同一个函数生成——不存在第二份会漂移的实现。
 */
import type { CoreEvent } from '../core/loop/events.ts';
import type { Msg } from '../core/types.ts';
import type { UiMessage } from './types.ts';

/** UI 事件 = 内核事件契约 + UI 侧合成事件（用户输入、工具实时输出、回合收尾） */
export type UiEvent =
  | CoreEvent
  | { type: 'user_input'; text: string }
  | { type: 'tool_progress'; text: string }
  | { type: 'turn_summary'; durationSec: number; label?: string };

// ── 文本整形 ──

function oneLine(s: string, max: number): string {
  const line = (s.split('\n')[0] ?? '').trim();
  return line.length > max ? line.slice(0, max) + '...' : line;
}

/** 时长 → 中文单位（呈现层格式化，自 chat.ts 迁入——编排层不管"怎么说"） */
function formatDuration(sec: number): string {
  if (sec < 60) return sec.toFixed(1) + '秒';
  if (sec < 3600) return `${Math.floor(sec / 60)}分${Math.floor(sec % 60)}秒`;
  return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分${Math.floor(sec % 60)}秒`;
}

/** 参数摘要：优先取语义最强的字段，只占一行（全文在展开态/内核历史里） */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const o = args as Record<string, unknown>;
  for (const k of ['path', 'command', 'query', 'dir', 'pattern']) {
    const v = o[k];
    if (typeof v === 'string' && v) return oneLine(v, 44);
  }
  const first = Object.values(o).find((v) => typeof v === 'string');
  return typeof first === 'string' ? oneLine(first, 44) : '';
}

/** 工具结果分类：决定步行尾的图标。括号开头的内核旁白（干预/未执行）判中性。 */
export function resultStatus(text: string): 'ok' | 'fail' | 'denied' | 'neutral' {
  if (/^(权限拦截|用户拒绝)/.test(text)) return 'denied';
  if (/^（/.test(text)) return 'neutral';
  if (/^(工具执行失败|参数校验失败|错误：)/.test(text)) return 'fail';
  return 'ok';
}

const STATUS_MARK: Record<ReturnType<typeof resultStatus>, string> = {
  ok: ' ✅ ',
  fail: ' ❌ ',
  denied: ' 🔐 ',
  neutral: ' - ',
};

/** 服务端错误分类 → 面向用户的友好提示（自 chat.ts 迁入：这是呈现逻辑，不是编排逻辑） */
export function friendlyErrorMessage(category: string | undefined, raw: string): string {
  switch (category) {
    case 'moderation':
      return '🚫 内容审核未通过：服务端拒绝生成该内容（可能涉及敏感/违规话题）。请调整提问方式或措辞后重试。';
    case 'token_limit':
      return '📏 上下文 / token 超出上限：当前对话历史过长，已无法继续生成。建议 /clear 开新会话，或让任务更聚焦。';
    case 'server_unavailable':
      return '🔌 服务端暂时不可用（限流或服务过载）：请稍候片刻后重试；若持续出现，请检查 API Key 配额或网络连通性。';
    case 'auth': {
      // 自研 provider 层不改写用户 env，报文里的尾号即服务商脱敏值，可信。
      const tail = /api key:?\s*\*?([0-9a-zA-Z]{4})/i.exec(raw);
      const tailText = tail
        ? `   当前使用的 Key 末尾 4 位：${tail[1]}（已由服务商脱敏，非完整 Key）`
        : '';
      return (
        '🔑 API Key 无效或未授权（服务商返回 401 鉴权失败）\n' +
        '   修复方式（任选其一）：\n' +
        '     - 修改项目根 .env 的 DEEPSEEK_API_KEY，或编辑 ~/.dsa/credentials.json\n' +
        '     - 输入 /set-key 按提示填新 Key（下次启动生效）\n' +
        '     - 确认该 Key 在服务商后台处于「启用」状态且有可用额度\n' +
        tailText
      );
    }
    case 'quota':
      return '💰 账户余额/配额不足：请到服务商后台充值或检查配额后重试。';
    default:
      return `⚠️ 生成出错：${raw || '未知错误'}`;
  }
}

// ── 折叠 ──

interface UserSeg { t: 'user'; text: string }
interface TextSeg { t: 'text'; step: number; text: string; answer: boolean; interrupted: boolean }
interface CallSeg { t: 'call'; step: number; name: string; args: unknown; results: string[]; live: string[] }
interface NoticeSeg { t: 'notice'; text: string }
interface ErrorSeg { t: 'error'; text: string }
type Seg = UserSeg | TextSeg | CallSeg | NoticeSeg | ErrorSeg;

/**
 * 把事件流折叠成段（第一遍：归并增量文本、配对调用与结果）。
 * 纯函数：同一事件列必然得到同一折叠——重放即复现。
 */
function segments(events: readonly UiEvent[]): Seg[] {
  const segs: Seg[] = [];
  let openText: TextSeg | null = null;
  let openCall: CallSeg | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case 'user_input':
        openText = null;
        openCall = null;
        segs.push({ t: 'user', text: ev.text });
        break;
      case 'assistant_text': {
        if (!ev.text) break;
        const step = ev.step ?? 0;
        if (openText && openText.step === step) {
          openText.text += ev.text;
        } else {
          openText = { t: 'text', step, text: ev.text, answer: false, interrupted: false };
          segs.push(openText);
        }
        if (ev.reactPhase === 'final') openText.answer = true;
        break;
      }
      case 'assistant_phase':
        if (openText && ev.phase === 'final') openText.answer = true;
        break;
      case 'assistant_promote':
        break; // CLI 无「思考盒晋升」交互；保留 case 防漏
      case 'tool_call':
        openText = null;
        openCall = {
          t: 'call',
          step: ev.step ?? 0,
          name: ev.toolName ?? 'tool',
          args: ev.args,
          results: [],
          live: [],
        };
        segs.push(openCall);
        break;
      case 'tool_result':
        if (openCall) openCall.results.push(String(ev.result ?? ''));
        else segs.push({ t: 'notice', text: `[工具结果] ${String(ev.result ?? '')}` });
        break;
      case 'tool_progress':
        if (openCall) {
          openCall.live.push(ev.text);
          if (openCall.live.length > 8) openCall.live.shift(); // 只留尾部，长输出不撑屏
        }
        break;
      case 'permission':
        break; // 拒绝已由步行的 🔐 呈现，不再重复一条
      case 'system':
        if (ev.text) segs.push({ t: 'notice', text: ev.text });
        break;
      case 'error':
        openText = null;
        segs.push({ t: 'error', text: friendlyErrorMessage(ev.errorCategory, ev.error ?? '未知错误') });
        break;
      case 'done':
        if (ev.reason === 'user_abort' && openText) openText.interrupted = true;
        openText = null;
        openCall = null;
        break;
      case 'turn_summary': {
        const dur = `⏱ 本次任务耗时 ${formatDuration(ev.durationSec)}`;
        segs.push({ t: 'notice', text: ev.label ? `${dur}\n${ev.label}` : dur });
        openText = null;
        openCall = null;
        break;
      }
    }
  }
  return segs;
}

/** 折叠事件流为 UI 消息列。id 取段的下标——事件列只追加，故 id 跨帧稳定。 */
export function foldTranscript(
  events: readonly UiEvent[],
  opts?: { detail?: boolean; live?: boolean },
): UiMessage[] {
  const detail = opts?.detail ?? false;
  const live = opts?.live ?? false;
  const segs = segments(events);

  // suffixHasCall[i]：第 i 段之后是否还有工具调用——有则该处的文本泡是
  // 「行动前叙述」，折叠态收起；回合末尾无后续调用的文本即最终答复。
  const suffixHasCall: boolean[] = new Array(segs.length).fill(false);
  let seen = false;
  for (let i = segs.length - 1; i >= 0; i--) {
    suffixHasCall[i] = seen;
    if (segs[i].t === 'call') seen = true;
  }
  // 当前回合起点：live 时本回合内的叙述保持可见（否则执行中屏幕不动，
  // 用户以为卡死）；回合结束（done 已入日志、live=false）自动收起。
  let turnStart = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].t === 'user') {
      turnStart = i;
      break;
    }
  }

  const out: UiMessage[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.t === 'user') {
      out.push({ id: i, role: 'user', kind: 'user', text: s.text });
    } else if (s.t === 'text') {
      const answered = s.answer || !suffixHasCall[i];
      const liveNarration = live && i > turnStart;
      if (!detail && !answered && !liveNarration) continue; // 折叠态收起过程叙述
      const suffix = s.interrupted ? '（已中断）' : '';
      out.push({
        id: i,
        role: 'assistant',
        kind: answered ? 'answer' : 'progress',
        phase: answered ? 'final' : 'progress',
        text: s.text + suffix,
      });
    } else if (s.t === 'call') {
      const head = s.results[s.results.length - 1];
      let line = `#${s.step} 🔧 ${s.name}${summarizeArgs(s.args) ? ' ' + summarizeArgs(s.args) : ''}`;
      if (head !== undefined) {
        line += STATUS_MARK[resultStatus(head)] + oneLine(head, 52);
      } else if (live) {
        line += ' ...'; // 执行中（结果未回）——本回合最后一条 call 段才可能无结果
      }
      if (detail) {
        const parts = [line];
        const argStr = s.args ? JSON.stringify(s.args) : '';
        if (argStr && argStr !== '{}') parts.push(`  参数 ${oneLine(argStr, 200)}`);
        for (const r of s.results) parts.push(...r.split('\n').slice(0, 4).map((l) => `  ${l}`));
        for (const p of s.live) parts.push(`  > ${oneLine(p, 120)}`);
        line = parts.join('\n');
      }
      out.push({ id: i, role: 'tool', kind: 'step', text: line });
    } else if (s.t === 'notice') {
      out.push({ id: i, role: 'system', kind: 'notice', text: s.text });
    } else {
      out.push({ id: i, role: 'error', kind: 'error', text: s.text });
    }
  }
  return out;
}

/**
 * 内核历史 Msg[] → 等价事件流（会话恢复 = 重放，与实时渲染共用同一 fold）。
 *
 * 每条 assistant 消息开一个新 step：文本与它的工具调用同段，折叠规则
 * （「后面有调用 → 行动前叙述」）才能与实时形态一致。
 */
export function eventsFromHistory(msgs: readonly Msg[]): UiEvent[] {
  const out: UiEvent[] = [];
  let step = 0;
  for (const m of msgs) {
    if (m.role === 'user') {
      out.push({ type: 'user_input', text: m.content });
    } else if (m.role === 'assistant') {
      step++;
      if (m.content.trim()) {
        out.push({
          type: 'assistant_text',
          text: m.content,
          step,
          reactPhase: m.toolCalls?.length ? 'progress' : 'final',
        });
      }
      for (const tc of m.toolCalls ?? []) {
        out.push({ type: 'tool_call', toolName: tc.name, args: tc.args, step });
      }
    } else if (m.role === 'tool') {
      out.push({ type: 'tool_result', toolName: m.name, result: m.content, step });
    }
    // system 不重放：内核旁白（截断建议等）是给模型的，不是给用户的
  }
  return out;
}
