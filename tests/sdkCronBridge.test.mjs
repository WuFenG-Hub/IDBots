import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function getBridgeModule() {
  return require('../dist-electron/main/sdkCronBridge.js');
}

test('buildCronDeleteInstruction carries cron id and forbids extra actions', () => {
  const { buildCronDeleteInstruction } = getBridgeModule();
  const instruction = buildCronDeleteInstruction({ id: 'cron-42', name: '每日报告' });
  assert.ok(instruction.includes('cron-42'));
  assert.ok(instruction.includes('每日报告'));
  assert.ok(instruction.includes('CronDelete'));
  // 明确「不存在也确认删除」保证对账闭环
  assert.ok(instruction.includes('找不到该任务'));
  assert.ok(instruction.includes('已删除 cron-42'));
  // 不允许创建新任务
  assert.ok(instruction.includes('不要创建任何新任务'));
});

test('buildCronCreateInstruction embeds cron/prompt/recurring/durable verbatim', () => {
  const { buildCronCreateInstruction } = getBridgeModule();
  const spec = {
    taskId: 'task-7',
    cronExpression: '0 9 * * 1',
    prompt: '[SDK_MIGRATE:task-7]\n每周一 9 点报告',
    recurring: true,
    sevenDayLimited: true,
    nextFireMs: 1786200000000,
    promptTruncated: false,
  };
  const instruction = buildCronCreateInstruction(spec);
  assert.ok(instruction.includes('0 9 * * 1'));
  assert.ok(instruction.includes('[SDK_MIGRATE:task-7]'));
  assert.ok(instruction.includes('每周一 9 点报告'));
  assert.ok(instruction.includes('recurring: true'));
  assert.ok(instruction.includes('durable: true'));
  // 一次性任务 → recurring: false
  const once = buildCronCreateInstruction({ ...spec, recurring: false });
  assert.ok(once.includes('recurring: false'));
});

test('buildCronCreateInstruction escapes prompt quotes for JSON-safe passing', () => {
  const { buildCronCreateInstruction } = getBridgeModule();
  const prompt = '含 "引号" 与 \\ 反斜杠';
  const instruction = buildCronCreateInstruction({
    taskId: 't1',
    cronExpression: '* * * * *',
    prompt,
    recurring: true,
    sevenDayLimited: false,
    nextFireMs: null,
    promptTruncated: false,
  });
  // JSON.stringify 形式:双引号包裹 + 转义
  assert.ok(instruction.includes('"含 \\"引号\\" 与 \\\\ 反斜杠"'));
});
