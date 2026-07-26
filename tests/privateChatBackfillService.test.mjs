import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSqliteStore,
  getRow,
} from './memoryTestUtils.mjs';

let computeUnprocessedAfterTimestampSec;
let createPrivateChatBackfillLoop;
try {
  ({
    computeUnprocessedAfterTimestampSec,
    createPrivateChatBackfillLoop,
  } = await import('../dist-electron/main/services/privateChatBackfillService.js'));
} catch {
  ({
    computeUnprocessedAfterTimestampSec,
    createPrivateChatBackfillLoop,
  } = await import('../dist-electron/services/privateChatBackfillService.js'));
}

const LOCAL_GLOBAL_META_ID = 'idq1local';
const PEER_GLOBAL_META_ID = 'idq1peer';
const MAPPED_PEER_GLOBAL_META_ID = 'idq1mappeer';
const LOCAL_IDENTITY = { metabotId: 1, globalMetaId: LOCAL_GLOBAL_META_ID };

function seedPrivateChatRow(db, input) {
  db.run(
    `INSERT INTO private_chat_messages (
      pin_id, tx_id, from_metaid, from_global_metaid, from_name, from_avatar, from_chat_pubkey,
      to_metaid, to_global_metaid, protocol, content, content_type, encryption, reply_pin,
      chain_timestamp, chain, raw_data, is_processed
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, 'ecdh', '', ?, 'mvc', '{}', ?)`,
    [
      input.pinId,
      input.txId ?? null,
      input.fromMetaId ?? '',
      input.fromGlobalMetaId ?? null,
      input.toMetaId ?? '',
      input.toGlobalMetaId ?? null,
      input.protocol ?? '/protocols/simplemsg',
      input.content ?? 'cipher',
      input.chainTimestamp ?? null,
      input.isProcessed ?? 1,
    ],
  );
}

function historyMessage(pinId, timestamp) {
  return {
    index: 1,
    txId: pinId.replace(/i\d+$/, ''),
    pinId,
    from: 'peer-meta',
    fromGlobalMetaId: PEER_GLOBAL_META_ID,
    fromUserInfo: {},
    to: 'local-meta',
    toGlobalMetaId: LOCAL_GLOBAL_META_ID,
    toUserInfo: {},
    protocol: '/protocols/simplemsg',
    content: 'U2FsdGVkX1cipher',
    contentType: 'text/markdown',
    encryption: 'ecdh',
    replyPin: '',
    timestamp,
    chain: 'mvc',
    raw: { pinId },
  };
}

function getProcessedFlag(db, pinId) {
  return getRow(db, 'SELECT is_processed FROM private_chat_messages WHERE pin_id = ?', [pinId])
    ?.is_processed;
}

function createHarness(overrides = {}) {
  const directoryCalls = [];
  const historyCalls = [];
  const state = {
    nowMs: overrides.nowMs ?? 1_785_000_000_000,
    directoryList: overrides.directoryList ?? [],
    directoryFails: overrides.directoryFails ?? false,
    historyMessages: overrides.historyMessages ?? [],
  };
  const deps = {
    getLocalIdentities: () => [LOCAL_IDENTITY],
    historySync: {
      async fetchRecentConversationMessages(params) {
        historyCalls.push(params);
        return typeof state.historyMessages === 'function'
          ? state.historyMessages(params)
          : state.historyMessages;
      },
    },
    fetchDirectoryJson: async (url) => {
      directoryCalls.push(url);
      if (state.directoryFails) {
        throw new Error('directory offline');
      }
      return { data: { list: state.directoryList } };
    },
    now: () => state.nowMs,
    emitLog: () => undefined,
    ...(overrides.deps ?? {}),
  };
  return { state, deps, directoryCalls, historyCalls };
}

test('computeUnprocessedAfterTimestampSec uses overlap behind the latest stored timestamp', () => {
  assert.equal(
    computeUnprocessedAfterTimestampSec({
      latestLocalTimestampSec: 10_000,
      nowSec: 20_000,
    }),
    9_700,
  );
  assert.equal(
    computeUnprocessedAfterTimestampSec({
      latestLocalTimestampSec: 10_000,
      nowSec: 20_000,
      overlapSec: 0,
    }),
    10_000,
  );
});

test('computeUnprocessedAfterTimestampSec falls back to the catch-up window for new pairs', () => {
  assert.equal(
    computeUnprocessedAfterTimestampSec({
      latestLocalTimestampSec: null,
      nowSec: 100_000,
      catchUpWindowSec: 3_600,
    }),
    96_400,
  );
});

test('backfill recovers a directory peer whose last pin is missing locally', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-old',
      fromGlobalMetaId: LOCAL_GLOBAL_META_ID,
      toGlobalMetaId: PEER_GLOBAL_META_ID,
      chainTimestamp: 10_000,
    });
    const harness = createHarness({
      directoryList: [{
        globalMetaId: PEER_GLOBAL_META_ID,
        groupId: '',
        lastMessagePinId: 'pin-c',
        timestamp: 9_900,
      }],
      historyMessages: [
        historyMessage('pin-a', 9_800),
        historyMessage('pin-b', 9_000),
        historyMessage('pin-c', 9_900),
      ],
    });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 1);
    assert.equal(result.inserted, 3);
    assert.equal(result.failedPeers, 0);
    assert.deepEqual(
      harness.historyCalls.map((call) => [call.metaId, call.otherMetaId]),
      [[LOCAL_GLOBAL_META_ID, PEER_GLOBAL_META_ID]],
    );
    assert.ok(harness.directoryCalls.every((url) => url.includes(`metaId=${LOCAL_GLOBAL_META_ID}`)));
    // Threshold = latest local (10_000) - overlap (300) = 9_700: the two
    // fresher rows are queued for the daemon, the older one is archived.
    assert.equal(getProcessedFlag(sqlite.db, 'pin-a'), 0);
    assert.equal(getProcessedFlag(sqlite.db, 'pin-c'), 0);
    assert.equal(getProcessedFlag(sqlite.db, 'pin-b'), 1);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill skips a directory peer whose last pin is already stored', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-seen',
      fromGlobalMetaId: PEER_GLOBAL_META_ID,
      toGlobalMetaId: LOCAL_GLOBAL_META_ID,
      chainTimestamp: 10_000,
    });
    const harness = createHarness({
      directoryList: [{
        globalMetaId: PEER_GLOBAL_META_ID,
        groupId: '',
        lastMessagePinId: 'pin-seen',
        timestamp: 10_000,
      }],
    });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 0);
    assert.equal(result.inserted, 0);
    assert.equal(harness.historyCalls.length, 0);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill only treats recent messages from a brand-new peer as live', async () => {
  const sqlite = await createSqliteStore();
  try {
    const nowMs = 1_785_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const harness = createHarness({
      nowMs,
      directoryList: [{
        globalMetaId: PEER_GLOBAL_META_ID,
        groupId: '',
        lastMessagePinId: 'pin-new',
        timestamp: nowSec - 3_600,
      }],
      historyMessages: [
        historyMessage('pin-new', nowSec - 3_600),
        historyMessage('pin-ancient', nowSec - 7 * 3_600),
      ],
    });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 1);
    assert.equal(result.inserted, 2);
    assert.equal(getProcessedFlag(sqlite.db, 'pin-new'), 0);
    assert.equal(getProcessedFlag(sqlite.db, 'pin-ancient'), 1);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill throttles probes for local-only peers the directory does not list', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-x',
      fromGlobalMetaId: PEER_GLOBAL_META_ID,
      toGlobalMetaId: LOCAL_GLOBAL_META_ID,
      chainTimestamp: 5_000,
    });
    const harness = createHarness({ directoryList: [] });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const first = await loop.syncOnce();
    assert.equal(first.probedPeers, 1);

    const second = await loop.syncOnce();
    assert.equal(second.probedPeers, 0);

    harness.state.nowMs += 61_000;
    const third = await loop.syncOnce();
    assert.equal(third.probedPeers, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill probes local peers when the directory is unavailable', async () => {
  const sqlite = await createSqliteStore();
  try {
    seedPrivateChatRow(sqlite.db, {
      pinId: 'pin-x',
      fromGlobalMetaId: PEER_GLOBAL_META_ID,
      toGlobalMetaId: LOCAL_GLOBAL_META_ID,
      chainTimestamp: 5_000,
    });
    const harness = createHarness({ directoryFails: true });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 1);
    assert.equal(harness.historyCalls.length, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('backfill discovers peers from A2A session mappings', async () => {
  const sqlite = await createSqliteStore();
  try {
    sqlite.db.run(
      `INSERT INTO cowork_conversation_mappings (
        channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at
      ) VALUES ('metaweb_private', ?, 1, 'session-1', '{}', 1, 1)`,
      [`metaweb-private:${MAPPED_PEER_GLOBAL_META_ID}`],
    );
    const harness = createHarness({ directoryList: [] });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.equal(result.probedPeers, 1);
    assert.deepEqual(
      harness.historyCalls.map((call) => call.otherMetaId),
      [MAPPED_PEER_GLOBAL_META_ID],
    );
  } finally {
    sqlite.cleanup();
  }
});

test('backfill is a no-op while private chats are disabled', async () => {
  const sqlite = await createSqliteStore();
  try {
    const harness = createHarness({
      directoryList: [{
        globalMetaId: PEER_GLOBAL_META_ID,
        groupId: '',
        lastMessagePinId: 'pin-new',
        timestamp: 9_900,
      }],
    });
    const loop = createPrivateChatBackfillLoop({
      db: sqlite.db,
      saveDb: () => undefined,
      shouldRun: () => false,
      ...harness.deps,
    });

    const result = await loop.syncOnce();

    assert.deepEqual(result, { identities: 0, probedPeers: 0, inserted: 0, failedPeers: 0 });
    assert.equal(harness.historyCalls.length, 0);
    assert.equal(harness.directoryCalls.length, 0);
  } finally {
    sqlite.cleanup();
  }
});
