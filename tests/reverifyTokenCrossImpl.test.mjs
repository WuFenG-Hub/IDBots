import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const tokens = require('../dist-electron/main/gateway/tokens.js');

const SECRET = 'test-gateway-secret';
const TENANT = 't_testtenant0000000001';

// Mints exactly like the control plane (cloud/control-plane/src/routes/
// sensitive.ts): HMAC-SHA256 over the RAW JSON string, then
// base64url(payload) + "." + base64url(signature). Contract 01
// §"Sensitive Route: Mnemonic Export". Deliberately independent of
// tokens.signReverifyToken so a drift on either side fails this test.
function mintControlPlaneToken({ purpose = 'reveal-mnemonic', expiresAt, nonce }) {
  const payload = JSON.stringify({ t: TENANT, p: purpose, e: expiresAt, n: nonce });
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest();
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature.toString('base64url')}`;
}

test('reverify token: gateway verifies a control-plane-minted token (cross-implementation)', () => {
  const now = 1_800_000_000_000;
  const store = new tokens.NonceStore(() => now);
  const token = mintControlPlaneToken({ expiresAt: now + 120_000, nonce: 'nonce-cp-1' });
  const options = { nonceStore: store, expectedPurpose: 'reveal-mnemonic', now };
  assert.deepEqual(
    tokens.verifyReverifyToken(SECRET, TENANT, token, options),
    { t: TENANT, p: 'reveal-mnemonic', e: now + 120_000, n: 'nonce-cp-1' },
  );
  // Single use: the same token must fail once the nonce is claimed.
  assert.equal(tokens.verifyReverifyToken(SECRET, TENANT, token, options), null);
});

test('reverify token: signReverifyToken is byte-identical to the control-plane minter', () => {
  const expiresAt = 1_800_000_060_000;
  assert.equal(
    tokens.signReverifyToken(SECRET, TENANT, 'reveal-mnemonic', expiresAt, 'nonce-same'),
    mintControlPlaneToken({ expiresAt, nonce: 'nonce-same' }),
  );
});

test('reverify token: a signature over the base64url payload text is rejected', () => {
  // The old gateway interpretation — HMAC over the encoded payload text —
  // must not verify; the control plane signs the decoded JSON.
  const now = 1_800_000_000_000;
  const json = JSON.stringify({ t: TENANT, p: 'reveal-mnemonic', e: now + 120_000, n: 'nonce-legacy' });
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  const legacyToken = `${encoded}.${crypto.createHmac('sha256', SECRET).update(encoded).digest().toString('base64url')}`;
  assert.equal(tokens.verifyReverifyToken(SECRET, TENANT, legacyToken, { now }), null);
});
