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
  return { store, anchor };
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
