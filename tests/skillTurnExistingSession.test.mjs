/**
 * Existing-session skill-turn tests (runSkillTurnInExistingSession).
 *
 * Covers two group-task defects fixed in this PR:
 * - B3 reply truncation: a multi-block streamed reply must be assembled from
 *   ALL non-thinking assistant content blocks of the turn, not just the last
 *   one (group messages used to arrive truncated, losing the [DELIVERABLE]
 *   prefix).
 * - B2 watchdog misjudgment: with recovery callbacks the watchdog must reject
 *   with SkillTurnTimeoutError WITHOUT marking the session 'error', and a late
 *   completion must still be delivered via onLateCompletion (deep research
 *   turns routinely exceed the old fixed 300s cap; the old behavior marked
 *   sessions error and lost late deliveries).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runSkillTurnInExistingSession,
  SkillTurnTimeoutError,
} = require('../dist-electron/main/services/orchestratorCoworkBridge.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeExistingSessionFixtures(sessionId) {
  const runner = new EventEmitter();
  const session = { id: sessionId, messages: [] };
  const sessionPatches = [];
  const store = {
    getSession(targetSessionId) {
      assert.equal(targetSessionId, session.id);
      return session;
    },
    addMessage(targetSessionId, message) {
      assert.equal(targetSessionId, session.id);
      const record = {
        id: `message-${session.messages.length + 1}`,
        timestamp: Date.now(),
        ...message,
      };
      session.messages.push(record);
      return record;
    },
    updateSession(targetSessionId, patch) {
      assert.equal(targetSessionId, session.id);
      sessionPatches.push(patch);
    },
  };
  runner.startSession = async () => { /* session runs on its own; no auto-complete */ };
  return { runner, store, session, sessionPatches };
}

function runTurn(fixtures, params = {}) {
  const { runner, store, session } = fixtures;
  return runSkillTurnInExistingSession(runner, store, {
    sessionId: session.id,
    systemPrompt: 'system',
    userMessage: 'build the page',
    cwd: '/tmp/idbots-wt',
    ...params,
  });
}

// ---------------------------------------------------------------------------
// B3: multi-block reply assembly
// ---------------------------------------------------------------------------

test('existing-session: multi-block streamed reply is assembled in full (not last block only)', async () => {
  const { runner, store, session } = makeExistingSessionFixtures('session-multiblock');
  // Pre-existing context: one user message before the turn starts.
  store.addMessage(session.id, { type: 'user', content: 'build the page' });

  const resultPromise = runTurn({ runner, store, session });

  // The turn streams content in multiple blocks, interleaved with thinking.
  store.addMessage(session.id, { type: 'assistant', content: 'T2 实证 + T3 规格骨架已完成，交付如下。', metadata: { isStreaming: false } });
  store.addMessage(session.id, { type: 'assistant', content: 'thinking fragment', metadata: { isThinking: true, isStreaming: true } });
  store.addMessage(session.id, { type: 'assistant', content: '[DELIVERABLE] spec: /tmp/metapredict-v2-sdd-skeleton.md', metadata: { isStreaming: false, isFinal: true } });

  runner.emit('complete', session.id);

  const result = await resultPromise;
  assert.equal(
    result.replyText,
    'T2 实证 + T3 规格骨架已完成，交付如下。\n\n[DELIVERABLE] spec: /tmp/metapredict-v2-sdd-skeleton.md'
  );
  // assistantMessageId points at the LAST content block of the turn.
  assert.equal(result.assistantMessageId, session.messages[session.messages.length - 1].id);
});

test('existing-session: single-block reply stays unchanged', async () => {
  const { runner, store, session } = makeExistingSessionFixtures('session-singleblock');
  store.addMessage(session.id, { type: 'user', content: 'build the page' });

  const resultPromise = runTurn({ runner, store, session });
  store.addMessage(session.id, { type: 'assistant', content: 'done', metadata: { isStreaming: false } });
  runner.emit('complete', session.id);

  const result = await resultPromise;
  assert.equal(result.replyText, 'done');
});

// ---------------------------------------------------------------------------
// B2: watchdog + recovery on the existing-session path
// ---------------------------------------------------------------------------

test('existing-session: watchdog rejects with SkillTurnTimeoutError, session NOT error-marked, late completion delivered via onLateCompletion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session, sessionPatches } = makeExistingSessionFixtures('session-existing-late');
  const lateCompletions = [];
  const lateTerminations = [];

  const resultPromise = runTurn({ runner, store, session }, {
    skillTurnTimeoutMs: 300,
    lateCompletionTimeoutMs: 60_000,
    onLateCompletion: (late) => { lateCompletions.push(late); },
    onLateTermination: (late) => { lateTerminations.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(300); // watchdog fires

  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.name, 'SkillTurnTimeoutError');
    assert.equal(error.sessionId, 'session-existing-late');
    assert.match(error.message, /Skill turn timed out after/);
    return true;
  });

  // The session is still alive: it must NOT be marked 'error' at timeout.
  assert.equal(sessionPatches.some((patch) => patch.status === 'error'), false);

  // The worker keeps working and eventually completes with the full reply.
  store.addMessage(session.id, { type: 'assistant', content: 'Late handoff: done, tests green', metadata: { isStreaming: false } });
  runner.emit('complete', session.id);

  assert.deepEqual(lateCompletions, [{ sessionId: 'session-existing-late', replyText: 'Late handoff: done, tests green' }]);
  assert.equal(lateTerminations.length, 0);
});

test('existing-session: late session error after the watchdog settles via onLateTermination', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session, sessionPatches } = makeExistingSessionFixtures('session-existing-late-error');
  const lateTerminations = [];

  const resultPromise = runTurn({ runner, store, session }, {
    skillTurnTimeoutMs: 300,
    onLateTermination: (late) => { lateTerminations.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(300);
  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.name, 'SkillTurnTimeoutError');
    return true;
  });

  runner.emit('error', session.id, 'API quota exceeded');
  assert.deepEqual(lateTerminations, [{ sessionId: 'session-existing-late-error', reason: 'error', message: 'API quota exceeded' }]);
  // No session error patch from the watchdog itself.
  assert.equal(sessionPatches.some((patch) => patch.status === 'error'), false);
});

test('existing-session: watchdog without recovery callbacks keeps the legacy fail behavior (session error-marked)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session, sessionPatches } = makeExistingSessionFixtures('session-existing-legacy');

  const resultPromise = runTurn({ runner, store, session }, { skillTurnTimeoutMs: 300 });

  await Promise.resolve();
  t.mock.timers.tick(300);

  await assert.rejects(resultPromise, (error) => {
    assert.match(error.message, /Skill turn timed out after/);
    assert.notEqual(error.name, 'SkillTurnTimeoutError');
    return true;
  });
  // Legacy path still marks the session error so private-chat behavior is unchanged.
  assert.equal(sessionPatches.some((patch) => patch.status === 'error'), true);
});

test('existing-session: silent session abandons recovery via onRecoveryExpired after the window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runner, store, session } = makeExistingSessionFixtures('session-existing-expiry');
  const expiries = [];

  const resultPromise = runTurn({ runner, store, session }, {
    skillTurnTimeoutMs: 300,
    lateCompletionTimeoutMs: 600,
    onRecoveryExpired: (late) => { expiries.push(late); },
  });

  await Promise.resolve();
  t.mock.timers.tick(300);
  await assert.rejects(resultPromise, (error) => {
    assert.equal(error.name, 'SkillTurnTimeoutError');
    return true;
  });
  assert.equal(expiries.length, 0); // window has not expired yet

  t.mock.timers.tick(600); // recovery window expires
  assert.deepEqual(expiries, [{ sessionId: 'session-existing-expiry' }]);
});
