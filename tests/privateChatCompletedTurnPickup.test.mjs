/**
 * Regression tests for the A2A "reply completed but never sent" bug.
 *
 * Background: a private-chat skill turn that outlives the daemon's watchdog
 * keeps running inside CoworkRunner and eventually persists its final
 * assistant message into the session — but the daemon already detached, so
 * the reply stayed a local-only "internal status" bubble and the peer never
 * received it. The fixes under test:
 *
 * - findDeliverableCompletedTurnReply: recover a completed-but-undelivered
 *   reply from the session instead of re-running the LLM turn (or dropping
 *   the row as stale).
 * - shouldDeferForBusyRunnerSession: never start a concurrent turn on a
 *   session whose previous turn is still running (CoworkRunner.startSession
 *   has no active-turn guard; a second start clobbers the first turn).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let findDeliverableCompletedTurnReply;
let shouldDeferForBusyRunnerSession;
try {
  ({
    findDeliverableCompletedTurnReply,
    shouldDeferForBusyRunnerSession,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    findDeliverableCompletedTurnReply,
    shouldDeferForBusyRunnerSession,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
}

const TRIGGER_ID = 'msg-trigger';

function createSessionWithMessages(messages) {
  const session = { id: 'session-1', messages };
  return {
    session,
    coworkStore: {
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
    },
  };
}

function userMessage(id, metadata = {}) {
  return {
    id,
    type: 'user',
    content: 'peer question',
    metadata: { sourceChannel: 'metaweb_private', direction: 'incoming', ...metadata },
  };
}

function assistantMessage(id, content, metadata = {}) {
  return { id, type: 'assistant', content, metadata: { isStreaming: false, isFinal: true, ...metadata } };
}

function thinkingMessage(id) {
  return assistantMessage(id, 'chain of thought', { isThinking: true });
}

const trigger = () => userMessage(TRIGGER_ID, { pinId: 'trigger-pin' });

test('pickup returns the final assistant reply written after the trigger', () => {
  const { coworkStore } = createSessionWithMessages([
    trigger(),
    thinkingMessage('msg-thinking'),
    { id: 'msg-tool', type: 'tool_use', content: '', metadata: {} },
    { id: 'msg-tool-result', type: 'tool_result', content: 'result', metadata: {} },
    assistantMessage('msg-reply', '  the real answer  '),
  ]);
  const picked = findDeliverableCompletedTurnReply({
    coworkStore,
    sessionId: 'session-1',
    triggerMessageId: TRIGGER_ID,
  });
  assert.deepEqual(picked, { replyText: 'the real answer', assistantMessageId: 'msg-reply' });
});

test('pickup returns null when the turn only produced thinking blocks', () => {
  const { coworkStore } = createSessionWithMessages([
    trigger(),
    thinkingMessage('msg-thinking'),
  ]);
  assert.equal(findDeliverableCompletedTurnReply({
    coworkStore,
    sessionId: 'session-1',
    triggerMessageId: TRIGGER_ID,
  }), null);
});

test('pickup returns null when the last text is followed by more tool activity', () => {
  const { coworkStore } = createSessionWithMessages([
    trigger(),
    assistantMessage('msg-progress', 'working on it…'),
    { id: 'msg-tool', type: 'tool_use', content: '', metadata: {} },
  ]);
  assert.equal(findDeliverableCompletedTurnReply({
    coworkStore,
    sessionId: 'session-1',
    triggerMessageId: TRIGGER_ID,
  }), null);
});

test('pickup skips assistant bubbles that were already delivered on-chain', () => {
  const { coworkStore } = createSessionWithMessages([
    trigger(),
    assistantMessage('msg-sent', 'already sent', {
      direction: 'outgoing',
      txid: 'a'.repeat(64),
      privateChatDeliveryStatus: 'sent',
    }),
  ]);
  assert.equal(findDeliverableCompletedTurnReply({
    coworkStore,
    sessionId: 'session-1',
    triggerMessageId: TRIGGER_ID,
  }), null);
});

test('pickup re-delivers a bubble whose broadcast previously failed', () => {
  const { coworkStore } = createSessionWithMessages([
    trigger(),
    assistantMessage('msg-failed', 'retry this answer', {
      direction: 'outgoing',
      privateChatDeliveryStatus: 'failed',
      privateChatDeliveryError: 'boom',
    }),
  ]);
  const picked = findDeliverableCompletedTurnReply({
    coworkStore,
    sessionId: 'session-1',
    triggerMessageId: TRIGGER_ID,
  });
  assert.deepEqual(picked, { replyText: 'retry this answer', assistantMessageId: 'msg-failed' });
});

test('pickup does not cross into a newer inbound turn', () => {
  const { coworkStore } = createSessionWithMessages([
    trigger(),
    thinkingMessage('msg-thinking'),
    userMessage('msg-newer-inbound', { pinId: 'newer-pin' }),
    assistantMessage('msg-later-reply', 'answer for the newer message'),
  ]);
  assert.equal(findDeliverableCompletedTurnReply({
    coworkStore,
    sessionId: 'session-1',
    triggerMessageId: TRIGGER_ID,
  }), null);
});

test('pickup returns null when the trigger message is not in the session', () => {
  const { coworkStore } = createSessionWithMessages([
    assistantMessage('msg-reply', 'orphan'),
  ]);
  assert.equal(findDeliverableCompletedTurnReply({
    coworkStore,
    sessionId: 'session-1',
    triggerMessageId: TRIGGER_ID,
  }), null);
});

test('pickup returns null for an unknown session', () => {
  const { coworkStore } = createSessionWithMessages([trigger()]);
  assert.equal(findDeliverableCompletedTurnReply({
    coworkStore,
    sessionId: 'session-other',
    triggerMessageId: TRIGGER_ID,
  }), null);
});

test('busy deferral is off without a runner activity probe or when idle', () => {
  const logs = [];
  const log = (message) => logs.push(message);
  assert.equal(shouldDeferForBusyRunnerSession(undefined, 'session-1', log), false);
  assert.equal(shouldDeferForBusyRunnerSession(() => false, 'session-1', log), false);
  assert.equal(logs.length, 0);
});

test('busy deferral holds while the session turn is active, then releases when idle', () => {
  const log = () => {};
  let active = true;
  const probe = () => active;
  assert.equal(shouldDeferForBusyRunnerSession(probe, 'session-2', log), true);
  assert.equal(shouldDeferForBusyRunnerSession(probe, 'session-2', log), true);
  active = false;
  assert.equal(shouldDeferForBusyRunnerSession(probe, 'session-2', log), false);
  // Once released, a new active turn starts a fresh deferral window.
  active = true;
  assert.equal(shouldDeferForBusyRunnerSession(probe, 'session-2', log), true);
});

test('busy deferral falls through once the cap is exceeded so a wedged turn cannot mute a conversation', () => {
  const logs = [];
  const log = (message) => logs.push(message);
  const probe = () => true;
  const start = 1_000_000;
  assert.equal(shouldDeferForBusyRunnerSession(probe, 'session-3', log, start), true);
  const withinCap = start + 44 * 60_000;
  assert.equal(shouldDeferForBusyRunnerSession(probe, 'session-3', log, withinCap), true);
  const beyondCap = start + 46 * 60_000;
  assert.equal(shouldDeferForBusyRunnerSession(probe, 'session-3', log, beyondCap), false);
  assert.ok(logs.some((message) => message.includes('stayed active')));
  // After the fall-through the next busy sighting starts a new window.
  assert.equal(shouldDeferForBusyRunnerSession(probe, 'session-3', log, beyondCap + 1000), true);
});
