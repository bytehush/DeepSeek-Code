/**
 * Embedder 单测（M7 · 修复 L5 CN 被墙静默退关键词）。
 *
 * 覆盖：
 * - resolveHfEndpoint 三态（无 mirror/无 env → undefined 维持 baseline；mirror 开 → 中科大写像；env 优先）
 * - NullEmbedder（离线关键词降级锚点）行为不变
 * - BgeEmbedder 离线/无依赖时 embed 不抛错、优雅降级
 * - RemoteEmbedder 无 key/url → 降级本地；远程不可达 → 捕获后降级本地（优雅降级）
 *
 * 全程不触发真实模型下载 / 远程网络（fetch 仅指向不可达地址以验证降级路径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BgeEmbedder,
  NullEmbedder,
  RemoteEmbedder,
  resolveHfEndpoint,
  DEFAULT_HF_MIRROR,
} from '../src/memory/embedder.ts';

test('resolveHfEndpoint: 无 mirror / 无 env → undefined（维持 baseline 直连 HF）', () => {
  const prev = process.env.HF_ENDPOINT;
  delete process.env.HF_ENDPOINT;
  try {
    assert.equal(resolveHfEndpoint(false), undefined);
  } finally {
    if (prev !== undefined) process.env.HF_ENDPOINT = prev;
  }
});

test('resolveHfEndpoint: embedderMirror 开启且无 env → 返回默认中科大写像', () => {
  const prev = process.env.HF_ENDPOINT;
  delete process.env.HF_ENDPOINT;
  try {
    assert.equal(resolveHfEndpoint(true), DEFAULT_HF_MIRROR);
  } finally {
    if (prev !== undefined) process.env.HF_ENDPOINT = prev;
  }
});

test('resolveHfEndpoint: env HF_ENDPOINT 优先级高于 flag（开/关皆尊重 env）', () => {
  const prev = process.env.HF_ENDPOINT;
  process.env.HF_ENDPOINT = 'https://my-mirror.example';
  try {
    assert.equal(resolveHfEndpoint(true), 'https://my-mirror.example');
    assert.equal(resolveHfEndpoint(false), 'https://my-mirror.example');
  } finally {
    if (prev !== undefined) process.env.HF_ENDPOINT = prev;
    else delete process.env.HF_ENDPOINT;
  }
});

test('NullEmbedder: embed 恒返回 null（离线关键词降级锚点，行为不变）', async () => {
  const e = new NullEmbedder();
  assert.equal(await e.embed('任意文本'), null);
});

test('BgeEmbedder: 未装模型/依赖时 embed 不抛错、降级 null 或返回向量', async () => {
  const e = new BgeEmbedder({ mode: 'local' });
  // 测试环境大概率未安装模型/依赖，应优雅返回 null 而非抛错；若已缓存则返回向量。
  const out = await e.embed('hello');
  assert.ok(out === null || Array.isArray(out));
});

test('RemoteEmbedder: 未配置 key/url → 降级本地 BGE，不抛错', async () => {
  const prevUrl = process.env.DSA_EMBEDDING_URL;
  const prevKey = process.env.DSA_EMBEDDING_KEY;
  delete process.env.DSA_EMBEDDING_URL;
  delete process.env.DSA_EMBEDDING_KEY;
  try {
    const e = new RemoteEmbedder();
    const out = await e.embed('hello');
    assert.ok(out === null || Array.isArray(out));
  } finally {
    if (prevUrl !== undefined) process.env.DSA_EMBEDDING_URL = prevUrl;
    if (prevKey !== undefined) process.env.DSA_EMBEDDING_KEY = prevKey;
  }
});

test('RemoteEmbedder: 远程不可达/无效 → 捕获后降级本地，不抛错（优雅降级）', async () => {
  const e = new RemoteEmbedder({ url: 'http://127.0.0.1:9', key: 'k', mirror: false });
  const out = await e.embed('hello');
  assert.ok(out === null || Array.isArray(out));
});
