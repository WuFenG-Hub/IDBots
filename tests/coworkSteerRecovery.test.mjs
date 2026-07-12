import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { createLegacyMemoryDb } from './memoryTestUtils.mjs';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(import.meta.url);
const UUIDS = {
  queued: '11111111-1111-4111-8111-111111111111',
  delivered: '22222222-2222-4222-8222-222222222222',
  settled: '33333333-3333-4333-8333-333333333333',
  failed: '44444444-4444-4444-8444-444444444444',
  cancelled: '55555555-5555-4555-8555-555555555555',
  ordinary: '66666666-6666-4666-8666-666666666666',
  assistant: '77777777-7777-4777-8777-777777777777',
  malformed: '88888888-8888-4888-8888-888888888888',
};

async function createStoreHarness() {
  const db = await createLegacyMemoryDb();
  db.run(`
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      sequence INTEGER
    );
  `);
  db.run(`
    CREATE TABLE cowork_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  let saves = 0;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => projectRoot,
          getPath: () => projectRoot,
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  let CoworkStore;
  try {
    ({ CoworkStore } = require('../dist-electron/main/coworkStore.js'));
  } finally {
    Module._load = originalLoad;
  }
  const store = new CoworkStore(db, () => { saves += 1; });
  const session = store.createSession('restart recovery', process.cwd());
  return {
    db,
    store,
    session,
    get saves() { return saves; },
    cleanup: () => db.close(),
  };
}

function addSteer(store, sessionId, id, status, extraMetadata = {}, type = 'user') {
  return store.addMessageWithId(sessionId, id, {
    type,
    content: `visible-${status}`,
    metadata: {
      interactionKind: 'steer',
      submissionId: id,
      submissionMode: 'steer',
      submissionResult: status === 'failed' ? 'failed' : status === 'settled' ? 'completed' : 'pending',
      steerStatus: status,
      preserved: `metadata-${status}`,
      ...extraMetadata,
    },
  });
}

test('restart marks only unresolved user steers failed and saves once without replay side effects', async (t) => {
  const harness = await createStoreHarness();
  t.after(harness.cleanup);

  addSteer(harness.store, harness.session.id, UUIDS.queued, 'queued');
  addSteer(harness.store, harness.session.id, UUIDS.delivered, 'delivered', { steerDeliveredAt: 123 });
  addSteer(harness.store, harness.session.id, UUIDS.settled, 'settled');
  addSteer(harness.store, harness.session.id, UUIDS.failed, 'failed', { steerErrorCode: 'old_failure' });
  addSteer(harness.store, harness.session.id, UUIDS.cancelled, 'cancelled');
  harness.store.addMessageWithId(harness.session.id, UUIDS.ordinary, {
    type: 'user',
    content: 'ordinary message',
    metadata: { submissionMode: 'continue', submissionResult: 'pending', preserved: 'ordinary' },
  });
  addSteer(harness.store, harness.session.id, UUIDS.assistant, 'queued', {}, 'assistant');
  harness.db.run(`
    INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
    VALUES (?, ?, 'user', 'malformed visible', '{not-json', 1, 99)
  `, [UUIDS.malformed, harness.session.id]);

  const savesBeforeRecovery = harness.saves;
  const changed = harness.store.markInterruptedSteersAfterRestart(5000);

  assert.equal(changed, 2);
  assert.equal(harness.saves, savesBeforeRecovery + 1);
  for (const id of [UUIDS.queued, UUIDS.delivered]) {
    const message = harness.store.getMessageById(harness.session.id, id);
    assert.equal(message.content, id === UUIDS.queued ? 'visible-queued' : 'visible-delivered');
    assert.equal(message.metadata.preserved, id === UUIDS.queued ? 'metadata-queued' : 'metadata-delivered');
    assert.equal(message.metadata.steerStatus, 'failed');
    assert.equal(message.metadata.submissionResult, 'failed');
    assert.equal(message.metadata.steerFailedAt, 5000);
    assert.equal(message.metadata.steerErrorCode, 'app_restarted');
  }
  assert.equal(harness.store.getMessageById(harness.session.id, UUIDS.settled).metadata.steerStatus, 'settled');
  assert.equal(harness.store.getMessageById(harness.session.id, UUIDS.failed).metadata.steerErrorCode, 'old_failure');
  assert.equal(harness.store.getMessageById(harness.session.id, UUIDS.cancelled).metadata.steerStatus, 'cancelled');
  assert.equal(harness.store.getMessageById(harness.session.id, UUIDS.ordinary).metadata.preserved, 'ordinary');
  assert.equal(harness.store.getMessageById(harness.session.id, UUIDS.assistant).metadata.steerStatus, 'queued');

  const malformedRow = harness.db.exec(
    'SELECT metadata FROM cowork_messages WHERE id = ?',
    [UUIDS.malformed],
  )[0].values[0][0];
  assert.equal(malformedRow, '{not-json');
});

test('restart recovery is idempotent and does not persist when nothing remains interrupted', async (t) => {
  const harness = await createStoreHarness();
  t.after(harness.cleanup);
  addSteer(harness.store, harness.session.id, UUIDS.queued, 'queued');

  assert.equal(harness.store.markInterruptedSteersAfterRestart(6000), 1);
  const savesAfterFirstRecovery = harness.saves;
  assert.equal(harness.store.markInterruptedSteersAfterRestart(7000), 0);
  assert.equal(harness.saves, savesAfterFirstRecovery);
  assert.equal(
    harness.store.getMessageById(harness.session.id, UUIDS.queued).metadata.steerFailedAt,
    6000,
  );
});

test('main invokes interrupted-steer recovery exactly once at the shared CoworkStore construction point', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src/main/main.ts'), 'utf8');
  const start = source.indexOf('const getCoworkStore = () =>');
  const end = source.indexOf('\nconst scheduleCoworkStoreHeavyMaintenance', start);
  assert.ok(start >= 0 && end > start, 'shared CoworkStore initializer should exist');
  const initializer = source.slice(start, end);
  assert.equal((initializer.match(/new CoworkStore\(/g) ?? []).length, 1);
  assert.equal((initializer.match(/markInterruptedSteersAfterRestart\(/g) ?? []).length, 1);
  assert.ok(
    initializer.indexOf('markInterruptedSteersAfterRestart(') > initializer.indexOf('new CoworkStore('),
    'recovery must run after construction',
  );
});

class FakeStore {
  constructor(messages = []) {
    this.sessions = new Map([
      ['session-1', this.session('session-1', messages)],
      ['session-2', this.session('session-2', [])],
    ]);
  }

  session(id, messages) {
    return {
      id,
      title: id,
      claudeSessionId: null,
      status: 'running',
      pinned: false,
      cwd: process.cwd(),
      systemPrompt: '',
      executionMode: 'local',
      activeSkillIds: [],
      messages,
      createdAt: 1,
      updatedAt: 1,
      sessionType: 'standard',
    };
  }

  getSession(id) { return this.sessions.get(id) ?? null; }
  getMessageById(sessionId, id) {
    return this.getSession(sessionId)?.messages.find((message) => message.id === id) ?? null;
  }
  getMessageOwnerSessionId(id) {
    for (const [sessionId, session] of this.sessions) {
      if (session.messages.some((message) => message.id === id)) return sessionId;
    }
    return null;
  }
  addMessageWithId(sessionId, id, input) {
    const existingOwner = this.getMessageOwnerSessionId(id);
    if (existingOwner) return this.getMessageById(existingOwner, id);
    const message = { id, timestamp: Date.now(), ...input };
    this.getSession(sessionId).messages.push(message);
    return message;
  }
  updateMessage(sessionId, id, updates) {
    Object.assign(this.getMessageById(sessionId, id), updates);
  }
}

class FakeRunner {
  constructor() {
    this.steerCalls = [];
    this.delivery = Promise.resolve();
  }
  getSteerCapability() { return 'open-local'; }
  trySubmitSteer(sessionId, submissionId, text) {
    this.steerCalls.push({ sessionId, submissionId, text });
    return { accepted: true, delivered: this.delivery };
  }
  waitForActiveTurnSettlement() { return Promise.resolve(); }
  continueSession() { throw new Error('unexpected continue'); }
}

async function createControllerHarness(messages = []) {
  const { CoworkTurnSubmissionController } = await import(
    '../dist-electron/main/services/coworkTurnSubmission.js'
  );
  const store = new FakeStore(messages);
  const runner = new FakeRunner();
  const controller = new CoworkTurnSubmissionController({
    store,
    runner,
    emitMessage: () => {},
    emitMessageUpdate: () => {},
  });
  return { store, runner, controller };
}

function failedSteer(overrides = {}) {
  return {
    id: UUIDS.queued,
    type: 'user',
    content: 'same corrected direction',
    timestamp: 1,
    metadata: {
      interactionKind: 'steer',
      submissionId: UUIDS.queued,
      submissionMode: 'steer',
      submissionResult: 'failed',
      steerStatus: 'failed',
      steerErrorCode: 'app_restarted',
    },
    ...overrides,
  };
}

test('explicit retry reuses a failed steer UUID only for the same trimmed content and one row', async () => {
  const harness = await createControllerHarness([failedSteer()]);
  const result = await harness.controller.submit({
    sessionId: 'session-1',
    submissionId: UUIDS.queued,
    text: '  same corrected direction  ',
  });

  assert.equal(result.success, true);
  assert.equal(harness.runner.steerCalls.length, 1);
  assert.equal(harness.store.getSession('session-1').messages.filter(({ id }) => id === UUIDS.queued).length, 1);
});

test('duplicate UUID rejects different content, non-user rows, non-steer failures, and cross-session reuse', async () => {
  for (const existing of [
    failedSteer(),
    failedSteer({ type: 'assistant' }),
    failedSteer({ metadata: { submissionMode: 'continue', submissionResult: 'failed' } }),
  ]) {
    const harness = await createControllerHarness([existing]);
    const result = await harness.controller.submit({
      sessionId: 'session-1',
      submissionId: UUIDS.queued,
      text: existing.type === 'user' && existing.metadata.submissionMode === 'steer'
        ? 'different direction'
        : 'same corrected direction',
    });
    assert.equal(result.success, false);
    assert.equal(result.code, 'invalid_input');
    assert.equal(harness.runner.steerCalls.length, 0);
  }

  const crossSession = await createControllerHarness([failedSteer()]);
  const result = await crossSession.controller.submit({
    sessionId: 'session-2',
    submissionId: UUIDS.queued,
    text: 'same corrected direction',
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'invalid_input');
  assert.equal(crossSession.runner.steerCalls.length, 0);
});

test('concurrent same UUID shares only identical input and rejects conflicting text immediately', async () => {
  const harness = await createControllerHarness();
  let deliver;
  harness.runner.delivery = new Promise((resolve) => { deliver = resolve; });

  const first = harness.controller.submit({
    sessionId: 'session-1', submissionId: UUIDS.queued, text: 'first direction',
  });
  const identical = harness.controller.submit({
    sessionId: 'session-1', submissionId: UUIDS.queued, text: ' first direction ',
  });
  const conflicting = harness.controller.submit({
    sessionId: 'session-1', submissionId: UUIDS.queued, text: 'second direction',
  });

  const identicalWasShared = identical === first;
  const conflictWasShared = conflicting === first;
  deliver();

  assert.equal(identicalWasShared, true);
  assert.equal(conflictWasShared, false);
  assert.deepEqual(await conflicting, {
    success: false,
    code: 'invalid_input',
    error: 'Submission UUID is already associated with different input',
  });
  assert.equal(harness.runner.steerCalls.length, 1);
  assert.equal((await first).success, true);
});
