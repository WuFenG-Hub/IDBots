import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CoworkTurnSubmissionController } from '../dist-electron/main/services/coworkTurnSubmission.js';

const UUID = '11111111-1111-4111-8111-111111111111';

class FakeStore {
  constructor(sessionOverrides = {}) {
    this.session = {
      id: 'session-1',
      title: 'test',
      claudeSessionId: null,
      status: 'idle',
      pinned: false,
      cwd: process.cwd(),
      systemPrompt: '',
      executionMode: 'local',
      activeSkillIds: [],
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      sessionType: 'standard',
      ...sessionOverrides,
    };
  }

  getSession(id) {
    return this.session?.id === id ? this.session : null;
  }

  getMessageById(sessionId, messageId) {
    return this.getSession(sessionId)?.messages.find((message) => message.id === messageId) ?? null;
  }

  addMessageWithId(sessionId, id, input) {
    const existing = this.getMessageById(sessionId, id);
    if (existing) return existing;
    const message = { id, timestamp: Date.now(), ...input };
    this.getSession(sessionId).messages.push(message);
    return message;
  }

  updateMessage(sessionId, messageId, updates) {
    const message = this.getMessageById(sessionId, messageId);
    if (message) Object.assign(message, updates);
  }
}

class FakeRunner extends EventEmitter {
  constructor(capability) {
    super();
    this.capability = capability;
    this.steerCalls = [];
    this.continueCalls = [];
    this.waitCalls = 0;
    this.delivery = Promise.resolve();
    this.admissionAccepted = true;
    this.turnSettlement = Promise.resolve();
    this.continueDelivery = Promise.resolve();
    this.continueError = null;
    this.sessionStopped = false;
  }

  getSteerCapability() {
    return this.capability;
  }

  trySubmitSteer(sessionId, submissionId, text) {
    this.steerCalls.push({ sessionId, submissionId, text });
    if (!this.admissionAccepted) return { accepted: false, reason: 'closing' };
    return { accepted: true, delivered: this.delivery };
  }

  waitForActiveTurnSettlement(sessionId) {
    this.waitCalls += 1;
    this.waitedSessionId = sessionId;
    return this.turnSettlement;
  }

  wasSessionStopped() {
    return this.sessionStopped;
  }

  async continueSession(sessionId, text, options) {
    this.continueCalls.push({ sessionId, text, options });
    await this.continueDelivery;
    if (this.continueError) throw this.continueError;
  }
}

function createHarness({ capability = 'inactive', sessionOverrides, configureRunner, onEmitMessage } = {}) {
  const store = new FakeStore(sessionOverrides);
  const runner = new FakeRunner(capability);
  configureRunner?.(runner, store);
  const emitted = [];
  const updates = [];
  const controller = new CoworkTurnSubmissionController({
    store,
    runner,
    emitMessage: (sessionId, message) => {
      emitted.push({ sessionId, message });
      onEmitMessage?.(sessionId, message);
    },
    emitMessageUpdate: (sessionId, messageId, content, metadata) => {
      updates.push({ sessionId, messageId, content, metadata });
    },
  });
  return { store, runner, emitted, updates, controller };
}

function input(overrides = {}) {
  return { sessionId: 'session-1', submissionId: UUID, text: ' next direction ', ...overrides };
}

test('persists once and submits a trimmed live steer without applying turn configuration', async () => {
  const harness = createHarness({ capability: 'open-local' });
  const result = await harness.controller.submit(input({
    systemPrompt: 'must be ignored',
    activeSkillIds: ['ignored-skill'],
  }));

  assert.equal(result.success, true);
  assert.equal(result.mode, 'steer');
  assert.equal(result.message.content, 'next direction');
  assert.deepEqual(harness.runner.steerCalls, [{
    sessionId: 'session-1', submissionId: UUID, text: 'next direction',
  }]);
  assert.equal(harness.runner.continueCalls.length, 0);
  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.store.getMessageById('session-1', UUID).metadata.steerStatus, 'delivered');
  assert.equal(harness.store.getMessageById('session-1', UUID).metadata.submissionMode, 'steer');
});

test('inactive sessions continue once with the requested system prompt and skills', async () => {
  const harness = createHarness();
  const result = await harness.controller.submit(input({
    systemPrompt: 'ordinary continuation prompt',
    activeSkillIds: ['skill-a'],
  }));

  assert.equal(result.success, true);
  assert.equal(result.mode, 'continue');
  assert.deepEqual(harness.runner.continueCalls, [{
    sessionId: 'session-1',
    text: 'next direction',
    options: {
      skipUserMessage: true,
      systemPrompt: 'ordinary continuation prompt',
      skillIds: ['skill-a'],
    },
  }]);
  assert.equal(result.message.metadata.interactionKind, undefined);
  assert.equal(result.message.metadata.submissionMode, 'continue');
});

test('waits for the exact closing turn then continues exactly once', async () => {
  let settle;
  const harness = createHarness({
    capability: 'closing-local',
    configureRunner: (runner) => {
      runner.turnSettlement = new Promise((resolve) => { settle = resolve; });
    },
  });

  const pending = harness.controller.submit(input());
  await Promise.resolve();
  assert.equal(harness.runner.continueCalls.length, 0);
  settle();
  const result = await pending;

  assert.equal(result.success, true);
  assert.equal(result.mode, 'continue');
  assert.equal(harness.runner.waitCalls, 1);
  assert.equal(harness.runner.continueCalls.length, 1);
  assert.equal(harness.store.session.messages.filter((message) => message.id === UUID).length, 1);
});

test('Stop while waiting for a closing local turn cancels the queued steer without Continue', async () => {
  let settle;
  const harness = createHarness({
    capability: 'closing-local',
    configureRunner: (runner) => {
      runner.turnSettlement = new Promise((resolve) => { settle = resolve; });
    },
  });

  const pending = harness.controller.submit(input());
  await Promise.resolve();
  harness.runner.sessionStopped = true;
  settle();
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(result.code, 'cancelled');
  assert.equal(harness.runner.continueCalls.length, 0);
  const metadata = harness.store.getMessageById('session-1', UUID).metadata;
  assert.equal(metadata.steerStatus, 'cancelled');
  assert.equal(metadata.submissionResult, 'failed');
  assert.equal(metadata.submissionErrorCode, 'cancelled');
});

test('Stop after open steer admission loses the closing race cancels without Continue', async () => {
  let settle;
  const harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => {
      runner.admissionAccepted = false;
      runner.turnSettlement = new Promise((resolve) => { settle = resolve; });
    },
  });

  const pending = harness.controller.submit(input());
  await Promise.resolve();
  assert.equal(harness.runner.steerCalls.length, 1);
  harness.runner.sessionStopped = true;
  settle();
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(result.code, 'cancelled');
  assert.equal(harness.runner.continueCalls.length, 0);
  assert.equal(
    harness.store.getMessageById('session-1', UUID).metadata.steerStatus,
    'cancelled',
  );
});

test('repeating a completed submission UUID does not duplicate execution', async () => {
  const harness = createHarness({ capability: 'open-local' });
  const first = await harness.controller.submit(input());
  const second = await harness.controller.submit(input());

  assert.deepEqual(second, first);
  assert.equal(harness.runner.steerCalls.length, 1);
  assert.equal(harness.emitted.length, 1);
});

test('coalesces concurrent duplicate UUIDs while steer delivery is in flight', async () => {
  let deliver;
  const harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => {
      runner.delivery = new Promise((resolve) => { deliver = resolve; });
    },
  });

  const firstPending = harness.controller.submit(input());
  const secondPending = harness.controller.submit(input());
  assert.equal(harness.runner.steerCalls.length, 1);
  deliver();
  const [first, second] = await Promise.all([firstPending, secondPending]);

  assert.deepEqual(second, first);
  assert.equal(harness.runner.steerCalls.length, 1);
  assert.equal(harness.store.session.messages.length, 1);
});

test('publishes the in-flight promise before synchronous emitMessage reentry', async () => {
  let deliver;
  let harness;
  let reentrantPromise;
  harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => {
      runner.delivery = new Promise((resolve) => { deliver = resolve; });
    },
    onEmitMessage: () => {
      reentrantPromise = harness.controller.submit(input());
    },
  });

  const firstPromise = harness.controller.submit(input());
  assert.equal(reentrantPromise, firstPromise);
  assert.equal(harness.runner.steerCalls.length, 1);
  deliver();
  const [first, reentrant] = await Promise.all([firstPromise, reentrantPromise]);
  assert.deepEqual(reentrant, first);

  const afterCompletion = harness.controller.submit(input());
  assert.notEqual(afterCompletion, firstPromise);
  assert.deepEqual(await afterCompletion, first);
  assert.equal(harness.runner.steerCalls.length, 1);
});

test('cleans a synchronously reentered failed submission so an explicit retry can execute', async () => {
  let rejectDelivery;
  let reentrantPromise;
  let harness;
  harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => {
      runner.delivery = new Promise((_resolve, reject) => { rejectDelivery = reject; });
    },
    onEmitMessage: () => {
      reentrantPromise = harness.controller.submit(input());
    },
  });

  const firstPromise = harness.controller.submit(input());
  assert.equal(reentrantPromise, firstPromise);
  rejectDelivery(new Error('shared failure'));
  const [first, reentrant] = await Promise.all([firstPromise, reentrantPromise]);
  assert.deepEqual(reentrant, first);
  assert.equal(first.success, false);
  assert.equal(harness.runner.steerCalls.length, 1);

  harness.runner.delivery = Promise.resolve();
  const retried = await harness.controller.submit(input());
  assert.equal(retried.success, true);
  assert.equal(harness.runner.steerCalls.length, 2);
});

test('coalesces concurrent ordinary continues and concurrent delivery failures', async () => {
  let continueTurn;
  const continuing = createHarness({
    configureRunner: (runner) => {
      runner.continueDelivery = new Promise((resolve) => { continueTurn = resolve; });
    },
  });
  const firstContinue = continuing.controller.submit(input());
  const secondContinue = continuing.controller.submit(input());
  assert.equal(continuing.runner.continueCalls.length, 1);
  continueTurn();
  const continueResults = await Promise.all([firstContinue, secondContinue]);
  assert.deepEqual(continueResults[1], continueResults[0]);
  assert.equal(continuing.runner.continueCalls.length, 1);

  let rejectDelivery;
  const failing = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => {
      runner.delivery = new Promise((_resolve, reject) => { rejectDelivery = reject; });
    },
  });
  const firstFailure = failing.controller.submit(input());
  const secondFailure = failing.controller.submit(input());
  rejectDelivery(new Error('one shared failure'));
  const failureResults = await Promise.all([firstFailure, secondFailure]);
  assert.deepEqual(failureResults[1], failureResults[0]);
  assert.equal(failing.runner.steerCalls.length, 1);
});

test('rejects A2A sessions before persistence or execution', async () => {
  const harness = createHarness({ sessionOverrides: { sessionType: 'a2a' } });
  const result = await harness.controller.submit(input());

  assert.deepEqual(result, {
    success: false,
    code: 'unsupported_session',
    error: 'Runtime input submission is not supported for A2A sessions',
  });
  assert.equal(harness.store.session.messages.length, 0);
  assert.equal(harness.runner.continueCalls.length, 0);
});

test('rejects an active sandbox turn but allows an inactive sandbox session to continue', async () => {
  const active = createHarness({
    capability: 'sandbox',
    sessionOverrides: { executionMode: 'sandbox', status: 'running' },
  });
  const rejected = await active.controller.submit(input());
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'unsupported_execution');
  assert.equal(active.store.session.messages.length, 0);

  const inactive = createHarness({
    capability: 'inactive',
    sessionOverrides: { executionMode: 'sandbox', status: 'completed' },
  });
  const continued = await inactive.controller.submit(input());
  assert.equal(continued.success, true);
  assert.equal(continued.mode, 'continue');
  assert.equal(inactive.runner.continueCalls.length, 1);
});

test('falls back to continue when synchronous steer admission loses the completion race', async () => {
  const harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => { runner.admissionAccepted = false; },
  });
  const result = await harness.controller.submit(input());

  assert.equal(result.success, true);
  assert.equal(result.mode, 'continue');
  assert.equal(harness.runner.steerCalls.length, 1);
  assert.equal(harness.runner.waitCalls, 1);
  assert.equal(harness.runner.continueCalls.length, 1);
  assert.equal(result.message.metadata.interactionKind, undefined);
  assert.equal(result.message.metadata.steerStatus, undefined);
});

test('rechecks the session after settlement before a fallback continue', async () => {
  const harness = createHarness({
    capability: 'closing-local',
    configureRunner: (runner, store) => {
      runner.turnSettlement = Promise.resolve().then(() => { store.session = null; });
    },
  });
  const result = await harness.controller.submit(input());

  assert.equal(result.success, false);
  assert.equal(result.code, 'session_not_found');
  assert.equal(harness.runner.continueCalls.length, 0);

  const changedToA2A = createHarness({
    capability: 'closing-local',
    configureRunner: (runner, store) => {
      runner.turnSettlement = Promise.resolve().then(() => { store.session.sessionType = 'a2a'; });
    },
  });
  const unsupported = await changedToA2A.controller.submit(input());
  assert.equal(unsupported.success, false);
  assert.equal(unsupported.code, 'unsupported_session');
  const metadata = changedToA2A.store.getMessageById('session-1', UUID).metadata;
  assert.equal(metadata.interactionKind, 'steer');
  assert.equal(metadata.steerStatus, 'failed');
  assert.equal(metadata.submissionResult, 'failed');
  assert.equal(metadata.submissionErrorCode, 'unsupported_session');
  assert.equal(changedToA2A.runner.continueCalls.length, 0);
});

test('maps channel delivery rejection and steerFailed events to honest failed metadata', async () => {
  const rejected = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => { runner.delivery = Promise.reject(new Error('channel closed')); },
  });
  const result = await rejected.controller.submit(input());
  assert.equal(result.success, false);
  assert.equal(result.code, 'delivery_failed');
  assert.equal(rejected.store.getMessageById('session-1', UUID).metadata.steerStatus, 'failed');
  assert.equal(rejected.updates.at(-1).metadata.steerStatus, 'failed');

  const evented = createHarness({ capability: 'open-local' });
  await evented.controller.submit(input());
  evented.runner.emit('steerFailed', 'session-1', UUID, 'retry transition');
  assert.equal(evented.store.getMessageById('session-1', UUID).metadata.steerStatus, 'failed');
  assert.equal(evented.updates.at(-1).metadata.steerErrorCode, 'delivery_failed');
});

test('clears every failure field when an explicit retry succeeds', async () => {
  const harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => { runner.delivery = Promise.reject(new Error('first failure')); },
  });
  const failed = await harness.controller.submit(input());
  assert.equal(failed.success, false);

  harness.runner.delivery = Promise.resolve();
  const retried = await harness.controller.submit(input());
  assert.equal(retried.success, true);
  const metadata = retried.message.metadata;
  assert.equal(metadata.steerStatus, 'delivered');
  assert.equal(metadata.submissionResult, 'completed');
  for (const field of [
    'steerErrorCode',
    'steerFailureReason',
    'steerFailedAt',
    'submissionErrorCode',
    'submissionFailureReason',
  ]) {
    assert.equal(metadata[field], undefined, `${field} should be cleared`);
  }
  assert.equal(harness.runner.steerCalls.length, 2);
});

test('records closing fallback failures without leaving a queued steer', async () => {
  const harness = createHarness({
    capability: 'closing-local',
    configureRunner: (runner) => { runner.continueError = new Error('continue failed'); },
  });
  const result = await harness.controller.submit(input());

  assert.equal(result.success, false);
  assert.equal(result.code, 'delivery_failed');
  const metadata = harness.store.getMessageById('session-1', UUID).metadata;
  assert.equal(metadata.interactionKind, undefined);
  assert.equal(metadata.steerStatus, undefined);
  assert.equal(metadata.submissionMode, 'continue');
  assert.equal(metadata.submissionResult, 'failed');
  assert.equal(metadata.submissionErrorCode, 'delivery_failed');
  assert.equal(metadata.submissionFailureReason, 'continue failed');
});

test('settlement events update persisted steer status and emit the complete update payload', async () => {
  const harness = createHarness({ capability: 'open-local' });
  await harness.controller.submit(input());
  harness.runner.emit('steerSettled', 'session-1', UUID);

  const message = harness.store.getMessageById('session-1', UUID);
  assert.equal(message.metadata.steerStatus, 'settled');
  assert.equal(harness.updates.at(-1).content, 'next direction');
  assert.equal(harness.updates.at(-1).metadata.steerStatus, 'settled');
});

test('a steerSettled event wins over a later delivery acknowledgement without duplicate updates', async () => {
  let deliver;
  const harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => {
      runner.delivery = new Promise((resolve) => { deliver = resolve; });
    },
  });
  const pending = harness.controller.submit(input());
  harness.runner.emit('steerSettled', 'session-1', UUID);
  const settled = harness.store.getMessageById('session-1', UUID);
  const settledAt = settled.metadata.steerSettledAt;
  const updateCount = harness.updates.length;

  deliver();
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.message.metadata.steerStatus, 'settled');
  assert.equal(result.message.metadata.steerSettledAt, settledAt);
  assert.equal(harness.updates.length, updateCount);
});

test('a steerFailed event wins over a later delivery acknowledgement without terminal downgrade', async () => {
  let deliver;
  const harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => {
      runner.delivery = new Promise((resolve) => { deliver = resolve; });
    },
  });
  const pending = harness.controller.submit(input());
  harness.runner.emit('steerFailed', 'session-1', UUID, 'runner retry');
  const failed = harness.store.getMessageById('session-1', UUID);
  const failedAt = failed.metadata.steerFailedAt;
  const updateCount = harness.updates.length;

  deliver();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, 'delivery_failed');
  const finalMessage = harness.store.getMessageById('session-1', UUID);
  assert.equal(finalMessage.metadata.steerStatus, 'failed');
  assert.equal(finalMessage.metadata.steerFailedAt, failedAt);
  assert.equal(harness.updates.length, updateCount);
});

test('a steerCancelled event settles pending delivery as cancelled and remains terminal', async () => {
  let rejectDelivery;
  const harness = createHarness({
    capability: 'open-local',
    configureRunner: (runner) => {
      runner.delivery = new Promise((_resolve, reject) => { rejectDelivery = reject; });
    },
  });
  const pending = harness.controller.submit(input());
  harness.runner.emit('steerCancelled', 'session-1', UUID, 'Cowork session stopped');
  rejectDelivery(new Error('Cowork session stopped'));

  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, 'cancelled');
  const cancelled = harness.store.getMessageById('session-1', UUID);
  assert.equal(cancelled.metadata.steerStatus, 'cancelled');
  assert.equal(cancelled.metadata.submissionResult, 'failed');
  assert.equal(cancelled.metadata.submissionErrorCode, 'cancelled');
  assert.equal(cancelled.metadata.steerErrorCode, 'cancelled');
  assert.equal(typeof cancelled.metadata.steerCancelledAt, 'number');
  assert.equal(cancelled.metadata.steerFailedAt, undefined);

  const cancelledAt = cancelled.metadata.steerCancelledAt;
  const updateCount = harness.updates.length;
  harness.runner.emit('steerFailed', 'session-1', UUID, 'late provider failure');
  harness.runner.emit('steerSettled', 'session-1', UUID);
  assert.equal(cancelled.metadata.steerStatus, 'cancelled');
  assert.equal(cancelled.metadata.steerCancelledAt, cancelledAt);
  assert.equal(harness.updates.length, updateCount);
});

test('a late cancellation event cannot downgrade a delivered but unsettled steer', async () => {
  const harness = createHarness({ capability: 'open-local' });
  const delivered = await harness.controller.submit(input());
  assert.equal(delivered.success, true);
  assert.equal(delivered.message.metadata.steerStatus, 'delivered');

  const updateCount = harness.updates.length;
  harness.runner.emit('steerCancelled', 'session-1', UUID, 'Cowork session stopped');
  const retained = harness.store.getMessageById('session-1', UUID);
  assert.equal(retained.metadata.steerStatus, 'delivered');
  assert.equal(retained.metadata.submissionResult, 'completed');
  assert.equal(retained.metadata.steerCancelledAt, undefined);
  assert.equal(harness.updates.length, updateCount);
});

test('terminal runner events are idempotent and dispose removes the listeners', async () => {
  const settled = createHarness({ capability: 'open-local' });
  await settled.controller.submit(input());
  settled.runner.emit('steerSettled', 'session-1', UUID);
  const updateCount = settled.updates.length;
  const settledAt = settled.store.getMessageById('session-1', UUID).metadata.steerSettledAt;
  settled.runner.emit('steerSettled', 'session-1', UUID);
  assert.equal(settled.updates.length, updateCount);
  assert.equal(settled.store.getMessageById('session-1', UUID).metadata.steerSettledAt, settledAt);

  const failed = createHarness({ capability: 'open-local' });
  await failed.controller.submit(input());
  failed.runner.emit('steerFailed', 'session-1', UUID, 'same terminal failure');
  const failedUpdates = failed.updates.length;
  const failedAt = failed.store.getMessageById('session-1', UUID).metadata.steerFailedAt;
  failed.runner.emit('steerFailed', 'session-1', UUID, 'same terminal failure');
  assert.equal(failed.updates.length, failedUpdates);
  assert.equal(failed.store.getMessageById('session-1', UUID).metadata.steerFailedAt, failedAt);

  const disposed = createHarness({ capability: 'open-local' });
  await disposed.controller.submit(input());
  disposed.controller.dispose();
  const disposedUpdates = disposed.updates.length;
  disposed.runner.emit('steerSettled', 'session-1', UUID);
  disposed.runner.emit('steerFailed', 'session-1', UUID, 'after dispose');
  disposed.runner.emit('steerCancelled', 'session-1', UUID, 'after dispose');
  assert.equal(disposed.updates.length, disposedUpdates);
  assert.equal(disposed.store.getMessageById('session-1', UUID).metadata.steerStatus, 'delivered');
});

test('rejects blank input and missing sessions without persisting', async () => {
  const blank = createHarness();
  const blankResult = await blank.controller.submit(input({ text: '   ' }));
  assert.equal(blankResult.success, false);
  assert.equal(blankResult.code, 'invalid_input');

  const missing = createHarness();
  missing.store.session = null;
  const missingResult = await missing.controller.submit(input());
  assert.equal(missingResult.success, false);
  assert.equal(missingResult.code, 'session_not_found');
});
