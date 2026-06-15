import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { getSqlJs } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);
let mockedUserDataPath = process.cwd();

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => mockedUserDataPath,
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

async function createSqliteStore() {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const { SqliteStore } = loadCompiledModule('../dist-electron/main/sqliteStore.js');
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-cross-session-store-'));
  mockedUserDataPath = userDataPath;
  const dbPath = path.join(userDataPath, 'test.sqlite');
  const store = new SqliteStore(db, dbPath);
  store.initializeTables(userDataPath);
  return {
    db,
    store,
    userDataPath,
    cleanup: () => fs.rmSync(userDataPath, { recursive: true, force: true }),
  };
}

function createCoworkStore(db) {
  const { CoworkStore } = loadCompiledModule('../dist-electron/main/coworkStore.js');
  return new CoworkStore(db, () => {});
}

const {
  CROSS_SESSION_INSERT_MAX_CHARS,
  CoworkCrossSessionService,
  formatIdbotsSessionLink,
  normalizeIdbotsSessionId,
} = await import('../dist-electron/main/services/coworkCrossSession.js');

test('normalizes raw and link session ids and rejects malformed ids', () => {
  assert.deepEqual(normalizeIdbotsSessionId('  abc-123_DEF.9  '), {
    ok: true,
    sessionId: 'abc-123_DEF.9',
  });
  assert.deepEqual(normalizeIdbotsSessionId('idbots://abc-123'), {
    ok: true,
    sessionId: 'abc-123',
  });
  assert.deepEqual(formatIdbotsSessionLink('  abc-123  '), 'IDBots://abc-123');

  for (const value of ['', 'IDBots://', 'abc/123', 'abc 123', 'abc?123']) {
    const result = normalizeIdbotsSessionId(value);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_SESSION_ID');
    assert.match(result.message, /session id/i);
  }
});

test('reads full standard and A2A sessions', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const service = new CoworkCrossSessionService(store);
    const standard = store.createSession('Standard chat', process.cwd(), '', 'local', [], 1);
    const a2a = store.createSession('Peer chat', process.cwd(), '', 'local', [], 1, 'a2a', 'peer-global', 'Peer', null);

    const userMessage = store.addMessage(standard.id, {
      type: 'user',
      content: 'hello standard',
    });
    const peerMessage = store.addMessage(a2a.id, {
      type: 'assistant',
      content: 'hello peer',
      metadata: { sourceChannel: 'metaweb_private' },
    });

    const standardResult = service.readAll({ sessionId: formatIdbotsSessionLink(standard.id) });
    assert.equal(standardResult.ok, true);
    assert.equal(standardResult.session.id, standard.id);
    assert.equal(standardResult.session.sessionType, 'standard');
    assert.deepEqual(standardResult.messages.map((message) => message.id), [userMessage.id]);

    const a2aResult = service.readAll({ sessionId: `idbots://${a2a.id}` });
    assert.equal(a2aResult.ok, true);
    assert.equal(a2aResult.session.id, a2a.id);
    assert.equal(a2aResult.session.sessionType, 'a2a');
    assert.equal(a2aResult.session.peerGlobalMetaId, 'peer-global');
    assert.deepEqual(a2aResult.messages.map((message) => message.id), [peerMessage.id]);
  } finally {
    sqlite.cleanup();
  }
});

test('reads the latest persisted message and returns null for existing empty sessions', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const service = new CoworkCrossSessionService(store);
    const session = store.createSession('Latest chat', process.cwd(), '', 'local', [], 1);
    const empty = store.createSession('Empty chat', process.cwd(), '', 'local', [], 1);

    store.addMessage(session.id, { type: 'user', content: 'first' });
    const latest = store.addMessage(session.id, {
      type: 'assistant',
      content: 'second',
      metadata: { marker: 'latest' },
    });

    assert.equal(store.getSessionLatestMessage(session.id)?.id, latest.id);

    const result = service.readLatest({ sessionId: session.id });
    assert.equal(result.ok, true);
    assert.equal(result.message.id, latest.id);
    assert.equal(result.message.content, 'second');
    assert.deepEqual(result.message.metadata, { marker: 'latest' });

    const emptyResult = service.readLatest({ sessionId: empty.id });
    assert.equal(emptyResult.ok, true);
    assert.equal(emptyResult.message, null);
  } finally {
    sqlite.cleanup();
  }
});

test('missing sessions return SESSION_NOT_FOUND', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const service = new CoworkCrossSessionService(store);

    const readAllResult = service.readAll({ sessionId: 'missing-session' });
    assert.equal(readAllResult.ok, false);
    assert.equal(readAllResult.code, 'SESSION_NOT_FOUND');
    assert.equal('messages' in readAllResult, false);

    const readLatestResult = service.readLatest({ sessionId: 'missing-session' });
    assert.equal(readLatestResult.ok, false);
    assert.equal(readLatestResult.code, 'SESSION_NOT_FOUND');
  } finally {
    sqlite.cleanup();
  }
});

test('inserts a source-prefixed user message into a standard target session with metadata', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const service = new CoworkCrossSessionService(store);
    const source = store.createSession('Source chat', process.cwd(), '', 'local', [], 1);
    const target = store.createSession('Target chat', process.cwd(), '', 'local', [], 1);

    const result = service.insertUserMessage({
      sourceSessionId: formatIdbotsSessionLink(source.id),
      targetSessionId: target.id,
      message: '  hello from elsewhere  ',
    });

    assert.equal(result.ok, true);
    assert.equal(result.sourceSessionId, source.id);
    assert.equal(result.targetSessionId, target.id);
    assert.equal(result.message.type, 'user');
    assert.equal(result.message.content, `来自${source.id} 的信息：hello from elsewhere`);
    assert.deepEqual(result.message.metadata, {
      sourceChannel: 'idbots_cross_session',
      sourceSessionId: source.id,
    });

    const targetSession = store.getSession(target.id);
    assert.equal(targetSession.messages.length, 1);
    assert.equal(targetSession.messages[0].id, result.message.id);
  } finally {
    sqlite.cleanup();
  }
});

test('rejects cross-session writes to A2A targets', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const service = new CoworkCrossSessionService(store);
    const source = store.createSession('Source chat', process.cwd(), '', 'local', [], 1);
    const target = store.createSession('Peer chat', process.cwd(), '', 'local', [], 1, 'a2a', 'peer-global', 'Peer', null);

    const result = service.insertUserMessage({
      sourceSessionId: source.id,
      targetSessionId: target.id,
      message: 'hello peer',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'WRITE_NOT_ALLOWED_FOR_A2A');
    assert.equal(store.getSession(target.id).messages.length, 0);
  } finally {
    sqlite.cleanup();
  }
});

test('rejects same-source-target writes', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const service = new CoworkCrossSessionService(store);
    const session = store.createSession('Same chat', process.cwd(), '', 'local', [], 1);

    const result = service.insertUserMessage({
      sourceSessionId: session.id,
      targetSessionId: formatIdbotsSessionLink(session.id),
      message: 'loop',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'SOURCE_TARGET_SAME_SESSION');
    assert.equal(store.getSession(session.id).messages.length, 0);
  } finally {
    sqlite.cleanup();
  }
});

test('rejects empty and too-long messages', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const service = new CoworkCrossSessionService(store);
    const source = store.createSession('Source chat', process.cwd(), '', 'local', [], 1);
    const target = store.createSession('Target chat', process.cwd(), '', 'local', [], 1);

    const empty = service.insertUserMessage({
      sourceSessionId: source.id,
      targetSessionId: target.id,
      message: '   ',
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'EMPTY_MESSAGE');

    const tooLong = service.insertUserMessage({
      sourceSessionId: source.id,
      targetSessionId: target.id,
      message: 'x'.repeat(CROSS_SESSION_INSERT_MAX_CHARS + 1),
    });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.code, 'MESSAGE_TOO_LONG');
    assert.equal(store.getSession(target.id).messages.length, 0);
  } finally {
    sqlite.cleanup();
  }
});
