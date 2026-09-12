/**
 * DSH shutdown soft-fail tests (2026-09-12 mass A2A 'error' incident).
 *
 * Root cause: app cleanup closed the DSH runtime while the private-chat
 * daemon was still polling (it was never stopped). Every turn launched inside
 * the shutdown window crashed with `DshKernel: closed`, and each crash marked
 * its A2A conversation session 'error' with a persisted `Error:` bubble,
 * which the session banner then showed on a dozen historical conversations.
 *
 * The fix, covered here:
 *  1. DshShutdownError — one distinct type for "runtime closed by app quit".
 *  2. DshTurnHub — closed-gate: no new turn boots a runtime during shutdown;
 *     in-flight turn failures are reclassified to DshShutdownError by hub
 *     state (raw transport text names no shutdown); an unexpected runtime
 *     death (crash/OOM) respawns the process once instead of erroring.
 *  3. CoworkRunner.runDshSessionLocal — rethrows shutdown errors WITHOUT
 *     handleError (no session 'error' status, no persisted `Error:` bubble).
 *  4. orchestratorCoworkBridge — both skill-turn entry points route shutdown
 *     errors to a soft cancel that never stamps the session 'error'.
 *  5. runAppCleanup — chat daemons + scheduler + orchestrator stop BEFORE
 *     cowork sessions and the DSH runtime close.
 *  6. CoworkStore.healDshShutdownA2AErrorSessions — boot-time heal lifts the
 *     stale banner for sessions whose terminal transcript message is exactly
 *     the shutdown marker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

// electron mock (same shape as skillTurnTimeoutRecovery.test.mjs): the hub,
// runner and bridge modules all touch app.getPath/app.isPackaged at import.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-shutdown-${name}`),
      },
      session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { DshShutdownError, isDshShutdownError } = require('../dist-electron/main/libs/dshShutdownError.js');
const { DshTurnHub } = require('../dist-electron/main/libs/coworkDshTurn.js');
const { runAppCleanup } = require('../dist-electron/main/services/appCleanup.js');
const coworkUtilPath = require.resolve('../dist-electron/main/libs/coworkUtil.js');
require(coworkUtilPath);
require.cache[coworkUtilPath].exports.generateSessionTitle = async () => 'Test Title';
const {
  runOrchestratorSkillTurn,
  runSkillTurnInExistingSession,
} = require('../dist-electron/main/services/orchestratorCoworkBridge.js');
Module._load = originalLoad;

// ---------------------------------------------------------------------------
// 1. isDshShutdownError classification
// ---------------------------------------------------------------------------

test('isDshShutdownError matches the shutdown markers only', () => {
  assert.equal(isDshShutdownError(new DshShutdownError()), true);
  assert.equal(isDshShutdownError(new Error('DshKernel: closed')), true);
  assert.equal(isDshShutdownError(new Error('DshTurnHub: shutting down')), true);
  assert.equal(isDshShutdownError('DshKernel: closed'), true);
  // Transport-level runtime deaths are NOT shutdown errors — they get the
  // respawn-retry / normal error handling instead.
  assert.equal(isDshShutdownError(new Error('DeepSeek Harness runtime exited')), false);
  assert.equal(isDshShutdownError(new Error('DeepSeek Harness runtime closed')), false);
  assert.equal(isDshShutdownError(new Error('boom')), false);
  assert.equal(isDshShutdownError(undefined), false);
  assert.equal(isDshShutdownError(null), false);
});

// ---------------------------------------------------------------------------
// 2. Hub closed gate + unexpected-exit respawn
// ---------------------------------------------------------------------------

const makeTurnInput = () => ({
  sessionId: 'cowork-shutdown-1',
  dshSessionId: 'cw-cowork-shutdown-1',
  prompt: 'hello',
  provider: {
    key: 'shutdowngw',
    provider: 'shutdowngw',
    model: 'mock-1',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-a',
    apiFormat: 'openai',
  },
  sections: [],
  hostTools: [],
  workspace: { cwd: process.cwd() },
  callbacks: {},
});

test('hub.close() makes runTurn fail soft and boots no runtime', async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-shutdown-hub-'));
  try {
    const hub = new DshTurnHub({ sessionRoot });
    await hub.close();
    await assert.rejects(
      hub.runTurn(makeTurnInput()),
      (error) => {
        assert.equal(error.name, 'DshShutdownError');
        return true;
      },
    );
    assert.equal(hub.runtimeSlotCount, 0, 'no runtime process was booted after close');
    await assert.rejects(
      hub.prewarm({ provider: makeTurnInput().provider, workspace: { cwd: process.cwd() } }),
      (error) => {
        assert.equal(error.name, 'DshShutdownError');
        return true;
      },
    );
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test('unexpected runtime exit respawns the process once, then propagates', async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-respawn-hub-'));
  try {
    const hub = new DshTurnHub({ sessionRoot });
    const slot = hub.getOrCreateSlot('shutdowngw');
    let ensureSessionCalls = 0;
    let restartCalls = 0;
    const fakeKernel = {
      running: false,
      restartCount: 0,
      ensureRuntime: async () => undefined,
      ensureSession: async () => {
        ensureSessionCalls += 1;
        throw new Error('DeepSeek Harness runtime exited');
      },
      prompt: async () => {
        throw new Error('prompt must not be reached in this test');
      },
      restart: async () => {
        restartCalls += 1;
      },
      disposeSession: async () => undefined,
      close: async () => undefined,
    };
    slot.kernel = fakeKernel;

    await assert.rejects(
      hub.runTurn(makeTurnInput()),
      /runtime exited/,
      'the second ensureSession failure surfaces the original error',
    );
    assert.equal(restartCalls, 1, 'exactly one respawn was attempted');
    assert.equal(ensureSessionCalls, 2, 'initial attempt + one retry after respawn');
    await hub.close().catch(() => undefined);
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test('a turn failure while the hub is closing reclassifies to DshShutdownError', async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-inflight-hub-'));
  try {
    const hub = new DshTurnHub({ sessionRoot });
    const slot = hub.getOrCreateSlot('shutdowngw');
    let restartCalls = 0;
    const fakeKernel = {
      running: false,
      restartCount: 0,
      ensureRuntime: async () => undefined,
      ensureSession: async () => {
        // App quit closes the hub while the session call is in flight; the
        // SDK's raw transport error names no shutdown.
        void hub.close();
        throw new Error('DeepSeek Harness runtime closed');
      },
      prompt: async () => undefined,
      restart: async () => {
        restartCalls += 1;
      },
      disposeSession: async () => undefined,
      close: async () => undefined,
    };
    slot.kernel = fakeKernel;

    await assert.rejects(
      hub.runTurn(makeTurnInput()),
      (error) => {
        assert.equal(error.name, 'DshShutdownError');
        return true;
      },
    );
    assert.equal(restartCalls, 0, 'no respawn is attempted once shutdown owns the failure');
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Runner: runDshSessionLocal rethrows shutdown errors without handleError
// ---------------------------------------------------------------------------

class RecordingStore {
  constructor() {
    this.messages = [];
    this.sessions = new Map();
    this.sessionPatches = [];
  }
  getSession(id) { return this.sessions.get(id) ?? null; }
  getSessionWithoutMessages(id) { return this.sessions.get(id) ?? null; }
  getConfig() { return {}; }
  updateSession(id, updates) {
    this.sessionPatches.push({ id, updates });
    const existing = this.sessions.get(id) ?? { id };
    this.sessions.set(id, { ...existing, ...updates });
  }
  addMessage(sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: Date.now(), ...message };
    this.messages.push({ sessionId, ...stored });
    return stored;
  }
  updateMessage(sessionId, messageId, updates) {
    const entry = this.messages.find((m) => m.sessionId === sessionId && m.id === messageId);
    if (!entry) return;
    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.metadata !== undefined) entry.metadata = { ...(entry.metadata ?? {}), ...updates.metadata };
  }
  getConversationSourceContextBySession() {
    return { hasSourceContext: false };
  }
  getMemoryBackend() {
    const noMemories = () => [];
    return {
      getEffectiveMemoryPolicyForSession: () => ({ memoryEnabled: false }),
      resolveMetabotIdForMemory: () => 1,
      applyTurnMemoryUpdates: async () => ({}),
      listUserMemories: noMemories,
      listDailySummaries: noMemories,
      searchDailySummaries: noMemories,
    };
  }
  getSessionUsageStats() { return null; }
}

test('runDshSessionLocal rethrows a shutdown error without marking the session error', async () => {
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-shutdown-runner-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  let runnerModule;
  let claudeSettings;
  try {
    runnerModule = require('../dist-electron/main/libs/coworkRunner.js');
    claudeSettings = require('../dist-electron/main/libs/claudeSettings.js');
  } finally {
    Module._load = originalLoad;
  }
  const { CoworkRunner } = runnerModule;

  const fakeConfigStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined;
      return {
        api: { key: 'sk-a', baseUrl: 'http://127.0.0.1:9/v1' },
        model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
        providers: {
          mockgw: { enabled: true, apiKey: 'sk-a', baseUrl: 'http://127.0.0.1:9/v1', apiFormat: 'openai', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }] },
        },
        dshKernelEnabled: true,
      };
    },
  };
  claudeSettings.setStoreGetter(() => fakeConfigStore);

  const store = new RecordingStore();
  const runner = new CoworkRunner(store, {});
  // A hub already closed by app quit: every turn rejects with DshShutdownError.
  runner.dshTurnHub = {
    runTurn: async () => {
      throw new DshShutdownError();
    },
    cancel: async () => undefined,
    cancelAgent: async () => undefined,
    compact: async () => ({ ok: false }),
  };

  const sessionId = 'shutdown-turn';
  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    executionMode: 'local',
    localTurnState: 'none',
    permissionMode: 'default',
    readFiles: new Map(),
  };
  runner.activeSessions.set(sessionId, activeSession);
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', messages: [] });
  const errorEvents = [];
  runner.on('error', (sid, message) => errorEvents.push({ sid, message }));
  runner.on('permissionRequest', () => undefined);

  await assert.rejects(
    runner.runDshSessionLocal(activeSession, 'hello', process.cwd(), 'You are Alice.'),
    (error) => {
      assert.equal(error.name, 'DshShutdownError');
      return true;
    },
  );

  assert.equal(
    store.sessionPatches.some((patch) => patch.updates.status === 'error'),
    false,
    'session status is never stamped error for a shutdown abort',
  );
  assert.equal(
    store.messages.some((m) => typeof m.content === 'string' && m.content.startsWith('Error:')),
    false,
    'no persisted Error bubble for a shutdown abort',
  );
  assert.equal(errorEvents.length, 0, 'no error event fires for a shutdown abort');
  assert.equal(runner.dshActiveTurns.has(sessionId), false, 'turn bookkeeping is cleaned up');
  assert.equal(runner.activeSessions.has(sessionId), false, 'active session is removed');
});

// ---------------------------------------------------------------------------
// 4. Bridge: both skill-turn entry points soft-cancel on shutdown errors
// ---------------------------------------------------------------------------

function makeBridgeFixtures(sessionId) {
  const runner = new EventEmitter();
  const session = { id: sessionId, messages: [] };
  const sessionPatches = [];
  const store = {
    createSession() {
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
    getAppLanguage: () => 'en',
  };
  return { runner, store, session, sessionPatches };
}

test('bridge (existing session): startSession shutdown rejection rejects WITHOUT session error', async () => {
  const { runner, store, sessionPatches } = makeBridgeFixtures('session-existing-shutdown');
  runner.startSession = async () => {
    throw new DshShutdownError();
  };

  await assert.rejects(
    runSkillTurnInExistingSession(runner, store, {
      sessionId: 'session-existing-shutdown',
      systemPrompt: 'system',
      userMessage: 'verify the stake txid',
      cwd: '/tmp/idbots-wt',
      skillTurnTimeoutMs: 60_000,
      lateCompletionTimeoutMs: 60_000,
    }),
    (error) => {
      assert.equal(error.name, 'DshShutdownError');
      return true;
    },
  );
  assert.equal(
    sessionPatches.some((patch) => patch.status === 'error'),
    false,
    'the A2A conversation session is not stamped error',
  );
});

test('bridge (existing session): an error EVENT with shutdown text also soft-cancels', async () => {
  const { runner, store, sessionPatches } = makeBridgeFixtures('session-existing-shutdown-event');
  runner.startSession = async () => {
    setTimeout(() => runner.emit('error', 'session-existing-shutdown-event', 'DshKernel: closed'), 0);
  };

  await assert.rejects(
    runSkillTurnInExistingSession(runner, store, {
      sessionId: 'session-existing-shutdown-event',
      systemPrompt: 'system',
      userMessage: 'verify the stake txid',
      cwd: '/tmp/idbots-wt',
      skillTurnTimeoutMs: 60_000,
      lateCompletionTimeoutMs: 60_000,
    }),
    /DshKernel: closed/,
  );
  assert.equal(
    sessionPatches.some((patch) => patch.status === 'error'),
    false,
    'shutdown-text error events do not stamp the session error either',
  );
});

test('bridge (orchestrator session): startSession shutdown rejection rejects WITHOUT session error', async () => {
  const { runner, store, sessionPatches } = makeBridgeFixtures('session-orchestrator-shutdown');
  runner.startSession = async () => {
    throw new DshShutdownError();
  };

  await assert.rejects(
    runOrchestratorSkillTurn(runner, store, {
      systemPrompt: 'system',
      userMessage: 'run the nightly study job',
      cwd: '/tmp/idbots-wt',
      skillTurnTimeoutMs: 60_000,
      lateCompletionTimeoutMs: 60_000,
    }),
    (error) => {
      assert.equal(error.name, 'DshShutdownError');
      return true;
    },
  );
  assert.equal(
    sessionPatches.some((patch) => patch.status === 'error'),
    false,
    'the worker session is not stamped error for a shutdown abort',
  );
});

test('bridge: non-shutdown failures still stamp the session error (regression guard)', async () => {
  const { runner, store, sessionPatches } = makeBridgeFixtures('session-real-failure');
  runner.startSession = async () => {
    throw new Error('provider 401 Unauthorized');
  };

  await assert.rejects(
    runSkillTurnInExistingSession(runner, store, {
      sessionId: 'session-real-failure',
      systemPrompt: 'system',
      userMessage: 'verify the stake txid',
      cwd: '/tmp/idbots-wt',
      skillTurnTimeoutMs: 60_000,
      lateCompletionTimeoutMs: 60_000,
    }),
    /401/,
  );
  assert.equal(
    sessionPatches.some((patch) => patch.status === 'error'),
    true,
    'real turn failures keep the error status contract',
  );
});

// ---------------------------------------------------------------------------
// 5. Cleanup ordering: turn-generating daemons stop before the runtime closes
// ---------------------------------------------------------------------------

test('runAppCleanup stops chat daemons, scheduler and orchestrator before closing the DSH runtime', async () => {
  const order = [];
  const record = (name) => () => {
    order.push(name);
  };
  await runAppCleanup({
    destroyTray: record('destroyTray'),
    stopSkillWatching: record('stopSkillWatching'),
    closeMetaidRpcServer: record('closeMetaidRpcServer'),
    stopCoworkSessions: record('stopCoworkSessions'),
    closeDshRuntime: async () => {
      order.push('closeDshRuntime');
    },
    stopPrivateChatDaemon: async () => {
      order.push('stopPrivateChatDaemon');
    },
    stopGroupTaskDaemon: record('stopGroupTaskDaemon'),
    stopOpenTeamGuestDaemon: record('stopOpenTeamGuestDaemon'),
    stopOpenAICompatProxy: async () => {
      order.push('stopOpenAICompatProxy');
    },
    stopSkillServices: async () => {
      order.push('stopSkillServices');
    },
    stopIMGateways: async () => {
      order.push('stopIMGateways');
    },
    stopScheduler: record('stopScheduler'),
    stopCognitiveOrchestrator: record('stopCognitiveOrchestrator'),
    stopDreamService: record('stopDreamService'),
    stopP2P: async () => {
      order.push('stopP2P');
    },
    stopProviderDiscovery: record('stopProviderDiscovery'),
    deactivateGroupChatTasks: record('deactivateGroupChatTasks'),
    log: () => undefined,
    error: () => undefined,
  });

  const indexOf = (name) => order.indexOf(name);
  for (const daemon of ['stopPrivateChatDaemon', 'stopGroupTaskDaemon', 'stopOpenTeamGuestDaemon']) {
    assert.ok(indexOf(daemon) !== -1, `${daemon} runs during cleanup`);
    assert.ok(
      indexOf(daemon) < indexOf('stopCoworkSessions'),
      `${daemon} runs before cowork sessions stop`,
    );
  }
  for (const loop of ['stopScheduler', 'stopCognitiveOrchestrator']) {
    assert.ok(
      indexOf(loop) < indexOf('closeDshRuntime'),
      `${loop} runs before the DSH runtime closes`,
    );
  }
  assert.ok(
    indexOf('stopCoworkSessions') < indexOf('closeDshRuntime'),
    'cowork sessions still stop before the runtime closes (existing invariant)',
  );
});

// ---------------------------------------------------------------------------
// 6. Boot heal: errored A2A sessions whose terminal message is the marker
// ---------------------------------------------------------------------------

const SHUTDOWN_MARKER = 'Error: DshKernel: closed';

function addShutdownMarker(coworkStore, sessionId, content = SHUTDOWN_MARKER) {
  coworkStore.addMessage(sessionId, {
    type: 'system',
    content,
    metadata: { error: content.slice('Error: '.length) },
  });
}

test('boot heal lifts a2a sessions parked on error by a shutdown marker', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const session = coworkStore.createSession('peer chat', process.cwd(), '', 'local', [], null, 'a2a');
    addShutdownMarker(coworkStore, session.id);
    coworkStore.updateSession(session.id, { status: 'error' });

    assert.equal(coworkStore.healDshShutdownA2AErrorSessions(), 1);
    assert.equal(coworkStore.getSession(session.id).status, 'completed');
    // The marker stays in the transcript as history — only the status heals.
    const page = coworkStore.getSessionMessagesPage(session.id, { limit: 10 });
    assert.ok(page.messages.some((m) => m.type === 'system' && m.content === SHUTDOWN_MARKER));

    // Idempotent: a second run touches nothing.
    assert.equal(coworkStore.healDshShutdownA2AErrorSessions(), 0);
  } finally {
    sqlite.cleanup();
  }
});

test('boot heal covers the legacy agent_agent session type and the hub shutdown text', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const session = coworkStore.createSession('legacy peer', process.cwd(), '', 'local', [], null, 'a2a');
    sqlite.db.run('UPDATE cowork_sessions SET session_type = ? WHERE id = ?', ['agent_agent', session.id]);
    addShutdownMarker(coworkStore, session.id, 'Error: DshTurnHub: shutting down');
    coworkStore.updateSession(session.id, { status: 'error' });

    assert.equal(coworkStore.healDshShutdownA2AErrorSessions(), 1);
    assert.equal(coworkStore.getSession(session.id).status, 'completed');
  } finally {
    sqlite.cleanup();
  }
});

test('boot heal never touches real errors, later activity, non-a2a sessions, or non-error statuses', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    // Real failure text: untouched.
    const realError = coworkStore.createSession('real error', process.cwd(), '', 'local', [], null, 'a2a');
    addShutdownMarker(coworkStore, realError.id, 'Error: provider 401 Unauthorized');
    coworkStore.updateSession(realError.id, { status: 'error' });

    // Shutdown marker but the conversation moved on afterwards: the live
    // heal (new transcript activity) owns this case, not the boot heal.
    const movedOn = coworkStore.createSession('moved on', process.cwd(), '', 'local', [], null, 'a2a');
    addShutdownMarker(coworkStore, movedOn.id);
    coworkStore.addMessage(movedOn.id, { type: 'user', content: 'peer followed up' });
    coworkStore.updateSession(movedOn.id, { status: 'error' });

    // Standard session with a shutdown marker: untouched.
    const standard = coworkStore.createSession('standard', process.cwd(), '', 'local', [], null, 'standard');
    addShutdownMarker(coworkStore, standard.id);
    coworkStore.updateSession(standard.id, { status: 'error' });

    // Shutdown marker but the session is not in error: untouched.
    const healthy = coworkStore.createSession('healthy', process.cwd(), '', 'local', [], null, 'a2a');
    addShutdownMarker(coworkStore, healthy.id);
    coworkStore.updateSession(healthy.id, { status: 'completed' });

    assert.equal(coworkStore.healDshShutdownA2AErrorSessions(), 0);
    assert.equal(coworkStore.getSession(realError.id).status, 'error');
    assert.equal(coworkStore.getSession(movedOn.id).status, 'error');
    assert.equal(coworkStore.getSession(standard.id).status, 'error');
    assert.equal(coworkStore.getSession(healthy.id).status, 'completed');
  } finally {
    sqlite.cleanup();
  }
});
