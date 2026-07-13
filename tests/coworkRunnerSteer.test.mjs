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
const { CoworkTurnSubmissionController } = loadCompiledModule('../dist-electron/main/services/coworkTurnSubmission.js');
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

  addMessageWithId(sessionId, messageId, message) {
    const existing = this.getMessageById(sessionId, messageId);
    if (existing) return existing;
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const stored = {
      id: messageId,
      type: message.type,
      content: message.content,
      timestamp: 1_700_000_100_000 + ++this.messageSeq,
      ...(message.metadata ? { metadata: message.metadata } : {}),
    };
    session.messages.push(stored);
    return stored;
  }

  getMessageById(sessionId, messageId) {
    return this.getSession(sessionId)?.messages.find((message) => message.id === messageId) ?? null;
  }

  getMessageOwnerSessionId(messageId) {
    for (const [sessionId, session] of this.sessions) {
      if (session.messages.some((message) => message.id === messageId)) return sessionId;
    }
    return null;
  }

  updateMessage(sessionId, messageId, updates) {
    const message = this.getMessageById(sessionId, messageId);
    if (message) Object.assign(message, updates);
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
  let queryError = null;
  let releaseFirstAck;
  const firstAckGate = new Promise((resolve) => {
    releaseFirstAck = resolve;
  });
  let releaseSecondAck;
  const secondAckGate = new Promise((resolve) => {
    releaseSecondAck = resolve;
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
    failQuery(error = new Error('generic provider failure')) {
      queryError = error;
      eventWaiters.shift()?.();
    },
    releaseFirstInputAck() { releaseFirstAck(); },
    releaseSecondInputAck() { releaseSecondAck(); },
    emitTerminalAssistant(parentToolUseId = null) {
      pushEvent({
        type: 'assistant',
        parent_tool_use_id: parentToolUseId,
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'terminal assistant response' }],
        },
      });
    },
    emitTerminalStream(stopReason = 'end_turn', parentToolUseId = null) {
      pushEvent({
        type: 'stream_event',
        parent_tool_use_id: parentToolUseId,
        event: {
          type: 'message_delta',
          delta: { stop_reason: stopReason },
        },
      });
    },
    emitResult(result = 'manual-result') {
      pushEvent(typeof result === 'string'
        ? { type: 'result', subtype: 'success', result }
        : { type: 'result', ...result });
    },
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
          if (config.terminalBeforeSecondAck && inputIndex === 2) {
            sdk.emitTerminalStream();
            await secondAckGate;
          }
          if (config.pauseBeforeSecondAck && inputIndex === 2) {
            await secondAckGate;
          }
          if (finishRequested) emitAvailableResults();
        }
      })().finally(() => {
        if (config.resultAfterInputClose) {
          pushEvent({ type: 'result', subtype: 'success', result: 'closed-input-result' });
        }
        consumerDone = true;
        eventWaiters.shift()?.();
      });

      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (queryError) throw queryError;
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

test('two top-level streaming end turns settle two delivered inputs before one result', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness({
    sdkOptions: { resultAfterInputClose: true },
  });
  const settled = [];
  runner.on('steerSettled', (_sessionId, submissionId) => settled.push(submissionId));

  let resolved = false;
  const run = runner.startSession(sessionId, 'initial task').then(() => {
    resolved = true;
  });
  await sdk.waitForInputCount(1);
  const steer = runner.trySubmitSteer(sessionId, 'steer-terminal', 'apply this correction');
  assert.equal(steer.accepted, true);
  await steer.delivered;
  await sdk.waitForInputCount(2);

  sdk.emitTerminalStream();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.deepEqual(settled, []);
  assert.equal(runner.getSteerCapability(sessionId), 'open-local');

  sdk.emitTerminalStream();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const resolvedFromTerminalBoundary = resolved;
  if (!resolved) runner.stopSession(sessionId);
  await run;
  assert.equal(resolvedFromTerminalBoundary, true);
  assert.deepEqual(settled, ['steer-terminal']);
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
});

test('late delivery acknowledgement waits for a new terminal assistant boundary', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness({
    sdkOptions: { terminalBeforeSecondAck: true, resultAfterInputClose: true },
  });
  const settled = [];
  runner.on('steerSettled', (_sessionId, submissionId) => settled.push(submissionId));

  let resolved = false;
  const run = runner.startSession(sessionId, 'initial task').then(() => {
    resolved = true;
  });
  await sdk.waitForInputCount(1);
  const steer = runner.trySubmitSteer(sessionId, 'steer-late-ack', 'apply after acknowledgement');
  assert.equal(steer.accepted, true);
  await sdk.waitForInputCount(2);
  await new Promise((resolve) => setImmediate(resolve));
  const capabilityAtTerminalBoundary = runner.getSteerCapability(sessionId);
  sdk.releaseSecondInputAck();
  await steer.delivered;
  await new Promise((resolve) => setImmediate(resolve));
  const resolvedAfterLateAcknowledgement = resolved;
  const settledAfterLateAcknowledgement = [...settled];
  const capabilityAfterLateAcknowledgement = runner.getSteerCapability(sessionId);

  sdk.emitTerminalStream();
  await new Promise((resolve) => setTimeout(resolve, 30));

  if (!resolved) runner.stopSession(sessionId);
  await run;
  assert.equal(capabilityAtTerminalBoundary, 'open-local');
  assert.equal(resolvedAfterLateAcknowledgement, false);
  assert.deepEqual(settledAfterLateAcknowledgement, []);
  assert.equal(capabilityAfterLateAcknowledgement, 'open-local');
  assert.deepEqual(settled, ['steer-late-ack']);
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
});

test('nested and non-end-turn streaming deltas are not local input boundaries', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness({
    sdkOptions: { resultAfterInputClose: true },
  });
  let resolved = false;
  const run = runner.startSession(sessionId, 'initial task').then(() => {
    resolved = true;
  });
  await sdk.waitForInputCount(1);

  sdk.emitTerminalStream('end_turn', 'nested-tool-use-id');
  sdk.emitTerminalStream('tool_use');
  await new Promise((resolve) => setImmediate(resolve));
  const resolvedAfterNestedBoundary = resolved;
  const capabilityAfterNestedBoundary = runner.getSteerCapability(sessionId);

  sdk.emitTerminalStream();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const resolvedFromTopLevelBoundary = resolved;
  if (!resolved) runner.stopSession(sessionId);
  await run;
  assert.equal(resolvedAfterNestedBoundary, false);
  assert.equal(capabilityAfterNestedBoundary, 'open-local');
  assert.equal(resolvedFromTopLevelBoundary, true);
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
});

test('result after a top-level terminal assistant boundary does not settle another input', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness({
    sdkOptions: { resultAfterInputClose: true },
  });
  const settled = [];
  runner.on('steerSettled', (_sessionId, submissionId) => settled.push(submissionId));
  let resolved = false;
  const run = runner.startSession(sessionId, 'initial task').then(() => {
    resolved = true;
  });
  await sdk.waitForInputCount(1);
  const steer = runner.trySubmitSteer(sessionId, 'steer-after-result', 'wait for my own boundary');
  assert.equal(steer.accepted, true);
  await steer.delivered;
  await sdk.waitForInputCount(2);

  sdk.emitTerminalStream();
  await new Promise((resolve) => setImmediate(resolve));
  sdk.emitResult('query-level-result');
  await new Promise((resolve) => setImmediate(resolve));
  const resolvedAfterResult = resolved;
  const settledAfterResult = [...settled];

  sdk.emitTerminalStream();
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (!resolved) runner.stopSession(sessionId);
  await run;
  assert.equal(resolvedAfterResult, false);
  assert.deepEqual(settledAfterResult, []);
  assert.deepEqual(settled, ['steer-after-result']);
});

test('result consumes one assistant credit before a later result-only steer settles', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness();
  const settled = [];
  runner.on('steerSettled', (_sessionId, submissionId) => settled.push(submissionId));
  runner.on('error', () => undefined);
  let resolved = false;
  const run = runner.startSession(sessionId, 'initial task').then(() => {
    resolved = true;
  });
  await sdk.waitForInputCount(1);
  const steer = runner.trySubmitSteer(sessionId, 'steer-result-only', 'settle from result fallback');
  assert.equal(steer.accepted, true);
  await steer.delivered;
  await sdk.waitForInputCount(2);

  sdk.emitTerminalStream();
  await new Promise((resolve) => setImmediate(resolve));
  sdk.emitResult('initial-result');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.deepEqual(settled, []);

  sdk.emitResult({ subtype: 'error', error: 'steer failed without assistant boundary' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const resolvedFromResultFallback = resolved;
  if (!resolved) runner.stopSession(sessionId);
  await run;
  assert.equal(resolvedFromResultFallback, true);
  assert.deepEqual(settled, ['steer-result-only']);
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
});

test('high-level assistant end turn does not double count a streaming boundary', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness({
    sdkOptions: { resultAfterInputClose: true },
  });
  const settled = [];
  runner.on('steerSettled', (_sessionId, submissionId) => settled.push(submissionId));
  let resolved = false;
  const run = runner.startSession(sessionId, 'initial task').then(() => {
    resolved = true;
  });
  await sdk.waitForInputCount(1);
  const steer = runner.trySubmitSteer(sessionId, 'steer-dual-provider', 'avoid duplicate settlement');
  assert.equal(steer.accepted, true);
  await steer.delivered;
  await sdk.waitForInputCount(2);

  sdk.emitTerminalStream();
  sdk.emitTerminalAssistant();
  sdk.emitResult('initial-result');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.deepEqual(settled, []);

  sdk.emitTerminalStream();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const resolvedFromSecondStreamingBoundary = resolved;
  if (!resolved) runner.stopSession(sessionId);
  await run;
  assert.equal(resolvedFromSecondStreamingBoundary, true);
  assert.deepEqual(settled, ['steer-dual-provider']);
});

test('generic runtime failure rejects an unacknowledged steer and allows explicit UUID retry', async () => {
  const { runner, sdk, store, sessionId } = createRunnerHarness({
    sdkOptions: { pauseBeforeSecondAck: true },
  });
  runner.on('error', () => undefined);
  const controller = new CoworkTurnSubmissionController({
    store,
    runner,
    emitMessage: () => undefined,
    emitMessageUpdate: () => undefined,
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const run = runner.startSession(sessionId, 'initial task');
    await sdk.waitForInputCount(1);
    const submissionId = '22222222-2222-4222-8222-222222222222';
    const submitted = controller.submit({ sessionId, submissionId, text: 'pending correction' });
    await sdk.waitForInputCount(2);
    sdk.failQuery(new Error('generic provider failure before delivery ack'));

    const outcome = await Promise.race([
      submitted,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    sdk.releaseSecondInputAck();
    await run;
    if (outcome === 'timeout') await submitted;
    await new Promise((resolve) => setImmediate(resolve));

    assert.notEqual(outcome, 'timeout');
    assert.equal(outcome.success, false);
    assert.equal(outcome.code, 'delivery_failed');
    assert.equal(store.getMessageById(sessionId, submissionId).metadata.steerStatus, 'failed');

    runner.continueSession = async () => undefined;
    const retried = await controller.submit({ sessionId, submissionId, text: 'pending correction' });
    assert.equal(retried.success, true);
    assert.equal(retried.mode, 'continue');
    assert.deepEqual(unhandled, []);
  } finally {
    controller.dispose();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('generic runtime failure marks a delivered but unsettled steer failed', async () => {
  const { runner, sdk, store, sessionId } = createRunnerHarness();
  runner.on('error', () => undefined);
  const controller = new CoworkTurnSubmissionController({
    store,
    runner,
    emitMessage: () => undefined,
    emitMessageUpdate: () => undefined,
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const run = runner.startSession(sessionId, 'initial task');
    await sdk.waitForInputCount(1);
    const submissionId = '33333333-3333-4333-8333-333333333333';
    const delivered = await controller.submit({ sessionId, submissionId, text: 'delivered correction' });
    assert.equal(delivered.success, true);
    assert.equal(store.getMessageById(sessionId, submissionId).metadata.steerStatus, 'delivered');

    sdk.failQuery(new Error('generic provider failure after delivery'));
    await run;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(store.getMessageById(sessionId, submissionId).metadata.steerStatus, 'failed');
    assert.deepEqual(unhandled, []);
  } finally {
    controller.dispose();
    process.off('unhandledRejection', onUnhandled);
  }
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

test('Stop cancels in-flight and queued controller steers within a bounded time', async () => {
  const { runner, sdk, store, sessionId } = createRunnerHarness({
    sdkOptions: { pauseBeforeSecondAck: true },
  });
  const controller = new CoworkTurnSubmissionController({
    store,
    runner,
    emitMessage: () => undefined,
    emitMessageUpdate: () => undefined,
  });
  const cancelledIds = [];
  runner.on('steerCancelled', (_sessionId, submissionId) => cancelledIds.push(submissionId));
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const run = runner.startSession(sessionId, 'initial task');
    await sdk.waitForInputCount(1);
    const inFlightId = '44444444-4444-4444-8444-444444444444';
    const queuedId = '55555555-5555-4555-8555-555555555555';
    const inFlight = controller.submit({ sessionId, submissionId: inFlightId, text: 'in-flight correction' });
    await sdk.waitForInputCount(2);
    const queued = controller.submit({ sessionId, submissionId: queuedId, text: 'queued correction' });

    runner.stopSession(sessionId);
    const outcome = await Promise.race([
      Promise.all([inFlight, queued]),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    sdk.releaseSecondInputAck();
    await run;
    await new Promise((resolve) => setImmediate(resolve));

    assert.notEqual(outcome, 'timeout');
    assert.deepEqual(outcome.map((result) => ({ success: result.success, code: result.code })), [
      { success: false, code: 'cancelled' },
      { success: false, code: 'cancelled' },
    ]);
    assert.deepEqual(cancelledIds, [inFlightId, queuedId]);
    for (const submissionId of [inFlightId, queuedId]) {
      const metadata = store.getMessageById(sessionId, submissionId).metadata;
      assert.equal(metadata.steerStatus, 'cancelled');
      assert.equal(metadata.submissionResult, 'failed');
      assert.equal(metadata.submissionErrorCode, 'cancelled');
      const cancelledAt = metadata.steerCancelledAt;
      runner.emit('steerFailed', sessionId, submissionId, 'late provider failure');
      runner.emit('steerSettled', sessionId, submissionId);
      assert.equal(metadata.steerStatus, 'cancelled');
      assert.equal(metadata.steerCancelledAt, cancelledAt);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    controller.dispose();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('Stop preserves a delivered but unsettled runner steer', async () => {
  const { runner, sdk, store, sessionId } = createRunnerHarness();
  const controller = new CoworkTurnSubmissionController({
    store,
    runner,
    emitMessage: () => undefined,
    emitMessageUpdate: () => undefined,
  });
  const cancelledIds = [];
  runner.on('steerCancelled', (_sessionId, submissionId) => cancelledIds.push(submissionId));
  try {
    const run = runner.startSession(sessionId, 'initial task');
    await sdk.waitForInputCount(1);
    const submissionId = '66666666-6666-4666-8666-666666666666';
    const delivered = await controller.submit({ sessionId, submissionId, text: 'delivered correction' });
    assert.equal(delivered.success, true);
    assert.equal(store.getMessageById(sessionId, submissionId).metadata.steerStatus, 'delivered');

    runner.stopSession(sessionId);
    await run;

    const metadata = store.getMessageById(sessionId, submissionId).metadata;
    assert.equal(metadata.steerStatus, 'delivered');
    assert.equal(metadata.submissionResult, 'completed');
    assert.equal(metadata.submissionErrorCode, undefined);
    assert.deepEqual(cancelledIds, []);
  } finally {
    controller.dispose();
  }
});

test('Stop while controller waits for a closing local turn cancels without restarting Continue', async () => {
  const { runner, sdk, store, sessionId } = createRunnerHarness();
  const controller = new CoworkTurnSubmissionController({
    store,
    runner,
    emitMessage: () => undefined,
    emitMessageUpdate: () => undefined,
  });
  let continueCalls = 0;
  runner.continueSession = async () => { continueCalls += 1; };
  try {
    const run = runner.startSession(sessionId, 'initial task');
    await sdk.waitForInputCount(1);
    runner.activeSessions.get(sessionId).localTurnState = 'closing';
    const submissionId = '77777777-7777-4777-8777-777777777777';
    const pending = controller.submit({ sessionId, submissionId, text: 'closing correction' });
    await Promise.resolve();

    assert.equal(runner.wasSessionStopped(sessionId), false);
    runner.stopSession(sessionId);
    assert.equal(runner.wasSessionStopped(sessionId), true);
    const result = await pending;
    await run;

    assert.equal(result.success, false);
    assert.equal(result.code, 'cancelled');
    assert.equal(continueCalls, 0);
    const metadata = store.getMessageById(sessionId, submissionId).metadata;
    assert.equal(metadata.steerStatus, 'cancelled');
    assert.equal(metadata.submissionResult, 'failed');
    assert.equal(metadata.submissionErrorCode, 'cancelled');
  } finally {
    controller.dispose();
  }
});

test('reports sandbox only for an active sandbox turn and inactive for a retained idle VM', { skip: !hasSteerApi }, () => {
  const { runner, sessionId } = createRunnerHarness({ session: { executionMode: 'sandbox' } });
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
  runner.activeSessions.set(sessionId, { executionMode: 'sandbox', localTurnState: 'open' });
  assert.equal(runner.getSteerCapability(sessionId), 'sandbox');
  assert.deepEqual(
    runner.trySubmitSteer(sessionId, 'steer-1', 'not supported'),
    { accepted: false, reason: 'sandbox' },
  );

  runner.activeSessions.get(sessionId).localTurnState = 'none';
  assert.equal(runner.getSteerCapability(sessionId), 'inactive');
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
