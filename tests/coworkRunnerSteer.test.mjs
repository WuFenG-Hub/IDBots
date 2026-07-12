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

function createFakeSdk(config = {}) {
  const inputs = [];
  const inputWaiters = [];
  const eventQueue = [];
  const eventWaiters = [];
  let queryCalls = 0;
  let emittedResults = 0;
  let consumerDone = false;
  let finishRequested = false;
  let abortObserved = false;
  let releaseFirstAck;
  const firstAckGate = new Promise((resolve) => {
    releaseFirstAck = resolve;
  });

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
    releaseFirstInputAck() { releaseFirstAck(); },
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
        const iterator = prompt[Symbol.asyncIterator]();
        let inputIndex = 0;
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const input = next.value;
          inputIndex += 1;
          inputs.push(input.message.content[0].text);
          wakeInputWaiters();
          if (config.resultBeforeFirstAck && inputIndex === 1) {
            pushEvent({ type: 'result', subtype: 'success', result: 'early-result' });
            await firstAckGate;
          }
          if (finishRequested) emitAvailableResults();
        }
      })().finally(() => {
        consumerDone = true;
        eventWaiters.shift()?.();
      });

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

function createRetrySdk() {
  const queryInputs = [[], []];
  const inputWaiters = [];
  let queryCalls = 0;
  let activeInputConsumers = 0;
  let failFirstQuery;
  let finishSecondQuery;
  const firstFailure = new Promise((_, reject) => {
    failFirstQuery = () => reject(new Error('No conversation found with session ID stale-session'));
  });
  const secondFinish = new Promise((resolve) => {
    finishSecondQuery = resolve;
  });

  const wakeInputWaiters = () => {
    for (const waiter of inputWaiters.splice(0)) waiter();
  };

  return {
    get queryCalls() { return queryCalls; },
    get activeInputConsumers() { return activeInputConsumers; },
    createSdkMcpServer: (definition) => definition,
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    failFirstQuery() { failFirstQuery(); },
    finishSecondQuery() { finishSecondQuery(); },
    async waitForQueryInputCount(queryIndex, count) {
      while ((queryInputs[queryIndex]?.length ?? 0) < count) {
        await new Promise((resolve) => inputWaiters.push(resolve));
      }
    },
    query({ prompt }) {
      const queryIndex = queryCalls;
      queryCalls += 1;
      activeInputConsumers += 1;
      void (async () => {
        for await (const input of prompt) {
          queryInputs[queryIndex].push(input.message.content[0].text);
          wakeInputWaiters();
        }
      })().finally(() => {
        activeInputConsumers -= 1;
      });

      if (queryIndex === 0) {
        return {
          async *[Symbol.asyncIterator]() {
            await firstFailure;
          },
        };
      }
      return {
        async *[Symbol.asyncIterator]() {
          await secondFinish;
          yield { type: 'result', subtype: 'success', result: 'retry-result' };
        },
      };
    },
  };
}

function createRunnerHarness(overrides = {}) {
  const cwd = path.resolve(process.cwd());
  const store = new FakeCoworkStore(cwd);
  const sessionId = overrides.sessionId ?? 'steer-session';
  store.createSession(sessionId, overrides.session ?? {});
  const sdk = overrides.sdk ?? createFakeSdk(overrides.sdkOptions);
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
  const runner = new CoworkRunner(store, {
    loadClaudeSdk: overrides.loadClaudeSdk ?? (async () => sdk),
  });
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

test('result before delivery acknowledgement still closes the local turn', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness({
    sdkOptions: { resultBeforeFirstAck: true },
  });
  let resolved = false;
  const run = runner.startSession(sessionId, 'initial task').then(() => {
    resolved = true;
  });
  await sdk.waitForInputCount(1);
  await new Promise((resolve) => setImmediate(resolve));
  sdk.releaseFirstInputAck();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const resolvedWithoutStop = resolved;
  if (!resolved) runner.stopSession(sessionId);
  await run;
  assert.equal(resolvedWithoutStop, true);
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
});

test('automatic retry fails pending steers and closes the superseded input channel', async () => {
  const sdk = createRetrySdk();
  let releaseSecondLoader;
  let enterSecondLoader;
  const secondLoaderEntered = new Promise((resolve) => {
    enterSecondLoader = resolve;
  });
  const secondLoaderGate = new Promise((resolve) => {
    releaseSecondLoader = resolve;
  });
  let loadCalls = 0;
  const { runner, sessionId } = createRunnerHarness({
    sdk,
    session: { claudeSessionId: 'stale-session' },
    loadClaudeSdk: async () => {
      loadCalls += 1;
      if (loadCalls === 2) {
        enterSecondLoader();
        await secondLoaderGate;
      }
      return sdk;
    },
  });
  const failed = [];
  runner.on('steerFailed', (_sessionId, submissionId, reason) => {
    failed.push({ submissionId, reason });
  });

  const run = runner.startSession(sessionId, 'initial task');
  await sdk.waitForQueryInputCount(0, 1);
  const accepted = runner.trySubmitSteer(sessionId, 'steer-before-retry', 'preserve tests');
  assert.equal(accepted.accepted, true);
  await sdk.waitForQueryInputCount(0, 2);
  await accepted.delivered;

  sdk.failFirstQuery();
  await secondLoaderEntered;
  const duringRetry = runner.trySubmitSteer(sessionId, 'steer-during-retry', 'too late');
  if (duringRetry.accepted) void duringRetry.delivered.catch(() => undefined);
  releaseSecondLoader();
  await sdk.waitForQueryInputCount(1, 1);
  sdk.finishSecondQuery();
  await run;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failed.map((entry) => entry.submissionId), ['steer-before-retry']);
  assert.match(failed[0].reason, /retry/i);
  assert.deepEqual(duringRetry, { accepted: false, reason: 'closing' });
  assert.equal(sdk.activeInputConsumers, 0);
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

test('continueSession refuses a concurrent runner during local turn setup', async () => {
  const { runner, sessionId } = createRunnerHarness();
  let runCalls = 0;
  let releaseSetup;
  const setupBlocked = new Promise((resolve) => {
    releaseSetup = resolve;
  });
  let setupEntered;
  const entered = new Promise((resolve) => {
    setupEntered = resolve;
  });
  runner.runClaudeCode = async () => {
    runCalls += 1;
    setupEntered();
    await setupBlocked;
  };

  const run = runner.startSession(sessionId, 'initial task');
  await entered;
  const concurrentOutcome = runner.continueSession(sessionId, 'unsafe setup race')
    .then(() => null, (error) => error);
  await new Promise((resolve) => setImmediate(resolve));

  const observedRunCalls = runCalls;
  releaseSetup();
  const concurrentError = await concurrentOutcome;
  await run;
  assert.equal(observedRunCalls, 1);
  assert.match(concurrentError?.message ?? '', /active local turn/i);
});

test('sandbox and auto sessions report sandbox capability during setup', async () => {
  for (const executionMode of ['sandbox', 'auto']) {
    const { runner, sessionId } = createRunnerHarness({
      sessionId: `setup-${executionMode}`,
      session: { executionMode },
    });
    let releaseSetup;
    const setupBlocked = new Promise((resolve) => {
      releaseSetup = resolve;
    });
    let enterSetup;
    const setupEntered = new Promise((resolve) => {
      enterSetup = resolve;
    });
    runner.runClaudeCode = async () => {
      enterSetup();
      await setupBlocked;
    };

    const run = runner.startSession(sessionId, 'initial task');
    await setupEntered;
    assert.equal(runner.getSteerCapability(sessionId), 'sandbox');
    const concurrent = runner.continueSession(sessionId, 'unsafe setup race')
      .then(() => null, (error) => error);
    releaseSetup();
    assert.match((await concurrent)?.message ?? '', /active local turn/i);
    await run;
  }
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
