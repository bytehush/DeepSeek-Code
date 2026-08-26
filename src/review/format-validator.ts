/**
 * ReviewCommons 审查共同体 · 审查系统① Format Validator
 *
 * 位置：src/review/format-validator.ts
 * 职责：格式硬门槛（客观、确定性、不依赖 LLM）。
 *   - 通用 sanity：非空、未截断；
 *   - 结构化校验（记录表 S5 五问：schema 来源=复用 zod）：
 *     调用方在构造时传入期望 zod schema，校验 content 是否为合法 JSON 且符合该 schema
 *     （字段/类型/必填），复用 src/tools/structured-parse.ts::parseJSON。
 *
 * 设计来源：deepseek-code-agent-审查编排者方案.md §5（Format Validator 职责边界）
 */

import { z } from 'zod';
import { parseJSON } from '../utils/structured-parse.ts';
import type { ReviewInput, ReviewReport, Reviewer } from './types.ts';

export interface FormatValidatorDeps {
  /** 期望输出结构（zod schema）。提供时做结构化校验；不提供时仅做通用格式 sanity。 */
  schema?: z.ZodType<unknown>;
  /** 最小长度（默认 1，即非空）。 */
  minLength?: number;
  /** 截断标记，命中任一个即视为未写完。 */
  truncationMarkers?: string[];
}

export class FormatValidator implements Reviewer {
  readonly name = 'format-validator';
  private readonly schema?: z.ZodType<unknown>;
  private readonly minLength: number;
  private readonly truncationMarkers: string[];

  constructor(deps: FormatValidatorDeps = {}) {
    this.schema = deps.schema;
    this.minLength = deps.minLength ?? 1;
    this.truncationMarkers = deps.truncationMarkers ?? [
      '...(truncated)',
      '…(截断)',
      '[内容已截断]',
      '<!-- truncated -->',
    ];
  }

  async review(input: ReviewInput): Promise<ReviewReport> {
    const content = input.content;
    const issues: string[] = [];

    // ① 通用格式 sanity
    const trimmed = content.trim();
    if (trimmed.length < this.minLength) {
      issues.push(`内容过短（长度 ${trimmed.length} < 最小 ${this.minLength}）`);
    }
    const hitMarker = this.truncationMarkers.find((m) => content.includes(m));
    if (hitMarker) {
      issues.push(`内容疑似被截断（命中截断标记「${hitMarker}」）`);
    }

    // ② 结构化校验（schema 提供时）
    if (this.schema) {
      const res = parseJSON(content, this.schema);
      if (!res.ok) {
        issues.push(...(res.errors ?? ['结构化校验失败（未知原因）']));
      }
    }

    const passed = issues.length === 0;
    return {
      passed,
      depthScore: 0,
      newThemes: [],
      deeperThanPrior: false,
      gaps: [],
      feedback: passed ? '格式合规' : `格式问题：${issues.join('；')}`,
    };
  }
}
