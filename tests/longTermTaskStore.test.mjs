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
 * Long-term task store (P0). Runs against the compiled output
 * (pnpm run compile:electron first), same as trackedTaskBoard.test.mjs.
 */

async function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-longterm-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  return { store, dir };
}

const SPEC = {
  title: 'AI internet launch',
  goal: 'Ship the AI-internet concept launch and cold-start.',
  subtasks: [
    { title: 'Message house', acceptanceCriteria: ['one-liner + 3 pillars'] },
    { title: 'New website', acceptanceCriteria: ['reachable', 'signup works'], dependsOnOrdinals: [1], preferredChannel: 'delegate_bot' },
    { title: 'Promo video', acceptanceCriteria: ['2.5-3.5 min'] },
  ],
};

async function createActive(store) {
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const taskId = created.value.id;
  const activated = store.activateTask(taskId, 'owner');
  assert.ok(activated.ok, JSON.stringify(activated));
  return taskId;
}

test('create → defining draft with pending sub-projects; activate → active on the board', async () => {
  const { store } = await openStore();
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const task = created.value;
  assert.equal(task.stage, 'defining');
  assert.equal(task.column, 'defining');
  assert.equal(task.subtasks.length, 3);
  assert.deepEqual(task.subtasks.map((s) => s.ordinal), [1, 2, 3]);
  assert.ok(task.subtasks.every((s) => s.status === 'pending'));
  assert.equal(task.events[0].kind, 'created');

  // A draft must not accept work yet.
  const begin = store.beginSubtask(task.subtasks[0].id, 'twin');
  assert.equal(begin.ok, false);
  assert.equal(begin.code, 'VALIDATION');

  const activated = store.activateTask(task.id, 'owner');
  assert.ok(activated.ok);
  assert.equal(activated.value.stage, 'active');
  assert.equal(activated.value.column, 'in_progress');
  assert.equal(activated.value.currentSubtaskTitle, 'Message house');
  assert.equal(activated.value.progress.total, 3);
  assert.equal(activated.value.progress.accepted, 0);
});

test('create validation: missing fields and bad dependency ordinals refused', async () => {
  const { store } = await openStore();
  assert.equal(store.createTask({ title: '', goal: 'g', subtasks: [{ title: 'a' }] }, 'owner').ok, false);
  assert.equal(store.createTask({ title: 't', goal: 'g', subtasks: [] }, 'owner').ok, false);
  assert.equal(
    store.createTask({ title: 't', goal: 'g', subtasks: [{ title: 'a', dependsOnOrdinals: [1] }] }, 'owner').ok,
    false,
    'self-dependency must be refused',
  );
  assert.equal(
    store.createTask({ title: 't', goal: 'g', subtasks: [{ title: 'a', dependsOnOrdinals: [9] }] }, 'owner').ok,
    false,
    'out-of-range ordinal must be refused',
  );
});

test('dependency gating: #2 cannot begin until #1 is accepted; then it can', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const detail = store.getTask(taskId);
  const [first, second] = detail.subtasks;

  const early = store.beginSubtask(second.id, 'twin');
  assert.equal(early.ok, false);
  assert.match(early.error, /dependencies not yet accepted/);

  // Drive #1 through the full loop: begin → propose (evidence) → owner accept.
  assert.ok(store.beginSubtask(first.id, 'twin').ok);
  const noEvidence = store.proposeSubtask(first.id, { evidence: [], summary: 'done' }, 'twin');
  assert.equal(noEvidence.ok, false);
  assert.ok(
    store.proposeSubtask(first.id, { evidence: [{ kind: 'pin', uri: 'pin://abc' }], summary: 'message house ready' }, 'twin').ok,
  );
  let after = store.getTask(taskId);
  assert.equal(after.column, 'waiting_owner');
  assert.equal(after.currentSubtaskStatus, 'waiting_owner');

  assert.ok(store.acceptSubtask(first.id, 'owner', 'looks right').ok);
  after = store.getTask(taskId);
  assert.equal(after.column, 'in_progress');
  assert.equal(after.currentSubtaskTitle, 'New website');
  assert.equal(after.progress.accepted, 1);

  assert.ok(store.beginSubtask(second.id, 'twin').ok);
});

test('acceptance authority: twin refused without the delegate switch, allowed with it', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const first = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(first.id, 'twin').ok);
  assert.ok(store.proposeSubtask(first.id, { evidence: [{ kind: 'dir', uri: '/tmp/x' }], summary: 's' }, 'twin').ok);

  const refused = store.acceptSubtask(first.id, 'twin');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'FORBIDDEN');

  assert.ok(store.updateTask({ taskId, acceptanceDelegate: true }, 'owner').ok);
  const accepted = store.acceptSubtask(first.id, 'twin', 'criteria verified');
  assert.ok(accepted.ok, JSON.stringify(accepted));
  assert.equal(accepted.value.acceptedBy, 'twin');
});

test('reject returns the sub-project to in_progress with feedback journalled', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const first = store.getTask(taskId).subtasks[0];
  store.beginSubtask(first.id, 'twin');
  store.proposeSubtask(first.id, { evidence: [{ kind: 'pin', uri: 'pin://x' }], summary: 's' }, 'twin');

  const noFeedback = store.rejectSubtask(first.id, 'owner', '');
  assert.equal(noFeedback.ok, false);
  const rejected = store.rejectSubtask(first.id, 'owner', 'tone is off, redo');
  assert.ok(rejected.ok);
  assert.equal(rejected.value.status, 'in_progress');
  const events = store.getTask(taskId).events;
  assert.equal(events[0].kind, 'rejected');
  assert.match(events[0].detail, /tone is off/);
});

test('waiting external → column waiting_external; unblock resumes', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const first = store.getTask(taskId).subtasks[0];
  store.beginSubtask(first.id, 'twin');
  const waited = store.waitSubtask(first.id, { kind: 'external', note: 'waiting for Apple notarization' }, 'twin');
  assert.ok(waited.ok);
  assert.equal(store.getTask(taskId).column, 'waiting_external');
  assert.equal(store.getTask(taskId).currentWaitNote, 'waiting for Apple notarization');

  assert.ok(store.unblockSubtask(first.id, 'twin', 'notarization passed').ok);
  const after = store.getTask(taskId);
  assert.equal(after.column, 'in_progress');
  assert.equal(after.events[0].kind, 'unblocked');
});

test('accepting every sub-project completes the task (done column, completed event)', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  for (const subtask of store.getTask(taskId).subtasks) {
    assert.ok(store.beginSubtask(subtask.id, 'twin').ok, `begin ${subtask.title}`);
    assert.ok(
      store.proposeSubtask(subtask.id, { evidence: [{ kind: 'url', uri: 'https://x' }], summary: 's' }, 'twin').ok,
    );
    assert.ok(store.acceptSubtask(subtask.id, 'owner').ok);
  }
  const after = store.getTask(taskId);
  assert.equal(after.stage, 'done');
  assert.equal(after.column, 'done');
  assert.equal(after.progress.percent, 100);
  assert.equal(after.events[0].kind, 'completed');
});

test('updateSubtask redefines an open sub-project and journals replanned; cycles refused', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const [first, second] = store.getTask(taskId).subtasks;

  const updated = store.updateSubtask(
    { subtaskId: first.id, acceptanceCriteria: ['new bar'], notes: 'owner narrowed the scope' },
    'owner',
  );
  assert.ok(updated.ok);
  assert.deepEqual(updated.value.acceptanceCriteria, ['new bar']);
  assert.match(store.getTask(taskId).events[0].detail, /acceptance criteria/);

  const cycle = store.updateSubtask({ subtaskId: first.id, dependsOn: [second.id] }, 'owner');
  assert.equal(cycle.ok, false, 'cycle #1→#2→#1 must be refused');
});

test('pause/cancel: paused column; cancelled leaves the board but keeps its data', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  assert.ok(store.pauseTask(taskId, 'owner', 'focus elsewhere').ok);
  assert.equal(store.getTask(taskId).column, 'paused');
  assert.ok(store.activateTask(taskId, 'owner').ok, 'resume via activate');
  assert.equal(store.getTask(taskId).column, 'in_progress');

  assert.ok(store.cancelTask(taskId, 'owner', 'obsolete').ok);
  assert.ok(store.getTask(taskId), 'row stays readable');
  const board = store.listBoard();
  assert.ok(!board.cards.some((card) => card.id === taskId), 'cancelled task is off the board');
});

test('board columns follow the frozen display order and sort by recency', async () => {
  const { store } = await openStore();
  await createActive(store);
  const created2 = store.createTask({ title: 'draft task', goal: 'g', subtasks: [{ title: 'only step' }] }, 'twin');
  assert.ok(created2.ok);
  const board = store.listBoard();
  assert.deepEqual(
    board.columns.map((c) => c.column),
    ['waiting_owner', 'in_progress', 'waiting_external', 'defining', 'paused', 'done'],
  );
  const defining = board.columns.find((c) => c.column === 'defining');
  assert.deepEqual(defining.cardIds, [created2.value.id]);
  const inProgress = board.columns.find((c) => c.column === 'in_progress');
  assert.equal(inProgress.cardIds.length, 1);
});
