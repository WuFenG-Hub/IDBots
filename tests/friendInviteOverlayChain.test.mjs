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
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'friend-invite-overlay-chain-test-user-data'),
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
  claimManagedOrchestratorSession,
} = loadCompiledModule('../dist-electron/main/services/orchestratorPermissionRelay.js');

/**
 * Real-device defect regression suite (2026-10-30 S6 final verification):
 * the A2A private-chat friend invite's owner authorization never showed its
 * overlay card and resolved as "not authorized" without any owner click.
 *
 * Root cause: the A2A conversation session is claimed as
 * orchestrator-managed the first time the private-chat daemon routes a
 * reply through the chat-skills turn path
 * (runPrivateChatSkillTurn → runSkillTurnInExistingSession →
 * claimManagedOrchestratorSession). From then on, the orchestrator
 * permission relay treated EVERY permissionRequest of that session as a
 * turn-scoped 60s text confirmation: it posted a system message (hidden in
 * the A2A view) and auto-denied after the relay timeout — including
 * requestSuspendedApproval prompts, which are owner-gated SUSPENDED waits
 * with no watchdog by design. The deny resolved the daemon's pending
 * approval, and the runner's permissionResolved dequeue removed the
 * overlay card the owner was supposed to click.
 *
 * These tests drive the REAL compiled CoworkRunner + relay module so the
 * emit → relay → resolve chain is exercised exactly as in the app.
 */

class RecordingStore {
  constructor() {
    this.messages = [];
    this.sessionUpdates = [];
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
  updateSession(sessionId, patch) {
    this.sessionUpdates.push({ sessionId, patch });
  }
}

const RELAY_TIMEOUT_MS = 60;
const WAIT_PAST_RELAY_TIMEOUT_MS = 200;

const makeHarness = () => {
  const store = new RecordingStore();
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0 });
  const responses = [];
  const originalRespond = runner.respondToPermission.bind(runner);
  runner.respondToPermission = (requestId, result) => {
    responses.push({ requestId, result });
    return originalRespond(requestId, result);
  };
  return { store, runner, responses };
};

const INVITE_QUESTION = '机器人「瑞幸店员」请求与「AI_Sunny」互加好友：授权后将用该机器人的钱包写链 /follow（contentBody=对方 GlobalMetaID，链上公开且不可撤销）。是否授权？';

/** requestSuspendedApproval + captured request id, mirroring the daemon bridge. */
const startSuspendedApproval = (runner, sessionId, question = INVITE_QUESTION) => {
  let captured = null;
  const onRequest = (sid, request) => {
    if (sid === sessionId) captured = request;
  };
  runner.on('permissionRequest', onRequest);
  const outcome = runner.requestSuspendedApproval({ sessionId, header: '好友确认', question });
  return { outcome, getCaptured: () => captured };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('suspended friend-invite approval survives the relay timeout on a claimed session', async () => {
  const { store, runner, responses } = makeHarness();
  const sessionId = 'sess-a2a-luckin';
  claimManagedOrchestratorSession(runner, sessionId, store, { timeoutMs: RELAY_TIMEOUT_MS });

  const { outcome, getCaptured } = startSuspendedApproval(runner, sessionId);
  await sleep(WAIT_PAST_RELAY_TIMEOUT_MS);

  const request = getCaptured();
  assert.ok(request, 'permissionRequest emitted for the A2A session');
  assert.equal(request.toolName, 'AskUserQuestion');
  assert.equal(runner.isPermissionPending(request.requestId), true, 'approval must still be pending after the relay timeout');
  assert.equal(runner.isPermissionSuspended(request.requestId), true, 'approval must be recognized as suspended');
  const denyForInvite = responses.filter((entry) => entry.requestId === request.requestId && entry.result.behavior === 'deny');
  assert.equal(denyForInvite.length, 0, 'no auto-deny may resolve the suspended approval');
  assert.equal(store.messages.length, 0, 'relay must not post its invisible 60s system prompt for a suspended approval');

  // The owner clicks allow much later — the approval still resolves approved.
  const allowOption = request.toolInput.questions[0].options[0].label;
  runner.respondToPermission(request.requestId, {
    behavior: 'allow',
    updatedInput: { ...request.toolInput, answers: { [request.toolInput.questions[0].question]: allowOption } },
  });
  assert.equal(await outcome, 'approved');
  assert.equal(runner.isPermissionPending(request.requestId), false);
});

test('explicit owner deny resolves the suspended approval as denied', async () => {
  const { store, runner } = makeHarness();
  const sessionId = 'sess-a2a-deny';
  claimManagedOrchestratorSession(runner, sessionId, store, { timeoutMs: RELAY_TIMEOUT_MS });

  const { outcome, getCaptured } = startSuspendedApproval(runner, sessionId);
  await sleep(WAIT_PAST_RELAY_TIMEOUT_MS);
  runner.respondToPermission(getCaptured().requestId, { behavior: 'deny', message: 'Permission denied' });
  assert.equal(await outcome, 'denied');
});

test('turn-scoped prompts on a claimed session keep the relay auto-deny (regression guard)', async () => {
  const { store, runner, responses } = makeHarness();
  const sessionId = 'sess-worker-turn';
  claimManagedOrchestratorSession(runner, sessionId, store, { timeoutMs: RELAY_TIMEOUT_MS });

  // A turn-scoped (watchdog-backed) prompt: not registered through the
  // runner's suspended path, exactly like the relay sees mid-turn prompts.
  runner.emit('permissionRequest', sessionId, {
    requestId: 'req-turn-scoped',
    toolName: 'Bash',
    toolInput: { command: 'rm -rf ./dist', description: 'Clean build output' },
  });

  assert.equal(store.messages.length, 1, 'relay posts its text confirmation into the transcript');
  assert.equal(store.messages[0].type, 'system');
  await sleep(WAIT_PAST_RELAY_TIMEOUT_MS);

  const deny = responses.find((entry) => entry.requestId === 'req-turn-scoped');
  assert.ok(deny, 'relay auto-denies the unanswered turn-scoped prompt');
  assert.equal(deny.result.behavior, 'deny');
});

test('a newer turn-scoped prompt does not supersede-deny a suspended approval', async () => {
  const { store, runner, responses } = makeHarness();
  const sessionId = 'sess-a2a-supersede';
  claimManagedOrchestratorSession(runner, sessionId, store, { timeoutMs: RELAY_TIMEOUT_MS });

  const { getCaptured } = startSuspendedApproval(runner, sessionId);
  await sleep(10);
  const suspendedId = getCaptured().requestId;

  // A second, turn-scoped prompt arrives for the same claimed session.
  runner.emit('permissionRequest', sessionId, {
    requestId: 'req-newer-turn',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  });
  await sleep(WAIT_PAST_RELAY_TIMEOUT_MS);

  const supersedeDeny = responses.find((entry) => entry.requestId === suspendedId);
  assert.equal(supersedeDeny, undefined, 'the suspended approval must never be superseded by a newer prompt');
  assert.equal(runner.isPermissionPending(suspendedId), true, 'suspended approval still pending');
});

test('session stop / teardown sweep leaves suspended approvals pending (owner-only resolution)', async () => {
  const { store, runner } = makeHarness();
  const sessionId = 'sess-a2a-stop';
  claimManagedOrchestratorSession(runner, sessionId, store, { timeoutMs: RELAY_TIMEOUT_MS });

  const { outcome, getCaptured } = startSuspendedApproval(runner, sessionId);
  await sleep(10);
  const suspendedId = getCaptured().requestId;

  // stopSession funnels through the same clearPendingPermissions sweep as
  // turn settlements (stall aborts, crashes, DSH shutdown). None of those
  // may resolve an owner-gated suspended approval.
  runner.stopSession(sessionId, { finalStatus: 'stopped', reason: 'test sweep' });
  assert.equal(runner.isPermissionPending(suspendedId), true, 'suspended approval survives the teardown sweep');

  runner.respondToPermission(suspendedId, { behavior: 'deny', message: 'Permission denied' });
  assert.equal(await outcome, 'denied');
});

test('main→renderer bridge gate forwards the suspended AskUserQuestion (delivery decision)', async () => {
  const { store, runner } = makeHarness();
  const sessionId = 'sess-a2a-bridge';

  // Replicates the main.ts permissionRequest bridge gate verbatim: text-mode
  // suppression requires confirmationMode==='text' AND a non-AskUserQuestion
  // tool AND a live text-relay owner. The suspended invite prompt must pass.
  const forwarded = [];
  runner.on('permissionRequest', (sid, request) => {
    const suppressed = runner.getSessionConfirmationMode(sid) === 'text'
      && request?.toolName !== 'AskUserQuestion'
      && runner.hasTextPermissionRelay(sid);
    if (!suppressed) forwarded.push({ sessionId: sid, request });
  });

  const { getCaptured } = startSuspendedApproval(runner, sessionId);
  await sleep(10);
  const request = getCaptured();

  assert.equal(forwarded.length, 1, 'the suspended invite prompt is broadcast to the renderer');
  assert.equal(forwarded[0].request.requestId, request.requestId);
  assert.equal(forwarded[0].request.toolName, 'AskUserQuestion');
  assert.ok(Array.isArray(request.toolInput.questions), 'AskUserQuestion payload carries its questions');
});
