import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { ecdhDecrypt, computeEcdhSharedSecretSha256 } from '../src/main/services/metaWebCrypto';
import { getPrivateKeyBufferForEcdh } from '../src/main/services/metabotWalletService';
import {
  buildPrivateMessagePayload,
  sendEncryptedSimplemsg,
  type MetaidDataPayloadInput,
} from '../src/main/services/encryptedSimplemsg';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_WALLET_PATH = "m/44'/10001'/0'/0/0";

test('buildPrivateMessagePayload defaults to markdown simplemsg content type', () => {
  const payload = JSON.parse(buildPrivateMessagePayload({
    to: ' peer-global ',
    encryptedContent: 'encrypted',
    contentType: '   ',
    replyPin: ' reply-pin ',
    nowSeconds: 1_770_000_000,
  }));

  assert.deepEqual(payload, {
    to: 'peer-global',
    timestamp: 1_770_000_000,
    content: 'encrypted',
    contentType: 'text/markdown',
    encrypt: 'ecdh',
    replyPin: 'reply-pin',
  });
});

test('buildPrivateMessagePayload rejects malformed simplemsg body inputs', () => {
  assert.throws(
    () => buildPrivateMessagePayload({
      to: '   ',
      encryptedContent: 'encrypted',
      nowSeconds: 1_770_000_000,
    }),
    /to is required/,
  );
  assert.throws(
    () => buildPrivateMessagePayload({
      to: 'peer-global',
      encryptedContent: '   ',
      nowSeconds: 1_770_000_000,
    }),
    /encryptedContent is required/,
  );
  assert.throws(
    () => buildPrivateMessagePayload({
      to: 'peer-global',
      encryptedContent: 'encrypted',
      nowSeconds: Number.NaN,
    }),
    /timestamp/i,
  );
  assert.throws(
    () => buildPrivateMessagePayload({
      to: 'peer-global',
      encryptedContent: 'encrypted',
      nowSeconds: -1,
    }),
    /timestamp/i,
  );
});

test('sendEncryptedSimplemsg encrypts plaintext and writes a simplemsg pin', async () => {
  const peerEcdh = crypto.createECDH('prime256v1');
  peerEcdh.generateKeys();
  const peerChatPubkey = peerEcdh.getPublicKey('hex', 'uncompressed');
  const plaintext = ' 不要把这句明文直接放进 payload ';
  const txid = 'e'.repeat(64);
  let capturedMetabotId = 0;
  let capturedPayload: MetaidDataPayloadInput | null = null;

  const result = await sendEncryptedSimplemsg({
    metabotId: 7,
    wallet: {
      mnemonic: TEST_MNEMONIC,
      path: '   ',
    },
    peerGlobalMetaId: 'peer-global',
    peerChatPubkey,
    plaintext,
    replyPin: '',
    nowSeconds: () => 1_770_000_001,
    createPin: async (metabotId, payload) => {
      capturedMetabotId = metabotId;
      capturedPayload = payload;
      return { txids: [txid], pinId: `${txid}i0` };
    },
  });

  assert.deepEqual(result, { txids: [txid], pinId: `${txid}i0` });
  assert.equal(capturedMetabotId, 7);
  assert.ok(capturedPayload);
  assert.equal(capturedPayload.operation, 'create');
  assert.equal(capturedPayload.path, '/protocols/simplemsg');
  assert.equal(capturedPayload.encryption, '0');
  assert.equal(capturedPayload.version, '1.0.0');
  assert.equal(capturedPayload.contentType, 'application/json');

  const inner = JSON.parse(String(capturedPayload.payload));
  assert.equal(inner.to, 'peer-global');
  assert.equal(inner.timestamp, 1_770_000_001);
  assert.equal(inner.contentType, 'text/markdown');
  assert.notEqual(inner.content, plaintext);
  assert.ok(!String(capturedPayload.payload).includes(plaintext));
  const localPrivateKey = await getPrivateKeyBufferForEcdh(TEST_MNEMONIC, TEST_WALLET_PATH);
  const decrypted = ecdhDecrypt(
    inner.content,
    computeEcdhSharedSecretSha256(localPrivateKey, peerChatPubkey),
  );
  assert.equal(decrypted, plaintext);
});

test('sendEncryptedSimplemsg validates required send inputs', async () => {
  const peerEcdh = crypto.createECDH('prime256v1');
  peerEcdh.generateKeys();
  const validInput = {
    metabotId: 7,
    wallet: {
      mnemonic: TEST_MNEMONIC,
      path: TEST_WALLET_PATH,
    },
    peerGlobalMetaId: 'peer-global',
    peerChatPubkey: peerEcdh.getPublicKey('hex', 'uncompressed'),
    plaintext: 'hello',
    createPin: async () => ({ txids: ['e'.repeat(64)], pinId: `${'e'.repeat(64)}i0` }),
  };

  await assert.rejects(
    () => sendEncryptedSimplemsg({ ...validInput, metabotId: 0 }),
    /metabotId/i,
  );
  await assert.rejects(
    () => sendEncryptedSimplemsg({ ...validInput, wallet: { ...validInput.wallet, mnemonic: '   ' } }),
    /wallet mnemonic/i,
  );
  await assert.rejects(
    () => sendEncryptedSimplemsg({ ...validInput, peerGlobalMetaId: '   ' }),
    /peerGlobalMetaId/i,
  );
  await assert.rejects(
    () => sendEncryptedSimplemsg({ ...validInput, peerChatPubkey: '   ' }),
    /peerChatPubkey/i,
  );
  await assert.rejects(
    () => sendEncryptedSimplemsg({ ...validInput, plaintext: '   ' }),
    /plaintext/i,
  );
});
