import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHumanIdentityPinWriter,
  humanIdentitySigningAvailable,
} from '../src/main/services/humanIdentityPinWriter.ts';

const BASE = {
  mnemonic: 'word '.repeat(12).trim(),
  path: "m/44'/10001'/0'/0/0",
  globalmetaid: 'idq1human',
  subsidy_state: 'claimed',
  chat_public_key_pin_id: null,
};

function payload(path = '/protocols/preference/feedback') {
  return {
    operation: 'create',
    path,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: '{}',
  };
}

function fakeCreatePin() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const createPin = async (params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({
      ...params,
      excludeAtCall: [...params.sessionSnapshot.excludeOutpoints],
      preferredAtCall: [...params.sessionSnapshot.preferredFundingUtxos],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const n = calls.length;
    return {
      txids: [String(n).padStart(64, '0')],
      pinId: `pin-${n}i0`,
      totalCost: 1,
      spentOutpoints: [`out${n}:0`],
      changeUtxo: { txId: `change${n}`, outputIndex: 1, satoshis: 1000 },
    };
  };
  return { calls, createPin, maxActive: () => maxActive };
}

test('writes are serialized and thread spent outpoints between pins', async () => {
  const fake = fakeCreatePin();
  const store = { get: () => BASE };
  const writePin = createHumanIdentityPinWriter(store, { createPin: fake.createPin, feeRate: () => 2 });

  const [first, second] = await Promise.all([writePin(payload()), writePin(payload())]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(fake.maxActive(), 1);
  assert.equal(fake.calls[0].options, undefined === undefined ? fake.calls[0].options : undefined);
  assert.deepEqual(fake.calls[0].options, { feeRate: 2 });
  assert.deepEqual(fake.calls[1].excludeAtCall, ['out1:0']);
  assert.equal(fake.calls[0].metaidData.path, '/protocols/preference/feedback');
  assert.equal(fake.calls[1].metaidData.path, '/protocols/preference/feedback');
});

test('a failed write does not block the queue', async () => {
  let calls = 0;
  const createPin = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Not enough balance');
    return { txids: ['t'], pinId: 'pin-9i0', totalCost: 1 };
  };
  const writePin = createHumanIdentityPinWriter({ get: () => BASE }, { createPin, feeRate: () => 1 });
  await assert.rejects(writePin(payload()), /Not enough balance/);
  const second = await writePin(payload());
  assert.equal(second.ok, true);
  assert.equal(second.pinId, 'pin-9i0');
});

test('identity and subsidy gates return explicit errors without signing', async () => {
  let signed = 0;
  const createPin = async () => {
    signed += 1;
    return { txids: ['t'], pinId: 'pi0', totalCost: 0 };
  };
  const deps = { createPin, feeRate: () => 1 };

  const missing = await createHumanIdentityPinWriter({ get: () => null }, deps)(payload());
  assert.deepEqual(missing, { ok: false, error: 'USER_IDENTITY_MISSING' });

  const noMetaId = await createHumanIdentityPinWriter({ get: () => ({ ...BASE, globalmetaid: null }) }, deps)(payload());
  assert.deepEqual(noMetaId, { ok: false, error: 'USER_IDENTITY_MISSING' });

  const subsidyFailed = await createHumanIdentityPinWriter(
    { get: () => ({ ...BASE, subsidy_state: 'failed' }) },
    deps,
  )(payload());
  assert.deepEqual(subsidyFailed, { ok: false, error: 'SUBSIDY_NOT_CLAIMED' });

  const subsidyMissing = await createHumanIdentityPinWriter(
    { get: () => ({ ...BASE, subsidy_state: null, chat_public_key_pin_id: null }) },
    deps,
  )(payload());
  assert.deepEqual(subsidyMissing, { ok: false, error: 'SUBSIDY_NOT_CLAIMED' });

  assert.equal(signed, 0);
});

test('identity replacement resets the UTXO session snapshot', async () => {
  const fake = fakeCreatePin();
  let identity = BASE;
  const store = { get: () => identity };
  const writePin = createHumanIdentityPinWriter(store, { createPin: fake.createPin, feeRate: () => 1 });

  await writePin(payload());
  identity = { ...BASE, mnemonic: 'other '.repeat(12).trim() };
  await writePin(payload());

  assert.equal(fake.calls[1].mnemonic, identity.mnemonic);
  // The replaced wallet starts from a fresh UTXO session: neither the old
  // spent-outpoint exclusions nor the old change preference carry over.
  assert.deepEqual(fake.calls[1].excludeAtCall, []);
  assert.deepEqual(fake.calls[1].preferredAtCall, []);
});

test('a write queued before logout fails instead of signing the removed wallet', async () => {
  const fake = fakeCreatePin();
  let identity = BASE;
  const store = { get: () => identity };
  const writePin = createHumanIdentityPinWriter(store, { createPin: fake.createPin, feeRate: () => 1 });

  const first = writePin(payload());
  identity = null;
  assert.deepEqual(await first, { ok: false, error: 'USER_IDENTITY_MISSING' });
  assert.equal(fake.calls.length, 0);
});

test('missing pin id falls back to txidi0', async () => {
  const createPin = async () => ({ txids: ['txfallback'], pinId: '', totalCost: 1 });
  const outcome = await createHumanIdentityPinWriter(
    { get: () => BASE },
    { createPin, feeRate: () => 1 },
  )(payload());
  assert.deepEqual(outcome, { ok: true, pinId: 'txfallbacki0', txids: ['txfallback'] });
});

test('humanIdentitySigningAvailable mirrors the sealed writer usability predicate', () => {
  assert.equal(humanIdentitySigningAvailable(BASE), true);
  assert.equal(humanIdentitySigningAvailable({ ...BASE, subsidy_state: 'failed' }), false);
  assert.equal(humanIdentitySigningAvailable({ ...BASE, subsidy_state: null, chat_public_key_pin_id: null }), false);
  // Legacy identity with a chat pin but no subsidy state remains usable.
  assert.equal(humanIdentitySigningAvailable({ ...BASE, subsidy_state: null, chat_public_key_pin_id: 'pin1i0' }), true);
  assert.equal(humanIdentitySigningAvailable(null), false);
  assert.equal(humanIdentitySigningAvailable({ ...BASE, globalmetaid: null }), false);
});
