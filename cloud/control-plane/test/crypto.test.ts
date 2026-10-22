import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decryptSecret,
  encryptSecret,
  maskPhone,
  sha256Hex,
  timingSafeEqualStr,
} from '../src/crypto.js';

const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 9);

describe('secret encryption (AES-256-GCM)', () => {
  test('encrypt/decrypt round-trips', () => {
    const secret = 'gw-secret-xyz';
    const encrypted = encryptSecret(KEY_A, secret);
    assert.notEqual(encrypted, secret);
    assert.equal(decryptSecret(KEY_A, encrypted), secret);
  });

  test('ciphertext carries a random IV (same plaintext encrypts differently)', () => {
    const a = encryptSecret(KEY_A, 'same');
    const b = encryptSecret(KEY_A, 'same');
    assert.notEqual(a, b);
  });

  test('tampering fails the GCM auth tag', () => {
    const encrypted = encryptSecret(KEY_A, 'top-secret');
    const blob = Buffer.from(encrypted, 'base64');
    blob[blob.length - 1] ^= 0xff; // flip bits in the auth tag
    assert.throws(() => decryptSecret(KEY_A, blob.toString('base64')));
  });

  test('decryption with the wrong key fails', () => {
    const encrypted = encryptSecret(KEY_A, 'top-secret');
    assert.throws(() => decryptSecret(KEY_B, encrypted));
  });

  test('truncated ciphertext is rejected', () => {
    assert.throws(() => decryptSecret(KEY_A, Buffer.alloc(8).toString('base64')));
  });
});

describe('hashing and comparison', () => {
  test('sha256Hex is stable and matches the known vector for "abc"', () => {
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(sha256Hex('abc'), sha256Hex('abc'));
    assert.notEqual(sha256Hex('abc'), sha256Hex('abd'));
  });

  test('timingSafeEqualStr compares constant-time style', () => {
    assert.equal(timingSafeEqualStr('same-value', 'same-value'), true);
    assert.equal(timingSafeEqualStr('same-value', 'same-value!'), false);
    assert.equal(timingSafeEqualStr('short', 'shorter'), false);
    assert.equal(timingSafeEqualStr('', ''), true);
  });
});

describe('phone masking', () => {
  test('masks the middle of a mainland number', () => {
    assert.equal(maskPhone('+8613800138000'), '+861****8000');
  });

  test('keeps short numbers safe', () => {
    assert.equal(maskPhone('+8611'), '****');
    assert.equal(maskPhone('+861234567'), '+861****4567');
  });
});
