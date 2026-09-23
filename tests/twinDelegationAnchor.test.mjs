import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');

/**
 * Delegation anchor hard gate (fix/delegation-anchor-hardgate): a delegation
 * issued from a long-term-bound session ALWAYS carries <longterm_anchor> —
 * prepended by the service when the Twin left it out. Unbound sessions and
 * already-anchored objectives pass through untouched. Task intent is never
 * polluted. Runs against compiled output (pnpm run compile:electron first).
 */

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-hardgate-'));

const SPEC = {
  title: 'Game hub',
  goal: 'Ship the on-chain game hub where real bots play real bots.',
  subtasks: [
    { title: 'Blueprint match loop', acceptanceCriteria: ['3 full matches, zero human intervention'] },
  ],
};

function makeBots() {
  return [
    { id: 1, name: 'Twin', enabled: true, metabot_type: 'twin', boss_global_metaid: 'owner-global', skills: [] },
    { id: 2, name: 'Builder', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-global', skills: [] },
  ];
}

async function makeWorld() {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  const db = sqliteStore.getDatabase();
  const saveDb = sqliteStore.getSaveFunction();
  const orchestrationStore = new OrchestrationStore(db, saveDb);
  const longTermTaskStore = new LongTermTaskStore(db, saveDb);
  const bots = makeBots();
  const directory = {
    getSession: (id) => ({ id, metabotId: 1 }),
    listMetabots: () => bots,
    getOwnerGlobalMetaId: () => 'owner-global',
  };
  const workerTurnCalls = [];
  const service = new TwinOrchestrationService({
    orchestrationStore,
    coworkStore: {},
    coworkRunner: {},
    directory,
    getMetabotById: (id) => bots.find((bot) => bot.id === id) ?? null,
    getWorkerWorkspace: (id) => `/tmp/idbots-worker-${id}`,
    longTermTaskStore: () => longTermTaskStore,
    runWorkerTurn: async (params) => {
      workerTurnCalls.push(params);
      return 'Handoff: done; evidence: stub.';
    },
  });
  const created = longTermTaskStore.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const taskId = created.value.id;
  const subtaskId = created.value.subtasks[0].id;
  assert.ok(longTermTaskStore.activateTask(taskId, 'owner').ok);
  assert.ok(longTermTaskStore.bindSession(subtaskId, 'lt-session', 'system').ok);
  return { service, longTermTaskStore, taskId, subtaskId, workerTurnCalls };
}

const DELEGATE_INPUT = {
  workerMetabotId: 2,
  objective: 'Publish the fork MetaApp pin and verify the URI opens',
  acceptanceCriteria: ['pin resolves', 'uri opens'],
};

test('bound session: anchor block is prepended to step objective + attempt prompt + worker prompt', async () => {
  const { service, workerTurnCalls } = await makeWorld();
  const result = await service.delegateLocalWorker('lt-session', { ...DELEGATE_INPUT });

  for (const text of [result.step.objective, result.attempt.prompt]) {
    assert.ok(text.includes('<longterm_anchor>'), `anchor missing in: ${text.slice(0, 80)}`);
    assert.ok(text.includes('Ship the on-chain game hub where real bots play real bots.'), 'goal missing');
    assert.ok(text.includes('3 full matches, zero human intervention'), 'criteria missing');
    assert.ok(text.includes('longterm_task_get(taskId)'), 'worker self-read duty missing');
  }
  // The anchor never pollutes the orchestration task's intent/title.
  assert.ok(!result.task.ownerIntent.includes('<longterm_anchor>'), 'task intent polluted by the anchor');
  assert.ok(result.task.ownerIntent.includes(DELEGATE_INPUT.objective));
  // The worker-facing prompt carries it too.
  assert.equal(workerTurnCalls.length, 1);
  assert.ok(workerTurnCalls[0].userMessage.includes('<longterm_anchor>'), 'worker prompt missing the anchor');
});

test('unbound session: objective passes through untouched (no anchor)', async () => {
  const { service } = await makeWorld();
  const result = await service.delegateLocalWorker('plain-session', { ...DELEGATE_INPUT });
  assert.ok(!result.step.objective.includes('<longterm_anchor>'));
  assert.equal(result.attempt.prompt, DELEGATE_INPUT.objective);
});

test('already-anchored objective is not double-wrapped', async () => {
  const { service } = await makeWorld();
  const anchored = `<longterm_anchor>\ncustom\n</longterm_anchor>\n\n${DELEGATE_INPUT.objective}`;
  const result = await service.delegateLocalWorker('lt-session', { ...DELEGATE_INPUT, objective: anchored });
  const count = (result.attempt.prompt.match(/<longterm_anchor>/g) ?? []).length;
  assert.equal(count, 1, 'anchor must not be duplicated');
});
