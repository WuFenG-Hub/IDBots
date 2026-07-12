import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'cowork-runner-steer-test-user-data'),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
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
const { setStoreGetter } = loadCompiledModule('../dist-electron/main/libs/claudeSettings.js');
const hasSteerApi = typeof CoworkRunner.prototype.trySubmitSteer === 'function';

class FakeCoworkStore {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.sessions = new Map();
    this.messageSeq = 0;
  }

  createSession(id, overrides = {}) {
    const session = {
      id,
      title: id,
      claudeSessionId: null,
      status: 'idle',
      pinned: false,
      cwd: this.cwd,
      systemPrompt: '',
      executionMode: 'local',
      activeSkillIds: [],
      messages: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      metabotId: 1,
      sessionType: 'standard',
      peerGlobalMetaId: null,
      peerName: null,
      hiddenFromSessionList: false,
      ...overrides,
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id) ?? null;
  }

  getSessionMetadata(id) {
    const session = this.getSession(id);
    return session ? { ...session, messages: [] } : null;
  }

  addMessage(id, message) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    const stored = {
      id: `msg-${++this.messageSeq}`,
      type: message.type,
      content: message.content,
      timestamp: 1_700_000_100_000 + this.messageSeq,
      ...(message.metadata ? { metadata: message.metadata } : {}),
    };
    session.messages.push(stored);
    return stored;
  }

  updateSession(id, patch) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    Object.assign(session, patch);
  }

  getConfig() {
    return {
      workingDirectory: this.cwd,
      systemPrompt: '',
      executionMode: 'local',
      memoryEnabled: false,
      memoryImplicitUpdateEnabled: false,
      memoryLlmJudgeEnabled: false,
      memoryGuardLevel: 'strict',
      memoryUserMemoriesMaxItems: 12,
    };
  }

  getConversationSourceContextBySession() {
    return { sourceChannel: 'cowork_ui', externalConversationId: 'local-cowork' };
  }

  getMemoryBackend() {
    return {
      getEffectiveMemoryPolicyForSession: () => ({
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'strict',
        memoryUserMemoriesMaxItems: 12,
      }),
      resolveMetabotIdForMemory: () => 1,
      listUserMemories: () => [],
      applyTurnMemoryUpdates: async () => ({ created: [], updated: [] }),
    };
  }
}

function createFakeSdk() {
  const inputs = [];
  const inputWaiters = [];
  const eventQueue = [];
  const eventWaiters = [];
  let queryCalls = 0;
  let emittedResults = 0;
  let consumerDone = false;
  let finishRequested = false;
  let abortObserved = false;

  const wakeInputWaiters = () => {
    for (const waiter of inputWaiters.splice(0)) waiter();
  };
  const pushEvent = (event) => {
    eventQueue.push(event);
    eventWaiters.shift()?.();
  };
  const emitAvailableResults = () => {
    while (emittedResults < inputs.length) {
      emittedResults += 1;
      pushEvent({ type: 'result', subtype: 'success', result: `result-${emittedResults}` });
    }
  };

  const sdk = {
    get queryCalls() { return queryCalls; },
    get inputs() { return inputs; },
    get abortObserved() { return abortObserved; },
    createSdkMcpServer: (definition) => definition,
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    async waitForInputCount(count) {
      while (inputs.length < count) {
        await new Promise((resolve) => inputWaiters.push(resolve));
      }
    },
    finishAllResults() {
      finishRequested = true;
      emitAvailableResults();
    },
    query({ prompt, options }) {
      queryCalls += 1;
      options.abortController.signal.addEventListener('abort', () => {
        abortObserved = true;
        eventWaiters.shift()?.();
      }, { once: true });

      void (async () => {
        try {
          for await (const input of prompt) {
            inputs.push(input.message.content[0].text);
            wakeInputWaiters();
            if (finishRequested) emitAvailableResults();
          }
        } catch (error) {
          if (!options.abortController.signal.aborted) throw error;
        } finally {
          consumerDone = true;
          eventWaiters.shift()?.();
        }
      })();

      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (eventQueue.length > 0) {
              yield eventQueue.shift();
              continue;
            }
            if (consumerDone || options.abortController.signal.aborted) return;
            await new Promise((resolve) => eventWaiters.push(resolve));
          }
        },
      };
    },
  };
  return sdk;
}

function createRunnerHarness(overrides = {}) {
  const cwd = path.resolve(process.cwd());
  const store = new FakeCoworkStore(cwd);
  const sessionId = overrides.sessionId ?? 'steer-session';
  store.createSession(sessionId, overrides.session ?? {});
  const sdk = createFakeSdk();
  const sqliteConfigStore = {
    get(key) {
      if (key !== 'app_config') return null;
      return {
        model: { defaultModel: 'test-model' },
        providers: {
          test: {
            enabled: true,
            apiKey: 'test-key',
            baseUrl: 'https://example.invalid',
            apiFormat: 'anthropic',
            models: [{ id: 'test-model', contextWindow: 100_000, maxOutputTokens: 4_000 }],
          },
        },
      };
    },
  };
  setStoreGetter(() => sqliteConfigStore);
  const runner = new CoworkRunner(store, { loadClaudeSdk: async () => sdk });
  return { runner, sdk, store, sessionId };
}

test('exposes synchronous live steer admission', () => {
  assert.equal(typeof CoworkRunner.prototype.trySubmitSteer, 'function');
});

test('initial input and steer share one SDK query and settle in FIFO order', { skip: !hasSteerApi }, async () => {
  const { runner, sdk, sessionId } = createRunnerHarness();
  const settled = [];
  runner.on('steerSettled', (_sessionId, submissionId) => settled.push(submissionId));

  const run = runner.startSession(sessionId, 'initial task');
  await sdk.waitForInputCount(1);

  const first = runner.trySubmitSteer(sessionId, 'steer-1', 'change direction');
  const second = runner.trySubmitSteer(sessionId, 'steer-2', 'keep the tests');
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  await Promise.all([first.delivered, second.delivered]);
  await sdk.waitForInputCount(3);
  sdk.finishAllResults();
  await run;

  assert.equal(sdk.queryCalls, 1);
  assert.match(sdk.inputs[0], /initial task/);
  assert.match(sdk.inputs[1], /<operator_steer>/);
  assert.match(sdk.inputs[1], /change direction/);
  assert.match(sdk.inputs[2], /keep the tests/);
  assert.deepEqual(settled, ['steer-1', 'steer-2']);
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
});

test('continueSession refuses to start a concurrent runner while live input is open', { skip: !hasSteerApi }, async () => {
  const { runner, sdk, sessionId } = createRunnerHarness();
  const run = runner.startSession(sessionId, 'initial task');
  await sdk.waitForInputCount(1);

  await assert.rejects(
    runner.continueSession(sessionId, 'unsafe second run'),
    /active local turn/i,
  );
  runner.stopSession(sessionId);
  await run;
});

test('stop aborts the live channel and query without an unhandled rejection', { skip: !hasSteerApi }, async () => {
  const { runner, sdk, sessionId } = createRunnerHarness();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const run = runner.startSession(sessionId, 'initial task');
    await sdk.waitForInputCount(1);
    const steer = runner.trySubmitSteer(sessionId, 'steer-1', 'queued correction');
    assert.equal(steer.accepted, true);
    runner.stopSession(sessionId);
    await assert.rejects(steer.delivered, /stopped/i);
    await run;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sdk.abortObserved, true);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('reports sandbox and inactive steer capabilities without changing sandbox routing', { skip: !hasSteerApi }, () => {
  const { runner, sessionId } = createRunnerHarness({ session: { executionMode: 'sandbox' } });
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
  runner.activeSessions.set(sessionId, { executionMode: 'sandbox' });
  assert.equal(runner.getSteerCapability(sessionId), 'sandbox');
  assert.deepEqual(
    runner.trySubmitSteer(sessionId, 'steer-1', 'not supported'),
    { accepted: false, reason: 'sandbox' },
  );
});

test('waitForActiveTurnSettlement resolves after the active turn cleanup', { skip: !hasSteerApi }, async () => {
  const { runner, sdk, sessionId } = createRunnerHarness();
  const run = runner.startSession(sessionId, 'initial task');
  await sdk.waitForInputCount(1);
  const settled = runner.waitForActiveTurnSettlement(sessionId);
  sdk.finishAllResults();
  await Promise.all([run, settled]);
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
});
