/**
 * thinkingLayout — 思考轮在 UI 中的落位判定（纯函数，便于单测锁住孤儿轮逻辑）
 *
 * 背景：思考盒在 UI 里有两个落位——
 *   位置 A（气泡上方）：某轮思考已挂靠到 assistant 答案气泡（messages 里 thinkingId === turnId）。
 *   位置 B（底部独立卡）：思考中、答案气泡尚未创建时的实时卡。
 *
 * 旧逻辑只覆盖了「实时活跃卡」（busy && 未 done），遗漏了「孤儿思考轮」：
 *   某轮思考已 done / interrupted，但 loop 未产出配套答案气泡（thinkingId 没对上），
 *   于是它既不在气泡上方（无气泡），也不在底部独立卡（旧判定要求 busy && 未 done）→ 凭空消失。
 *
 * 这里是唯一的真相来源：把 thinkings 拆成「实时活跃卡」与「孤儿/历史卡」两类，
 * ChatArea 据此渲染，确保「思考内容在任何生命周期都完整保留」。
 */
import type { UiMessage } from '../../app/types.ts';
import type { ThinkingTurn } from './App.tsx';

export interface OrphanLayout {
  /** 实时活跃卡：busy 且仍处于 thinking/outputting 的孤儿轮（答案气泡尚未创建） */
  live: ThinkingTurn | undefined;
  /** 孤儿/历史卡：已 done / interrupted 但无配套答案气泡的思考轮，须作为独立卡渲染避免丢失 */
  history: ThinkingTurn[];
}

/** 计算思考轮的 UI 落位。纯函数、无副作用，便于单测。 */
export function computeOrphans(thinkings: ThinkingTurn[], messages: UiMessage[], busy: boolean): OrphanLayout {
  // 已被答案气泡匹配的思考轮次 id（位置 A），这些不进孤儿集合，避免与气泡上方卡重复
  const matchedTurnIds = new Set(
    messages
      .filter((m) => m.role === 'assistant' && typeof m.thinkingId === 'number')
      .map((m) => m.thinkingId as number),
  );
  const orphans = thinkings.filter((t) => !matchedTurnIds.has(t.turnId));
  // 实时活跃卡：取「最新孤儿轮」，只要它仍处于 thinking/outputting 且全局 busy，就显示为
  // live 卡——不受历史里是否有 assistant 气泡影响（历史气泡已通过 matchedTurnIds 排除，
  // 不会与 live 卡重叠）。这正是「切换/后续任务中发消息也能看到助手头像+思考卡」的关键。
  // 过度防御回归：早期为消除 [overlap] 把 guard 写成「messages 含 assistant 即不显示 live」，
  // 范围过大，导致任何有历史的任务在思考阶段完全没有 live 卡。
  const latestOrphan = orphans[orphans.length - 1];
  const live =
    busy && latestOrphan && (latestOrphan.status === 'thinking' || latestOrphan.status === 'outputting')
      ? latestOrphan
      : undefined;
  // 其余孤儿轮（已结束 / 中断 / 多轮思考里未匹配的早期轮）全部作为历史卡渲染
  const history = orphans.filter((t) => t !== live);
  return { live, history };
}
