/**
 * 统一鉴权模块（P4.1 收口）。
 *
 * 把原先散落在 cli/auth.ts（API Key 凭证）与 gui/accounts.ts（网页账户密码）的
 * 鉴权逻辑统一到本目录，供 cli / gui / 任何入口层共享 import，消除 gui→cli 的跨层依赖。
 *
 * - credentials.ts：API Key 凭证解析 / 持久化 / 每账号凭据目录。
 * - accounts.ts：网页账户密码（scrypt 加盐哈希）/ 会话 token。
 */
export * from './credentials.ts';
export * from './accounts.ts';
