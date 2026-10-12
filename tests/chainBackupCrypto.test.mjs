import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  deriveBackupKey,
  encryptJson,
  decryptJson,
  objectId,
  canonicalJson,
} = require('../dist-electron/main/services/chainBackupCrypto.js');

// A well-known valid 12-word test mnemonic (never holds funds).
const TEST_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const TEST_GID = 'idqtestglobalmetaid00000000000000000000001';

test('deriveBackupKey is deterministic for the same mnemonic + globalmetaid', () => {
  const a = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  const b = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
});

test('deriveBackupKey differs across globalmetaid and across mnemonics', () => {
  const base = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  const otherGid = deriveBackupKey(TEST_MNEMONIC, 'idqtestglobalmetaid00000000000000000000002');
  const otherMnemonic = deriveBackupKey(
    'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
    TEST_GID,
  );
  assert.notDeepEqual(base, otherGid);
  assert.notDeepEqual(base, otherMnemonic);
});

test('encryptJson → decryptJson round-trip restores the value', () => {
  const key = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  const value = { kind: 'memory', data: { text: 'remember the milk', n: 42, list: [1, 2, 3] } };
  const encrypted = encryptJson(key, value);
  assert.ok(encrypted.length > 28); // nonce + tag + body
  assert.deepEqual(decryptJson(key, encrypted), JSON.parse(canonicalJson(value)));
});

test('decryptJson rejects tampering and wrong keys', () => {
  const key = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  const encrypted = encryptJson(key, { secret: 'soul' });

  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptJson(key, tampered));

  const wrongKey = deriveBackupKey(TEST_MNEMONIC, 'idqtestglobalmetaid00000000000000000000002');
  assert.throws(() => decryptJson(wrongKey, encrypted));
});

test('objectId is stable regardless of key order and undefined fields', () => {
  const a = objectId({ kind: 'memory', data: { text: 'hi', extra: undefined, n: 1 } });
  const b = objectId({ data: { n: 1, text: 'hi' }, kind: 'memory' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});
