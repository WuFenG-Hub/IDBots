import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function getScheduledTaskStoreClass() {
  return require('../dist-electron/main/scheduledTaskStore.js').ScheduledTaskStore;
}

function createTaskInput(overrides = {}) {
  return {
    name: 'Recurring probe task',
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

async function createLifecycleStore() {
  const ScheduledTaskStore = getScheduledTaskStoreClass();
  const { db, cleanup } = await createSqliteStore();
  const store = new ScheduledTaskStore(db, () => {});
  return { store, db, cleanup };
}

test('ScheduledTaskStore adds lifecycle columns and persists provenance on create', async () => {
  const { store, db, cleanup } = await createLifecycleStore();
  try {
    const columns = db
      .exec('PRAGMA table_info(scheduled_tasks);')[0].values
      .map((row) => String(row[1]));
    for (const column of [
      'origin', 'origin_session_id', 'origin_context',
      'exit_condition', 'max_fires', 'fire_count',
    ]) {
      assert.ok(columns.includes(column), `missing lifecycle column ${column}`);
    }

    const task = store.createTask(createTaskInput({
      origin: 'agent',
      originSessionId: 'sess-origin',
      originContext: 'chat',
      exitCondition: 'Endpoint recovers or upstream order is delivered.',
      maxFires: 50,
    }));

    assert.equal(task.origin, 'agent');
    assert.equal(task.originSessionId, 'sess-origin');
    assert.equal(task.originContext, 'chat');
    assert.equal(task.exitCondition, 'Endpoint recovers or upstream order is delivered.');
    assert.equal(task.maxFires, 50);
    assert.equal(task.fireCount, 0);
    assert.equal(task.state.lastStatus, null);
  } finally {
    cleanup();
  }
});

test('markTaskCompleted spends the fire budget and retires the task at the cap', async () => {
  const { store, cleanup } = await createLifecycleStore();
  try {
    const task = store.createTask(createTaskInput({ maxFires: 2 }));
    const schedule = { type: 'cron', expression: '*/5 * * * *' };

    store.markTaskCompleted(task.id, true, 100, null, schedule);
    let current = store.getTask(task.id);
    assert.equal(current.fireCount, 1);
    assert.equal(current.state.lastStatus, 'success');
    assert.equal(current.enabled, true, 'task still has budget left');

    // The final fire retires the task regardless of outcome.
    store.markTaskCompleted(task.id, false, 100, 'boom', schedule);
    current = store.getTask(task.id);
    assert.equal(current.fireCount, 2);
    assert.equal(current.enabled, false, 'cap reached → auto-disabled');
    assert.equal(current.state.lastStatus, 'max_fires_reached');
    assert.equal(current.state.nextRunAtMs, null);
  } finally {
    cleanup();
  }
});

test('re-enabling a retired task is a renewal: fire budget resets, editing an enabled task does not', async () => {
  const { store, cleanup } = await createLifecycleStore();
  try {
    const schedule = { type: 'cron', expression: '*/5 * * * *' };
    const task = store.createTask(createTaskInput({ maxFires: 1 }));
    store.markTaskCompleted(task.id, true, 100, null, schedule);
    assert.equal(store.getTask(task.id).enabled, false);

    const renewed = store.updateTask(task.id, { enabled: true });
    assert.equal(renewed.fireCount, 0, 'explicit re-enable = fresh lifecycle');
    assert.equal(renewed.enabled, true);

    store.markTaskCompleted(task.id, true, 100, null, schedule);
    // Editing an enabled task (no enable transition) must not reset the counter.
    const edited = store.updateTask(task.id, { name: 'Renamed mid-life' });
    assert.equal(edited.fireCount, 1);
  } finally {
    cleanup();
  }
});

test('getDueTasks and getNextDueTimeMs exclude tasks whose fire budget is exhausted', async () => {
  const { store, db, cleanup } = await createLifecycleStore();
  try {
    const schedule = { type: 'cron', expression: '*/5 * * * *' };
    const capped = store.createTask(createTaskInput({ name: 'capped', maxFires: 1 }));
    const uncapped = store.createTask(createTaskInput({ name: 'uncapped' }));

    // Force both tasks due (past timestamp).
    db.run('UPDATE scheduled_tasks SET next_run_at_ms = 1000');

    assert.equal(store.getDueTasks(Date.now()).length, 2);
    assert.notEqual(store.getNextDueTimeMs(), null);

    store.markTaskCompleted(capped.id, true, 10, null, schedule);
    // Retirement disabled the task; also simulate a stale enabled+exhausted
    // row (defense in depth for the due-set filter).
    db.run('UPDATE scheduled_tasks SET enabled = 1, next_run_at_ms = 1000 WHERE id = ?', [capped.id]);

    const dueIds = store.getDueTasks(Date.now()).map((task) => task.id);
    assert.ok(!dueIds.includes(capped.id), 'exhausted task must never be due');
    assert.ok(dueIds.includes(uncapped.id));
  } finally {
    cleanup();
  }
});

test('updateTask can revise the exit clause and budget without touching provenance', async () => {
  const { store, cleanup } = await createLifecycleStore();
  try {
    const task = store.createTask(createTaskInput({
      origin: 'agent',
      originSessionId: 'sess-origin',
      exitCondition: 'old clause',
      maxFires: 10,
    }));

    const updated = store.updateTask(task.id, {
      exitCondition: 'new clause: delivered upstream',
      maxFires: 20,
    });
    assert.equal(updated.exitCondition, 'new clause: delivered upstream');
    assert.equal(updated.maxFires, 20);
    assert.equal(updated.origin, 'agent', 'origin is immutable after create');
    assert.equal(updated.originSessionId, 'sess-origin');
  } finally {
    cleanup();
  }
});
