/**
 * src/agent/middleware/after-dispatch.ts — afterDispatch 接缝中间件
 *
 * 承载关注点（来自循环解耦方案 §1.2）：
 *   #16 成功路径验证提示（successChecks）：本轮所有工具结果落盘后，统一插入验证提示，
 *        避免 user 消息楔入 tool 结果之间导致 API 400。
 */
import type { AfterDispatch, CoreApi } from '../core.ts';

export const insertSuccessChecks: AfterDispatch = (api: CoreApi) => {
  const { ctx, history } = api;
  if (ctx.successChecks.length > 0) {
    history.addUser(ctx.successChecks.join('\n'));
  }
};
