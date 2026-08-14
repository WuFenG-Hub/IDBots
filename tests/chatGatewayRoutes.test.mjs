/**
 * Mega-Phase M4 (R-M4.1) chat gateway route tests.
 *
 * Pure route-logic tests for `handlePrivateSendRoute` /
 * `handlePrivateHistoryRoute` (chatGatewayRoutes.ts): validation error paths
 * plus a REAL encrypted-send round (mnemonic → ECDH encrypt → create-pin
 * capture) proving the simplemsg payload shape, and a history mapping test.
 *
 * Live route availability in the installed app requires this PR to be merged
 * and the app rebuilt (same gate as PR #15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveCompiledModulePath(relative) {
  const candidates = [`../dist-electron/main/${relative}`, `../dist-electron/${relative}`];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      /* try next */
    }
  }
  throw new Error(`cannot resolve compiled module: ${relative}`);
}

const { handlePrivateSendRoute, handlePrivateHistoryRoute } = require(
  resolveCompiledModulePath('services/chatGatewayRoutes.js')
);

// A real mnemonic + the derived public key (self-chat ECDH works for tests).
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const PEER_GMID = 'idq1l7fz6v96qn64kpq8ekn7qvjzhkk45afccvg9va'; // 小红 (worker)

const { getPrivateKeyBufferForEcdh } = require(
  resolveCompiledModulePath('services/metabotWalletService.js')
);

let PEER_PUBKEY = '';
async function ensurePeerPubkey() {
  if (PEER_PUBKEY) return PEER_PUBKEY;
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const priv = await getPrivateKeyBufferForEcdh(MNEMONIC, WALLET_PATH);
  PEER_PUBKEY = Buffer.from(secp256k1.getPublicKey(new Uint8Array(priv), true)).toString('hex');
  return PEER_PUBKEY;
}

function makeSendDeps(overrides = {}) {
  let captured = null;
  const deps = {
    getWalletMnemonic: () => MNEMONIC,
    resolvePeerChatPubkey: async () => PEER_PUBKEY,
    createSimplemsgPin: async (metabotId, payload) => {
      captured = { metabotId, payload };
      return { pinId: `${'a'.repeat(64)}i0`, txids: ['tx1'] };
    },
    readHistory: async () => [],
  };
  return { deps: { ...deps, ...overrides }, getCaptured: () => captured };
}

test('send: validation errors (bad JSON, missing fields, bad ids, empty content)', async () => {
  const { deps } = makeSendDeps();
  assert.equal((await handlePrivateSendRoute(deps, '{not json')).status, 400);
  assert.equal((await handlePrivateSendRoute(deps, '{}')).status, 400);
  assert.equal((await handlePrivateSendRoute(deps, JSON.stringify({ metabot_id: 0, to_global_meta_id: 'x', content: 'hi' }))).status, 400);
  assert.equal((await handlePrivateSendRoute(deps, JSON.stringify({ metabot_id: 9, to_global_meta_id: '', content: 'hi' }))).status, 400);
  assert.equal((await handlePrivateSendRoute(deps, JSON.stringify({ metabot_id: 9, to_global_meta_id: 'x', content: '  ' }))).status, 400);
});

test('send: no wallet → 400 (mnemonic never exposed)', async () => {
  const { deps } = makeSendDeps({ getWalletMnemonic: () => '' });
  const result = await handlePrivateSendRoute(deps, JSON.stringify({ metabot_id: 9, to_global_meta_id: PEER_GMID, content: 'hi' }));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /no wallet/);
  assert.ok(!JSON.stringify(result).includes(MNEMONIC), 'mnemonic must not leak into the response');
});

test('send: peer chat pubkey unavailable → 400', async () => {
  const { deps } = makeSendDeps({ resolvePeerChatPubkey: async () => '' });
  const result = await handlePrivateSendRoute(deps, JSON.stringify({ metabot_id: 9, to_global_meta_id: PEER_GMID, content: 'hi' }));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /peer chat pubkey/);
});

test('send: REAL encrypted simplemsg payload (ECDH) via captured create-pin', async () => {
  await ensurePeerPubkey();
  const { deps, getCaptured } = makeSendDeps();
  const result = await handlePrivateSendRoute(
    deps,
    JSON.stringify({ metabot_id: 9, to_global_meta_id: PEER_GMID, content: 'hello 小红', reply_pin: 'replyPinId' })
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.match(result.body.pinId, /^[0-9a-f]{64}i0$/);
  const captured = getCaptured();
  assert.ok(captured, 'create-pin was invoked');
  assert.equal(captured.payload.path, '/protocols/simplemsg');
  assert.equal(captured.payload.operation, 'create');
  const body = JSON.parse(captured.payload.payload);
  assert.equal(body.to, PEER_GMID);
  assert.equal(body.encrypt, 'ecdh');
  assert.equal(body.replyPin, 'replyPinId');
  assert.notEqual(body.content, 'hello 小红', 'content is encrypted, never plaintext');
});

test('send: oversized content → 400', async () => {
  const { deps } = makeSendDeps();
  const big = 'x'.repeat(70 * 1024);
  const result = await handlePrivateSendRoute(deps, JSON.stringify({ metabot_id: 9, to_global_meta_id: PEER_GMID, content: big }));
  assert.equal(result.status, 400);
});

test('history: validation + mapping', async () => {
  const rows = [
    { id: 1, direction: 'in', content: 'from peer', timestamp: 1000 },
    { id: 2, direction: 'out', content: 'to peer', timestamp: 2000 },
  ];
  const deps = { readHistory: async () => rows };
  assert.equal((await handlePrivateHistoryRoute(deps, '{}')).status, 400);
  assert.equal((await handlePrivateHistoryRoute(deps, JSON.stringify({ metabot_id: 9, peer_global_meta_id: '' }))).status, 400);
  const ok = await handlePrivateHistoryRoute(deps, JSON.stringify({ metabot_id: 9, peer_global_meta_id: PEER_GMID, limit: 10 }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.messages.length, 2);
  assert.equal(ok.body.messages[1].content, 'to peer');
  assert.equal(ok.body.peer, PEER_GMID);
});
