/**
 * 前端登录态与「当前激活任务」的持久化收口。
 *
 * 设计要点（修复「刷新/关标签重开回登录」的根因）：
 *  - token 必须存 localStorage（而非 sessionStorage）。sessionStorage 在「关标签重开」
 *    或隐私容器刷新时会被清空，导致每次重开都丢失登录态；localStorage 跨刷新/重开存活。
 *  - 当前激活任务 id 同样存 localStorage，刷新后据此恢复「回到哪个对话」（思考内容本身
 *    由服务端磁盘持久化，前端不存，避免与服务端分叉）。
 *  - 全部访问走 try/catch + typeof 守卫：隐私模式 / 存储不可用时静默降级为「无持久态」，
 *    绝不抛错中断渲染。
 *
 * 集中到本模块，既消除 sessionStorage/localStorage 错配，也让持久化逻辑可纯函数单测
 * （不必渲染整个 React 组件）。
 */

const TOKEN_KEY = 'dsa_token';
const ACTIVE_TASK_KEY = 'dsa_active_task';

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式 / 存储配额/不可用时忽略 */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** 读取登录 token（localStorage）。无/不可用时返回 null。 */
export function readToken(): string | null {
  return safeGet(TOKEN_KEY);
}

/** 写入登录 token（localStorage）。 */
export function writeToken(token: string): void {
  safeSet(TOKEN_KEY, token);
}

/** 清除登录 token（登出时）。 */
export function clearToken(): void {
  safeRemove(TOKEN_KEY);
}

/** 读取当前激活任务 id（localStorage）。无/不可用时返回 null。 */
export function readActiveTask(): string | null {
  return safeGet(ACTIVE_TASK_KEY);
}

/** 写入当前激活任务 id（localStorage）。 */
export function writeActiveTask(id: string): void {
  safeSet(ACTIVE_TASK_KEY, id);
}

/** 清除当前激活任务 id。 */
export function clearActiveTask(): void {
  safeRemove(ACTIVE_TASK_KEY);
}

export { TOKEN_KEY, ACTIVE_TASK_KEY };
