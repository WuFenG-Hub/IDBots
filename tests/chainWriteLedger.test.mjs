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
  shouldRecordChainWrite,
  recordChainWriteFromCreatePin,
} = await import('../dist-electron/main/libs/chainWriteLedger.js')
  .catch(() => import('../dist-electron/libs/chainWriteLedger.js'));

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

const CHAT_PATHS = [
  '/protocols/simplemsg',
  '/protocols/simplegroupcreate',
  '/protocols/simplegroupjoin',
  '/protocols/simplegroupremoveuser',
  '/protocols/simplegroupchat',
];

const INTERNAL_ORIGINS = [
  'internal:group-task-deliverable',
  'internal:service-order',
  'internal:metaapp',
  'internal:gig-square',
  'internal:private-chat',
  'internal:group-chat',
  'internal:identity-sync',
];

test('shouldRecordChainWrite excludes chat protocol paths', () => {
  for (const path of CHAT_PATHS) {
    assert.equal(shouldRecordChainWrite({ path }), false, path);
  }
});

test('shouldRecordChainWrite excludes /info/ identity sync paths', () => {
  assert.equal(shouldRecordChainWrite({ path: '/info/name' }), false);
  assert.equal(shouldRecordChainWrite({ path: '/info/avatar' }), false);
  assert.equal(shouldRecordChainWrite({ path: '/info/chatpubkey' }), false);
});

test('shouldRecordChainWrite excludes internal origins with dedicated tables', () => {
  for (const origin of INTERNAL_ORIGINS) {
    assert.equal(shouldRecordChainWrite({ origin }), false, origin);
    // The origin rule wins even for otherwise-recordable paths.
    assert.equal(shouldRecordChainWrite({ path: '/protocols/simplenote', origin }), false, origin);
  }
});

test('shouldRecordChainWrite records everything else', () => {
  assert.equal(shouldRecordChainWrite({ path: '/protocols/simplebuzz' }), true);
  assert.equal(shouldRecordChainWrite({ path: '/protocols/simplenote' }), true);
  assert.equal(shouldRecordChainWrite({ path: '/file' }), true);
  assert.equal(shouldRecordChainWrite({ path: '/protocols/paylike' }), true);
  assert.equal(shouldRecordChainWrite({ path: '/protocols/simplebuzz', origin: 'tool:post_buzz' }), true);
  assert.equal(shouldRecordChainWrite({ path: '/protocols/paycomment', origin: 'tool:omni_cast' }), true);
  assert.equal(shouldRecordChainWrite({ path: '/file', origin: 'tool:upload_file' }), true);
  assert.equal(shouldRecordChainWrite({ path: '/protocols/simplebuzz', origin: 'rpc' }), true);
  assert.equal(shouldRecordChainWrite({}), true);
  assert.equal(shouldRecordChainWrite({ path: null, origin: null }), true);
});

const makeTextPin = (overrides = {}) => ({
  metaidData: {
    operation: 'create',
    path: '/protocols/simplebuzz',
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify({ content: 'hello ledger' }),
  },
  result: { txids: ['tx-abc'], pinId: 'tx-abci0', totalCost: 1000 },
  ...overrides,
});

test('recordChainWriteFromCreatePin records a text pin with full payload', () => {
  const { store } = setup();
  try {
    const { metaidData, result } = makeTextPin();
    recordChainWriteFromCreatePin(7, metaidData, result, 'tool:post_buzz');
    const row = store.getWriteByPinId('tx-abci0');
    assert.ok(row, 'write recorded');
    assert.equal(row.metabotId, 7);
    assert.equal(row.txId, 'tx-abc');
    assert.equal(row.path, '/protocols/simplebuzz');
    assert.equal(row.operation, 'create');
    assert.equal(row.contentText, metaidData.payload, 'text payload stored in full');
    assert.equal(row.contentBytes, Buffer.byteLength(metaidData.payload, 'utf8'));
    assert.equal(row.contentType, 'application/json');
    assert.equal(row.origin, 'tool:post_buzz');
    assert.ok(row.occurredAtMs > 0);
  } finally {
    teardown();
  }
});

test('recordChainWriteFromCreatePin skips sponsor draft-phase results', () => {
  const { store } = setup();
  try {
    const { metaidData } = makeTextPin();
    recordChainWriteFromCreatePin(7, metaidData, {
      txids: [],
      pinId: '',
      totalCost: 0,
      draft: { unsignedTxHex: 'deadbeef', estimatedTxSize: 500, feeRate: 1, userInputs: [], changeOutput: null },
    });
    assert.equal(store.listWritesForDay(7, 0, Date.now() + 1000).length, 0, 'draft is not a broadcast');
  } finally {
    teardown();
  }
});

test('recordChainWriteFromCreatePin skips empty pinId results', () => {
  const { store } = setup();
  try {
    const { metaidData } = makeTextPin();
    recordChainWriteFromCreatePin(7, metaidData, { txids: ['tx-x'], pinId: '  ', totalCost: 0 });
    assert.equal(store.listWritesForDay(7, 0, Date.now() + 1000).length, 0);
  } finally {
    teardown();
  }
});

test('recordChainWriteFromCreatePin skips excluded paths and origins', () => {
  const { store } = setup();
  try {
    const { result } = makeTextPin();
    recordChainWriteFromCreatePin(7, {
      operation: 'create',
      path: '/protocols/simplemsg',
      contentType: 'application/json',
      payload: '{"content":"encrypted"}',
    }, result);
    recordChainWriteFromCreatePin(7, {
      operation: 'create',
      path: '/info/name',
      contentType: 'text/plain',
      payload: 'Bot Name',
    }, result);
    recordChainWriteFromCreatePin(7, makeTextPin().metaidData, result, 'internal:service-order');
    assert.equal(store.getWriteByPinId('tx-abci0'), null, 'nothing excluded was recorded');
  } finally {
    teardown();
  }
});

test('recordChainWriteFromCreatePin stores Buffer payloads as metadata only', () => {
  const { store } = setup();
  try {
    const bytes = Buffer.from([1, 2, 3, 4, 5, 250, 255]);
    recordChainWriteFromCreatePin(7, {
      operation: 'create',
      path: '/file',
      contentType: 'image/png;binary',
      payload: bytes,
    }, { txids: ['tx-img'], pinId: 'tx-imgi0', totalCost: 2000 }, 'tool:upload_file');
    const row = store.getWriteByPinId('tx-imgi0');
    assert.ok(row);
    assert.equal(row.contentText, null, 'binary payload never stored as text');
    assert.equal(row.contentBytes, bytes.length);
    assert.equal(row.contentType, 'image/png;binary');
    assert.equal(row.origin, 'tool:upload_file');
  } finally {
    teardown();
  }
});

test('recordChainWriteFromCreatePin treats base64 string payloads as binary', () => {
  const { store } = setup();
  try {
    const raw = Buffer.from('binary-bytes-here');
    recordChainWriteFromCreatePin(7, {
      operation: 'create',
      path: '/file',
      contentType: 'application/octet-stream',
      payload: raw.toString('base64'),
      encoding: 'base64',
    }, { txids: ['tx-b64'], pinId: 'tx-b64i0', totalCost: 2000 });
    const row = store.getWriteByPinId('tx-b64i0');
    assert.ok(row);
    assert.equal(row.contentText, null);
    assert.equal(row.contentBytes, raw.length, 'decoded byte size recorded');
  } finally {
    teardown();
  }
});

test('recordChainWriteFromCreatePin is a silent no-op without a store', () => {
  setChainContentHistoryStore(null);
  const { metaidData, result } = makeTextPin();
  assert.doesNotThrow(() => recordChainWriteFromCreatePin(7, metaidData, result));
  assert.equal(getChainContentHistoryStore(), null);
});

test('recordChainWriteFromCreatePin never throws when the store fails', () => {
  setChainContentHistoryStore({
    recordWrite: () => {
      throw new Error('db is gone');
    },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const { metaidData, result } = makeTextPin();
    assert.doesNotThrow(() => recordChainWriteFromCreatePin(7, metaidData, result));
    assert.equal(warnings.length, 1, 'failure surfaces as console.warn only');
  } finally {
    console.warn = originalWarn;
    teardown();
  }
});
