import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function getMigrationModule() {
  return require('../dist-electron/main/sdkCronMigration.js');
}

function getScheduledTaskStoreModule() {
  return require('../dist-electron/main/scheduledTaskStore.js');
}

function createTaskInput(overrides = {}) {
  return {
    name: 'Migratable task',
    description: '',
    schedule: { type: 'cron', expression: '*/5 * * * *' },
    prompt: 'Run this task',
    workingDirectory: process.cwd(),
    systemPrompt: '',
    executionMode: 'local',
    metabotId: 1,
    expiresAt: null,
    notifyPlatforms: [],
    enabled: true,
    ...overrides,
  };
}

test('datetimeToCronExpression converts at-schedule to one-shot cron', () => {
  const { datetimeToCronExpression } = getMigrationModule();
  assert.equal(datetimeToCronExpression('2026-08-09T14:30:00'), '30 14 9 8 *');
  assert.equal(datetimeToCronExpression(''), null);
  assert.equal(datetimeToCronExpression('not-a-date'), null);
  assert.equal(datetimeToCronExpression(null), null);
});

test('getNextCronFireMs parses valid cron and rejects invalid', () => {
  const { getNextCronFireMs } = getMigrationModule();
  const next = getNextCronFireMs('0 4 * * *', 1786200000000);
  assert.ok(typeof next === 'number' && next > 1786200000000);
  assert.equal(getNextCronFireMs('not a cron', 1786200000000), null);
});

test('buildMigratedCronSpec maps at / cron / interval schedules', () => {
  const { buildMigratedCronSpec } = getMigrationModule();
  const now = 1786200000000;

  const atTask = { ...createTaskInput({ schedule: { type: 'at', datetime: '2026-08-10T09:00:00' } }), id: 't-at' };
  const atSpec = buildMigratedCronSpec(atTask, now);
  assert.equal(atSpec.reason, null);
  assert.equal(atSpec.spec.cronExpression, '0 9 10 8 *');
  assert.equal(atSpec.spec.recurring, false);

  const cronTask = { ...createTaskInput({ schedule: { type: 'cron', expression: '30 9 * * 1-5' } }), id: 't-cron' };
  const cronSpec = buildMigratedCronSpec(cronTask, now);
  assert.equal(cronSpec.reason, null);
  assert.equal(cronSpec.spec.cronExpression, '30 9 * * 1-5');
  assert.equal(cronSpec.spec.recurring, true);

  const intervalTask = { ...createTaskInput({ schedule: { type: 'interval', intervalMs: 60000 } }), id: 't-int' };
  const intervalSpec = buildMigratedCronSpec(intervalTask, now);
  assert.equal(intervalSpec.spec, null);
  assert.ok(intervalSpec.reason.includes('interval'));

  const badAtTask = { ...createTaskInput({ schedule: { type: 'at', datetime: 'bad' } }), id: 't-bad' };
  const badAtSpec = buildMigratedCronSpec(badAtTask, now);
  assert.equal(badAtSpec.spec, null);
});

test('migration marker round-trips and survives prompt clipping (marker is front-loaded)', () => {
  const { buildMigrationMarker, extractMigrationTaskId, buildMigratedCronSpec } = getMigrationModule();
  const marker = buildMigrationMarker('task-42');
  assert.equal(marker, '[SDK_MIGRATE:task-42]');
  assert.equal(extractMigrationTaskId(`${marker}\nrun`), 'task-42');
  assert.equal(extractMigrationTaskId('no marker'), null);

  // 超长 prompt：SDK 裁剪只动尾部，前置标记必然保留。
  const longTask = {
    ...createTaskInput({ prompt: 'z'.repeat(2000) }),
    id: 't-long',
    schedule: { type: 'cron', expression: '0 4 * * *' },
  };
  const spec = buildMigratedCronSpec(longTask, 1786200000000);
  assert.equal(spec.spec.promptTruncated, true);
  assert.ok(spec.spec.prompt.length <= 1000 + 30);
  assert.equal(extractMigrationTaskId(spec.spec.prompt), 't-long');
});

test('seven-day limit: expiresAt beyond 7 days or next fire beyond 7 days flagged', () => {
  const { buildMigratedCronSpec } = getMigrationModule();
  const now = 1786200000000; // 2026-08-09 附近
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  // 年周期任务（每年 9 月 1 日）：下次触发在 now+7 天之外 → 受限
  const farFire = {
    ...createTaskInput({ schedule: { type: 'cron', expression: '0 4 1 9 *' } }),
    id: 't-far',
    expiresAt: null,
  };
  const farSpec = buildMigratedCronSpec(farFire, now);
  assert.equal(farSpec.spec.sevenDayLimited, true);

  // 每日触发：下次触发 24h 内 → 不受限
  const nearFire = {
    ...createTaskInput({ schedule: { type: 'cron', expression: '0 4 * * *' } }),
    id: 't-near',
    expiresAt: null,
  };
  const nearSpec = buildMigratedCronSpec(nearFire, now - 60 * 60 * 1000);
  assert.equal(nearSpec.spec.sevenDayLimited, false);

  // expiresAt 超过 7 天 → 受限；prompt 带标记
  const expiring = {
    ...createTaskInput({ schedule: { type: 'cron', expression: '*/5 * * * *' } }),
    id: 't-exp',
    expiresAt: new Date(now + 2 * weekMs).toISOString(),
  };
  const expSpec = buildMigratedCronSpec(expiring, now);
  assert.equal(expSpec.spec.sevenDayLimited, true);
  assert.ok(expSpec.spec.prompt.includes('[SDK_7DAY_LIMITED]'));
});

test('planTaskMigration is idempotent: migrated/disabled skipped, interval unsupported', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { planTaskMigration, buildMigratedCronSpec } = getMigrationModule();
  const { ScheduledTaskStore } = getScheduledTaskStoreModule();
  try {
    const store = new ScheduledTaskStore(db, () => {});

    const migratable = store.createTask(createTaskInput({ name: 'migratable' }));
    const disabled = store.createTask(createTaskInput({ name: 'disabled', enabled: false }));
    const interval = store.createTask(createTaskInput({
      name: 'interval',
      schedule: { type: 'interval', intervalMs: 60000 },
    }));

    // 第一次规划：migratable=1, skipped=1(disabled), unsupported=1(interval)
    const plan1 = planTaskMigration(store.listTasks());
    assert.equal(plan1.migratable.length, 1);
    assert.equal(plan1.skipped.length, 1);
    assert.equal(plan1.unsupported.length, 1);

    // 模拟迁移完成：标记 migrated
    const spec = buildMigratedCronSpec(plan1.migratable[0].task);
    store.markMigrated(migratable.id, 'sdk-cron-1');

    // 第二次规划（幂等）：migratable=0，migrated 任务进 skipped
    const plan2 = planTaskMigration(store.listTasks());
    assert.equal(plan2.migratable.length, 0);
    assert.equal(plan2.skipped.length, 2); // migrated + disabled
    assert.equal(plan2.unsupported.length, 1);

    assert.equal(interval.schedule.type, 'interval');
  } finally {
    cleanup();
  }
});

test('planTaskMigration counts seven-day-limited and truncated specs', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { planTaskMigration } = getMigrationModule();
  const { ScheduledTaskStore } = getScheduledTaskStoreModule();
  try {
    const store = new ScheduledTaskStore(db, () => {});
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    store.createTask(createTaskInput({
      name: 'far fire',
      schedule: { type: 'cron', expression: '0 4 * * *' },
      expiresAt: new Date(now + 2 * weekMs).toISOString(),
    }));
    store.createTask(createTaskInput({
      name: 'long prompt',
      prompt: 'p'.repeat(1200),
    }));

    const plan = planTaskMigration(store.listTasks(), now);
    assert.equal(plan.migratable.length, 2);
    assert.equal(plan.sevenDayLimitedCount, 1);
    assert.equal(plan.truncatedCount, 1);
  } finally {
    cleanup();
  }
});
