/**
 * 工具参数校验与解析兜底（P1.3 · 地基首选）。
 *
 * 对接 S1.1 根因 #1/#2/#4：
 * - #1 parseTools 静默吞 JSON 错误 → extractArguments 解析失败「明确返回 error」，不静默降级为 {}。
 * - #2 分发前无 validateArgs → validateArgs 在工具执行前对 arguments 做 JSON Schema 轻量校验。
 * - #4 缺参变字面量 "undefined" → validateArgs 在分发前拦下缺参/类型错，避免流入 resolve()。
 *
 * 设计约束：
 * - 不引入新依赖（项目无 ajv），用轻量 JSON Schema 校验覆盖 type/required/properties/enum/items。
 * - 纯函数、无副作用、可单测；被后续 S1.2 拆分与 loop.ts 分发接线复用。
 */

/** 工具参数的 JSON Schema 子集（与 loop.ts toModelTools 发出的 t.parameters 形状一致）。 */
export interface JsonSchemaLike {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  enum?: unknown[];
  description?: string;
  [k: string]: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * 轻量 JSON Schema 校验（分发前调用）。
 * 覆盖 type / required / properties(递归) / enum / items，足够拦下缺参与类型错。
 */
export function validateArgs(value: unknown, schema: JsonSchemaLike): ValidationResult {
  const errors: string[] = [];
  check(value, schema, '$', errors);
  return { ok: errors.length === 0, errors };
}

function check(v: unknown, schema: JsonSchemaLike, path: string, errors: string[]): void {
  if (schema.type && !typeMatches(v, schema.type)) {
    errors.push(`${path}: 期望类型 ${schema.type}，实际 ${typeName(v)}`);
    return; // 类型错则不再深入，避免噪声
  }
  if (schema.type === 'object' && schema.properties) {
    const obj = v as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: 缺少必填字段`);
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in obj) check(obj[k], sub, `${path}.${k}`, errors);
    }
  }
  if (schema.type === 'array' && schema.items && Array.isArray(v)) {
    v.forEach((item, i) => check(item, schema.items as JsonSchemaLike, `${path}[${i}]`, errors));
  }
  if (schema.enum && !schema.enum.includes(v)) {
    errors.push(`${path}: 值不在枚举 ${JSON.stringify(schema.enum)} 中`);
  }
}

function typeMatches(v: unknown, t: string): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && !Number.isNaN(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export interface ExtractResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * 从模型返回的 arguments 字符串中容错提取对象。
 * 关键：解析失败「明确返回 error」，绝不静默降级为 {}（修复根因 #1）。
 */
export function extractArguments(raw: unknown): ExtractResult {
  if (raw === null || raw === undefined) {
    return { ok: false, error: 'arguments 为 null/undefined' };
  }
  // 已是解析后的对象/数组（兼容 ToolCallRequest.rawArguments 为 Record 的契约变体）：
  // 直接返回，避免 String(obj) 得到 "[object Object]" 后解析失败。
  if (typeof raw === 'object' && raw !== null) {
    return { ok: true, value: raw };
  }
  const text = String(raw).trim();
  if (text === '') return { ok: true, value: {} }; // 无参工具

  // 1. 直接 parse
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    /* fallthrough */
  }

  // 2. 去 markdown 代码围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return { ok: true, value: JSON.parse(fence[1].trim()) };
    } catch {
      /* fallthrough */
    }
  }

  // 3. B3 根因修复：LLM 常在大型多行 content 里把换行/制表符直接写进 JSON 字符串
  //    （未转义），导致 JSON.parse 失败 → 整段参数被拒（"参数校验失败"）。
  //    在字符串字面量内把这些未转义控制字符转成合法 JSON 转义（\n \r \t 等）。
  try {
    return { ok: true, value: JSON.parse(escapeControlInStrings(text)) };
  } catch {
    /* fallthrough */
  }

  // 4. 容错修复：去尾随逗号 + 补缺失右括号，再转义控制字符
  const repaired = repair(text);
  try {
    return { ok: true, value: JSON.parse(escapeControlInStrings(repaired)) };
  } catch (e) {
    return { ok: false, error: `无法解析 arguments: ${(e as Error).message}` };
  }
}

/**
 * 在 JSON 字符串字面量内部，把未转义的控制字符（换行/回车/制表等）转成合法转义序列。
 * 状态机扫描：仅在引号内、且非转义状态下转换；已转义的序列（如 \" \\n）原样保留。
 * 这把 LLM 直接写进字符串的裸换行修正为 \n，JSON.parse 即可还原为真实换行字符。
 */
function escapeControlInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = !inStr;
      continue;
    }
    if (inStr) {
      const code = s.charCodeAt(i);
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
    }
    out += ch;
  }
  return out;
}

function repair(s: string): string {
  let t = s.trim();
  t = t.replace(/,(\s*[}\]])/g, '$1'); // 尾随逗号
  const opens = (t.match(/[\[{]/g) || []).length;
  const closes = (t.match(/[\]}]/g) || []).length;
  if (opens > closes) t += '}'.repeat(opens - closes);
  return t;
}

// ─────────────────────────────────────────────────────────────
// 以下 fuzzyMatchBlock 由 S1.2 从 index.ts 并入（文本鲁棒匹配，供 edit_file）。

/**
 * 在文件内容中定位 old_string 的起始字符索引，比 buf.indexOf 更鲁棒。
 * 依次尝试：1) 精确匹配；2) 统一换行符(\r\n→\n)后匹配；
 * 3) 逐行忽略首尾空白匹配（覆盖缩进/行尾空白差异）。
 * 返回 -1 表示均失败。edit_file 用它替代 indexOf，减少因细微空白差异导致的失败。
 */
export function fuzzyMatchBlock(buf: string, oldS: string): number {
  const exact = buf.indexOf(oldS);
  if (exact !== -1) return exact;

  const normOld = oldS.replace(/\r\n/g, '\n');
  const e2 = buf.indexOf(normOld);
  if (e2 !== -1) return e2;

  const oldLines = normOld.split('\n');
  const bufLines = buf.split('\n');
  // 全空白块无意义，跳过逐行匹配避免误命中
  if (oldLines.every((l) => l.trim() === '')) return -1;

  if (oldLines.length === 1) {
    const target = oldLines[0];
    for (let i = 0; i < bufLines.length; i++) {
      if (bufLines[i] === target || bufLines[i].trim() === target.trim()) {
        let idx = 0;
        for (let k = 0; k < i; k++) idx += bufLines[k].length + 1;
        return idx;
      }
    }
    return -1;
  }
  for (let i = 0; i + oldLines.length <= bufLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (bufLines[i + j].trim() !== oldLines[j].trim()) {
        ok = false;
        break;
      }
    }
    if (ok) {
      let idx = 0;
      for (let k = 0; k < i; k++) idx += bufLines[k].length + 1;
      return idx;
    }
  }
  return -1;
}
