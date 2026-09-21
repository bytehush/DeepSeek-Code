/**
 * ToolRegistry —— 工具的唯一事实源（幽灵工具的结构解药）。
 *
 * 机制：System Prompt 的工具段 **由注册表生成**，不存在第二份手写清单。
 * 提示词里可能出现的工具名 ⊆ 注册名，由构造保证而非人工维护；
 * test/prompt-contract.test.ts 另加一道回归断言。
 *
 * 每个工具自带 capability（权限维度）与 risk（闸门输入），
 * 权限判定因此无需再按工具名硬编码（旧 isMutatingTool 的反模式）。
 */
import { z } from 'zod';
import type { Capability, Risk } from '../permission/engine.ts';

export interface ToolContext {
  /** 工作区根（路径解析基准） */
  cwd: string;
  /** 受保护目录（写操作禁止落点） */
  protectedRoots: string[];
  /** 实时输出回调（bash stdout 等） */
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** 回灌给模型的文本 */
  content: string;
  /** 结构化附注（trace / UI 展示用，不进模型） */
  details?: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  label: string;
  /** 给模型看的一行说明（进 system prompt 与 tool schema description） */
  description: string;
  /** 参数校验器（只读持有；execute 前 safeParse） */
  readonly parameters: z.ZodTypeAny;
  /** JSON Schema（provider wire 用；由 zod 派生） */
  jsonSchema: Record<string, unknown>;
  capability: Capability;
  risk: Risk;
  /** 破坏性参数检测：如 bash 的 command 是否命中 destructive 模式 */
  isDestructiveArgs?: (args: Record<string, unknown>) => boolean;
  /** 写操作的 diff 预览（require_confirm 时展示）；返回 null 表示无预览 */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => string | null;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): this {
    if (this.tools.has(spec.name)) throw new Error(`工具重复注册: ${spec.name}`);
    this.tools.set(spec.name, spec);
    return this;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** provider wire 用的工具定义 */
  wireSpecs(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema,
    }));
  }

  /**
   * System Prompt 的工具段（唯一来源）。
   * 参数摘要取 zod shape 的键名，避免在提示词里复制一份会漂移的签名。
   */
  promptSection(): string {
    const lines = this.list().map((t) => {
      const shape = t.parameters instanceof z.ZodObject ? Object.keys(t.parameters.shape) : [];
      const sig = shape.length > 0 ? `(${shape.join(', ')})` : '()';
      return `- \`${t.name}${sig}\`：${t.description}`;
    });
    return ['可用工具（当前会话注册表实时生成，仅以下工具存在）：', ...lines].join('\n');
  }
}

/** 从 zod schema 派生 JSON Schema（wire 用；保持窄依赖，不引第三方转换器） */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    return jsonSchemaFromObject(schema as z.ZodObject<z.ZodRawShape>);
  }
  return withDesc(schema, schema.description);
}

function jsonSchemaFromObject(obj: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(obj.shape)) {
    const opt =
      value instanceof z.ZodOptional || value instanceof z.ZodDefault;
    properties[key] = { ...toPropInner(value as z.ZodTypeAny) };
    if (!opt) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function toPropInner(s: z.ZodTypeAny): Record<string, unknown> {
  if (s instanceof z.ZodOptional) return withDesc(s.unwrap(), s.description);
  if (s instanceof z.ZodDefault) return withDesc(s.removeDefault(), s.description);
  return withDesc(s, s.description);
}

function withDesc(s: z.ZodTypeAny, desc: string | undefined): Record<string, unknown> {
  const base: Record<string, unknown> =
    s instanceof z.ZodString
      ? { type: 'string' }
      : s instanceof z.ZodNumber
        ? { type: 'number' }
        : s instanceof z.ZodBoolean
          ? { type: 'boolean' }
          : s instanceof z.ZodArray
            ? { type: 'array', items: { type: 'string' } }
            : s instanceof z.ZodObject
              ? jsonSchemaFromObject(s as z.ZodObject<z.ZodRawShape>)
              : { type: 'string' };
  return desc ? { ...base, description: desc } : base;
}

/** 便捷构造：注册参数用 zod object 并自动派生 wire schema */
export function defineTool(
  spec: Omit<ToolSpec, 'jsonSchema' | 'parameters'> & { parameters: z.ZodObject<z.ZodRawShape> },
): ToolSpec {
  return {
    ...spec,
    parameters: spec.parameters,
    jsonSchema: zodToJsonSchema(spec.parameters),
  };
}
