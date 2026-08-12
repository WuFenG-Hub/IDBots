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

test('buildCronCreateUiInstruction embeds cron/prompt/recurring and forces durable', () => {
  const { buildCronCreateUiInstruction } = getBridgeModule();
  const instruction = buildCronCreateUiInstruction({
    cronExpression: '*/15 * * * *',
    prompt: '[SDK_CRON:abc123]\n每 15 分钟巡检',
    recurring: true,
  });
  assert.ok(instruction.includes('*/15 * * * *'));
  assert.ok(instruction.includes('[SDK_CRON:abc123]'));
  assert.ok(instruction.includes('每 15 分钟巡检'));
  assert.ok(instruction.includes('recurring: true'));
  assert.ok(instruction.includes('durable: true'));
  // 区分于迁移桥：话术为「新建定时任务」
  assert.ok(instruction.includes('新建定时任务'));
});

test('buildCronRunNowInstruction wraps the prompt as an immediate execution request', () => {
  const { buildCronRunNowInstruction } = getBridgeModule();
  const instruction = buildCronRunNowInstruction('检查收件箱并总结未读邮件');
  assert.ok(instruction.includes('立即执行'));
  assert.ok(instruction.includes('检查收件箱并总结未读邮件'));
  // 不应触发创建/删除 cron 工具
  assert.ok(instruction.includes('不要调用 CronCreate'));
});

test('buildCronMarker / extractCronNonce round-trip and survive truncation', () => {
  const { buildCronMarker, extractCronNonce, buildCronPromptWithMarker } = getBridgeModule();
  const marker = buildCronMarker('nonce-xyz');
  assert.equal(marker, '[SDK_CRON:nonce-xyz]');
  assert.equal(extractCronNonce(marker), 'nonce-xyz');
  assert.equal(extractCronNonce('no marker here'), null);

  // 标记前置：即使 prompt 超长被截断，标记仍保留在前部。
  const longPrompt = buildCronPromptWithMarker(marker, 'x'.repeat(2000));
  assert.ok(longPrompt.startsWith('[SDK_CRON:nonce-xyz]'));
  assert.equal(extractCronNonce(longPrompt), 'nonce-xyz');
});

test('computeSdkCronFromSpec maps each schedule mode to the right cron expression', () => {
  const { computeSdkCronFromSpec } = getBridgeModule();
  const base = { name: 'n', prompt: 'p', metabotId: null };

  // daily 09:30 -> 30 9 * * * (recurring)
  const daily = computeSdkCronFromSpec({ ...base, mode: 'daily', date: '', time: '09:30', weekday: 1, monthDay: 1, intervalValue: 5, intervalUnit: 'minutes', cronExpression: '' });
  assert.deepEqual(daily, { expression: '30 9 * * *', recurring: true });

  // weekly Friday 18:00 -> 0 18 * * 5
  const weekly = computeSdkCronFromSpec({ ...base, mode: 'weekly', date: '', time: '18:00', weekday: 5, monthDay: 1, intervalValue: 5, intervalUnit: 'minutes', cronExpression: '' });
  assert.deepEqual(weekly, { expression: '0 18 * * 5', recurring: true });

  // interval 30 min -> */30 * * * *
  const interval = computeSdkCronFromSpec({ ...base, mode: 'interval', date: '', time: '09:00', weekday: 1, monthDay: 1, intervalValue: 30, intervalUnit: 'minutes', cronExpression: '' });
  assert.deepEqual(interval, { expression: '*/30 * * * *', recurring: true });

  // once 2026-12-25 10:00 -> 0 10 25 12 * (one-shot, recurring=false)
  const once = computeSdkCronFromSpec({ ...base, mode: 'once', date: '2026-12-25', time: '10:00', weekday: 1, monthDay: 1, intervalValue: 5, intervalUnit: 'minutes', cronExpression: '' });
  assert.deepEqual(once, { expression: '0 10 25 12 *', recurring: false });

  // cron passthrough
  const cron = computeSdkCronFromSpec({ ...base, mode: 'cron', date: '', time: '09:00', weekday: 1, monthDay: 1, intervalValue: 5, intervalUnit: 'minutes', cronExpression: '0 9 * * 1-5' });
  assert.deepEqual(cron, { expression: '0 9 * * 1-5', recurring: true });

  // malformed cron -> null
  const bad = computeSdkCronFromSpec({ ...base, mode: 'cron', date: '', time: '09:00', weekday: 1, monthDay: 1, intervalValue: 5, intervalUnit: 'minutes', cronExpression: '0 9 * *' });
  assert.equal(bad.expression, null);
});

// ---- deriveScheduleSpecFromCron: backfill spec from raw cron (enables toggle/edit) ----

test('deriveScheduleSpecFromCron: daily cron -> mode daily with time', () => {
  const { deriveScheduleSpecFromCron } = getBridgeModule();
  const spec = deriveScheduleSpecFromCron({ schedule: '30 9 * * *', name: 'n', prompt: 'p' });
  assert.equal(spec.mode, 'daily');
  assert.equal(spec.time, '09:30');
  assert.equal(spec.cronExpression, '30 9 * * *');
  assert.equal(spec.name, 'n');
  assert.equal(spec.prompt, 'p');
});

test('deriveScheduleSpecFromCron: */N minutes -> interval minutes', () => {
  const { deriveScheduleSpecFromCron } = getBridgeModule();
  const spec = deriveScheduleSpecFromCron({ schedule: '*/15 * * * *', name: 'n', prompt: 'p' });
  assert.equal(spec.mode, 'interval');
  assert.equal(spec.intervalUnit, 'minutes');
  assert.equal(spec.intervalValue, 15);
});

test('deriveScheduleSpecFromCron: weekly cron -> mode weekly with weekday', () => {
  const { deriveScheduleSpecFromCron } = getBridgeModule();
  const spec = deriveScheduleSpecFromCron({ schedule: '0 18 * * 5', name: 'n', prompt: 'p' });
  assert.equal(spec.mode, 'weekly');
  assert.equal(spec.weekday, 5);
  assert.equal(spec.time, '18:00');
});

test('deriveScheduleSpecFromCron: monthly cron -> mode monthly with monthDay', () => {
  const { deriveScheduleSpecFromCron } = getBridgeModule();
  const spec = deriveScheduleSpecFromCron({ schedule: '15 0 20 * *', name: 'n', prompt: 'p' });
  assert.equal(spec.mode, 'monthly');
  assert.equal(spec.monthDay, 20);
  assert.equal(spec.time, '00:15');
});

test('deriveScheduleSpecFromCron: complex minute-list cron -> mode cron + raw expression (no fake semantic)', () => {
  const { deriveScheduleSpecFromCron } = getBridgeModule();
  // 7,22,37,52 每小时跑——分钟非单整数，不能还原成具体时刻，归为 cron 原样。
  const spec = deriveScheduleSpecFromCron({ schedule: '7,22,37,52 * * * *', name: 'n', prompt: 'p' });
  assert.equal(spec.mode, 'cron');
  assert.equal(spec.cronExpression, '7,22,37,52 * * * *');
});

test('deriveScheduleSpecFromCron: hour range cron -> mode cron (cannot reduce to single time)', () => {
  const { deriveScheduleSpecFromCron } = getBridgeModule();
  const spec = deriveScheduleSpecFromCron({ schedule: '*/15 9-17 * * 1-5', name: 'n', prompt: 'p' });
  assert.equal(spec.mode, 'cron');
  assert.equal(spec.cronExpression, '*/15 9-17 * * 1-5');
});

test('deriveScheduleSpecFromCron: non-5-field expression -> null (cannot derive)', () => {
  const { deriveScheduleSpecFromCron } = getBridgeModule();
  assert.equal(deriveScheduleSpecFromCron({ schedule: '0 9 * *', name: 'n', prompt: 'p' }), null);
  assert.equal(deriveScheduleSpecFromCron({ schedule: '', name: 'n', prompt: 'p' }), null);
});
