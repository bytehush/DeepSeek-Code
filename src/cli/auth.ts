/**
 * 兼容壳（P4.1 收口）：鉴权逻辑已统一到 src/auth/credentials.ts。
 * 本文件仅做转发，保持 cli 内既有 `import ... from './auth.ts'` 引用路径不变。
 */
export * from '../auth/credentials.ts';
