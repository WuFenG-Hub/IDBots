import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
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
const { DshShutdownError } = loadCompiledModule('../dist-electron/main/libs/dshShutdownError.js');

class FakeCoworkStore {
  constructor() {
    this.session = {
      id: 's-pipeline',
      status: 'idle',
      cwd: '',
      systemPrompt: '',
      executionMode: 'local',
    };
    this.messages = [];
    this.messageSeq = 0;
  }

  updateSession(id, patch) {
    assert.equal(id, this.session.id);
    Object.assign(this.session, patch);
  }

  addMessage(id, message) {
    const stored = {
      id: `msg-${++this.messageSeq}`,
      type: message.type,
      content: message.content,
      timestamp: 1_700_000_100_000 + this.messageSeq,
      ...(message.metadata ? { metadata: message.metadata } : {}),
    };
    this.messages.push(stored);
    return stored;
  }

  getSession(id) {
    return id === this.session.id ? this.session : null;
  }

  getConversationSourceContextBySession() {
    return null;
  }

  getConfig() {
    return { executionMode: 'local' };
  }

  getMemoryBackend() {
    return {
      getEffectiveMemoryPolicyForSession: () => ({
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'standard',
        memoryUserMemoriesMaxItems: 0,
        memoryPromptMaxChars: 0,
      }),
    };
  }
}

function createHarness(cwd) {
  const store = new FakeCoworkStore();
  store.session.cwd = cwd;
  const runner = new CoworkRunner(store);
  // handleError emits 'error'; without a listener Node raises ERR_UNHANDLED_ERROR.
  runner.on('error', () => {});
  return { store, runner };
}

// 2026-09-14 session bfe4934f: a private-chat daemon redrive startSession'd
// the A2A session, the turn threw before the execution pipeline engaged, and
// the old catch swallowed the error into console.error only — status stayed
// 'running' forever ("本机 Bot 正在后台处理") with a leaked activeSessions
// entry, and the daemon deferred to the dead turn on every sweep.
test('pre-pipeline turn failure settles the session instead of stranding it on running', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-prepipeline-'));
  const { store, runner } = createHarness(base);
  // Exact incident window: a prologue await throws before runClaudeCode runs.
  runner.buildTwinLocalRosterPrompt = async () => {
    throw new Error('roster boom before pipeline');
  };

  await assert.rejects(
    runner.startSession('s-pipeline', 'hello', { systemPrompt: 'sp-new' }),
    /roster boom before pipeline/,
    'the original error must propagate so caller-side retries can run',
  );

  assert.equal(store.session.status, 'error', 'status must leave running');
  assert.equal(runner.isSessionActive('s-pipeline'), false, 'activeSessions entry must be removed');
  const last = store.messages.at(-1);
  assert.equal(last.type, 'system');
  assert.match(last.content, /^Error: roster boom before pipeline/);
});

test('kernel-body failure takes the same settle path (startSession catch)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-prepipeline-kernel-'));
  const { store, runner } = createHarness(base);
  runner.buildTwinLocalRosterPrompt = async () => '';
  runner.runLocalKernel = async () => {
    throw new Error('kernel exploded');
  };

  await assert.rejects(
    runner.startSession('s-pipeline', 'hello', { systemPrompt: 'sp-new' }),
    /kernel exploded/,
  );

  assert.equal(store.session.status, 'error');
  assert.equal(runner.isSessionActive('s-pipeline'), false);
  assert.match(store.messages.at(-1).content, /^Error: kernel exploded/);
});

// Shutdown aborts keep their soft contract: rethrown untouched, no error
// status, no persisted Error bubble (2026-09-12 mass-banner incident).
test('DSH shutdown abort still rethrows soft without settling to error', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-prepipeline-shutdown-'));
  const { store, runner } = createHarness(base);
  runner.buildTwinLocalRosterPrompt = async () => '';
  runner.runLocalKernel = async () => {
    throw new DshShutdownError();
  };

  await assert.rejects(
    runner.startSession('s-pipeline', 'hello', { systemPrompt: 'sp-new' }),
    (error) => error instanceof DshShutdownError,
  );

  assert.notEqual(store.session.status, 'error', 'shutdown abort must not error the session');
  assert.equal(
    store.messages.some((message) => /^Error:/.test(message.content ?? '')),
    false,
    'no Error bubble for shutdown aborts',
  );
});

// Both entry points (startSession + continueSession's active branch) must
// route failures through the settle helper — no console-only swallow left.
test('both turn entry catches settle through the shared helper', () => {
  const source = fs.readFileSync('src/main/libs/coworkRunner.ts', 'utf8');
  assert.ok(
    source.includes("settlePrePipelineTurnFailure(activeSession, 'startSession', error);"),
    'startSession catch must route through the settle helper',
  );
  assert.ok(
    source.includes("settlePrePipelineTurnFailure(activeSession, 'continueSession', error);"),
    'continueSession catch must route through the settle helper',
  );
  assert(
    !source.includes("console.error('Cowork session error:'"),
    'startSession must not swallow turn failures into console-only',
  );
  assert(
    !source.includes("console.error('Cowork continue error:'"),
    'continueSession must not swallow turn failures into console-only',
  );
});
