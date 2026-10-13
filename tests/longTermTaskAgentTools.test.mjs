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
