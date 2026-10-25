import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { H1, pid } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { createUserPreferenceWriter } = require('../dist-electron/main/services/preference/userWriter.js');
const { createHumanIdentityPinWriter } = require('../dist-electron/main/services/humanIdentityPinWriter.js');

const IDENTITY = {
  mnemonic: 'word '.repeat(12).trim(),
  path: "m/44'/10001'/0'/0/0",
  globalmetaid: H1,
  subsidy_state: 'claimed',
  chat_public_key_pin_id: pid(1),
};

const fakeCreatePin = () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const createPin = async (params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({ ...params, excludeAtCall: [...params.sessionSnapshot.excludeOutpoints] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const n = calls.length;
    return {
      txids: [`${String(n).padStart(64, '0')}`],
      pinId: pid(700 + n),
      totalCost: 1,
      spentOutpoints: [`out${n}:0`],
      changeUtxo: { txId: `change${n}`, outputIndex: 1, satoshis: 1000 },
    };
  };
  return { calls, createPin, maxActive: () => maxActive };
};

test('writes are serialized and thread spent outpoints between pins', async () => {
  const fake = fakeCreatePin();
  const resolve = createUserPreferenceWriter({ get: () => IDENTITY }, { createPin: fake.createPin, feeRate: () => 2 });
  const writer = resolve();
  assert.equal(writer.globalMetaId, H1);
  const [first, second] = await Promise.all([
    writer.write('commit', { round: pid(1), hash: 'a'.repeat(64) }),
    resolve().write('reveal', { round: pid(1) }),
  ]);
  assert.equal(first.pinId, pid(701));
  assert.equal(second.pinId, pid(702));
  assert.equal(fake.maxActive(), 1);
  assert.deepEqual(fake.calls[1].excludeAtCall, ['out1:0']);
  assert.deepEqual(fake.calls[0].metaidData, {
    operation: 'create',
    path: '/protocols/preference/commit',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify({ round: pid(1), hash: 'a'.repeat(64) }),
  });
  assert.deepEqual(fake.calls[0].options, { feeRate: 2 });
  assert.equal(fake.calls[0].mnemonic, IDENTITY.mnemonic);
});

test('a failed write does not block the queue', async () => {
  let calls = 0;
  const createPin = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Not enough balance');
    return { txids: ['t'], pinId: pid(900), totalCost: 1 };
  };
  const resolve = createUserPreferenceWriter({ get: () => IDENTITY }, { createPin, feeRate: () => 1 });
  await assert.rejects(resolve().write('commit', {}), /Not enough balance/);
  assert.equal((await resolve().write('commit', {})).pinId, pid(900));
});

test('identity and subsidy gates', () => {
  const deps = { createPin: async () => ({ txids: [], pinId: '', totalCost: 0 }), feeRate: () => 1 };
  assert.deepEqual(createUserPreferenceWriter({ get: () => null }, deps)(), { error: 'USER_IDENTITY_MISSING' });
  assert.deepEqual(createUserPreferenceWriter({ get: () => ({ ...IDENTITY, globalmetaid: null }) }, deps)(), {
    error: 'USER_IDENTITY_MISSING',
  });
  assert.deepEqual(createUserPreferenceWriter({ get: () => ({ ...IDENTITY, subsidy_state: 'failed' }) }, deps)(), {
    error: 'SUBSIDY_NOT_CLAIMED',
  });
  assert.deepEqual(
    createUserPreferenceWriter({ get: () => ({ ...IDENTITY, subsidy_state: null, chat_public_key_pin_id: null }) }, deps)(),
    { error: 'SUBSIDY_NOT_CLAIMED' },
  );
});

test('a shared pin writer produces equivalent sealed writes (shared queue with the browser path)', async () => {
  const fake = fakeCreatePin();
  const writePin = createHumanIdentityPinWriter({ get: () => IDENTITY }, { createPin: fake.createPin, feeRate: () => 3 });
  const resolve = createUserPreferenceWriter({ get: () => IDENTITY }, {
    createPin: fake.createPin,
    feeRate: () => 3,
    pinWriter: writePin,
  });
  const writer = resolve();
  assert.equal(writer.globalMetaId, H1);
  const [first, second] = await Promise.all([
    writer.write('commit', { round: pid(2), hash: 'b'.repeat(64) }),
    writer.write('reveal', { round: pid(2), pick: 'a' }),
  ]);
  assert.equal(first.pinId, pid(701));
  assert.equal(second.pinId, pid(702));
  assert.equal(fake.maxActive(), 1);
  assert.deepEqual(fake.calls[0].metaidData, {
    operation: 'create',
    path: '/protocols/preference/commit',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify({ round: pid(2), hash: 'b'.repeat(64) }),
  });
  assert.deepEqual(fake.calls[0].options, { feeRate: 3 });
  assert.deepEqual(fake.calls[1].excludeAtCall, ['out1:0']);
});

test('the shared writer surfaces gate failures as thrown sentinel errors', async () => {
  const fake = fakeCreatePin();
  const writePin = createHumanIdentityPinWriter({ get: () => null }, { createPin: fake.createPin, feeRate: () => 1 });
  const resolve = createUserPreferenceWriter({ get: () => IDENTITY }, {
    createPin: fake.createPin,
    feeRate: () => 1,
    pinWriter: writePin,
  });
  // resolve() still passes its own gate; the execution-time gate in the
  // shared writer throws (identity removed between resolve and write).
  const writer = resolve();
  await assert.rejects(writer.write('commit', {}), /USER_IDENTITY_MISSING/);
});

test('a sealed write queued before identity replacement fails instead of signing as the new identity', async () => {
  let identity = IDENTITY;
  const store = { get: () => identity };
  const fake = fakeCreatePin();
  const resolve = createUserPreferenceWriter(store, { createPin: fake.createPin, feeRate: () => 1 });
  const writer = resolve();
  assert.equal(writer.globalMetaId, H1);

  // The identity the caller resolved to (A) is replaced by B before the
  // write executes; the shared writer must refuse to sign as B.
  identity = { ...IDENTITY, mnemonic: 'other '.repeat(12).trim(), globalmetaid: pid(9) };
  const thrown = await writer.write('commit', { round: pid(1) }).then(
    () => null,
    (error) => error,
  );
  assert.ok(thrown, 'write must reject');
  assert.equal(thrown.code, 'IDENTITY_MISMATCH');
  assert.match(thrown.message, /IDENTITY_MISMATCH/);
  assert.equal(fake.calls.length, 0);
});

test('resolve() passes its captured identity to the shared writer as expectedGlobalMetaId', async () => {
  const seenOptions = [];
  const pinWriter = async (metaidData, options) => {
    seenOptions.push(options);
    return { ok: true, pinId: pid(800), txids: ['t'], totalCost: 1 };
  };
  const resolve = createUserPreferenceWriter({ get: () => IDENTITY }, {
    createPin: fakeCreatePin().createPin,
    feeRate: () => 1,
    pinWriter,
  });
  await resolve().write('commit', {});
  assert.deepEqual(seenOptions, [{ expectedGlobalMetaId: H1 }]);
});
