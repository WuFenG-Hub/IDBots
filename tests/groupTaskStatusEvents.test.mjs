/**
 * P1-5 status-transition log: group_task_status_events recording on every real
 * group_tasks transition (who/when/from/to), actor threading, list ordering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-status-events-'));

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
  return { store, groupTaskStore, db: store.getDatabase() };
};

const createTask = (groupTaskStore) =>
  groupTaskStore.createTask({
    groupId: 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0',
    title: 'Build MetaApp',
    goal: 'Ship the intro MetaApp',
    chairMetabotId: 1,
    createdBy: 'user',
  });

test('status events table + index exist after schema init', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    const columns = db.exec('PRAGMA table_info(group_task_status_events)')[0].values.map((r) => r[1]);
    for (const expected of ['id', 'task_id', 'from_status', 'to_status', 'actor_kind', 'actor_globalmetaid', 'actor_name', 'created_at']) {
      assert.ok(columns.includes(expected), `column ${expected} present`);
    }
    const indexes = db.exec('PRAGMA index_list(group_task_status_events)')[0].values.map((r) => String(r[1]));
    assert.ok(indexes.includes('idx_group_task_status_events_task'), 'task index present');
  } finally {
    store.close();
  }
});

test('every real transition records an event with the given actor', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = createTask(groupTaskStore); // planning
    groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair', globalMetaId: 'gmid-twin', name: 'Twin Bot' } });
    groupTaskStore.updateTaskStatus(task.id, 'review', { actor: { kind: 'chair', globalMetaId: 'gmid-twin', name: 'Twin Bot' } });
    groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'owner', name: 'Owner' } });
    groupTaskStore.updateTaskStatus(task.id, 'done', { actor: { kind: 'owner' } });

    const events = groupTaskStore.listStatusEvents(task.id);
    assert.equal(events.length, 4, 'one event per real transition');
    // newest first
    assert.deepEqual(
      events.map((e) => [e.fromStatus, e.toStatus, e.actorKind, e.actorName]),
      [
        ['executing', 'done', 'owner', null],
        ['review', 'executing', 'owner', 'Owner'],
        ['executing', 'review', 'chair', 'Twin Bot'],
        ['planning', 'executing', 'chair', 'Twin Bot'],
      ],
    );
    assert.ok(events.every((e) => typeof e.id === 'number' && typeof e.createdAt === 'string'));
  } finally {
    store.close();
  }
});

test('actor defaults to system; same-status updates and illegal transitions record nothing', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = createTask(groupTaskStore);
    groupTaskStore.updateTaskStatus(task.id, 'executing'); // default actor
    const events = groupTaskStore.listStatusEvents(task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].actorKind, 'system');
    assert.equal(events[0].actorGlobalMetaId, null);

    // same-status is a no-op (no event)
    groupTaskStore.updateTaskStatus(task.id, 'executing');
    assert.equal(groupTaskStore.listStatusEvents(task.id).length, 1);

    // illegal transition throws and records nothing
    assert.throws(() => groupTaskStore.updateTaskStatus(task.id, 'planning'));
    assert.equal(groupTaskStore.listStatusEvents(task.id).length, 1);
  } finally {
    store.close();
  }
});

test('events survive a store reopen (persisted) and respect the limit', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  const task = createTask(groupTaskStore);
  groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
  groupTaskStore.updateTaskStatus(task.id, 'review', { actor: { kind: 'chair' } });
  store.close();

  const reopened = await openStores(tempDir);
  try {
    const events = reopened.groupTaskStore.listStatusEvents(task.id);
    assert.equal(events.length, 2, 'events persisted across reopen');
    assert.equal(reopened.groupTaskStore.listStatusEvents(task.id, { limit: 1 }).length, 1);
  } finally {
    reopened.store.close();
  }
});

test('status events never break a transition when recording fails (no table yet)', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    // Drop the table so the INSERT inside recordStatusEvent throws; the
    // transition itself must still succeed.
    db.run('DROP TABLE group_task_status_events');
    const task = createTask(groupTaskStore);
    const updated = groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
    assert.equal(updated.status, 'executing', 'transition applied despite event-record failure');
  } finally {
    store.close();
  }
});
