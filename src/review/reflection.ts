/**
 * ReviewCommons 审查共同体 · 审查系统② Reflection（递进式质量深度审查）
 *
 * 位置：src/review/reflection.ts
 * 职责：用 Pro 模型评估 agent 输出的质量深度，并判定是否比上一轮「更深」。
 *   - 深度评分 1–5 由模型自评；deeperThanPrior 由本模块按确定性规则计算
 *     （depthScore > priorDepth 且 newThemes 不全是 priorThemes 子集），不轻信模型自判。
 *   - 与 Format Validator 同实现 Reviewer 接口，编排者用同一套 review() 调用。
 *
 * 设计来源：deepseek-code-agent-审查编排者方案.md §3（递进式反思）/ §5
 */

import { z } from 'zod';
import { fetchStructured, formatAnchor, PRO_COMMON_PREFIX } from '../tools/structured-parse.ts';
import type { DeepSeekClient, ChatMessage, JsonSchemaDef } from '../llm/deepseek.ts';
import type { ReviewInput, ReviewReport, Reviewer, ReflectionState } from './types.ts';

/** 模型自评的原始深度结论（未经 deeperThanPrior 判定）。 */
export interface RawReflection {
  passed: boolean;
  depthScore: number;
  newThemes: string[];
  gaps: string[];
  feedback: string;
}

/** 深度评估器（可注入，便于单测隔离 LLM）。默认实现见 createProReflectionAssessor。 */
export interface ReflectionAssessor {
  assess(content: string, prior: ReflectionState): Promise<RawReflection>;
}

/**
 * 确定性递进判定：是否比上轮更深。
 * 规则（方案 §3.3）：depthScore > priorDepth 且 newThemes 不全是 priorThemes 子集。
 */
export function computeDeeperThanPrior(
  depthScore: number,
  newThemes: string[],
  prior: ReflectionState,
): boolean {
  const deeper = depthScore > prior.priorDepth;
  const hasNewTheme = !newThemes.every((t) => prior.priorThemes.includes(t));
  return deeper && hasNewTheme;
}

export class ReflectionReviewer implements Reviewer {
  readonly name = 'reflection';
  private readonly assessor: ReflectionAssessor;

  constructor(assessor: ReflectionAssessor) {
    this.assessor = assessor;
  }

  async review(input: ReviewInput): Promise<ReviewReport> {
    const raw = await this.assessor.assess(input.content, input.priorState);
    const deeperThanPrior = computeDeeperThanPrior(raw.depthScore, raw.newThemes, input.priorState);
    return {
      passed: raw.passed,
      depthScore: raw.depthScore,
      newThemes: raw.newThemes,
      deeperThanPrior,
      gaps: raw.gaps,
      feedback: raw.feedback,
    };
  }
}

// ── 默认实现：Pro 模型评估器 ────────────────────────────────────────────────

const reflectionSchema = z.object({
  passed: z.coerce.boolean(),
  depthScore: z.coerce.number().int().min(1).max(5),
  newThemes: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  feedback: z.string().default(''),
});

const REFLECTION_JSON_SCHEMA: JsonSchemaDef = {
  name: 'reflection_report',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      passed: { type: 'boolean' },
      depthScore: { type: 'integer', minimum: 1, maximum: 5 },
      newThemes: { type: 'array', items: { type: 'string' } },
      gaps: { type: 'array', items: { type: 'string' } },
      feedback: { type: 'string' },
    },
    required: ['passed', 'depthScore', 'newThemes', 'gaps', 'feedback'],
    additionalProperties: false,
  },
};

const REFLECTION_SYSTEM = `你是 AI 输出的质量深度审核员。你的任务不是查事实错误（那由 verify_answer 负责），
而是评估「思考深度」：本轮答复相比上一轮，是否在更根本的层面上分析了问题。

深度判断线索：
- 是否从「改了变量名 / 修了语法」这类表层，深化到「架构职责划分 / 设计取舍 / 根因」这类更抽象归因；
- 是否覆盖了上一轮遗留、尚未深挖的点（gaps）；
- 是否提出了新的、此前未出现的洞察主题（newThemes）。

评分 1–5：1=表层复述；3=中等分析；5=触及根因的本质性洞察。
passed=true 表示本轮内容质量可接受（无明显半成品/自相矛盾），与深度无关。
若评估失败或内容质量不可接受，passed=false 并给出具体 feedback 指引 agent 下一轮如何深化。`;

/**
 * 构造 Pro 模型评估器（S5.4 接线时使用）。
 * 复用 verify_answer 同款 fetchStructured 调用模式（PRO_COMMON_PREFIX + strict JSON schema）。
 */
export function createProReflectionAssessor(
  client: DeepSeekClient,
  signal?: AbortSignal,
): ReflectionAssessor {
  return {
    async assess(content: string, prior: ReflectionState): Promise<RawReflection> {
      const priorCtx =
        prior.round === 0
          ? '（首轮审查，无前序深度可比对）'
          : `上轮深度=${prior.priorDepth}，已覆盖主题=${prior.priorThemes.join('、') || '无'}，遗留待深挖=${prior.priorGaps.join('、') || '无'}`;
      const user = `待审答复:\n---\n${content.slice(0, 4000)}\n---\n\n${priorCtx}\n\n请评估本轮答复的质量深度，并判断是否比上轮更深。`;

      const msgs: ChatMessage[] = [
        { role: 'system', content: PRO_COMMON_PREFIX },
        { role: 'system', content: REFLECTION_SYSTEM },
        {
          role: 'user',
          content: formatAnchor(
            'passed:bool, depthScore:int(1-5), newThemes:string[], gaps:string[], feedback:string',
            '只输出纯 JSON 对象，不要包含解释。',
          ),
        },
        { role: 'user', content: user },
      ];

      const result = await fetchStructured(client, msgs, reflectionSchema, REFLECTION_JSON_SCHEMA, {
        maxRetries: 2,
        reasoningEffort: 'high',
        signal,
      });

      if (!result.ok) {
        // 解析失败 → 保守：视为不达标，要求重做（避免放行未经审查内容）
        return {
          passed: false,
          depthScore: 0,
          newThemes: [],
          gaps: [],
          feedback: `深度审核解析失败：${result.errors?.join('；')}`,
        };
      }
      const d = result.data!;
      return {
        passed: d.passed,
        depthScore: d.depthScore,
        newThemes: d.newThemes ?? [],
        gaps: d.gaps ?? [],
        feedback: d.feedback ?? '',
      };
    },
  };
}
