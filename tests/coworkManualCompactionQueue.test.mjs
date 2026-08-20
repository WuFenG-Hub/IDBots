import test from 'node:test';
import assert from 'node:assert/strict';
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

class FakeCoworkStore {
  constructor() {
    this.sessions = new Map();
    this.messageSeq = 0;
    this.usageStats = new Map();
  }

  createSession(id, overrides = {}) {
    const session = {
      id,
      title: overrides.title ?? id,
      claudeSessionId: overrides.claudeSessionId ?? null,
      status: overrides.status ?? 'idle',
      pinned: overrides.pinned ?? false,
      cwd: overrides.cwd ?? process.cwd(),
      systemPrompt: overrides.systemPrompt ?? '',
      executionMode: overrides.executionMode ?? 'local',
      activeSkillIds: overrides.activeSkillIds ?? [],
      messages: [...(overrides.messages ?? [])],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      metabotId: overrides.metabotId ?? 1,
      sessionType: overrides.sessionType ?? 'standard',
      peerGlobalMetaId: overrides.peerGlobalMetaId ?? null,
      peerName: overrides.peerName ?? null,
      hiddenFromSessionList: overrides.hiddenFromSessionList ?? false,
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

  getSessionLatestMessage(id) {
    const session = this.getSession(id);
    return session?.messages.at(-1) ?? null;
  }

  getSessionLatestVisibleMessage(id) {
    return this.getSessionLatestMessage(id);
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
    session.updatedAt = stored.timestamp;
    return stored;
  }

  updateSession(id, patch) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    Object.assign(session, patch);
  }

  getConfig() {
    return {
      workingDirectory: process.cwd(),
      systemPrompt: '',
      executionMode: 'local',
      memoryEnabled: false,
      memoryImplicitUpdateEnabled: false,
      memoryLlmJudgeEnabled: false,
      memoryGuardLevel: 'strict',
      memoryUserMemoriesMaxItems: 12,
    };
  }

  getSessionUsageStats(id) {
    return this.usageStats.get(id) ?? null;
  }

  setSessionUsageStats(id, stats) {
    this.usageStats.set(id, stats);
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
    };
  }
}

test('requestManualCompaction queues for an idle local session (no activeSession in memory)', async () => {
  const store = new FakeCoworkStore();
  const session = store.createSession('idle-1', {
    messages: [
      { id: 'm1', type: 'user', content: 'hello', timestamp: 1 },
      { id: 'm2', type: 'assistant', content: 'hi', timestamp: 2 },
    ],
  });
  const runner = new CoworkRunner(store);

  const result = await runner.requestManualCompaction('idle-1');
  assert.equal(result.success, true);
  // The idle queue entry exists and the session got the notice system message.
  assert.equal(runner.pendingManualCompactSessions.has('idle-1'), true);
  const lastMessage = store.getSession('idle-1').messages.at(-1);
  assert.equal(lastMessage.type, 'system');
  assert.match(lastMessage.content, /已请求手动压缩历史/);

  // Duplicate request is rejected while still queued.
  const duplicate = await runner.requestManualCompaction('idle-1');
  assert.equal(duplicate.success, false);
  assert.match(duplicate.error, /already queued/);
});

test('requestManualCompaction rejects unknown sessions; sandbox is coerced to local', async () => {
  const store = new FakeCoworkStore();
  store.createSession('sandbox-1', {
    executionMode: 'sandbox',
    messages: [
      { id: 'm1', type: 'user', content: 'hello', timestamp: 1 },
    ],
  });
  const runner = new CoworkRunner(store);

  const missing = await runner.requestManualCompaction('nope');
  assert.equal(missing.success, false);
  assert.match(missing.error, /Session is not active/);

  const sandbox = await runner.requestManualCompaction('sandbox-1');
  assert.equal(sandbox.success, true);
  assert.equal(runner.pendingManualCompactSessions.has('sandbox-1'), true);
});

test('requestManualCompaction on a DSH session calls native compactNow and does not queue', async () => {
  const store = new FakeCoworkStore();
  store.createSession('dsh-1', {
    claudeSessionId: 'dsh:cw-dsh-1',
    messages: [
      { id: 'm1', type: 'user', content: 'hello', timestamp: 1 },
      { id: 'm2', type: 'assistant', content: 'hi', timestamp: 2 },
    ],
  });
  const runner = new CoworkRunner(store);

  const withoutHub = await runner.requestManualCompaction('dsh-1');
  assert.equal(withoutHub.success, false);
  assert.match(withoutHub.error, /Send a message first/);
  assert.equal(runner.pendingManualCompactSessions.has('dsh-1'), false);

  let compactCalls = 0;
  runner.dshTurnHub = {
    compact: async (sessionId) => {
      compactCalls += 1;
      assert.equal(sessionId, 'dsh-1');
      return { ok: true, compacted: true, shadowedItemCount: 2, shadowedTokenCount: 40 };
    },
  };
  const compacted = await runner.requestManualCompaction('dsh-1');
  assert.equal(compacted.success, true);
  assert.equal(compactCalls, 1);
  assert.equal(runner.pendingManualCompactSessions.has('dsh-1'), false);
  const last = store.getSession('dsh-1').messages.at(-1);
  assert.equal(last.type, 'assistant');

  runner.dshTurnHub = {
    compact: async () => ({ ok: false, code: 'busy', message: 'agent is not idle' }),
  };
  const busy = await runner.requestManualCompaction('dsh-1');
  assert.equal(busy.success, false);
  assert.match(busy.error, /Wait for the current turn/);
});

test('requestManualCompaction rejects sessions without compressible history', async () => {
  const store = new FakeCoworkStore();
  store.createSession('empty-1', { messages: [] });
  const runner = new CoworkRunner(store);

  const result = await runner.requestManualCompaction('empty-1');
  assert.equal(result.success, false);
  assert.match(result.error, /No conversation history to compact yet/);
});

test('real context usage snapshot persists and stays readable after the active session is gone', async () => {
  const store = new FakeCoworkStore();
  store.createSession('usage-1', {
    messages: [
      { id: 'm1', type: 'user', content: 'hello', timestamp: 1 },
    ],
  });
  const runner = new CoworkRunner(store);
  // White-box: drive the private capture path directly (the end_turn boundary
  // calls this method with the live SDK Query object).
  const activeSession = { realContextUsage: undefined };
  await runner['captureRealContextUsageFromSdk']('usage-1', activeSession, {
    getContextUsage: async () => ({
      totalTokens: 123_456,
      maxTokens: 1_000_000,
      categories: [{ name: 'messages', tokens: 120_000, color: '#fff' }],
    }),
  });

  assert.equal(activeSession.realContextUsage.usedTokens, 123_456);
  assert.equal(activeSession.realContextUsage.isRealUsage, true);
  // Simulate turn-end cleanup: the active session is dropped, but the
  // persisted snapshot keeps the ring truthful.
  const persisted = runner.getRealContextUsage('usage-1');
  assert.equal(persisted.usedTokens, 123_456);
  assert.equal(persisted.contextWindow, 1_000_000);
  assert.equal(persisted.categories[0].tokens, 120_000);
});

test('captureRealContextUsageFromSdk tolerates SDK failures without throwing', async () => {
  const store = new FakeCoworkStore();
  store.createSession('usage-2', { messages: [] });
  const runner = new CoworkRunner(store);
  const activeSession = { realContextUsage: undefined };

  await runner['captureRealContextUsageFromSdk']('usage-2', activeSession, {
    getContextUsage: async () => {
      throw new Error('ProcessTransport is not ready for writing');
    },
  });
  assert.equal(activeSession.realContextUsage, undefined);
  assert.equal(runner.getRealContextUsage('usage-2'), null);
});
