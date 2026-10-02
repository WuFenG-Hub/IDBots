import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import {
  createSqliteStore,
  getColumns,
  getSqlJs,
} from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function getStoreModule() {
  return require('../dist-electron/main/scheduledTaskStore.js');
}

function createTaskInput(overrides = {}) {
  return {
    name: 'Recurring task',
    description: '',
    schedule: { type: 'interval', intervalMs: 60_000 },
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

test('skip reason codes are enumerable and cover the gate outcomes', () => {
  const { SCHEDULED_TASK_SKIP_REASONS } = getStoreModule();
  assert.deepEqual(
    [...SCHEDULED_TASK_SKIP_REASONS].sort(),
    ['already_running', 'disabled', 'expired', 'stuck_running']
  );
});

test('recordSkippedRun writes a structured skip entry distinguishable from success and error', async () => {
  const { db, store: sqliteStore, cleanup } = await createSqliteStore();
  const { ScheduledTaskStore } = getStoreModule();

  try {
    const store = new ScheduledTaskStore(db, sqliteStore.getSaveFunction());
    const task = store.createTask(createTaskInput({ name: 'Nightly digest' }));

    const successRun = store.createRun(task.id, 'scheduled');
    store.completeRun(successRun.id, 'success', 'session-1', 12, null);
    const errorRun = store.createRun(task.id, 'scheduled');
    store.completeRun(errorRun.id, 'error', null, 5, 'boom');

    const before = new Date().toISOString();
    const skipped = store.recordSkippedRun(task.id, 'already_running', 'scheduled');
    const after = new Date().toISOString();

    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.skipReason, 'already_running');
    assert.equal(skipped.taskId, task.id);
    assert.equal(skipped.sessionId, null);
    assert.equal(skipped.trigger, 'scheduled');
    assert.ok(skipped.startedAt >= before && skipped.startedAt <= after);
    // A skipped run is terminal the moment it is written.
    assert.equal(skipped.finishedAt, skipped.startedAt);
    assert.equal(skipped.durationMs, 0);

    const runs = store.listRuns(task.id);
    assert.deepEqual(runs.map((run) => run.status).sort(), ['error', 'skipped', 'success']);
    const byStatus = Object.fromEntries(runs.map((run) => [run.status, run]));
    assert.equal(byStatus.success.skipReason, null);
    assert.equal(byStatus.error.skipReason, null);
    assert.equal(byStatus.skipped.skipReason, 'already_running');

    const allRuns = store.listAllRuns(10, 0);
    const listed = allRuns.find((run) => run.id === skipped.id);
    assert.equal(listed.taskName, 'Nightly digest');
    assert.equal(listed.status, 'skipped');
    assert.equal(listed.skipReason, 'already_running');
  } finally {
    cleanup();
  }
});

test('skip_reason migration is idempotent on legacy run tables and keeps old runs unclassified', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const { ScheduledTaskStore } = getStoreModule();

  try {
    db.run(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_json TEXT NOT NULL,
        prompt TEXT NOT NULL,
        working_directory TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        execution_mode TEXT NOT NULL DEFAULT 'auto',
        metabot_id INTEGER,
        expires_at TEXT,
        notify_platforms_json TEXT NOT NULL DEFAULT '[]',
        next_run_at_ms INTEGER,
        last_run_at_ms INTEGER,
        last_status TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        running_at_ms INTEGER,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        trigger_type TEXT NOT NULL DEFAULT 'scheduled'
      );
    `);
    db.run(`
      INSERT INTO scheduled_tasks (
        id, name, description, enabled, schedule_json, prompt,
        working_directory, system_prompt, execution_mode, metabot_id,
        expires_at, notify_platforms_json, next_run_at_ms, consecutive_errors,
        created_at, updated_at
      )
      VALUES (
        'legacy-task', 'Legacy task', '', 1, ?, 'Run legacy task',
        ?, '', 'local', 1,
        NULL, '[]', 1, 0,
        '2026-05-23T00:00:00.000Z', '2026-05-23T00:00:00.000Z'
      );
    `, [
      JSON.stringify({ type: 'interval', intervalMs: 60_000 }),
      process.cwd(),
    ]);
    db.run(`
      INSERT INTO scheduled_task_runs (
        id, task_id, session_id, status, started_at, finished_at, duration_ms, trigger_type
      )
      VALUES ('legacy-run', 'legacy-task', 'legacy-session', 'success',
              '2026-05-23T00:05:00.000Z', '2026-05-23T00:06:00.000Z', 60000, 'scheduled');
    `);

    assert.equal(getColumns(db, 'scheduled_task_runs').includes('skip_reason'), false);

    const store = new ScheduledTaskStore(db, () => {});
    assert.equal(getColumns(db, 'scheduled_task_runs').includes('skip_reason'), true);

    const legacyRun = store.getRun('legacy-run');
    assert.equal(legacyRun.status, 'success');
    assert.equal(legacyRun.skipReason, null);

    // Re-running the migration (next app start) must not throw or duplicate work.
    const secondStore = new ScheduledTaskStore(db, () => {});
    const skipped = secondStore.recordSkippedRun('legacy-task', 'expired', 'scheduled');
    assert.equal(secondStore.getRun(skipped.id).skipReason, 'expired');
    assert.deepEqual(
      secondStore.listRuns('legacy-task').map((run) => run.status).sort(),
      ['skipped', 'success']
    );
  } finally {
    db.close();
  }
});

test('getRunningTasks and releaseStuckRunningTask only touch the running marker', async () => {
  const { db, store: sqliteStore, cleanup } = await createSqliteStore();
  const { ScheduledTaskStore } = getStoreModule();

  try {
    const store = new ScheduledTaskStore(db, sqliteStore.getSaveFunction());
    const task = store.createTask(createTaskInput({ name: 'Wedged task' }));

    store.markTaskRunning(task.id, Date.now() - 60_000);
    assert.deepEqual(store.getRunningTasks().map((running) => running.id), [task.id]);

    // A running marker keeps the task out of the due set even past its next run.
    const futureMs = Date.now() + 10 * 60_000;
    assert.deepEqual(store.getDueTasks(futureMs), []);

    store.releaseStuckRunningTask(task.id);

    assert.deepEqual(store.getRunningTasks(), []);
    const released = store.getTask(task.id);
    assert.equal(released.state.runningAtMs, null);
    // Release is not a failure: error bookkeeping and status are untouched.
    assert.equal(released.state.consecutiveErrors, 0);
    assert.equal(released.state.lastError, null);
    assert.equal(released.state.lastStatus, 'running');
    assert.deepEqual(store.getDueTasks(futureMs).map((due) => due.id), [task.id]);
  } finally {
    cleanup();
  }
});
