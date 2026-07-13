import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { createLegacyMemoryDb } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function loadCompiledModule(modulePath) {
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

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

async function createTestCoworkStore() {
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
  const { CoworkStore } = loadCompiledModule('../dist-electron/main/coworkStore.js');
  return {
    store: new CoworkStore(db, () => {}),
    cleanup: () => db.close(),
  };
}

test('addMessageWithId is idempotent for one steer submission UUID', async (t) => {
  const { store, cleanup } = await createTestCoworkStore();
  t.after(cleanup);
  const session = store.createSession('steer', process.cwd());
  const id = '11111111-1111-4111-8111-111111111111';
  const input = {
    type: 'user',
    content: 'only change the query',
    metadata: { interactionKind: 'steer', steerStatus: 'queued', submissionId: id },
  };

  const first = store.addMessageWithId(session.id, id, input);
  const second = store.addMessageWithId(session.id, id, {
    ...input,
    content: 'must not replace the original content',
  });

  assert.equal(first.id, id);
  assert.equal(second.id, id);
  assert.equal(second.content, input.content);
  assert.equal(store.getSession(session.id).messages.filter((item) => item.id === id).length, 1);
});

test('updates steer delivery metadata without changing visible content', async (t) => {
  const { store, cleanup } = await createTestCoworkStore();
  t.after(cleanup);
  const session = store.createSession('steer', process.cwd());
  const message = store.addMessageWithId(session.id, crypto.randomUUID(), {
    type: 'user',
    content: 'keep this raw',
    metadata: { interactionKind: 'steer', steerStatus: 'queued' },
  });

  store.updateMessage(session.id, message.id, {
    metadata: { ...message.metadata, steerStatus: 'delivered', steerDeliveredAt: 123 },
  });

  const updated = store.getMessageById(session.id, message.id);
  assert.equal(updated.content, 'keep this raw');
  assert.equal(updated.metadata.steerStatus, 'delivered');
  assert.equal(updated.metadata.steerDeliveredAt, 123);
});

test('persists Stop cancellation as a distinct steer terminal state', async (t) => {
  const { store, cleanup } = await createTestCoworkStore();
  t.after(cleanup);
  const session = store.createSession('steer', process.cwd());
  const message = store.addMessageWithId(session.id, crypto.randomUUID(), {
    type: 'user',
    content: 'cancel this steer with the task',
    metadata: {
      interactionKind: 'steer',
      submissionMode: 'steer',
      submissionResult: 'pending',
      steerStatus: 'queued',
    },
  });

  store.updateMessage(session.id, message.id, {
    metadata: {
      ...message.metadata,
      submissionResult: 'failed',
      submissionErrorCode: 'cancelled',
      steerStatus: 'cancelled',
      steerCancelledAt: 456,
      steerErrorCode: 'cancelled',
    },
  });

  const updated = store.getMessageById(session.id, message.id);
  assert.equal(updated.metadata.steerStatus, 'cancelled');
  assert.equal(updated.metadata.submissionResult, 'failed');
  assert.equal(updated.metadata.submissionErrorCode, 'cancelled');
  assert.equal(updated.metadata.steerCancelledAt, 456);
  assert.equal(updated.metadata.steerFailedAt, undefined);
});
