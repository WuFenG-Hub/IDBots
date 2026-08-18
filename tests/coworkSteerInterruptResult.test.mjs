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
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'cowork-steer-interrupt-test-user-data'),
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
const {
  isSdkInternalDiagnostic,
  filterSdkInternalDiagnostics,
  isSteerInterruptDiagnostic,
} = loadCompiledModule('../dist-electron/main/libs/coworkSdkResultDiagnostics.js');

// The exact diagnostic the Claude Code CLI emits when a runtime steer
// interrupts the in-flight turn (observed in cowork.log session
// 1a92e2fd-1505-4a73-ba21-14c9593631f3).
const STEER_INTERRUPT_DIAGNOSTIC =
  '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use';

class RecordingStore {
  constructor() {
    this.messages = [];
    this.sessionStatus = 'running';
  }
  getSession() {
    return { messages: this.messages };
  }
  addMessage(_sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: 1_700_000_000_000, ...message };
    this.messages.push(stored);
    return stored;
  }
  updateSession(_sessionId, updates) {
    if (typeof updates.status === 'string') this.sessionStatus = updates.status;
  }
  getSessionUsageStats() {
    return null;
  }
}

const makeRunner = (extraActiveSession) => {
  const store = new RecordingStore();
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0 });
  // handleError emits an 'error' event; without a listener EventEmitter
  // crashes the process on the genuinely-failed-result test below.
  runner.on('error', () => undefined);
  runner.activeSessions.set('s1', {
    sessionId: 's1',
    abortController: { signal: { aborted: false } },
    ...extraActiveSession,
  });
  return { store, runner };
};

test('helper classifies and filters CLI-internal ede_diagnostic entries', () => {
  assert.equal(isSdkInternalDiagnostic(STEER_INTERRUPT_DIAGNOSTIC), true);
  assert.equal(isSdkInternalDiagnostic('  [ede_diagnostic] turn aborted (canceled) stop_reason=max_turns'), true);
  assert.equal(isSdkInternalDiagnostic('API connection failed after 3 retries'), false);
  assert.equal(isSteerInterruptDiagnostic(STEER_INTERRUPT_DIAGNOSTIC), true);
  assert.equal(isSteerInterruptDiagnostic('API connection failed after 3 retries'), false);

  assert.deepEqual(
    filterSdkInternalDiagnostics([STEER_INTERRUPT_DIAGNOSTIC, 'Real provider error', '[ede_diagnostic] turn aborted (x)']),
    ['Real provider error']
  );
});

test('diagnostic-only error result is a benign steer boundary, not a session error', () => {
  const { store, runner } = makeRunner();
  // A delivered-but-unsettled steer so the acknowledgment can be attributed.
  runner.activeSessions.get('s1').localPendingSteerIds = ['steer-1'];
  runner.activeSessions.get('s1').localDeliveredSteerIds = new Set(['steer-1']);
  store.messages.push({
    id: 'steer-1',
    type: 'user',
    content: '改成生成天气海报',
    timestamp: 1_700_000_000_000,
  });

  runner.handleClaudeEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [STEER_INTERRUPT_DIAGNOSTIC],
    uuid: 'u',
    session_id: 's1',
  });

  // No `Error: ...` system message, and the session status was NOT flipped to error.
  assert.equal(store.sessionStatus, 'running');
  const errorMessages = store.messages.filter(
    (message) => message.type === 'system' && message.content.startsWith('Error:')
  );
  assert.equal(errorMessages.length, 0);

  // The steer is acknowledged in the timeline with its text.
  const ack = store.messages.find((message) => message.metadata?.steerInterruptAcknowledged === true);
  assert.ok(ack, 'expected a steer-acknowledgment system message');
  assert.equal(ack.metadata.steerText, '改成生成天气海报');
});

test('diagnostic-only result without an attributed steer still does not error', () => {
  const { store, runner } = makeRunner();
  runner.handleClaudeEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [STEER_INTERRUPT_DIAGNOSTIC],
    uuid: 'u',
    session_id: 's1',
  });

  assert.equal(store.sessionStatus, 'running');
  assert.equal(
    store.messages.filter((message) => message.type === 'system' && message.content.startsWith('Error:')).length,
    0
  );
});

test('real errors next to diagnostics are still surfaced', () => {
  const { store, runner } = makeRunner();
  runner.handleClaudeEvent('s1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [STEER_INTERRUPT_DIAGNOSTIC, 'Connection timed out after 60s'],
    uuid: 'u',
    session_id: 's1',
  });

  assert.equal(store.sessionStatus, 'error');
  const errorMessages = store.messages.filter(
    (message) => message.type === 'system' && message.content.startsWith('Error:')
  );
  assert.equal(errorMessages.length, 1);
  assert.equal(errorMessages[0].content, 'Error: Connection timed out after 60s');
  assert.ok(!errorMessages[0].content.includes('[ede_diagnostic]'), 'diagnostic must not leak into user-visible error');
});
