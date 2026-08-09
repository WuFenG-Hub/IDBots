/**
 * Skill-turn watchdog recovery tests.
 *
 * Covers the "Skill turn 300s watchdog misjudgment" fix: when the watchdog
 * fires, the worker session keeps running inside CoworkRunner. A session that
 * eventually completes must be able to correct its attempt to completed; only
 * sessions that truly produce no output (errored / stopped / silent recovery
 * window) are marked failed.
 *
 * Bridge-level tests simulate the CoworkRunner with a fake EventEmitter-based
 * runner; service-level tests drive TwinOrchestrationService with a mocked
 * runWorkerTurn that rejects with SkillTurnTimeoutError and then fires the
 * recovery callbacks the way the real bridge does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runOrchestratorSkillTurn,
  SkillTurnTimeoutError,
} = require('../dist-electron/main/services/orchestratorCoworkBridge.js');
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');

// ---------------------------------------------------------------------------
// Bridge-level fixtures
// ---------------------------------------------------------------------------

function makeBridgeFixtures(sessionId) {
  const runner = new EventEmitter();
  const session = { id: sessionId, messages: [] };
  const sessionPatches = [];
  const store = {
    createSession(title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) {
      return session;
    },
    addMessage(sessionIdToAdd, message) {
      const record = {
        id: `message-${session.messages.length + 1}`,
        timestamp: Date.now(),
        ...message,
      };
      session.messages.push(record);
      return record;
    },
    getSession(targetSessionId) {
      assert.equal(targetSessionId, session.id);
      return session;
    },
    updateSession(targetSessionId, patch) {
      assert.equal(targetSessionId, session.id);
      sessionPatches.push(patch);
    },
  };
  runner.startSession = async () => { /* session runs on its own; no auto-complete */ };
  return { runner, store, session, sessionPatches };
}

// ---------------------------------------------------------------------------
// Bridge-level: watchdog fires, then the session keeps producing
// ---------------------------------------------------------------------------

test('bridge: watchdog rejects with SkillTurnTimeoutError and a late completion is recovered via onLateCompletion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session, sessionPatches } = makeBridgeFixtures('session-late-ok');
  const lateCompletions = [];
  const lateTerminations = [];
  const expiries = [];

  const resultPromise = runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'build the page',
    cwd: '/tmp/idbots-wt',
    skillTurnTimeoutMs: 300,
    lateCompletionTimeoutMs: 60_000,
    onLateCompletion: (late) => { lateCompletions.push(late); },
    onLateTermination: (late) => { lateTerminations.push(late); },
    onRecoveryExpired: (late) => { expiries.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(300); // watchdog fires

  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.name, 'SkillTurnTimeoutError');
    assert.equal(error.sessionId, 'session-late-ok');
    assert.match(error.message, /Skill turn timed out after/);
    return true;
  });

  // The session is still alive: it must NOT be marked 'error' at timeout.
  assert.equal(sessionPatches.some((patch) => patch.status === 'error'), false);

  // Hours later the session completes with a real result.
  session.messages.push({ id: 'assistant-late', type: 'assistant', content: 'Late handoff: done, tests green', timestamp: Date.now() });
  runner.emit('complete', 'session-late-ok');

  assert.deepEqual(lateCompletions, [{ sessionId: 'session-late-ok', replyText: 'Late handoff: done, tests green' }]);
  assert.equal(lateTerminations.length, 0);
  assert.equal(expiries.length, 0);

  // A second 'complete' must not double-report (listeners are detached).
  runner.emit('complete', 'session-late-ok');
  assert.equal(lateCompletions.length, 1);
});

test('bridge: late session error after the watchdog settles via onLateTermination and detaches listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session } = makeBridgeFixtures('session-late-error');
  const lateCompletions = [];
  const lateTerminations = [];

  const resultPromise = runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'build the page',
    cwd: '/tmp/idbots-wt',
    skillTurnTimeoutMs: 300,
    onLateCompletion: (late) => { lateCompletions.push(late); },
    onLateTermination: (late) => { lateTerminations.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(300);
  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.name, 'SkillTurnTimeoutError');
    return true;
  });

  runner.emit('error', 'session-late-error', 'API quota exceeded');
  assert.deepEqual(lateTerminations, [{ sessionId: 'session-late-error', reason: 'error', message: 'API quota exceeded' }]);

  // Listeners are gone: a later completion must not resurrect anything.
  session.messages.push({ id: 'assistant-late', type: 'assistant', content: 'too late', timestamp: Date.now() });
  runner.emit('complete', 'session-late-error');
  assert.equal(lateCompletions.length, 0);
});

test('bridge: session stopped after the watchdog settles via onLateTermination(stopped)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store } = makeBridgeFixtures('session-late-stopped');
  const lateTerminations = [];

  const resultPromise = runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'build the page',
    cwd: '/tmp/idbots-wt',
    skillTurnTimeoutMs: 300,
    onLateTermination: (late) => { lateTerminations.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(300);
  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.name, 'SkillTurnTimeoutError');
    return true;
  });

  runner.emit('stopped', 'session-late-stopped');
  assert.deepEqual(lateTerminations, [{ sessionId: 'session-late-stopped', reason: 'stopped', message: undefined }]);
});

test('bridge: silent session abandons recovery after the window via onRecoveryExpired', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session } = makeBridgeFixtures('session-late-silent');
  const lateCompletions = [];
  const expiries = [];

  const resultPromise = runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'build the page',
    cwd: '/tmp/idbots-wt',
    skillTurnTimeoutMs: 300,
    lateCompletionTimeoutMs: 60_000,
    onLateCompletion: (late) => { lateCompletions.push(late); },
    onRecoveryExpired: (late) => { expiries.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(300);
  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.name, 'SkillTurnTimeoutError');
    return true;
  });

  t.mock.timers.tick(60_000);
  assert.deepEqual(expiries, [{ sessionId: 'session-late-silent' }]);

  // Window closed: a very late completion is ignored.
  session.messages.push({ id: 'assistant-late', type: 'assistant', content: 'finally done', timestamp: Date.now() });
  runner.emit('complete', 'session-late-silent');
  assert.equal(lateCompletions.length, 0);
});

test('bridge: session completing before the watchdog resolves normally without recovery callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session } = makeBridgeFixtures('session-on-time');
  const lateCompletions = [];
  const lateTerminations = [];
  const expiries = [];

  runner.startSession = async (sessionId) => {
    session.messages.push({ id: 'assistant-on-time', type: 'assistant', content: 'on-time handoff', timestamp: Date.now() });
    queueMicrotask(() => runner.emit('complete', sessionId));
  };

  const resultPromise = runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'build the page',
    cwd: '/tmp/idbots-wt',
    skillTurnTimeoutMs: 300,
    onLateCompletion: (late) => { lateCompletions.push(late); },
    onLateTermination: (late) => { lateTerminations.push(late); },
    onRecoveryExpired: (late) => { expiries.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(100); // before the watchdog
  assert.equal(await resultPromise, 'on-time handoff');
  t.mock.timers.tick(300); // watchdog would have fired — must be a no-op now
  assert.equal(lateCompletions.length, 0);
  assert.equal(lateTerminations.length, 0);
  assert.equal(expiries.length, 0);
});

// ---------------------------------------------------------------------------
// Service-level: attempt state alignment
// ---------------------------------------------------------------------------

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-skill-timeout-'));

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
    getSession: (id) => id === 'twin-session' ? { id, metabotId: 1 } : null,
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

async function waitFor(assertion, timeoutMs = 1000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  if (lastError) throw lastError;
  assertion();
}

test('service: timeout parks the attempt as timed_out; a late completion corrects it to completed and the task to review', async () => {
  let capturedParams;
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    capturedParams = params;
    params.onSessionCreated('worker-session-timeout-ok');
    throw new SkillTurnTimeoutError('worker-session-timeout-ok', 300_000);
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'Fix the watchdog misjudgment',
      idempotencyKey: 'timeout-recovery-1',
    });

    // Watchdog fired: attempt parked as timed_out; step and task stay active.
    await waitFor(() => {
      assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'timed_out');
      assert.equal(orchestrationStore.getStep(result.step.id).status, 'running');
      assert.equal(orchestrationStore.getTask(result.task.id).status, 'running');
    });
    assert.match(orchestrationStore.getAttempt(result.attempt.id).error, /Skill turn timed out after/);
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).result, null);

    // Hours later the worker session completes — the late result lands.
    await capturedParams.onLateCompletion({ sessionId: 'worker-session-timeout-ok', replyText: 'Late handoff: committed abc123, tests 47/47' });
    await waitFor(() => {
      assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'completed');
      assert.equal(orchestrationStore.getStep(result.step.id).status, 'completed');
      assert.equal(orchestrationStore.getTask(result.task.id).status, 'review');
    });
    const attempt = orchestrationStore.getAttempt(result.attempt.id);
    assert.equal(attempt.result.replyText, 'Late handoff: committed abc123, tests 47/47');
    assert.equal(attempt.error, null);
  } finally {
    sqliteStore.close();
  }
});

test('service: timeout with no output settles to failed when the recovery window expires', async () => {
  let capturedParams;
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    capturedParams = params;
    params.onSessionCreated('worker-session-silent');
    throw new SkillTurnTimeoutError('worker-session-silent', 300_000);
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'Silent worker case',
      idempotencyKey: 'timeout-silent-1',
    });
    await waitFor(() => assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'timed_out'));

    await capturedParams.onRecoveryExpired({ sessionId: 'worker-session-silent' });
    await waitFor(() => {
      assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'failed');
      assert.equal(orchestrationStore.getStep(result.step.id).status, 'failed');
      assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed');
    });
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).error, 'SKILL_TURN_TIMEOUT_NO_RECOVERY');
  } finally {
    sqliteStore.close();
  }
});

test('service: timeout then session error settles the attempt to failed with the real error', async () => {
  let capturedParams;
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    capturedParams = params;
    params.onSessionCreated('worker-session-errored');
    throw new SkillTurnTimeoutError('worker-session-errored', 300_000);
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'Worker that errors later',
      idempotencyKey: 'timeout-error-1',
    });
    await waitFor(() => assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'timed_out'));

    await capturedParams.onLateTermination({ sessionId: 'worker-session-errored', reason: 'error', message: 'API quota exceeded' });
    await waitFor(() => {
      assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'failed');
      assert.equal(orchestrationStore.getStep(result.step.id).status, 'failed');
    });
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).error, 'API quota exceeded');
    assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed');
  } finally {
    sqliteStore.close();
  }
});

test('service: owner cancellation wins — a late completion never resurrects a cancelled task', async () => {
  let capturedParams;
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    capturedParams = params;
    params.onSessionCreated('worker-session-cancelled');
    throw new SkillTurnTimeoutError('worker-session-cancelled', 300_000);
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'Will be cancelled',
      idempotencyKey: 'timeout-cancel-1',
    });
    await waitFor(() => assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'timed_out'));

    service.cancelTask('twin-session', result.task.id);
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'cancelled');
    assert.equal(orchestrationStore.getTask(result.task.id).status, 'cancelled');

    await capturedParams.onLateCompletion({ sessionId: 'worker-session-cancelled', replyText: 'should be ignored' });
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'cancelled');
    assert.equal(orchestrationStore.getTask(result.task.id).status, 'cancelled');
    assert.equal(orchestrationStore.getStep(result.step.id).status, 'cancelled');
  } finally {
    sqliteStore.close();
  }
});

test('service: non-timeout worker failure still marks attempt/step/task failed as before', async () => {
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    params.onSessionCreated('worker-session-crashed');
    throw new Error('worker crashed');
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'Crash case',
      idempotencyKey: 'plain-failure-1',
    });
    await waitFor(() => {
      assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'failed');
      assert.equal(orchestrationStore.getStep(result.step.id).status, 'failed');
      assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed');
    });
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).error, 'worker crashed');
  } finally {
    sqliteStore.close();
  }
});

// ---------------------------------------------------------------------------
// Regression: reasoning-only "[reasoning unavailable]" must never become a handoff
// ---------------------------------------------------------------------------

test('bridge: a session ending with a reasoning-only [reasoning unavailable] turn yields an empty reply (no fake handoff)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session } = makeBridgeFixtures('session-thinking-only');
  runner.startSession = async (sessionId) => {
    // Worker emits progress text, runs a tool, then ends with reasoning-only.
    session.messages.push({ id: 'assistant-progress', type: 'assistant', content: 'python 不可用，直接用 Edit 打补丁调试副本：', timestamp: Date.now() });
    session.messages.push({ id: 'tool-read', type: 'tool_use', content: 'Using tool: Read', timestamp: Date.now() });
    session.messages.push({ id: 'tool-read-result', type: 'tool_result', content: 'file content', timestamp: Date.now() });
    session.messages.push({ id: 'assistant-think-1', type: 'assistant', content: '[reasoning unavailable]', metadata: { isThinking: true }, timestamp: Date.now() });
    session.messages.push({ id: 'assistant-think-2', type: 'assistant', content: '[reasoning unavailable]', metadata: { isThinking: true }, timestamp: Date.now() });
    queueMicrotask(() => runner.emit('complete', sessionId));
  };

  const resultPromise = runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'fix F2',
    cwd: '/tmp/idbots-wt',
    skillTurnTimeoutMs: 300,
  });

  await Promise.resolve();
  t.mock.timers.tick(100); // before the watchdog
  assert.equal(await resultPromise, '');
});

test('bridge: a real final text after tool activity and a thinking block is still extracted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session } = makeBridgeFixtures('session-real-final');
  runner.startSession = async (sessionId) => {
    session.messages.push({ id: 'assistant-progress', type: 'assistant', content: 'checking the code…', timestamp: Date.now() });
    session.messages.push({ id: 'tool-read', type: 'tool_use', content: 'Using tool: Read', timestamp: Date.now() });
    session.messages.push({ id: 'tool-read-result', type: 'tool_result', content: 'file content', timestamp: Date.now() });
    session.messages.push({ id: 'assistant-think', type: 'assistant', content: '[reasoning unavailable]', metadata: { isThinking: true }, timestamp: Date.now() });
    session.messages.push({ id: 'assistant-final', type: 'assistant', content: 'Final handoff: tests green', timestamp: Date.now() });
    queueMicrotask(() => runner.emit('complete', sessionId));
  };

  const resultPromise = runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'fix F2',
    cwd: '/tmp/idbots-wt',
    skillTurnTimeoutMs: 300,
  });

  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(await resultPromise, 'Final handoff: tests green');
});

test('bridge: a late completion that only contains [reasoning unavailable] is reported as empty, not a fake handoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session } = makeBridgeFixtures('session-late-thinking-only');
  const lateCompletions = [];

  const resultPromise = runOrchestratorSkillTurn(runner, store, {
    systemPrompt: 'system',
    userMessage: 'build the page',
    cwd: '/tmp/idbots-wt',
    skillTurnTimeoutMs: 300,
    onLateCompletion: (late) => { lateCompletions.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(300);
  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.name, 'SkillTurnTimeoutError');
    return true;
  });

  session.messages.push({ id: 'assistant-think', type: 'assistant', content: '[reasoning unavailable]', metadata: { isThinking: true }, timestamp: Date.now() });
  runner.emit('complete', 'session-late-thinking-only');
  assert.deepEqual(lateCompletions, [{ sessionId: 'session-late-thinking-only', replyText: '' }]);
});

test('service: a [reasoning unavailable] handoff fails the attempt with WORKER_EMPTY_HANDOFF instead of falsely completing', async () => {
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    params.onSessionCreated('worker-session-placeholder');
    return '[reasoning unavailable]';
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'Placeholder handoff',
      idempotencyKey: 'placeholder-handoff-1',
    });
    await waitFor(() => {
      assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'failed');
      assert.equal(orchestrationStore.getStep(result.step.id).status, 'failed');
      assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed');
    });
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).error, 'WORKER_EMPTY_HANDOFF');
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).result, null);
  } finally {
    sqliteStore.close();
  }
});

test('service: a late [reasoning unavailable] completion settles to WORKER_EMPTY_HANDOFF, not completed', async () => {
  let capturedParams;
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    capturedParams = params;
    params.onSessionCreated('worker-session-late-placeholder');
    throw new SkillTurnTimeoutError('worker-session-late-placeholder', 300_000);
  });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'Late placeholder handoff',
      idempotencyKey: 'late-placeholder-1',
    });
    await waitFor(() => assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'timed_out'));

    await capturedParams.onLateCompletion({ sessionId: 'worker-session-late-placeholder', replyText: '[reasoning unavailable]' });
    await waitFor(() => {
      assert.equal(orchestrationStore.getAttempt(result.attempt.id).status, 'failed');
      assert.equal(orchestrationStore.getStep(result.step.id).status, 'failed');
      assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed');
    });
    assert.equal(orchestrationStore.getAttempt(result.attempt.id).error, 'WORKER_EMPTY_HANDOFF');
  } finally {
    sqliteStore.close();
  }
});
