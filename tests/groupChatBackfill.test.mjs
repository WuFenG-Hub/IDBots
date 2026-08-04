import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  createGroupChatBackfillLoop,
  setGroupChatBackfillActiveGroupIdsGetter,
} = require('../dist-electron/main/services/groupChatBackfillService.js');
const { encryptGroupMessageECB } = require('../dist-electron/main/services/metaWebCrypto.js');

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const OTHER_GROUP_ID = 'bbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111i0';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-backfill-'));

const historyItem = (overrides = {}) => ({
  index: 0,
  txId: 'tx-deadbeef',
  pinId: 'tx-deadbeef-i0',
  groupId: GROUP_ID,
  channelId: '',
  metaId: 'metaid-sender',
  globalMetaId: 'gmid-sender',
  address: 'mvc-addr',
  nickName: 'SenderNick',
  userInfo: { name: 'Sender Name', avatar: 'avatar-url', chatPublicKey: 'chat-pub' },
  protocol: '/protocols/simplegroupchat',
  content: 'plaintext content',
  contentType: 'text/plain',
  encryption: '',
  chatType: 0,
  replyPin: '',
  mention: [],
  timestamp: 1785000000000,
  chain: 'mvc',
  ...overrides,
});

const pageEnvelope = (list) => ({ code: 0, data: { list } });

/**
 * Programmable fetchJson: pages keyed by `${origin}|${groupId}|${startIndex}`.
 * Value may be an envelope object, or an Error to throw (endpoint failure).
 */
const createFakeFetch = (pages, calls) => async (url) => {
  calls.push(url);
  const u = new URL(url);
  const key = `${u.origin}|${u.searchParams.get('groupId')}|${u.searchParams.get('startIndex')}`;
  const value = pages[key];
  if (value instanceof Error) throw value;
  if (value === undefined) return pageEnvelope([]);
  return value;
};

const createHarness = async (pages, groupIds = [GROUP_ID]) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const calls = [];
  const fetchJson = createFakeFetch(pages, calls);
  setGroupChatBackfillActiveGroupIdsGetter(() => groupIds);
  const loop = createGroupChatBackfillLoop({
    db,
    saveDb: () => {},
    fetchJson,
    emitLog: () => {},
  });
  return { store, db, calls, loop, cleanup: () => store.close() };
};

const getRow = (db, sql, params = []) => {
  const result = db.exec(sql, params);
  if (!result[0]?.values?.[0]) return null;
  return Object.fromEntries(result[0].columns.map((c, i) => [c, result[0].values[0][i]]));
};

const countRows = (db, groupId = GROUP_ID) =>
  db.exec('SELECT COUNT(*) FROM group_chat_messages WHERE group_id = ?', [groupId])[0].values[0][0];

const requestedStartIndexes = (calls, origin) =>
  calls
    .map((url) => new URL(url))
    .filter((u) => u.origin === origin)
    .map((u) => Number(u.searchParams.get('startIndex')));

test('empty table: first page starts at index 0; rows stored with msg_index and is_processed = 0', async () => {
  const pages = {
    [`https://api.idchat.io|${GROUP_ID}|0`]: pageEnvelope([
      historyItem({ index: 0, pinId: 'pin-a', txId: 'tx-a', content: 'first' }),
      historyItem({ index: 1, pinId: 'pin-b', txId: 'tx-b', content: 'second' }),
    ]),
    [`https://www.show.now|${GROUP_ID}|0`]: pageEnvelope([]),
  };
  const h = await createHarness(pages);
  try {
    const result = await h.loop.syncOnce();
    assert.equal(result.failedGroups, 0);
    assert.equal(result.inserted, 2);
    assert.deepEqual(requestedStartIndexes(h.calls, 'https://api.idchat.io'), [0]);

    const row = getRow(h.db, 'SELECT * FROM group_chat_messages WHERE pin_id = ?', ['pin-a']);
    assert.equal(row.msg_index, 0);
    assert.equal(row.is_processed, 0, 'backfilled rows must stay unprocessed for the orchestrator');
    assert.equal(row.content, 'first');
    assert.equal(row.sender_name, 'Sender Name');
    assert.equal(row.sender_global_metaid, 'gmid-sender');
    assert.equal(row.protocol, '/protocols/simplegroupchat');
    assert.equal(row.group_id, GROUP_ID);
  } finally {
    h.cleanup();
  }
});

test('cursor advances: next tick resumes at MAX(msg_index) + 1', async () => {
  const pages = {
    [`https://api.idchat.io|${GROUP_ID}|0`]: pageEnvelope([
      historyItem({ index: 0, pinId: 'pin-a', txId: 'tx-a' }),
      historyItem({ index: 5, pinId: 'pin-b', txId: 'tx-b' }),
    ]),
    [`https://www.show.now|${GROUP_ID}|0`]: pageEnvelope([]),
    [`https://api.idchat.io|${GROUP_ID}|6`]: pageEnvelope([
      historyItem({ index: 6, pinId: 'pin-c', txId: 'tx-c' }),
    ]),
    [`https://www.show.now|${GROUP_ID}|6`]: pageEnvelope([]),
  };
  const h = await createHarness(pages);
  try {
    await h.loop.syncOnce();
    assert.equal(countRows(h.db), 2);

    h.calls.length = 0;
    const second = await h.loop.syncOnce();
    assert.equal(second.inserted, 1);
    assert.deepEqual(requestedStartIndexes(h.calls, 'https://api.idchat.io'), [6]);
    assert.equal(countRows(h.db), 3);
  } finally {
    h.cleanup();
  }
});

test('dual-endpoint merge dedupes by pinId and keeps the richer record', async () => {
  const sparse = historyItem({
    index: 0, pinId: 'pin-shared', txId: 'tx-shared', content: 'shared',
    userInfo: null, nickName: '', metaId: '', address: '', protocol: '',
  });
  const rich = historyItem({ index: 0, pinId: 'pin-shared', txId: 'tx-shared', content: 'shared' });
  const pages = {
    [`https://api.idchat.io|${GROUP_ID}|0`]: pageEnvelope([
      sparse,
      historyItem({ index: 1, pinId: 'pin-only-a', txId: 'tx-only-a' }),
    ]),
    [`https://www.show.now|${GROUP_ID}|0`]: pageEnvelope([
      rich,
      historyItem({ index: 2, pinId: 'pin-only-b', txId: 'tx-only-b' }),
    ]),
  };
  const h = await createHarness(pages);
  try {
    const result = await h.loop.syncOnce();
    assert.equal(result.inserted, 3, 'union of both endpoints, deduped by pinId');
    assert.equal(countRows(h.db), 3);
    const shared = getRow(h.db, 'SELECT * FROM group_chat_messages WHERE pin_id = ?', ['pin-shared']);
    assert.equal(shared.sender_name, 'Sender Name', 'richer record wins');
    assert.equal(shared.sender_metaid, 'metaid-sender');
  } finally {
    h.cleanup();
  }
});

test('INSERT OR IGNORE idempotency: repeating the same page inserts nothing new', async () => {
  const pages = {
    [`https://api.idchat.io|${GROUP_ID}|0`]: pageEnvelope([
      historyItem({ index: 0, pinId: 'pin-a', txId: 'tx-a' }),
      historyItem({ index: 1, pinId: 'pin-b', txId: 'tx-b' }),
    ]),
    [`https://www.show.now|${GROUP_ID}|0`]: pageEnvelope([
      historyItem({ index: 0, pinId: 'pin-a', txId: 'tx-a' }),
    ]),
    [`https://api.idchat.io|${GROUP_ID}|2`]: pageEnvelope([
      historyItem({ index: 0, pinId: 'pin-a', txId: 'tx-a' }),
      historyItem({ index: 1, pinId: 'pin-b', txId: 'tx-b' }),
    ]),
    [`https://www.show.now|${GROUP_ID}|2`]: pageEnvelope([]),
  };
  const h = await createHarness(pages);
  try {
    await h.loop.syncOnce();
    assert.equal(countRows(h.db), 2);
    const second = await h.loop.syncOnce();
    assert.equal(second.inserted, 0, 'pin_id UNIQUE dedupes socket/backfill overlap');
    assert.equal(countRows(h.db), 2);
  } finally {
    h.cleanup();
  }
});

test('AES-encrypted items are decrypted with key = first 16 chars of groupId', async () => {
  const cipher = encryptGroupMessageECB('secret hello', GROUP_ID);
  const pages = {
    [`https://api.idchat.io|${GROUP_ID}|0`]: pageEnvelope([
      historyItem({ index: 0, pinId: 'pin-enc', txId: 'tx-enc', content: cipher, encryption: 'aes', chatType: 0 }),
      historyItem({ index: 1, pinId: 'pin-plain', txId: 'tx-plain', content: 'not encrypted', encryption: '', chatType: 0 }),
      historyItem({ index: 2, pinId: 'pin-ct2', txId: 'tx-ct2', content: cipher, encryption: 'aes', chatType: 2 }),
    ]),
    [`https://www.show.now|${GROUP_ID}|0`]: pageEnvelope([]),
  };
  const h = await createHarness(pages);
  try {
    await h.loop.syncOnce();
    const enc = getRow(h.db, 'SELECT content FROM group_chat_messages WHERE pin_id = ?', ['pin-enc']);
    assert.equal(enc.content, 'secret hello');
    const plain = getRow(h.db, 'SELECT content FROM group_chat_messages WHERE pin_id = ?', ['pin-plain']);
    assert.equal(plain.content, 'not encrypted');
    // chatType outside {0,1}: ciphertext kept as-is (mirrors routeGroupChat)
    const ct2 = getRow(h.db, 'SELECT content FROM group_chat_messages WHERE pin_id = ?', ['pin-ct2']);
    assert.equal(ct2.content, cipher);
  } finally {
    h.cleanup();
  }
});

test('malformed endpoint responses never kill the tick', async () => {
  const pages = {
    // GROUP_ID: both endpoints fail -> failedGroups += 1
    [`https://api.idchat.io|${GROUP_ID}|0`]: new Error('network down'),
    [`https://www.show.now|${GROUP_ID}|0`]: new Error('http 500'),
    // OTHER_GROUP_ID: one endpoint garbage envelope, the other valid
    [`https://api.idchat.io|${OTHER_GROUP_ID}|0`]: { code: 7, data: null },
    [`https://www.show.now|${OTHER_GROUP_ID}|0`]: pageEnvelope([
      historyItem({ index: 0, pinId: 'pin-other', txId: 'tx-other', groupId: OTHER_GROUP_ID }),
    ]),
  };
  const h = await createHarness(pages, [GROUP_ID, OTHER_GROUP_ID]);
  try {
    const result = await h.loop.syncOnce();
    assert.equal(result.failedGroups, 1);
    assert.equal(result.inserted, 1);
    assert.equal(countRows(h.db, GROUP_ID), 0);
    assert.equal(countRows(h.db, OTHER_GROUP_ID), 1);

    // next tick recovers: GROUP_ID endpoints now serve data
    pages[`https://api.idchat.io|${GROUP_ID}|0`] = pageEnvelope([
      historyItem({ index: 0, pinId: 'pin-recovered', txId: 'tx-recovered' }),
    ]);
    pages[`https://www.show.now|${GROUP_ID}|0`] = pageEnvelope([]);
    const second = await h.loop.syncOnce();
    assert.equal(second.failedGroups, 0);
    assert.equal(countRows(h.db, GROUP_ID), 1);
  } finally {
    h.cleanup();
  }
});
