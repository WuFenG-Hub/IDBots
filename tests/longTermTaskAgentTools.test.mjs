import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { buildLongTermTaskAgentTools } = require('../dist-electron/main/libs/longTermTaskAgentTools.js');

/**
 * longterm_delegation_anchor (delegation-context fix): the anchor block must
 * carry ids + goal + criteria + recent events + worker duties, so a worker
 * bot pulls full context from the source instead of relying on the Twin's
 * relay. Runs against compiled output (pnpm run compile:electron first).
 */

async function openWorld(language = 'en') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-anchor-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const captured = new Map();
  const toolFactory = (name, description, schema, handler) => {
    captured.set(name, { description, handler });
    return { name };
  };
  const tools = buildLongTermTaskAgentTools({
    tool: toolFactory,
    control: { store: () => store, getAppLanguage: () => language },
  });
  assert.ok(tools.length > 0);
  const anchor = captured.get('longterm_delegation_anchor');
  assert.ok(anchor, 'longterm_delegation_anchor tool missing');
  return { store, captured, anchor };
}

const SPEC = {
  title: 'Game hub',
  goal: 'Ship the on-chain game hub where real bots play real bots.',
  subtasks: [
    {
      title: 'Blueprint match loop',
      description: 'Two local bots play a full match unattended.',
      acceptanceCriteria: ['3 full matches, zero human intervention', 'every move a compliant event message'],
      preferredChannel: 'delegate_bot',
    },
    { title: 'Spectate & replay', dependsOnOrdinals: [1] },
  ],
};

test('anchor block (en): ids, goal, criteria, channel, events, worker duties', async () => {
  const { store, anchor } = await openWorld('en');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const taskId = created.value.id;
  const subtaskId = created.value.subtasks[0].id;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  assert.ok(store.beginSubtask(subtaskId, 'twin', 'delegate_bot').ok);

  const result = await anchor.handler({ taskId, subtaskId });
  const text = result.content[0].text;
  assert.ok(text.includes('<longterm_anchor>'), 'anchor block wrapper missing');
  assert.ok(text.includes(`taskId: ${taskId}`));
  assert.ok(text.includes(`subtaskId: ${subtaskId}`));
  assert.ok(text.includes('Ship the on-chain game hub where real bots play real bots.'), 'goal missing');
  assert.ok(text.includes('3 full matches, zero human intervention'), 'criteria missing');
  assert.ok(text.includes('delegate_bot'), 'channel missing');
  assert.ok(text.includes('Recent journal events:'), 'journal digest missing');
  assert.ok(text.includes('longterm_task_get(taskId)'), 'worker self-read duty missing');
  assert.ok(text.includes('never invent infrastructure'), 'anti-invention rule missing');
  assert.ok(text.includes('longterm_event_note(taskId, subtaskId)'), 'journal-back duty missing');
});

test('anchor block (zh): Chinese labels and duties for zh owners', async () => {
  const { store, anchor } = await openWorld('zh');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;
  const subtaskId = created.value.subtasks[0].id;

  const result = await anchor.handler({ taskId, subtaskId });
  const text = result.content[0].text;
  assert.ok(text.includes('验收标准:'));
  assert.ok(text.includes('工作要求:'));
  assert.ok(text.includes('禁止自行发明基建'));
});

test('anchor refuses unknown task / subtask', async () => {
  const { anchor } = await openWorld('en');
  const missingTask = await anchor.handler({ taskId: 'ltt_nope', subtaskId: 'lts_nope' });
  assert.equal(missingTask.isError, true);
  const { store, anchor: anchor2 } = await openWorld('en');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const missingSub = await anchor2.handler({ taskId: created.value.id, subtaskId: 'lts_nope' });
  assert.equal(missingSub.isError, true);
  void store;
});

test('longterm_task_complete tool: delegate gate + goal-level closure through the twin channel', async () => {
  const { store, captured } = await openWorld('en');
  const complete = captured.get('longterm_task_complete');
  assert.ok(complete, 'longterm_task_complete tool missing');
  assert.match(complete.description, /GOAL met/i, 'description must frame this as a goal-level verdict');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;
  assert.ok(store.activateTask(taskId, 'owner').ok);

  const refused = await complete.handler({
    taskId,
    summary: 'hub shipped and live',
    evidence: [{ kind: 'url', uri: 'https://x.example/hub' }],
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /FORBIDDEN/);

  assert.ok(store.updateTask({ taskId, acceptanceDelegate: true }, 'owner').ok);
  const closed = await complete.handler({
    taskId,
    summary: 'hub shipped and live; spectate deferred',
    evidence: [{ kind: 'url', uri: 'https://x.example/hub', note: 'live hub' }],
  });
  assert.equal(closed.isError, undefined);
  const after = store.getTask(taskId);
  assert.equal(after.stage, 'done');
  assert.ok(after.subtasks.every((sub) => sub.status === 'skipped'));
});

test('longterm_subtask_skip tool: plan verdict with reason; last-open skip keeps the delegate gate', async () => {
  const { store, captured } = await openWorld('en');
  const skip = captured.get('longterm_subtask_skip');
  assert.ok(skip, 'longterm_subtask_skip tool missing');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  const [first, second] = store.getTask(taskId).subtasks;

  const skipped = await skip.handler({ subtaskId: second.id, reason: 'spectate covered by the replay page' });
  assert.equal(skipped.isError, undefined);
  assert.equal(store.getSubtask(second.id).status, 'skipped');
  assert.match(store.getTask(taskId).events[0].detail, /replay page/);

  // Skipping the now-last open sub-project completes the task — acceptance
  // authority, so the twin channel is refused without the delegate switch.
  const closing = await skip.handler({ subtaskId: first.id, reason: 'goal met' });
  assert.equal(closing.isError, true);
  assert.match(closing.content[0].text, /FORBIDDEN/);
  assert.equal(store.getTask(taskId).stage, 'active');

  assert.ok(store.updateTask({ taskId, acceptanceDelegate: true }, 'owner').ok);
  const closingOk = await skip.handler({ subtaskId: first.id, reason: 'goal met' });
  assert.equal(closingOk.isError, undefined);
  assert.equal(store.getTask(taskId).stage, 'done');
});

/**
 * Agent-channel projection (bug report 2026-10-20, SEC-1 / BUG-1 root cause):
 * the store resolves participants WITH their avatar (a base64 data URL, ~75K
 * chars per bot) for the board's chips, and every create / activate / get /
 * list echo shipped it to the model — 87% of the result budget, which is what
 * pushed the runtime shaper into tearing the identity fields. The Twin's tools
 * must drop the avatar on every task-shaped echo while the store (the owner
 * channel) keeps it.
 */
async function openWorldWithAvatar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-avatar-'));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const definitionSessionId = 'sess_definition_1';
  const now = Date.now();
  db.run(
    'INSERT INTO cowork_sessions (id, title, cwd, metabot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [definitionSessionId, 'definition', '/tmp', 7, now, now],
  );
  const avatar = 'data:image/png;base64,' + 'A'.repeat(75800);
  const store = new LongTermTaskStore(db, sqliteStore.getSaveFunction(), {
    resolveParticipants: (ids) => ids.map((id) => ({ id, name: `bot-${id}`, avatar })),
  });
  const captured = new Map();
  buildLongTermTaskAgentTools({
    tool: (name, description, schema, handler) => {
      captured.set(name, { description, handler });
      return { name };
    },
    control: { store: () => store, getAppLanguage: () => 'en' },
  });
  return { store, captured, avatar, definitionSessionId };
}

const BASE64_RUN = /[A-Za-z0-9+/=]{512,}/;

test('agent echoes carry participants without the avatar; the store (owner channel) keeps it', async () => {
  const { store, captured, avatar, definitionSessionId } = await openWorldWithAvatar();
  const create = captured.get('longterm_task_create');
  const created = await create.handler({ ...SPEC, definitionSessionId });
  assert.equal(created.isError, undefined, created.content[0].text);
  const createdJson = JSON.parse(created.content[0].text);
  const taskId = createdJson.id;

  // The store still resolves the full row — the board's chips depend on it.
  const ownerView = store.getTask(taskId);
  assert.equal(ownerView.participants.length, 1);
  assert.equal(ownerView.participants[0].id, 7);
  assert.equal(ownerView.participants[0].avatar, avatar);

  // The agent echo keeps the participant identity and drops the bytes.
  assert.deepEqual(createdJson.participants, [{ id: 7, name: 'bot-7' }]);
  assert.equal('avatar' in createdJson.participants[0], false);
  assert.doesNotMatch(created.content[0].text, BASE64_RUN, 'create echo carries a base64 run');
  // Identity fields come back whole (the shaper only tore them because the
  // avatar blew the budget; without it the echo is well under any budget).
  assert.equal(createdJson.title, SPEC.title);
  assert.equal(createdJson.goal, SPEC.goal);
  assert.equal(createdJson.subtasks.length, 2);

  const taskEchoes = [
    ['longterm_task_activate', { taskId }],
    ['longterm_task_get', { taskId }],
    ['longterm_task_update', { taskId, title: 'Game hub v2' }],
    ['longterm_task_update', { taskId, action: 'pause', note: 'hold' }],
    ['longterm_task_update', { taskId, action: 'resume' }],
  ];
  for (const [name, args] of taskEchoes) {
    const result = await captured.get(name).handler(args);
    assert.equal(result.isError, undefined, `${name}: ${result.content[0].text}`);
    const text = result.content[0].text;
    assert.doesNotMatch(text, BASE64_RUN, `${name} echo carries a base64 run`);
    const json = JSON.parse(text);
    assert.deepEqual(json.participants, [{ id: 7, name: 'bot-7' }], `${name} participants`);
  }

  const board = await captured.get('longterm_task_list').handler({});
  assert.doesNotMatch(board.content[0].text, BASE64_RUN, 'list echo carries a base64 run');
  const boardJson = JSON.parse(board.content[0].text);
  assert.equal(boardJson.cards.length, 1);
  assert.deepEqual(boardJson.cards[0].participants, [{ id: 7, name: 'bot-7' }]);

  // completeTask returns the closed task through the same projection.
  assert.ok(store.updateTask({ taskId, acceptanceDelegate: true }, 'owner').ok);
  const closed = await captured.get('longterm_task_complete').handler({
    taskId,
    summary: 'hub shipped',
    evidence: [{ kind: 'url', uri: 'https://x.example/hub' }],
  });
  assert.equal(closed.isError, undefined, closed.content[0].text);
  assert.doesNotMatch(closed.content[0].text, BASE64_RUN, 'complete echo carries a base64 run');
  assert.deepEqual(JSON.parse(closed.content[0].text).participants, [{ id: 7, name: 'bot-7' }]);
});

test('longterm_task_update pause/resume/cancel follow the shared result contract (bare value or Refused error)', async () => {
  const { store, captured } = await openWorldWithAvatar();
  const update = captured.get('longterm_task_update');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;

  // pause from a draft is refused by the store — the tool surfaces it as an error result.
  const badPause = await update.handler({ taskId, action: 'pause' });
  assert.equal(badPause.isError, true);
  assert.match(badPause.content[0].text, /Refused \(VALIDATION\)/);

  assert.ok(store.activateTask(taskId, 'owner').ok);
  const paused = await update.handler({ taskId, action: 'pause', note: 'hold' });
  assert.equal(paused.isError, undefined);
  const pausedJson = JSON.parse(paused.content[0].text);
  assert.equal(pausedJson.id, taskId, 'pause returns the task itself, not a {ok,value} wrapper');
  assert.equal(pausedJson.stage, 'paused');
  assert.equal('ok' in pausedJson, false);

  const cancelled = await update.handler({ taskId, action: 'cancel', note: 'moot' });
  assert.equal(cancelled.isError, undefined);
  assert.equal(cancelled.content[0].text, 'Cancelled.');
  assert.equal(store.getTask(taskId).stage, 'cancelled');

  const cancelAgain = await update.handler({ taskId, action: 'cancel' });
  assert.equal(cancelAgain.isError, true);
  assert.match(cancelAgain.content[0].text, /Refused \(VALIDATION\)/);
});

/**
 * BUG-2 (bug report 2026-10-20): activation is the owner's sign-off, not the
 * start of work, so every sub-project is still `pending` afterwards — correct,
 * but it read as "activated and nothing moved". The activate / resume echoes
 * now state the next step instead of leaving it to be inferred.
 */
test('longterm_task_activate echo names the first beginnable sub-project as nextAction', async () => {
  const { store, captured } = await openWorld('en');
  const activate = captured.get('longterm_task_activate');
  assert.match(activate.description, /does NOT begin work/, 'description must say activation is not begin');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;
  const [first, second] = created.value.subtasks;

  const activated = await activate.handler({ taskId });
  assert.equal(activated.isError, undefined, activated.content[0].text);
  const json = JSON.parse(activated.content[0].text);
  assert.equal(json.stage, 'active');
  // The derived focus is already populated (deriveCurrentSubtask); the DB pin stays null until begin.
  assert.equal(json.currentSubtaskId, first.id);
  assert.equal(json.currentSubtaskTitle, first.title);
  assert.equal(json.currentSubtaskStatus, 'pending');
  assert.equal(typeof json.nextAction, 'string');
  assert.match(json.nextAction, /longterm_subtask_begin/);
  assert.ok(json.nextAction.includes(first.id), `nextAction must name the first sub-project id: ${json.nextAction}`);
  assert.ok(json.nextAction.includes(first.title), `nextAction must name the first sub-project title: ${json.nextAction}`);
  assert.ok(!json.nextAction.includes(second.id), 'the dependency-blocked second sub-project is not the one to begin');

  // Once work is in flight, resume carries no nextAction — nothing to begin.
  assert.ok(store.beginSubtask(first.id, 'twin', 'delegate_bot').ok);
  const update = captured.get('longterm_task_update');
  const paused = await update.handler({ taskId, action: 'pause', note: 'hold' });
  assert.equal(paused.isError, undefined);
  assert.equal('nextAction' in JSON.parse(paused.content[0].text), false, 'pause never carries nextAction');
  const resumed = await update.handler({ taskId, action: 'resume' });
  assert.equal(resumed.isError, undefined);
  const resumedJson = JSON.parse(resumed.content[0].text);
  assert.equal(resumedJson.stage, 'active');
  assert.equal(resumedJson.currentSubtaskStatus, 'in_progress');
  assert.equal('nextAction' in resumedJson, false, 'resume with a sub-project in flight carries no nextAction');

  // Resume with everything still pending (paused before any begin) states the step again.
  const fresh = store.createTask(SPEC, 'owner');
  assert.ok(fresh.ok);
  assert.ok(store.activateTask(fresh.value.id, 'owner').ok);
  assert.ok(store.pauseTask(fresh.value.id, 'owner').ok);
  const resumedFresh = await update.handler({ taskId: fresh.value.id, action: 'resume' });
  assert.equal(resumedFresh.isError, undefined);
  assert.match(JSON.parse(resumedFresh.content[0].text).nextAction, /longterm_subtask_begin/);
});

test('longterm_task_activate nextAction reports a fully dependency-blocked plan instead of naming a sub-project', async () => {
  const { store, captured } = await openWorld('en');
  // createTask only validates ordinal range / self-reference; a 1 <-> 2 cycle
  // is accepted at creation and leaves nothing beginnable.
  const created = store.createTask(
    {
      title: 'Cyclic',
      goal: 'Two sub-projects that wait on each other.',
      subtasks: [
        { title: 'A', dependsOnOrdinals: [2] },
        { title: 'B', dependsOnOrdinals: [1] },
      ],
    },
    'owner',
  );
  assert.ok(created.ok, JSON.stringify(created));
  const activated = await captured.get('longterm_task_activate').handler({ taskId: created.value.id });
  assert.equal(activated.isError, undefined, activated.content[0].text);
  const json = JSON.parse(activated.content[0].text);
  assert.match(json.nextAction, /blocked by an unmet dependency/);
  assert.match(json.nextAction, /longterm_subtask_update/);
  assert.doesNotMatch(json.nextAction, /longterm_subtask_begin/);
});
