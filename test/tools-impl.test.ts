import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createBaseTools,
  rewriteInlineScript,
  MAX_COMMAND_LENGTH,
  findAllOccurrences,
  occurrenceLineNumbers,
} from '../src/tools/implementations.ts';

const findTool = (name: string) => {
  const tools = createBaseTools({} as never);
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};

test('rewriteInlineScript: 单行 python -c 原样返回，不落临时文件', () => {
  const r = rewriteInlineScript('python -c "print(1)"');
  assert.equal(r.cmd, 'python -c "print(1)"');
  assert.equal(r.tmpFile, null);
});

test('rewriteInlineScript: 多行 python -c 落临时文件并改写命令', async () => {
  const body = 'for i in range(3):\n  print(i)';
  const r = rewriteInlineScript(`python -c "${body}"`);
  assert.ok(r.tmpFile && r.tmpFile.endsWith('.py'), '应生成 .py 临时文件');
  assert.match(r.cmd, /^python "?.*\.py"?$/);
  // 临时文件真实存在且内容为脚本体
  const written = await fs.readFile(r.tmpFile!, 'utf8');
  assert.ok(written.includes('for i in range(3):'), '临时文件内容应为脚本体');
  await fs.unlink(r.tmpFile!);
});

test('rewriteInlineScript: 多行 node -e 落 .js 临时文件', async () => {
  const body = 'for (let i=0;i<3;i++){\n  console.log(i);\n}';
  const r = rewriteInlineScript(`node -e "${body}"`);
  assert.ok(r.tmpFile && r.tmpFile.endsWith('.js'));
  const written = await fs.readFile(r.tmpFile!, 'utf8');
  assert.ok(written.includes('console.log(i)'));
  await fs.unlink(r.tmpFile!);
});

test('rewriteInlineScript: 多行 powershell -Command 落 .ps1 并用 -File 执行', async () => {
  const body = '1..3 | ForEach-Object {\n  Write-Host $_\n}';
  const r = rewriteInlineScript(`powershell -Command "${body}"`);
  assert.ok(r.tmpFile && r.tmpFile.endsWith('.ps1'));
  assert.match(r.cmd, /-File ".+\.ps1"$/);
  await fs.unlink(r.tmpFile!);
});

test('run_command: 命令超长直接拒绝（不启动子进程）', async () => {
  const rc = findTool('run_command');
  const huge = 'x'.repeat(MAX_COMMAND_LENGTH + 1);
  const res = await rc.execute({ command: huge }, { cwd: process.cwd(), signal: undefined });
  assert.equal(res.ok, false);
  assert.match(res.output, /命令过长/);
});

test('run_command: 普通单行命令走原样（长度护栏不误伤）', async () => {
  const rc = findTool('run_command');
  // 仅验证改写层：单行命令不产生临时文件
  const r = rewriteInlineScript('dir');
  assert.equal(r.tmpFile, null);
  assert.equal(r.cmd, 'dir');
});

test('findAllOccurrences / occurrenceLineNumbers: 定位所有重复匹配行号', () => {
  const buf = 'foo\nbar\nfoo\nbaz\nfoo';
  assert.deepEqual(findAllOccurrences(buf, 'foo'), [0, 8, 16]);
  assert.deepEqual(occurrenceLineNumbers(buf, 'foo'), [1, 3, 5]);
});

test('edit_file: old_string 不唯一时返回匹配行号（可行动诊断, B2）', async () => {
  const edit = findTool('edit_file');
  const tmp = join(tmpdir(), `dsa-edit-${randomUUID()}.txt`);
  await fs.writeFile(tmp, 'line1\nTARGET\nline3\nTARGET\nline5', 'utf8');
  const res = await edit.execute(
    { path: tmp, old_string: 'TARGET', new_string: 'X' },
    { cwd: tmpdir(), signal: undefined },
  );
  assert.equal(res.ok, false);
  assert.match(res.output, /出现 2 次/);
  assert.match(res.output, /行号/);
  assert.match(res.output, /2, 4/); // 两处分别在第 2、4 行
  await fs.unlink(tmp);
});

test('edit_file: 唯一匹配仍正常执行（不被 B2 改动误伤）', async () => {
  const edit = findTool('edit_file');
  const tmp = join(tmpdir(), `dsa-edit-${randomUUID()}.txt`);
  await fs.writeFile(tmp, 'AAA\nBBB\nCCC', 'utf8');
  const res = await edit.execute(
    { path: tmp, old_string: 'BBB', new_string: 'B2' },
    { cwd: tmpdir(), signal: undefined },
  );
  // 命中唯一匹配：进入写盘路径（verifyWrittenFile 对纯文本通过），ok 应为 true
  assert.equal(res.ok, true);
  const after = await fs.readFile(tmp, 'utf8');
  assert.equal(after, 'AAA\nB2\nCCC');
  await fs.unlink(tmp);
});

