import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createSqliteStore, getColumns } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function getMirrorStoreModule() {
  return require('../dist-electron/main/sdkCronMirrorStore.js');
}

function getScheduledTaskStoreModule() {
  return require('../dist-electron/main/scheduledTaskStore.js');
}

test('parseScheduledTasksFile parses the real durable file format', () => {
  const { parseScheduledTasksFile } = getMirrorStoreModule();
  const content = JSON.stringify({
    tasks: [
      {
        id: 'cc454fe9',
        cron: '0 4 * * *',
        prompt: 'hello',
        createdAt: 1786206675341,
        recurring: true,
        createdBySessionId: 'sess-1',
        createdByPid: 1,
      },
      {
        id: 'abc123',
        cron: '30 9 * * 1-5',
        prompt: 'weekday',
        createdAt: 1,
        recurring: false,
        createdBySessionId: '',
      },
      { id: 'broken' },
    ],
  });
  const parsed = parseScheduledTasksFile(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'cc454fe9');
  assert.equal(parsed[0].schedule, '0 4 * * *');
  assert.equal(parsed[0].recurring, true);
  assert.equal(parsed[0].durable, true);
  assert.equal(parsed[0].createdBySessionId, 'sess-1');
  assert.equal(parsed[0].createdAtMs, 1786206675341);
  assert.equal(parsed[1].recurring, false);
  assert.equal(parsed[1].createdBySessionId, null);
  // createdAt 缺失 → null；非法值 → null
  const noCreatedAt = parseScheduledTasksFile('{"tasks":[{"id":"x1","cron":"0 4 * * *","prompt":"p"}]}');
  assert.equal(noCreatedAt[0].createdAtMs, null);
  const badCreatedAt = parseScheduledTasksFile('{"tasks":[{"id":"x2","cron":"0 4 * * *","prompt":"p","createdAt":"not-a-number"}]}');
  assert.equal(badCreatedAt[0].createdAtMs, null);
});

test('parseScheduledTasksFile handles invalid input', () => {
  const { parseScheduledTasksFile } = getMirrorStoreModule();
  assert.deepEqual(parseScheduledTasksFile('not json'), []);
  assert.deepEqual(parseScheduledTasksFile('{"other": true}'), []);
  assert.deepEqual(parseScheduledTasksFile(''), []);
});

test('summarizeCronPrompt takes first line and truncates to 48 chars', () => {
  const { summarizeCronPrompt } = getMirrorStoreModule();
  assert.equal(summarizeCronPrompt('  first line\nsecond line  '), 'first line');
  assert.equal(summarizeCronPrompt(''), '(unnamed cron)');
  assert.equal(summarizeCronPrompt('   '), '(unnamed cron)');
  const long = 'x'.repeat(60);
  const summary = summarizeCronPrompt(long);
  assert.ok(summary.length <= 49);
  assert.ok(summary.endsWith('…'));
});

test('truncateCronPrompt clips at 1000 chars with SDK marker', () => {
  const { truncateCronPrompt } = getMirrorStoreModule();
  const short = 'abc';
  assert.equal(truncateCronPrompt(short), 'abc');
  const long = 'y'.repeat(1100);
  const clipped = truncateCronPrompt(long);
  assert.ok(clipped.length < 1100);
  assert.ok(clipped.includes('… [+100 chars]'));
});

test('upsert is idempotent by cron id and updates fields', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { SdkCronMirrorStore } = getMirrorStoreModule();
  try {
    const store = new SdkCronMirrorStore(db, () => {});
    const cron = { id: 'c1', schedule: '0 4 * * *', recurring: true, prompt: 'task one' };
    store.upsert(cron, 'sess-a', 'stop_hook');
    store.upsert(cron, 'sess-a', 'stop_hook');
    store.upsert({ ...cron, prompt: 'task one updated', durable: true }, 'sess-a', 'file_scan');

    const mirrors = store.listMirrors();
    assert.equal(mirrors.length, 1);
    assert.equal(mirrors[0].id, 'c1');
    assert.equal(mirrors[0].name, 'task one updated');
    assert.equal(mirrors[0].durable, true);
    assert.equal(mirrors[0].source, 'file_scan');
  } finally {
    cleanup();
  }
});

test('upsert reactivates a previously deleted cron', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { SdkCronMirrorStore } = getMirrorStoreModule();
  try {
    const store = new SdkCronMirrorStore(db, () => {});
    store.upsert({ id: 'c1', schedule: '0 4 * * *', recurring: true, prompt: 'p' }, 'sess-a', 'stop_hook');
    store.markDeleted('c1');
    assert.equal(store.getById('c1').status, 'deleted');
    store.upsert({ id: 'c1', schedule: '0 4 * * *', recurring: true, prompt: 'p' }, 'sess-a', 'file_scan');
    assert.equal(store.getById('c1').status, 'active');
  } finally {
    cleanup();
  }
});

test('reconcileSession marks missing non-durable crons deleted and keeps durable', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { SdkCronMirrorStore } = getMirrorStoreModule();
  try {
    const store = new SdkCronMirrorStore(db, () => {});
    store.upsert({ id: 'c1', schedule: '0 4 * * *', recurring: true, prompt: 'p' }, 'sess-a', 'stop_hook');
    store.upsert({ id: 'c2', schedule: '0 5 * * *', recurring: true, prompt: 'p', durable: true }, 'sess-a', 'file_scan');
    store.upsert({ id: 'c3', schedule: '0 6 * * *', recurring: true, prompt: 'p' }, 'sess-b', 'stop_hook');

    const changed = store.reconcileSession('sess-a', ['c2']);
    assert.equal(changed, 1);
    assert.equal(store.getById('c1').status, 'deleted');
    assert.equal(store.getById('c2').status, 'active');
    assert.equal(store.getById('c3').status, 'active');
  } finally {
    cleanup();
  }
});

test('reconcileDurableFile marks file-missing durable crons deleted', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { SdkCronMirrorStore } = getMirrorStoreModule();
  try {
    const store = new SdkCronMirrorStore(db, () => {});
    store.upsert({ id: 'c1', schedule: '0 4 * * *', recurring: true, prompt: 'p', durable: true }, 'sess-a', 'file_scan');
    store.upsert({ id: 'c2', schedule: '0 5 * * *', recurring: true, prompt: 'p', durable: true }, 'sess-a', 'file_scan');
    store.upsert({ id: 'c3', schedule: '0 6 * * *', recurring: true, prompt: 'p', durable: true }, 'sess-b', 'file_scan');

    const result = store.reconcileDurableFile('sess-a', [{ id: 'c2' }]);
    assert.equal(result.deleted, 1);
    assert.equal(store.getById('c1').status, 'deleted');
    assert.equal(store.getById('c2').status, 'active');
    assert.equal(store.getById('c3').status, 'active');
  } finally {
    cleanup();
  }
});

test('migration mapping: setMigrationMapping / findByMigratedTaskId / migratedTaskId filter', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { SdkCronMirrorStore } = getMirrorStoreModule();
  try {
    const store = new SdkCronMirrorStore(db, () => {});
    store.upsert({ id: 'c1', schedule: '0 4 * * *', recurring: true, prompt: '[SDK_MIGRATE:t1] run' }, 'sess-a', 'stop_hook');
    store.setMigrationMapping('c1', 't1');
    assert.equal(store.findByMigratedTaskId('t1').id, 'c1');
    assert.equal(store.getById('c1').migratedTaskId, 't1');
    assert.equal(store.findByMigratedTaskId('missing'), null);
  } finally {
    cleanup();
  }
});

test('findCronPromptMatch matches exact and clipped prompts', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { SdkCronMirrorStore } = getMirrorStoreModule();
  try {
    const store = new SdkCronMirrorStore(db, () => {});
    store.upsert({ id: 'c1', schedule: '0 4 * * *', recurring: true, prompt: 'hello world' }, 'sess-a', 'stop_hook');
    assert.equal(store.findCronPromptMatch('sess-a', 'hello world').id, 'c1');
    assert.equal(store.findCronPromptMatch('sess-a', 'hello'), null);
    assert.equal(store.findCronPromptMatch('sess-b', 'hello world'), null);
  } finally {
    cleanup();
  }
});

test('mirror table and migration columns coexist in the same sqlite', async () => {
  const { db, cleanup } = await createSqliteStore();
  const { SdkCronMirrorStore } = getMirrorStoreModule();
  const { ScheduledTaskStore } = getScheduledTaskStoreModule();
  try {
    const mirrorStore = new SdkCronMirrorStore(db, () => {});
    const taskStore = new ScheduledTaskStore(db, () => {});
    assert.ok(getColumns(db, 'sdk_cron_mirror').includes('migrated_task_id'));
    assert.ok(getColumns(db, 'scheduled_tasks').includes('migration_status'));
    assert.ok(getColumns(db, 'scheduled_tasks').includes('migrated_task_id'));
    mirrorStore.upsert({ id: 'c1', schedule: '0 4 * * *', recurring: true, prompt: 'p' }, 'sess-a', 'stop_hook');
    assert.equal(mirrorStore.countActive(), 1);
  } finally {
    cleanup();
  }
});
