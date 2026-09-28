import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');

/**
 * Subtask status-change notifications.
 *
 * Twin-side mutations (agent tools, heartbeat) write straight to the store and
 * never touch the owner IPC handlers, so a new `waiting_owner` card would stay
 * invisible to the sidebar badge until the renderer's 30s board poll. main.ts
 * subscribes here and pushes the board refresh, which means the contract this
 * suite pins is precise: fire on every REAL transition (with ids), stay silent
 * when a mutation leaves the status alone, and never let a subscriber's throw
 * break the mutation.
 *
 * Runs against the compiled output (pnpm run compile:electron first).
 */

async function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-longterm-notify-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  return { store, dir };
}

const SPEC = {
  title: 'Notify suite',
  goal: 'Pin the status-change contract.',
  subtasks: [
    { title: 'First', acceptanceCriteria: ['done'] },
    { title: 'Second', acceptanceCriteria: ['done'] },
  ],
};

async function createActive(store) {
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const activated = store.activateTask(created.value.id, 'owner');
  assert.ok(activated.ok, JSON.stringify(activated));
  return created.value.id;
}

/** Collect every change the store reports, in order. */
function record(store) {
  const changes = [];
  const unsubscribe = store.onSubtaskStatusChange((change) => changes.push(change));
  return { changes, unsubscribe };
}

test('a twin-side owner wait notifies listeners with task, subtask and status', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const subtaskId = store.getTask(taskId).subtasks[0].id;
  const { changes } = record(store);

  assert.ok(store.beginSubtask(subtaskId, 'twin').ok);

  const wait = store.waitSubtask(subtaskId, { kind: 'owner', note: '背景…\n需要你拍板的事项…' }, 'twin');
  assert.ok(wait.ok, JSON.stringify(wait));

  assert.equal(changes.length, 2, 'began + owner wait');
  assert.deepEqual(changes[0], {
    taskId,
    subtaskId,
    status: 'in_progress',
    previousStatus: 'pending',
    reason: 'began',
  });
  assert.deepEqual(changes[1], {
    taskId,
    subtaskId,
    status: 'waiting_owner',
    previousStatus: 'in_progress',
    reason: 'waiting_owner',
  });
});

test('the proposal path (waiting_owner) notifies listeners', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const subtaskId = store.getTask(taskId).subtasks[0].id;
  assert.ok(store.beginSubtask(subtaskId, 'twin').ok);
  const { changes } = record(store);

  const proposed = store.proposeSubtask(
    subtaskId,
    { evidence: [{ kind: 'url', uri: 'https://example.com/proof' }], summary: 'all criteria met' },
    'twin',
  );
  assert.ok(proposed.ok, JSON.stringify(proposed));

  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'waiting_owner');
  assert.equal(changes[0].previousStatus, 'in_progress');
  assert.equal(changes[0].reason, 'proposed');
  assert.equal(changes[0].subtaskId, subtaskId);
  assert.equal(changes[0].taskId, taskId);
});

test('re-waiting in the same state stays silent, and the owner verdict notifies once', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const subtaskId = store.getTask(taskId).subtasks[0].id;
  assert.ok(store.beginSubtask(subtaskId, 'twin').ok);
  assert.ok(store.waitSubtask(subtaskId, { kind: 'owner', note: 'first brief' }, 'twin').ok);

  const { changes } = record(store);

  // Same status: the note is refreshed, the status is not — no push (the
  // renderer's board poll picks the note up, and a push per keystroke would be
  // noise, not news).
  const rewait = store.waitSubtask(subtaskId, { kind: 'owner', note: 'rewritten six-section brief' }, 'twin');
  assert.ok(rewait.ok, JSON.stringify(rewait));
  assert.equal(rewait.value.waitNote, 'rewritten six-section brief', 'the note itself still updates');
  assert.equal(changes.length, 0, 'a same-status re-wait must not notify');

  // in_progress -> waiting_external IS a transition.
  assert.ok(store.unblockSubtask(subtaskId, 'owner').ok);
  assert.ok(store.waitSubtask(subtaskId, { kind: 'external', note: 'waiting on notarization' }, 'twin').ok);
  assert.deepEqual(changes.map((change) => change.status), ['in_progress', 'waiting_external']);

  // Owner unblocks, then accepts: the verdict is one more transition.
  assert.ok(store.unblockSubtask(subtaskId, 'owner').ok);
  const before = changes.length;
  assert.ok(store.acceptSubtask(subtaskId, 'owner').ok);
  assert.equal(changes.length, before + 1);
  assert.equal(changes[changes.length - 1].status, 'accepted');
  assert.equal(changes[changes.length - 1].reason, 'accepted');
});

test('non-status mutations and failed calls never notify', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const secondId = store.getTask(taskId).subtasks[1].id;
  const { changes } = record(store);

  // A rejected call changes nothing at all.
  const refused = store.waitSubtask(secondId, { kind: 'owner', note: 'not begun yet' }, 'twin');
  assert.equal(refused.ok, false);
  assert.equal(changes.length, 0);

  // beginSubtask is a real transition...
  assert.ok(store.beginSubtask(secondId, 'twin').ok);
  assert.equal(changes.length, 1);

  // ...while binding a session, editing fields and reordering are not.
  assert.ok(store.bindSession(secondId, 'session-1', 'system').ok);
  assert.ok(store.updateSubtask({ subtaskId: secondId, title: 'Renamed' }, 'owner').ok);
  assert.equal(changes.length, 1, 'only status transitions notify');
});

test('listeners can unsubscribe, and a throwing listener never breaks the mutation', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const subtaskId = store.getTask(taskId).subtasks[0].id;

  const seen = [];
  const unsubscribe = store.onSubtaskStatusChange((change) => seen.push(change.subtaskId));
  store.onSubtaskStatusChange(() => {
    throw new Error('subscriber blew up');
  });

  const began = store.beginSubtask(subtaskId, 'twin');
  assert.ok(began.ok, 'the mutation survives a throwing subscriber');
  assert.deepEqual(seen, [subtaskId]);

  unsubscribe();
  assert.ok(store.waitSubtask(subtaskId, { kind: 'owner', note: 'brief' }, 'twin').ok);
  assert.deepEqual(seen, [subtaskId], 'the unsubscribed listener hears nothing more');
});

test('a new sub-project notifies as a creation (no previous status)', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const { changes } = record(store);

  const added = store.addSubtask(taskId, { title: 'Third', acceptanceCriteria: ['done'] }, 'owner');
  assert.ok(added.ok, JSON.stringify(added));

  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'pending');
  assert.equal(changes[0].previousStatus, null);
  assert.equal(changes[0].reason, 'created');
  assert.equal(changes[0].subtaskId, added.value.id);
});
