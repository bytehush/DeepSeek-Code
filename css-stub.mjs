/**
 * css-stub.mjs — Node 测试用的 .css import 桩。
 * ChatArea.tsx 顶层 `import './ChatArea.css'` 在 Node 直跑会崩（无法解析 .css）。
 * 本 loader 把所有 .css 解析为空模块，使 ChatArea 可在 Node 里被 renderToStaticMarkup 真实渲染。
 * 用法：node --import tsx --import ./css-stub.mjs --test ...
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

// 从 cwd（项目根）解析绝对路径，pathToFileURL 正确百分号编码中文路径，供 register 使用
register(pathToFileURL(pathResolve('css-stub.mjs')).href);

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) {
    return { url: 'css-stub:' + specifier, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('css-stub:')) {
    return { format: 'module', source: 'export default {}', shortCircuit: true };
  }
  return next(url, context);
}
