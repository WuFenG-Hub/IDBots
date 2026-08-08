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
const { CoworkCrossSessionService } = require('../dist-electron/main/services/coworkCrossSession.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-twin-orchestration-'));

function makeBots() {
  return [
    { id: 1, name: 'Twin', enabled: true, metabot_type: 'twin', boss_global_metaid: 'owner-global', skills: [] },
    { id: 2, name: 'Builder', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-global', skills: ['metaapp-builder'] },
  ];
}

function makeCrossSessionHarness() {
  // Minimal CoworkCrossSessionStore over a session map; the REAL
  // CoworkCrossSessionService runs on top so the notification exercises the
  // actual insert path (content wrap + metadata) used in production.
  const sessions = new Map([
    ['twin-session', { id: 'twin-session', sessionType: 'standard' }],
    ['worker-session-2', { id: 'worker-session-2', sessionType: 'standard' }],
  ]);
  const inserted = []; // { targetSessionId, message }
  const store = {
    getSession: (id) => sessions.get(id) ?? null,
    getSessionMetadata: (id) => sessions.get(id) ?? null,
    getSessionLatestMessage: () => null,
    addMessage: (sessionId, message) => {
      const full = { id: 'm-' + (inserted.length + 1), timestamp: 1700000000000, ...message };
      inserted.push({ targetSessionId: sessionId, message: full });
      return full;
    },
  };
  const service = new CoworkCrossSessionService(store);
  return { service, inserted };
}

function makeKv() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
    delete: (key) => { map.delete(key); },
    map,
  };
}

async function makeService(runWorkerTurn, overrides = {}) {
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
    ...(overrides.insertCrossSessionUserMessage
      ? { insertCrossSessionUserMessage: overrides.insertCrossSessionUserMessage }
      : {}),
    ...(overrides.kv ? { kv: overrides.kv } : {}),
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


// ---------------------------------------------------------------------------
// Round-4 r6: worker terminal-state [ORCH-NOTIFY] to the Twin session
// ---------------------------------------------------------------------------

test('r6: normal completion notifies the Twin with [ORCH-NOTIFY] 已完成 + task id', async () => {
  const cross = makeCrossSessionHarness();
  const kv = makeKv();
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    await params.onSessionCreated('worker-session-2');
    return 'Handoff: built index.html; verification evidence: file exists.';
  }, {
    insertCrossSessionUserMessage: (input) => cross.service.insertUserMessage(input),
    kv,
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2, objective: 'Build the MetaApp', idempotencyKey: 'r6-complete',
    });
    await waitFor(() => assert.equal(orchestrationStore.getTask(result.task.id).status, 'review'));

    assert.equal(cross.inserted.length, 1, 'exactly one notification');
    assert.equal(cross.inserted[0].targetSessionId, 'twin-session');
    assert.equal(cross.inserted[0].message.type, 'user');
    assert.match(cross.inserted[0].message.content, /\[ORCH-NOTIFY\]/);
    assert.match(cross.inserted[0].message.content, /worker Builder 已完成 task/);
    assert.match(cross.inserted[0].message.content, new RegExp('task ' + result.task.id));
    assert.match(cross.inserted[0].message.content, /→ review，请验收/);
    assert.equal(cross.inserted[0].message.metadata.sourceChannel, 'idbots_cross_session');
    assert.equal(cross.inserted[0].message.metadata.sourceSessionId, 'worker-session-2');
    assert.equal(kv.get('orch_notify:' + result.task.id + ':completed'), '1', 'kv guard set');
    assert.equal(kv.get('orch_notify:' + result.task.id + ':failed'), undefined);
  } finally {
    sqliteStore.close();
  }
});

test('r6: direct failure notifies the Twin with 未完成 + reason', async () => {
  const cross = makeCrossSessionHarness();
  const kv = makeKv();
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    await params.onSessionCreated('worker-session-2');
    throw new Error('worker crashed');
  }, {
    insertCrossSessionUserMessage: (input) => cross.service.insertUserMessage(input),
    kv,
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2, objective: 'fail', idempotencyKey: 'r6-fail',
    });
    await waitFor(() => assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed'));

    assert.equal(cross.inserted.length, 1, 'exactly one failure notification');
    assert.match(cross.inserted[0].message.content, /\[ORCH-NOTIFY\] worker Builder 未完成 task/);
    assert.match(cross.inserted[0].message.content, /worker crashed（failed）/);
    assert.equal(kv.get('orch_notify:' + result.task.id + ':failed'), '1', 'failure guard set');
  } finally {
    sqliteStore.close();
  }
});

test('r6: late completion (onLateCompletion after watchdog) notifies once — kv idempotency', async () => {
  const cross = makeCrossSessionHarness();
  const kv = makeKv();
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    await params.onSessionCreated('worker-session-2');
    // Simulate the watchdog-then-late-completion flow: the recovery hook fires
    // (correcting the attempt), then the turn rejects with the timeout error.
    params.onLateCompletion({ replyText: 'Handoff: late but real.' });
    throw { name: 'SkillTurnTimeoutError', sessionId: 'worker-session-2', timeoutMs: 300000, message: 'watchdog' };
  }, {
    insertCrossSessionUserMessage: (input) => cross.service.insertUserMessage(input),
    kv,
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2, objective: 'late', idempotencyKey: 'r6-late-complete',
    });
    await waitFor(() => assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'completed'));
    await waitFor(() => assert.equal(orchestrationStore.getTask(result.task.id).status, 'review'));

    assert.equal(cross.inserted.length, 1, 'completion notified exactly once despite two paths firing');
    assert.match(cross.inserted[0].message.content, /已完成/);
    assert.equal(kv.get('orch_notify:' + result.task.id + ':completed'), '1');
  } finally {
    sqliteStore.close();
  }
});

test('r6: late failure settlement (onLateTermination) notifies the Twin with the reason', async () => {
  const cross = makeCrossSessionHarness();
  const kv = makeKv();
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    await params.onSessionCreated('worker-session-2');
    params.onLateTermination({ reason: 'error', message: 'worker died late' });
    throw { name: 'SkillTurnTimeoutError', sessionId: 'worker-session-2', timeoutMs: 300000, message: 'watchdog' };
  }, {
    insertCrossSessionUserMessage: (input) => cross.service.insertUserMessage(input),
    kv,
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2, objective: 'late fail', idempotencyKey: 'r6-late-fail',
    });
    await waitFor(() => assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'failed'));

    assert.equal(cross.inserted.length, 1, 'one failure notification');
    assert.match(cross.inserted[0].message.content, /未完成/);
    assert.match(cross.inserted[0].message.content, /worker died late（failed）/);
    assert.equal(kv.get('orch_notify:' + result.task.id + ':failed'), '1');
  } finally {
    sqliteStore.close();
  }
});

test('r6: pre-set kv guard suppresses a second notification for the same terminal state', async () => {
  const cross = makeCrossSessionHarness();
  const kv = makeKv();
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    await params.onSessionCreated('worker-session-2');
    return 'Handoff: done.';
  }, {
    insertCrossSessionUserMessage: (input) => cross.service.insertUserMessage(input),
    kv,
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2, objective: 'silent complete', idempotencyKey: 'r6-pre-guarded',
    });
    // Simulate a duplicate terminal transition: the guard is already set.
    kv.set('orch_notify:' + result.task.id + ':completed', '1');
    await waitFor(() => assert.equal(orchestrationStore.getTask(result.task.id).status, 'review'));
    assert.equal(cross.inserted.length, 0, 'guard key already set → no duplicate notification');
  } finally {
    sqliteStore.close();
  }
});

test('r6: missing worker session identity skips the notification without throwing', async () => {
  const cross = makeCrossSessionHarness();
  const kv = makeKv();
  const { sqliteStore, orchestrationStore, service } = await makeService(async () => {
    // NO onSessionCreated: the attempt never gains a worker session identity.
    throw new Error('boom without a session');
  }, {
    insertCrossSessionUserMessage: (input) => cross.service.insertUserMessage(input),
    kv,
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2, objective: 'no session', idempotencyKey: 'r6-no-session',
    });
    await waitFor(() => assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed'));
    assert.equal(cross.inserted.length, 0, 'no worker session id → notify skipped, no throw');
    assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed', 'failure flow unaffected');
  } finally {
    sqliteStore.close();
  }
});
