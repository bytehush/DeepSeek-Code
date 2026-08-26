/**
 * 启动时捕获的 API Key 末 4 位（非完整 Key，安全可展示）。
 *
 * 为什么需要它：pi-ai 的 deepseekProvider 在真实请求命中 401 时，会把
 * process.env.DEEPSEEK_API_KEY 改写成自身的脱敏串（形如 `****ined`），
 * 导致在错误处理时读取 process.env 拿到的是变形值。因此必须在 Agent
 * 构造之前（assemble 阶段、env 尚为真值时）就把尾号捕获下来，供 chat.ts
 * 友好报错时展示「当前使用的 Key 末尾 4 位」。
 */
let apiKeyTail: string | null = null;

export function setApiKeyTail(tail: string | null): void {
  apiKeyTail = tail;
}

export function getApiKeyTail(): string | null {
  return apiKeyTail;
}
