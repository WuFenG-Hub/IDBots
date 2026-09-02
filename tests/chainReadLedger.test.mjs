import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js')
  .catch(() => import('../dist-electron/nativeSqliteDatabase.js'));
const { ChainContentHistoryStore } = await import('../dist-electron/main/chainContentHistoryStore.js')
  .catch(() => import('../dist-electron/chainContentHistoryStore.js'));
const {
  getChainContentHistoryStore,
  setChainContentHistoryStore,
} = await import('../dist-electron/main/chainContentHistoryRuntime.js')
  .catch(() => import('../dist-electron/chainContentHistoryRuntime.js'));
const {
  readInputFromMetawebPin,
  readInputFromSocialPost,
  readInputFromOmniJson,
  recordChainReadSafe,
  markChainReadSavedToKbSafe,
} = await import('../dist-electron/main/libs/chainReadLedger.js')
  .catch(() => import('../dist-electron/libs/chainReadLedger.js'));

const setup = () => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new ChainContentHistoryStore(db, () => {});
  setChainContentHistoryStore(store);
  return { db, store };
};

const teardown = () => {
  setChainContentHistoryStore(null);
};

const makePin = (overrides = {}) => ({
  pinId: 'tx-aaa'.padEnd(64, 'a') + 'i0',
  currentPinId: 'tx-aaa'.padEnd(64, 'a') + 'i0',
  protocol: 'simplenote',
  path: '/protocols/simplenote',
  chainName: 'mvc',
  operation: 'create',
  creator: { globalMetaId: 'gm-author', metaid: 'metaid-1', name: 'Author', address: 'addr' },
  createdAt: 1_700_000_000,
  contentType: 'text/plain',
  payload: null,
  text: 'full article body',
  truncated: false,
  totalLength: 18,
  meta: { title: 'Deep article', summary: '', tags: [] },
  attachments: [],
  source: 'local',
  ...overrides,
});

const makePost = (overrides = {}) => ({
  pinId: 'tx-bbb'.padEnd(64, 'b') + 'i0',
  sourcePinId: 'tx-bbb'.padEnd(64, 'b') + 'i0',
  currentPinId: 'tx-bbb'.padEnd(64, 'b') + 'i0',
  chainName: 'mvc',
  protocolPath: '/protocols/simplebuzz',
  author: { globalMetaId: 'gm-poster', metaId: 'metaid-2', address: 'addr2' },
  contentType: 'text/plain;utf-8',
  payload: { content: 'buzz body text', contentType: 'text/plain;utf-8', attachments: [] },
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  likeCount: 0,
  commentCount: 0,
  donateCount: 0,
  quoteCount: 0,
  ...overrides,
});

// --- readInputFromMetawebPin ------------------------------------------------

test('readInputFromMetawebPin maps a normalized pin', () => {
  const input = readInputFromMetawebPin(makePin(), 7, 'read_metaweb_pin');
  assert.ok(input);
  assert.equal(input.metabotId, 7);
  assert.equal(input.pinId, makePin().pinId);
  assert.equal(input.path, '/protocols/simplenote');
  assert.equal(input.protocol, 'simplenote');
  assert.equal(input.title, 'Deep article');
  assert.equal(input.authorGlobalMetaId, 'gm-author');
  assert.equal(input.contentText, 'full article body');
  assert.equal(input.contentBytes, null, 'byte size is computed by the store');
  assert.equal(input.source, 'read_metaweb_pin');
  assert.ok(input.readAtMs > 0);
});

test('readInputFromMetawebPin tolerates missing fields', () => {
  const input = readInputFromMetawebPin({
    pinId: 'pin-minimal',
    protocol: '',
    path: '',
    creator: {},
    meta: {},
    text: null,
  }, 7, 'read_metaweb_pin');
  assert.ok(input);
  assert.equal(input.pinId, 'pin-minimal');
  assert.equal(input.path, null);
  assert.equal(input.protocol, null);
  assert.equal(input.title, null);
  assert.equal(input.authorGlobalMetaId, null);
  assert.equal(input.contentText, null);
});

test('readInputFromMetawebPin skips without a pin id or bot attribution', () => {
  assert.equal(readInputFromMetawebPin(makePin({ pinId: '  ' }), 7, 'read_metaweb_pin'), null);
  assert.equal(readInputFromMetawebPin(makePin(), null, 'read_metaweb_pin'), null);
  assert.equal(readInputFromMetawebPin(makePin(), undefined, 'read_metaweb_pin'), null);
  assert.equal(readInputFromMetawebPin(makePin(), Number.NaN, 'read_metaweb_pin'), null);
});

// --- readInputFromSocialPost -------------------------------------------------

test('readInputFromSocialPost maps a post detail', () => {
  const input = readInputFromSocialPost(makePost(), 9);
  assert.ok(input);
  assert.equal(input.metabotId, 9);
  assert.equal(input.pinId, makePost().pinId);
  assert.equal(input.path, '/protocols/simplebuzz');
  assert.equal(input.protocol, null, 'posts carry no normalized protocol field');
  assert.equal(input.title, null, 'buzz posts have no title');
  assert.equal(input.authorGlobalMetaId, 'gm-poster');
  assert.equal(input.contentText, 'buzz body text');
  assert.equal(input.source, 'social_post_detail');
});

test('readInputFromSocialPost tolerates empty payload and attribution gaps', () => {
  const noPayload = readInputFromSocialPost(makePost({ payload: null }), 9);
  assert.ok(noPayload);
  assert.equal(noPayload.contentText, null);
  assert.equal(readInputFromSocialPost(makePost({ pinId: '' }), 9), null);
  assert.equal(readInputFromSocialPost(makePost(), null), null);
});

// --- readInputFromOmniJson ---------------------------------------------------

test('readInputFromOmniJson unwraps the code/data envelope', () => {
  const json = {
    code: 0,
    data: {
      pinId: 'tx-envelope',
      path: '/protocols/simplebuzz',
      contentBody: 'hello omni',
      title: 'Buzz title',
      creator: { globalMetaId: 'gm-creator' },
    },
  };
  const input = readInputFromOmniJson('pin', json, 'tx-envelope', 7);
  assert.ok(input);
  assert.equal(input.pinId, 'tx-envelope');
  assert.equal(input.path, '/protocols/simplebuzz');
  assert.equal(input.contentText, 'hello omni');
  assert.equal(input.title, 'Buzz title');
  assert.equal(input.authorGlobalMetaId, 'gm-creator');
  assert.equal(input.source, 'omni_read:pin');
});

test('readInputFromOmniJson accepts alternate key spellings', () => {
  const lower = readInputFromOmniJson('pin', { pinid: 'tx-lower', content: 'c1' }, 'fallback', 7);
  assert.equal(lower.pinId, 'tx-lower');
  assert.equal(lower.contentText, 'c1');
  const topAuthor = readInputFromOmniJson('pin', { pinId: 'tx-top', globalmetaid: 'gm-top' }, 'fallback', 7);
  assert.equal(topAuthor.authorGlobalMetaId, 'gm-top');
  const authorObj = readInputFromOmniJson('pin', { pinId: 'tx-a2', author: { globalMetaId: 'gm-a2' } }, 'fallback', 7);
  assert.equal(authorObj.authorGlobalMetaId, 'gm-a2');
});

test('readInputFromOmniJson falls back to the requested pin id', () => {
  const input = readInputFromOmniJson('buzz_info', { code: 0, data: { content: 'buzz body' } }, 'tx-fallback', 7);
  assert.ok(input);
  assert.equal(input.pinId, 'tx-fallback');
  assert.equal(input.contentText, 'buzz body');
  assert.equal(input.source, 'omni_read:buzz_info');
});

test('readInputFromOmniJson records the raw body string for pin_content', () => {
  const input = readInputFromOmniJson('pin_content', 'raw content body', 'tx-content', 7);
  assert.ok(input);
  assert.equal(input.pinId, 'tx-content');
  assert.equal(input.contentText, 'raw content body');
  assert.equal(input.source, 'omni_read:pin_content');
});

test('readInputFromOmniJson skips error envelopes and unmappable payloads', () => {
  assert.equal(readInputFromOmniJson('pin', { code: -1, message: 'not found' }, 'tx-err', 7), null);
  assert.equal(readInputFromOmniJson('pin', null, 'tx-null', 7), null);
  assert.equal(readInputFromOmniJson('pin', 42, 'tx-num', 7), null);
  assert.equal(readInputFromOmniJson('pin', ['a', 'b'], 'tx-arr', 7), null);
  assert.equal(readInputFromOmniJson('pin', { content: 'x' }, '  ', 7), null, 'no pin id anywhere');
  assert.equal(readInputFromOmniJson('pin_content', 'body', ' ', 7), null, 'string body needs fallback pin id');
  assert.equal(readInputFromOmniJson('pin', { pinId: 'tx-x' }, 'tx-x', null), null, 'no bot attribution');
});

// --- recordChainReadSafe ------------------------------------------------------

test('recordChainReadSafe is a silent no-op without a store', () => {
  setChainContentHistoryStore(null);
  assert.doesNotThrow(() => recordChainReadSafe(readInputFromMetawebPin(makePin(), 7, 'read_metaweb_pin')));
  assert.equal(getChainContentHistoryStore(), null);
});

test('recordChainReadSafe skips null input and unattributed metabot ids', () => {
  const { store } = setup();
  try {
    recordChainReadSafe(null);
    recordChainReadSafe(readInputFromMetawebPin(makePin(), null, 'read_metaweb_pin'));
    recordChainReadSafe({ metabotId: null, pinId: 'tx-x', source: 'read_metaweb_pin', readAtMs: 1 });
    assert.equal(store.getReadByPinId(7, makePin().pinId), null, 'nothing recorded');
    assert.equal(store.getReadByPinId(7, 'tx-x'), null);
  } finally {
    teardown();
  }
});

test('recordChainReadSafe never throws when the store fails', () => {
  setChainContentHistoryStore({
    recordRead: () => {
      throw new Error('db is gone');
    },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.doesNotThrow(() => recordChainReadSafe(readInputFromMetawebPin(makePin(), 7, 'read_metaweb_pin')));
    assert.equal(warnings.length, 1, 'failure surfaces as console.warn only');
  } finally {
    console.warn = originalWarn;
    teardown();
  }
});

// --- end-to-end against the real store ---------------------------------------

test('end-to-end: read lands in metabot_chain_reads, re-read bumps count, KB backfill flags the row', () => {
  const { store } = setup();
  try {
    const pin = makePin();
    recordChainReadSafe(readInputFromMetawebPin(pin, 7, 'read_metaweb_pin'));
    let row = store.getReadByPinId(7, pin.pinId);
    assert.ok(row, 'read recorded');
    assert.equal(row.readCount, 1);
    assert.equal(row.source, 'read_metaweb_pin');
    assert.equal(row.title, 'Deep article');
    assert.equal(row.contentExcerpt, 'full article body');
    assert.equal(row.contentBytes, Buffer.byteLength('full article body', 'utf8'));
    assert.equal(row.savedToKb, false);

    // A re-read refreshes the excerpt and bumps the counters.
    recordChainReadSafe(readInputFromMetawebPin(makePin({ text: 'updated body' }), 7, 'read_metaweb_pin'));
    row = store.getReadByPinId(7, pin.pinId);
    assert.equal(row.readCount, 2);
    assert.equal(row.contentExcerpt, 'updated body');
    assert.ok(row.lastReadAtMs >= row.firstReadAtMs);

    // knowledge_base_add_document back-fills saved_to_kb for metaweb sources.
    markChainReadSavedToKbSafe(7, pin.pinId, 'kb-1');
    row = store.getReadByPinId(7, pin.pinId);
    assert.equal(row.savedToKb, true);
    assert.equal(row.kbId, 'kb-1');

    // Unknown pins / unattributed bots are silent no-ops.
    markChainReadSavedToKbSafe(7, 'tx-unknown', 'kb-1');
    markChainReadSavedToKbSafe(null, pin.pinId, 'kb-2');
    row = store.getReadByPinId(7, pin.pinId);
    assert.equal(row.kbId, 'kb-1', 'unattributed backfill changed nothing');
  } finally {
    teardown();
  }
});

test('end-to-end: omni pin_content read lands with its source tag', () => {
  const { store } = setup();
  try {
    recordChainReadSafe(readInputFromOmniJson('pin_content', 'article text', 'tx-omni-1', 8));
    const row = store.getReadByPinId(8, 'tx-omni-1');
    assert.ok(row);
    assert.equal(row.metabotId, 8);
    assert.equal(row.source, 'omni_read:pin_content');
    assert.equal(row.contentExcerpt, 'article text');
  } finally {
    teardown();
  }
});
