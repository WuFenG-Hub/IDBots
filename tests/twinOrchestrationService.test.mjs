import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-twin-orchestration-'));

function makeBots() {
  return [
    { id: 1, name: 'Twin', enabled: true, metabot_type: 'twin', boss_global_metaid: 'owner-global', skills: [] },
    { id: 2, name: 'Builder', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-global', skills: ['metaapp-builder'] },
  ];
}

async function makeService(runWorkerTurn) {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  const orchestrationStore = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const bots = makeBots();
  const directory = {
    getSession: (id) => id === 'twin-session' ? { id, metabotId: 1 } : id === 'worker-session' ? { id, metabotId: 2 } : null,
    listMetabots: () => bots,
    getOwnerGlobalMetaId: () => 'owner-global',
  };
  const service = new TwinOrchestrationService({
    orchestrationStore,
    coworkStore: {},
    coworkRunner: {},
    directory,
    getMetabotById: (id) => bots.find((bot) => bot.id === id) ?? null,
    getWorkerWorkspace: (id) => `/tmp/idbots-worker-${id}`,
    runWorkerTurn,
  });
  return { sqliteStore, orchestrationStore, service };
}

async function waitFor(assertion, timeoutMs = 500) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  if (lastError) throw lastError;
  assertion();
}

test('delegation creates durable records, launches a dedicated Worker identity, and moves task to review', async () => {
  const calls = [];
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    calls.push(params);
    await params.onSessionCreated('worker-session-2');
    return 'Handoff: built index.html; verification evidence: file exists.';
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'Build the MetaID knowledge-base MetaApp',
      acceptanceCriteria: [{ id: 'html', check: 'index.html exists' }],
      permissionScope: { workspace: 'read_write', network: 'read_only' },
      idempotencyKey: 'task-1-step-1-attempt-1',
    });
    assert.equal(result.reused, false);
    assert.equal(result.task.status, 'running');
    assert.ok(result.step.status === 'queued' || result.step.status === 'running');
    assert.ok(result.attempt.status === 'queued' || result.attempt.status === 'running');
    await waitFor(() => {
      assert.equal(orchestrationStore.getTask(result.task.id).status, 'review');
      assert.equal(orchestrationStore.getStep(result.step.id).status, 'completed');
      assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'completed');
    });
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).workerSessionId, 'worker-session-2');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].metabotId, 2);
    assert.deepEqual(calls[0].activeSkillIds, ['metaapp-builder']);
    assert.equal(calls[0].autoApprove, false);
    assert.equal(calls[0].disableMemoryUpdates, false);
    assert.match(calls[0].userMessage, /<twin_delegation>/);
    assert.match(calls[0].userMessage, /index.html exists/);

    const reused = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'This should not run again',
      idempotencyKey: 'task-1-step-1-attempt-1',
    });
    assert.equal(reused.reused, true);
    assert.equal(calls.length, 1);
    assert.equal(reused.attempt.id, result.attempt.id);
    assert.equal(orchestrationStore.getActiveWorkload(2), 0);
  } finally {
    sqliteStore.close();
  }
});

test('delegation failure is durable and cannot be invoked by a Worker session', async () => {
  const { sqliteStore, orchestrationStore, service } = await makeService(async () => {
    throw new Error('worker crashed');
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', { workerMetabotId: 2, objective: 'fail', idempotencyKey: 'fail-key' });
    await waitFor(() => assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed'));
    const task = orchestrationStore.listActiveTasks()[0];
    assert.equal(task.status, 'failed');
    const step = orchestrationStore.listSteps(task.id)[0];
    assert.equal(step.status, 'failed');
    assert.equal(orchestrationStore.listAttempts(step.id)[0].error, 'worker crashed');

    await assert.rejects(service.delegateLocalWorker('worker-session', { workerMetabotId: 2, objective: 'forbidden', idempotencyKey: 'forbidden-key' }), /Only the current Twin Bot/);
  } finally {
    sqliteStore.close();
  }
});
