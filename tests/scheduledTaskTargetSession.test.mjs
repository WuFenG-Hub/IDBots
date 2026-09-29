import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import {
  createSqliteStore,
  getColumns,
  getCompiledStores,
  getRow,
  getSqlJs,
} from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function getScheduledTaskStoreClass() {
  return require('../dist-electron/main/scheduledTaskStore.js').ScheduledTaskStore;
}

function createTaskInput(overrides = {}) {
  return {
    name: 'Recurring task',
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

const LEGACY_SCHEDULED_TASKS_DDL = `
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
`;

const LEGACY_SCHEDULED_TASK_RUNS_DDL = `
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
`;

test('ScheduledTaskStore normalizes a target session binding and preserves/clears/sets it on update', async () => {
  const { db, cleanup } = await createSqliteStore();
  const ScheduledTaskStore = getScheduledTaskStoreClass();

  try {
    const store = new ScheduledTaskStore(db, () => {});
    const task = store.createTask(createTaskInput({ targetSessionId: '  session-a  ' }));

    assert.equal(task.targetSessionId, 'session-a');
    assert.equal(
      getRow(db, 'SELECT target_session_id FROM scheduled_tasks WHERE id = ?', [task.id]).target_session_id,
      'session-a'
    );

    // undefined preserves
    assert.equal(store.updateTask(task.id, { name: 'Renamed recurring task' }).targetSessionId, 'session-a');

    // string sets
    assert.equal(store.updateTask(task.id, { targetSessionId: 'session-b' }).targetSessionId, 'session-b');

    // explicit null clears
    assert.equal(store.updateTask(task.id, { targetSessionId: null }).targetSessionId, null);

    // blank string normalizes to null, i.e. clears too
    assert.equal(store.updateTask(task.id, { targetSessionId: 'session-c' }).targetSessionId, 'session-c');
    assert.equal(store.updateTask(task.id, { targetSessionId: '   ' }).targetSessionId, null);
    assert.equal(store.getTask(task.id).targetSessionId, null);
    assert.equal(
      getRow(db, 'SELECT target_session_id FROM scheduled_tasks WHERE id = ?', [task.id]).target_session_id,
      null
    );
  } finally {
    cleanup();
  }
});

test('ScheduledTaskStore keeps the target session binding separate from the last-run cowork session', async () => {
  const { db, cleanup } = await createSqliteStore();
  const ScheduledTaskStore = getScheduledTaskStoreClass();

  try {
    const store = new ScheduledTaskStore(db, () => {});
    const task = store.createTask(createTaskInput());
    assert.equal(task.targetSessionId, null);

    store.setTaskSessionId(task.id, 'last-run-session');
    assert.equal(store.getTask(task.id).coworkSessionId, 'last-run-session');
    assert.equal(store.getTask(task.id).targetSessionId, null);

    store.updateTask(task.id, { targetSessionId: 'bound-session' });
    assert.equal(store.getTask(task.id).targetSessionId, 'bound-session');
    assert.equal(store.getTask(task.id).coworkSessionId, 'last-run-session');
  } finally {
    cleanup();
  }
});

test('ScheduledTaskStore resets the target session binding when the execution MetaBot changes', async () => {
  const { db, cleanup } = await createSqliteStore();
  const ScheduledTaskStore = getScheduledTaskStoreClass();

  try {
    const store = new ScheduledTaskStore(db, () => {});
    const task = store.createTask(createTaskInput({ targetSessionId: 'session-a' }));

    const sameBot = store.updateTask(task.id, { metabotId: 1 });
    assert.equal(sameBot.targetSessionId, 'session-a');

    const changedBot = store.updateTask(task.id, { metabotId: 2 });
    assert.equal(changedBot.targetSessionId, null);
    assert.equal(store.getTask(task.id).targetSessionId, null);

    // A rebind after the bot change survives unrelated updates.
    store.updateTask(task.id, { targetSessionId: 'session-b' });
    assert.equal(store.updateTask(task.id, { metabotId: 2 }).targetSessionId, 'session-b');
  } finally {
    cleanup();
  }
});

test('ScheduledTaskStore self-heals legacy tables before persisting target session bindings', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const ScheduledTaskStore = getScheduledTaskStoreClass();

  try {
    db.run(LEGACY_SCHEDULED_TASKS_DDL);
    db.run(LEGACY_SCHEDULED_TASK_RUNS_DDL);
    db.run(`
      INSERT INTO scheduled_tasks (
        id, name, description, enabled, schedule_json, prompt,
        working_directory, system_prompt, execution_mode, metabot_id,
        expires_at, notify_platforms_json, next_run_at_ms, consecutive_errors,
        created_at, updated_at
      )
      VALUES (
        'legacy-task', 'Legacy recurring task', '', 1, ?, 'Run legacy task',
        ?, '', 'local', 1,
        NULL, '[]', NULL, 0,
        '2026-05-23T00:00:00.000Z', '2026-05-23T00:00:00.000Z'
      );
    `, [JSON.stringify({ type: 'cron', expression: '*/5 * * * *' }), process.cwd()]);

    assert.equal(getColumns(db, 'scheduled_tasks').includes('target_session_id'), false);

    const store = new ScheduledTaskStore(db, () => {});
    assert.equal(getColumns(db, 'scheduled_tasks').includes('target_session_id'), true);
    assert.equal(store.getTask('legacy-task').targetSessionId, null);

    store.updateTask('legacy-task', { targetSessionId: 'legacy-bound-session' });
    assert.equal(store.getTask('legacy-task').targetSessionId, 'legacy-bound-session');
  } finally {
    db.close();
  }
});

test('SqliteStore migration adds target_session_id to legacy scheduled task tables', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const { SqliteStore } = getCompiledStores();
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-scheduled-task-target-'));
  const dbPath = path.join(userDataPath, 'test.sqlite');

  try {
    db.run(LEGACY_SCHEDULED_TASKS_DDL);

    const sqliteStore = new SqliteStore(db, dbPath);
    sqliteStore.initializeTables(userDataPath);

    assert.ok(getColumns(db, 'scheduled_tasks').includes('target_session_id'));
  } finally {
    db.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
