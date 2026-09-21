import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/core/permission/engine.ts';

test('decide: explore 仅放行 low 风险，其余拦截', () => {
  assert.equal(
    decide({ mode: 'explore', effectiveRisk: 'low', isFileWrite: false, destructive: false, toolName: 'read_file' }).action,
    'allow',
  );
  assert.equal(
    decide({ mode: 'explore', effectiveRisk: 'mid', isFileWrite: false, destructive: false, toolName: 'x' }).action,
    'deny',
  );
  assert.equal(
    decide({ mode: 'explore', effectiveRisk: 'high', isFileWrite: true, destructive: false, toolName: 'edit_file' }).action,
    'deny',
  );
  assert.equal(
    decide({ mode: 'explore', effectiveRisk: 'high', isFileWrite: false, destructive: true, toolName: 'run_command' }).action,
    'deny',
  );
});

test('decide: ask 文件写/high 需确认，其余放行', () => {
  const fileWrite = decide({ mode: 'ask', effectiveRisk: 'mid', isFileWrite: true, destructive: false, toolName: 'edit_file' });
  assert.equal(fileWrite.action, 'require_confirm');

  const high = decide({ mode: 'ask', effectiveRisk: 'high', isFileWrite: false, destructive: false, toolName: 'run_command' });
  assert.equal(high.action, 'require_confirm');

  // ask + 非文件写 + low → 放行
  assert.equal(
    decide({ mode: 'ask', effectiveRisk: 'low', isFileWrite: false, destructive: false, toolName: 'read_file' }).action,
    'allow',
  );
  // ask + 非文件写 + mid → 放行（原逻辑仅 high 弹确认）
  assert.equal(
    decide({ mode: 'ask', effectiveRisk: 'mid', isFileWrite: false, destructive: false, toolName: 'x' }).action,
    'allow',
  );
});

test('decide: execute 仅 destructive/文件写 需确认', () => {
  assert.equal(
    decide({ mode: 'execute', effectiveRisk: 'high', isFileWrite: false, destructive: true, toolName: 'run_command' }).action,
    'require_confirm',
  );
  assert.equal(
    decide({ mode: 'execute', effectiveRisk: 'mid', isFileWrite: true, destructive: false, toolName: 'edit_file' }).action,
    'require_confirm',
  );
  // execute + 非 destructive + 非文件写 → 放行
  assert.equal(
    decide({ mode: 'execute', effectiveRisk: 'mid', isFileWrite: false, destructive: false, toolName: 'x' }).action,
    'allow',
  );
  assert.equal(
    decide({ mode: 'execute', effectiveRisk: 'low', isFileWrite: false, destructive: false, toolName: 'read_file' }).action,
    'allow',
  );
});

test('decide: require_confirm 通道选择正确', () => {
  const fileReview = decide({ mode: 'ask', effectiveRisk: 'mid', isFileWrite: true, destructive: false, toolName: 'edit_file' });
  assert.equal(fileReview.action, 'require_confirm');
  if (fileReview.action === 'require_confirm') assert.equal(fileReview.channel, 'file_review');

  const riskPrompt = decide({ mode: 'ask', effectiveRisk: 'high', isFileWrite: false, destructive: false, toolName: 'run_command' });
  assert.equal(riskPrompt.action, 'require_confirm');
  if (riskPrompt.action === 'require_confirm') assert.equal(riskPrompt.channel, 'risk_prompt');

  const execDestructive = decide({ mode: 'execute', effectiveRisk: 'high', isFileWrite: false, destructive: true, toolName: 'run_command' });
  assert.equal(execDestructive.action, 'require_confirm');
  if (execDestructive.action === 'require_confirm') assert.equal(execDestructive.channel, 'risk_prompt');

  const execFile = decide({ mode: 'execute', effectiveRisk: 'mid', isFileWrite: true, destructive: false, toolName: 'edit_file' });
  assert.equal(execFile.action, 'require_confirm');
  if (execFile.action === 'require_confirm') assert.equal(execFile.channel, 'file_review');
});

test('decide: deny 携带原因且含工具名', () => {
  const v = decide({ mode: 'explore', effectiveRisk: 'high', isFileWrite: false, destructive: false, toolName: 'run_command' });
  assert.equal(v.action, 'deny');
  if (v.action === 'deny') {
    assert.match(v.reason, /explore/);
    assert.match(v.reason, /run_command/);
  }
});
