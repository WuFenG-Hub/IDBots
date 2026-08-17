import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// coworkRunner imports 'electron' — stub it like the sibling runner tests do.
function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadCompiledModule('../dist-electron/main/libs/coworkRunner.js');
const { resolveTwinSourceSessionFallback } = loadCompiledModule('../dist-electron/main/services/groupTaskSourceSession.js');

// ---------------------------------------------------------------------------
// Minimal fake cowork store — only the surface reviveErroredSessionForContinuation
// and insertCrossSessionMessageAndQueue touch.
// ---------------------------------------------------------------------------

class FakeStore {
  constructor() {
    this.sessions = new Map();
    this.updated = [];
  }

  createSession(id, { status = 'idle', sessionType = 'standard', metabotId = null } = {}) {
    this.sessions.set(id, {
      id,
      title: id,
      status,
      pinned: 0,
      cwd: process.cwd(),
      systemPrompt: '',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      sessionType,
      metabotId,
      peerGlobalMetaId: null,
      peerName: null,
      hiddenFromSessionList: false,
      messages: [],
    });
    return this.sessions.get(id);
  }

  getSession(id) {
    return this.sessions.get(id) ?? null;
  }

  getSessionMetadata(id) {
    return this.getSession(id);
  }

  getSessionLatestMessage(id) {
    const session = this.getSession(id);
    return session ? session.messages[session.messages.length - 1] ?? null : null;
  }

  getSessionLatestVisibleMessage(id) {
    return this.getSessionLatestMessage(id);
  }

  addMessage(id, message) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    const stored = {
      id: `m-${session.messages.length + 1}`,
      timestamp: 1_700_000_100_000 + session.messages.length,
      ...message,
    };
    session.messages.push(stored);
    session.updatedAt = stored.timestamp;
    return stored;
  }

  updateSession(id, patch) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    Object.assign(session, patch);
    this.updated.push({ id, patch });
  }
}

function createHarness() {
  const store = new FakeStore();
  const runner = new CoworkRunner(store);
  return { store, runner };
}

// ---------------------------------------------------------------------------
// P1: reviveErroredSessionForContinuation
// ---------------------------------------------------------------------------

test('P1: an errored source session is reset to idle so the acceptance continuation can queue', () => {
  const { store, runner } = createHarness();
  store.createSession('source-1', { status: 'error' });

  const revived = runner.reviveErroredSessionForContinuation('source-1');
  assert.equal(revived, true);
  assert.equal(store.getSession('source-1').status, 'idle');
});

test('P1: a user-stopped session is never revived (stop is a deliberate terminal state)', () => {
  const { store, runner } = createHarness();
  store.createSession('source-2', { status: 'stopped' });

  assert.equal(runner.reviveErroredSessionForContinuation('source-2'), false);
  assert.equal(store.getSession('source-2').status, 'stopped');
});

test('P1: an explicitly stoppedSessions member is never revived even if the status says error', () => {
  const { store, runner } = createHarness();
  store.createSession('source-3', { status: 'error' });
  runner.stopSession('source-3', { finalStatus: 'error' });

  assert.equal(runner.reviveErroredSessionForContinuation('source-3'), false);
  assert.equal(store.getSession('source-3').status, 'error');
});

test('P1: idle/completed sessions and unknown ids are untouched (no-op, false)', () => {
  const { store, runner } = createHarness();
  store.createSession('source-4', { status: 'completed' });
  assert.equal(runner.reviveErroredSessionForContinuation('source-4'), false);
  assert.equal(store.getSession('source-4').status, 'completed');
  assert.equal(runner.reviveErroredSessionForContinuation('missing'), false);
  assert.deepEqual(store.updated, []);
});

test('P1: after revival the acceptance insert queues a continuation run', () => {
  const { store, runner } = createHarness();
  store.createSession('group-task-9', { status: 'idle' });
  store.createSession('source-5', { status: 'error' });

  runner.reviveErroredSessionForContinuation('source-5');
  const result = runner.insertCrossSessionMessageAndQueue({
    sourceSessionId: 'group-task-9',
    targetSessionId: 'source-5',
    message: '[GROUP_TASK_ACCEPTANCE] 任务「T」已完成验收：结果：done',
  });
  assert.equal(result.insert.ok, true, 'message inserted into the source session');
  assert.equal(result.runQueued, true, 'continuation queued (no TARGET_SESSION_STOPPED)');
});

// ---------------------------------------------------------------------------
// P1/P4: resolveTwinSourceSessionFallback (pure)
// ---------------------------------------------------------------------------

const fakeExec = (rows) => (sql, params) => {
  assert.match(sql, /FROM cowork_sessions/);
  assert.equal(params[0], 1);
  return [{ values: rows.map((id) => [id]) }];
};

test('P4 fallback: exactly one recent Twin standard session resolves', () => {
  const result = resolveTwinSourceSessionFallback(fakeExec(['twin-session-a']), 1, 1_000_000_000);
  assert.deepEqual(result, { sessionId: 'twin-session-a' });
});

test('P4 fallback: multiple recent Twin sessions are ambiguous → null-ish verdict', () => {
  const result = resolveTwinSourceSessionFallback(
    fakeExec(['twin-session-a', 'twin-session-b']),
    1,
    1_000_000_000,
  );
  assert.deepEqual(result, { ambiguous: 2 });
});

test('P4 fallback: zero candidates and invalid twin ids return null', () => {
  assert.equal(resolveTwinSourceSessionFallback(fakeExec([]), 1, 1_000_000_000), null);
  assert.equal(resolveTwinSourceSessionFallback(fakeExec(['x']), 0, 1_000_000_000), null);
  assert.equal(resolveTwinSourceSessionFallback(fakeExec(['x']), -3, 1_000_000_000), null);
});

// ---------------------------------------------------------------------------
// Static guards: the volatile context carries the session id on both kernels;
// the skill script forwards source_session_id; env injection is wired.
// ---------------------------------------------------------------------------

test('Local Time Context carries the CoWork session id on both kernel paths', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'libs', 'coworkRunner.ts'),
    'utf8',
  );
  assert.match(source, /Current CoWork session id: \$\{trimmedSessionId\}/);
  const callSites = source.match(/buildLocalTimeContextPrompt\(systemPromptProfile\.localTimeMode[^)]*\)/g) ?? [];
  assert.ok(callSites.length >= 2, `expected both kernel call sites, got ${callSites.length}`);
  for (const call of callSites) {
    assert.match(call, /sessionId/, `call site must pass sessionId: ${call}`);
  }
});

test('skill script forwards source_session_id (payload wins over env)', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'SKILLs', 'metabot-group-task', 'scripts', 'index.js'),
    'utf8',
  );
  assert.match(source, /params\.source_session_id \?\? process\.env\.IDBOTS_COWORK_SESSION_ID/);
});

test('skill session env injects IDBOTS_COWORK_SESSION_ID for subprocess-capable kernels', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(source, /overrides\.IDBOTS_COWORK_SESSION_ID = sessionId\.trim\(\)/);
});
