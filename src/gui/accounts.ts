/**
 * 兼容壳（P4.1 收口）：账户逻辑已统一到 src/auth/accounts.ts。
 * 本文件仅做转发，保持 gui 内既有 `import ... from './accounts.ts'` 引用路径不变。
 */
export * from '../auth/accounts.ts';
