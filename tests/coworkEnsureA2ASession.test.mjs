import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import {
  getSqlJs,
} from './memoryTestUtils.mjs';

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
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-a2a-session-store-'));
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
  ensureCoworkA2ASession,
  normalizeCoworkA2ASessionInput,
} = await import('../dist-electron/main/services/coworkEnsureA2ASession.js');

function insertMetabot(db, input) {
  db.run(`
    INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
    VALUES (?, ?, ?, ?)
  `, [
    input.id,
    `test mnemonic ${input.id}`,
    "m/44'/10001'/0'/0/0",
    input.createdAt ?? 1_770_000_000_000,
  ]);

  db.run(`
    INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, chat_public_key_pin_id, name, avatar, enabled,
      metaid, globalmetaid, metabot_info_pinid, metabot_type, created_by,
      role, soul, goal, bio, background, boss_id, llm_id, tools, skills,
      allow_chat_skills, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
  `, [
    input.id,
    input.id,
    `mvc-${input.id}`,
    `btc-${input.id}`,
    `doge-${input.id}`,
    `pub-${input.id}`,
    `chat-pub-${input.id}`,
    input.name,
    input.avatar ?? null,
    `metaid-${input.id}`,
    input.globalmetaid,
    input.type ?? 'worker',
    'test',
    'Test role',
    'Test soul',
    '[]',
    '[]',
    '[]',
    input.createdAt ?? 1_770_000_000_000,
    input.updatedAt ?? 1_770_000_000_000,
  ]);
}

test('normalizeCoworkA2ASessionInput accepts local actor id and rejects malformed peers', () => {
  assert.deepEqual(normalizeCoworkA2ASessionInput({
    actorId: 'idbots-metabot-42',
    peerGlobalMetaId: ' IDQ1PEER ',
    peerName: ' Peer Bot ',
    peerAvatar: ' avatar-data ',
  }), {
    localMetabotId: 42,
    peerGlobalMetaId: 'idq1peer',
    peerName: 'Peer Bot',
    peerAvatar: 'avatar-data',
  });

  assert.throws(() => normalizeCoworkA2ASessionInput({
    actorId: 'bad-actor',
    peerGlobalMetaId: 'idq1peer',
  }), /local Bot actor/i);

  assert.throws(() => normalizeCoworkA2ASessionInput({
    actorId: 'idbots-metabot-42',
    peerGlobalMetaId: 'not-global',
  }), /peer GlobalMetaID/i);
});

test('ensureCoworkA2ASession creates canonical metaweb private A2A session', async () => {
  const sqlite = await createSqliteStore();
  try {
    insertMetabot(sqlite.db, {
      id: 7,
      name: 'Local Bot',
      globalmetaid: 'idq1local',
      avatar: 'local-avatar',
    });
    const coworkStore = createCoworkStore(sqlite.db);

    const result = ensureCoworkA2ASession({
      coworkStore,
      getMetabotById: (id) => (id === 7 ? {
        id,
        name: 'Local Bot',
        globalmetaid: 'idq1local',
      } : null),
      input: {
        actorId: 'idbots-metabot-7',
        peerGlobalMetaId: 'IDQ1PEER',
        peerName: 'Peer Bot',
        peerAvatar: 'peer-avatar',
      },
    });

    assert.equal(result.created, true);
    assert.equal(result.externalConversationId, 'metaweb-private:idq1peer');
    assert.equal(result.session.sessionType, 'a2a');
    assert.equal(result.session.metabotId, 7);
    assert.equal(result.session.peerGlobalMetaId, 'idq1peer');
    assert.equal(result.session.peerName, 'Peer Bot');
    assert.equal(result.session.peerAvatar, 'peer-avatar');

    const mapping = coworkStore.getConversationMapping('metaweb_private', 'metaweb-private:idq1peer', 7);
    assert.equal(mapping?.coworkSessionId, result.session.id);
    assert.deepEqual(JSON.parse(mapping.metadataJson), {
      peerGlobalMetaId: 'idq1peer',
      peerName: 'Peer Bot',
      peerAvatar: 'peer-avatar',
      source: 'bot_browser',
      a2aConversationId: 'metaweb-private:idq1peer',
      a2aThreadId: mapping ? JSON.parse(mapping.metadataJson).a2aThreadId : undefined,
      episodeIndex: 1,
      episodeStartedAt: result.session.createdAt,
    });
  } finally {
    sqlite.cleanup();
  }
});

test('ensureCoworkA2ASession always reuses and restores the existing canonical session', async () => {
  const sqlite = await createSqliteStore();
  try {
    insertMetabot(sqlite.db, {
      id: 8,
      name: 'Local Bot',
      globalmetaid: 'idq1local',
    });
    const coworkStore = createCoworkStore(sqlite.db);
    const existing = coworkStore.createSession(
      'Old Peer',
      process.cwd(),
      '',
      'local',
      [],
      8,
      'a2a',
      'idq1peer',
      'Old Peer',
      null,
    );
    coworkStore.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: 'metaweb-private:idq1peer',
      metabotId: 8,
      coworkSessionId: existing.id,
      metadataJson: JSON.stringify({
        byeSent: true,
        episodeRestartRequestedAt: 1_800_000_000_000,
      }),
    });
    coworkStore.addMessage(existing.id, { type: 'user', content: 'existing history' });
    coworkStore.archiveSession(existing.id);

    const result = ensureCoworkA2ASession({
      coworkStore,
      getMetabotById: () => ({
        id: 8,
        name: 'Local Bot',
        globalmetaid: 'idq1local',
      }),
      input: {
        actorId: 'idbots-metabot-8',
        peerGlobalMetaId: 'idq1peer',
        peerName: 'New Peer',
        peerAvatar: 'new-avatar',
      },
    });

    assert.equal(result.created, false);
    assert.equal(result.session.id, existing.id);
    assert.equal(result.session.peerName, 'New Peer');
    assert.equal(result.session.peerAvatar, 'new-avatar');
    assert.equal(coworkStore.isSessionArchived(existing.id), false);
    assert.deepEqual(coworkStore.getSession(existing.id)?.messages.map((message) => message.content), [
      'existing history',
    ]);
    assert.deepEqual(coworkStore.listSessions().map((session) => session.id), [existing.id]);
  } finally {
    sqlite.cleanup();
  }
});

test('ensureCoworkA2ASession rejects self chat and local Bots without GlobalMetaID', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    assert.throws(() => ensureCoworkA2ASession({
      coworkStore,
      getMetabotById: () => ({
        id: 9,
        name: 'Local Bot',
        globalmetaid: null,
      }),
      input: {
        actorId: 'idbots-metabot-9',
        peerGlobalMetaId: 'idq1peer',
      },
    }), /GlobalMetaID/i);

    assert.throws(() => ensureCoworkA2ASession({
      coworkStore,
      getMetabotById: () => ({
        id: 9,
        name: 'Local Bot',
        globalmetaid: 'idq1same',
      }),
      input: {
        actorId: 'idbots-metabot-9',
        peerGlobalMetaId: 'idq1same',
      },
    }), /itself/i);
  } finally {
    sqlite.cleanup();
  }
});
