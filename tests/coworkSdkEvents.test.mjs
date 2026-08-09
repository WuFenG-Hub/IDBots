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
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'cowork-sdk-events-test-user-data'),
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

class RecordingStore {
  constructor() {
    this.messages = [];
  }
  getSession() {
    return { messages: this.messages };
  }
  addMessage(_sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: 1_700_000_000_000, ...message };
    this.messages.push(stored);
    return stored;
  }
  getSessionUsageStats() {
    return null;
  }
}

const makeRunner = () => {
  const store = new RecordingStore();
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0 });
  // Minimal ActiveSession entry so handleClaudeEvent does not early-return.
  runner.activeSessions.set('s1', { sessionId: 's1', abortController: { signal: { aborted: false } } });
  return { store, runner };
};

const emit = (runner, event) => runner.handleClaudeEvent('s1', event);

test('notification is surfaced as a system message with priority', () => {
  const { store, runner } = makeRunner();
  emit(runner, { type: 'system', subtype: 'notification', key: 'k', text: 'Task done', priority: 'high' });
  assert.equal(store.messages.length, 1);
  assert.equal(store.messages[0].type, 'system');
  assert.equal(store.messages[0].content, 'Task done');
  assert.deepEqual(store.messages[0].metadata.sdkNotification, { key: 'k', priority: 'high' });
});

test('duplicate consecutive notifications are deduped', () => {
  const { store, runner } = makeRunner();
  const event = { type: 'system', subtype: 'notification', text: 'same', priority: 'low' };
  emit(runner, event);
  emit(runner, event);
  assert.equal(store.messages.length, 1);
});

test('informational is surfaced with its level', () => {
  const { store, runner } = makeRunner();
  emit(runner, { type: 'system', subtype: 'informational', content: 'Heads up', level: 'warning' });
  assert.equal(store.messages[0].content, 'Heads up');
  assert.deepEqual(store.messages[0].metadata.sdkInformational, { level: 'warning' });
});

test('compact_boundary is surfaced with token metadata', () => {
  const { store, runner } = makeRunner();
  emit(runner, {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 120_000, post_tokens: 40_000, duration_ms: 900 },
  });
  assert.equal(store.messages[0].content, '');
  assert.deepEqual(store.messages[0].metadata.sdkCompactBoundary, {
    trigger: 'auto',
    preTokens: 120_000,
    postTokens: 40_000,
    durationMs: 900,
  });
});

test('permission_denied is surfaced with tool + reason', () => {
  const { store, runner } = makeRunner();
  emit(runner, {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'tu-1',
    agent_id: 'agent-7',
    decision_reason_type: 'mode',
    decision_reason: 'plan mode blocks it',
    message: 'Bash is not allowed',
  });
  assert.equal(store.messages[0].content, 'Bash is not allowed');
  assert.deepEqual(store.messages[0].metadata.sdkPermissionDenied, {
    toolName: 'Bash',
    reason: 'plan mode blocks it',
    reasonType: 'mode',
    agentId: 'agent-7',
  });
});

test('conversation_reset is surfaced', () => {
  const { store, runner } = makeRunner();
  emit(runner, { type: 'conversation_reset', new_conversation_id: 'x', uuid: 'u', session_id: 's1' });
  assert.equal(store.messages[0].content, '');
  assert.equal(store.messages[0].metadata.sdkConversationReset, true);
});

test('rate_limit_event surfaces only actionable states', () => {
  const { store, runner } = makeRunner();
  emit(runner, {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', utilization: 0.2 },
    uuid: 'u',
    session_id: 's1',
  });
  assert.equal(store.messages.length, 0);

  emit(runner, {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', utilization: 0.97, rateLimitType: 'five_hour' },
    uuid: 'u',
    session_id: 's1',
  });
  assert.equal(store.messages.length, 1);
  assert.deepEqual(store.messages[0].metadata.sdkRateLimit, {
    status: 'rejected',
    utilization: 0.97,
    rateLimitType: 'five_hour',
  });
});

test('thinking_tokens feeds the usage stats estimate', () => {
  const { runner } = makeRunner();
  emit(runner, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1234, estimated_tokens_delta: 10, uuid: 'u', session_id: 's1' });
  const stats = runner.getSessionUsageStats('s1');
  assert.equal(stats, null); // no token usage yet, so no stats row

  // With usage present, the estimate is merged in.
  runner.usageStatsBySessionId.set('s1', {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    source: 'none',
  });
  const merged = runner.getSessionUsageStats('s1');
  assert.equal(merged.thinkingTokensEstimate, 1234);
});

test('session_state_changed and files_persisted stay log-only (no messages)', () => {
  const { store, runner } = makeRunner();
  emit(runner, { type: 'system', subtype: 'session_state_changed', state: 'requires_action', uuid: 'u', session_id: 's1' });
  emit(runner, { type: 'system', subtype: 'files_persisted', files: [{ filename: 'a', file_id: '1' }], failed: [], processed_at: 'x', uuid: 'u', session_id: 's1' });
  assert.equal(store.messages.length, 0);
});
