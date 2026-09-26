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
 * (pnpm run compile:electron first).
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

test('dependency-linked sub-projects cannot be manually reordered; free ones can', async () => {
  const { store } = await openStore();
  const created = store.createTask({
    title: 't', goal: 'g',
    subtasks: [
      { title: 'A' },
      { title: 'B', dependsOnOrdinals: [1] },
      { title: 'C' },
      { title: 'D' },
    ],
  }, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const [a, b, c, d] = created.value.subtasks;

  // Linked rows: A (depended on), B (has deps) — refused in both directions.
  const down = store.moveSubtask(a.id, 'down', 'owner');
  assert.equal(down.ok, false);
  assert.match(down.error, /dependency-linked/);
  assert.equal(store.moveSubtask(b.id, 'up', 'owner').ok, false);
  assert.equal(store.moveSubtask(b.id, 'down', 'owner').ok, false);

  // Free rows: C and D swap cleanly, and swap back.
  const moved = store.moveSubtask(c.id, 'down', 'owner');
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(moved.value.ordinal, 4);
  assert.equal(store.getSubtask(d.id).ordinal, 3);
  assert.ok(store.moveSubtask(c.id, 'up', 'owner').ok);
  assert.equal(store.getSubtask(c.id).ordinal, 3);

  // An ordinal edit is also a manual reorder: refused on linked, allowed on free.
  const linkedEdit = store.updateSubtask({ subtaskId: a.id, ordinal: 5 }, 'owner');
  assert.equal(linkedEdit.ok, false);
  assert.match(linkedEdit.error, /dependency-linked/);
  assert.ok(store.updateSubtask({ subtaskId: c.id, ordinal: 6 }, 'owner').ok);
});

test('expected-duration budget: persisted at creation, updated, cleared; invalid values fall back to null', async () => {
  const { store } = await openStore();
  const created = store.createTask(
    { title: 't', goal: 'g', subtasks: [{ title: 's1', expectedMinutes: 90 }, { title: 's2', expectedMinutes: -5 }] },
    'owner',
  );
  assert.ok(created.ok);
  assert.equal(created.value.subtasks[0].expectedMinutes, 90);
  assert.equal(created.value.subtasks[1].expectedMinutes, null, 'invalid budget falls back to null');

  const id = created.value.subtasks[0].id;
  const updated = store.updateSubtask({ subtaskId: id, expectedMinutes: 240 }, 'twin');
  assert.ok(updated.ok);
  assert.equal(updated.value.expectedMinutes, 240);
  assert.match(store.getTask(created.value.id).events[0].detail, /expected duration/);

  const cleared = store.updateSubtask({ subtaskId: id, expectedMinutes: null }, 'twin');
  assert.ok(cleared.ok);
  assert.equal(cleared.value.expectedMinutes, null);

  // The budget rides the board summary so the card can show it.
  assert.equal(store.getTask(created.value.id).currentExpectedMinutes, null);
  store.updateSubtask({ subtaskId: id, expectedMinutes: 300 }, 'twin');
  assert.equal(store.getTask(created.value.id).currentExpectedMinutes, 300);
});

test('migration: a pre-P1 database gains expected_minutes via a guarded ALTER, rows intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-longterm-mig-'));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  // Old shape: no expected_minutes column (pre-P1 databases).
  db.run(`CREATE TABLE long_term_subtasks (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending', depends_on_json TEXT NOT NULL DEFAULT '[]',
    preferred_channel TEXT, evidence_json TEXT NOT NULL DEFAULT '[]', session_id TEXT,
    wait_note TEXT NOT NULL DEFAULT '', wait_until TEXT, notes TEXT NOT NULL DEFAULT '',
    accepted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT,
    UNIQUE(task_id, ordinal))`);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO long_term_subtasks
     (id, task_id, ordinal, title, status, created_at, updated_at) VALUES ('lts_old', 'ltt_old', 1, 'legacy', 'pending', ?, ?)`,
    [now, now],
  );

  const store = new LongTermTaskStore(db, sqliteStore.getSaveFunction());
  const subtask = store.getSubtask('lts_old');
  assert.ok(subtask, 'legacy row readable after migration');
  assert.equal(subtask.expectedMinutes, null, 'legacy row has no budget');
  // New writes can carry a budget on the migrated table.
  assert.ok(store.updateSubtask({ subtaskId: 'lts_old', expectedMinutes: 120 }, 'twin').ok);
  assert.equal(store.getSubtask('lts_old').expectedMinutes, 120);
});

test('proposing acceptance clears a residual external waitUntil (no phantom quiet window)', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const first = store.getTask(taskId).subtasks[0];
  store.beginSubtask(first.id, 'twin');
  store.waitSubtask(
    first.id,
    { kind: 'external', note: 'notarization', waitUntil: new Date(Date.now() + 12 * 3_600_000).toISOString() },
    'twin',
  );
  assert.ok(store.proposeSubtask(first.id, { evidence: [{ kind: 'dir', uri: '/tmp/x' }], summary: 's' }, 'twin').ok);
  assert.equal(store.getSubtask(first.id).waitUntil, null, 'acceptance proposal must not inherit the external wait window');
});

test('proposeSubtask validates evidence URI shapes', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  const first = store.getTask(taskId).subtasks[0];
  store.beginSubtask(first.id, 'twin');
  const bad = store.proposeSubtask(first.id, {
    evidence: [{ kind: 'pin', uri: 'https://not-a-pin' }, { kind: 'dir', uri: 'relative/path' }],
    summary: 's',
  }, 'twin');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'VALIDATION');
  assert.match(bad.error, /malformed evidence/);
  const good = store.proposeSubtask(first.id, {
    evidence: [{ kind: 'pin', uri: 'pin://abc' }, { kind: 'dir', uri: '/tmp/x' }, { kind: 'other', uri: 'anything' }],
    summary: 's',
  }, 'twin');
  assert.ok(good.ok, JSON.stringify(good));
});

test('supervision re-arm state: set and read back per task', async () => {
  const { store } = await openStore();
  const taskId = await createActive(store);
  assert.equal(store.getSuperviseState(taskId), null);
  store.setSuperviseState(taskId, { lastSuperviseAtMs: 1234, lastFailureSignal: 'fails:2@a1' });
  assert.deepEqual(
    store.getSuperviseState(taskId),
    { lastSuperviseAtMs: 1234, lastFailureSignal: 'fails:2@a1', convergenceAtMs: [] },
  );
  // P1-A: a duration-style write (no failure signature) must NOT wipe the
  // failure dedup marker — the two signals consume separately.
  store.setSuperviseState(taskId, { lastSuperviseAtMs: 5678 });
  assert.equal(store.getSuperviseState(taskId).lastFailureSignal, 'fails:2@a1', 'duration write preserves the failure marker');
  assert.deepEqual(store.getSuperviseState(taskId).convergenceAtMs, [], 'supervision write preserves an empty trail');
  // A new failure signature overwrites the old one; convergence writes keep it.
  store.setSuperviseState(taskId, { lastSuperviseAtMs: 6000, lastFailureSignal: 'fails:3@a9' });
  assert.equal(store.getSuperviseState(taskId).lastFailureSignal, 'fails:3@a9');
  store.setSuperviseState(taskId, { lastSuperviseAtMs: 6500, convergenceAtMs: [100, 200] });
  assert.equal(store.getSuperviseState(taskId).lastFailureSignal, 'fails:3@a9', 'convergence write preserves the failure marker');
  assert.deepEqual(store.getSuperviseState(taskId).convergenceAtMs, [100, 200]);
  store.setSuperviseState(taskId, { lastSuperviseAtMs: 7000 });
  assert.deepEqual(store.getSuperviseState(taskId).convergenceAtMs, [100, 200], 'omitted field keeps the existing trail');
});
