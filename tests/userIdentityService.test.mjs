import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { createMetaBotWallet } = await import('../dist-electron/main/services/metabotWalletService.js');
const {
  createUserIdentity,
  importUserIdentity,
  logoutUserIdentity,
  resumeUserIdentitySetup,
  retryUserIdentitySubsidy,
  syncUserIdentityToChain,
  buildUserInfoSyncSteps,
  updateUserIdentityName,
} = await import('../dist-electron/main/services/userIdentityService.js');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Official BIP39 24-word test vector (256-bit zero entropy).
const TEST_MNEMONIC_24 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';
const AVATAR_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-user-identity-svc-'));

const makeStores = async () => {
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
  const store = await SqliteStore.create(makeTempDir());
  const userStore = new UserIdentityStore(store.getDatabase(), () => store.save());
  return { store, userStore };
};

const makePinMock = (behavior) => {
  const calls = [];
  let n = 0;
  const fn = async (params) => {
    n += 1;
    calls.push({
      ...params,
      // Record a copy: the service mutates one shared sessionSnapshot across calls.
      excludeOutpointsSnapshot: [...(params.sessionSnapshot?.excludeOutpoints ?? [])],
    });
    const stepKey = params.metaidData.path;
    const failure = behavior?.failOn?.includes(stepKey);
    if (failure) throw new Error(`pin ${stepKey} failed`);
    return {
      txids: [`tx-${n}`],
      pinId: `pin-${n}`,
      totalCost: 100,
      spentOutpoints: [`spent-${n}:0`],
      changeUtxo: null,
    };
  };
  return { fn, calls };
};

const baseDeps = (pinMock) => ({
  createPin: pinMock.fn,
  requestSubsidy: async () => ({ success: true }),
  sleep: async () => {},
});

test('createUserIdentity publishes name/avatar/chatpubkey and stores chat pin id', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const result = await createUserIdentity(userStore, { name: 'Alice', avatar: AVATAR_DATA_URL }, baseDeps(pinMock));

  assert.equal(result.success, true);
  assert.equal(result.mnemonic.split(' ').length, 12);
  assert.equal(result.identity.name, 'Alice');
  assert.ok(result.identity.globalmetaid);

  const paths = pinMock.calls.map((c) => c.metaidData.path);
  assert.deepEqual(paths, ['/info/name', '/info/avatar', '/info/chatpubkey']);
  // Outpoints are threaded between sequential pins to avoid double-spend.
  assert.deepEqual(pinMock.calls[1].excludeOutpointsSnapshot, ['spent-1:0']);

  const saved = userStore.get();
  assert.equal(saved.chat_public_key_pin_id, 'pin-3');
  assert.equal(result.chainSync.success, true);
  store.close();
});

test('createUserIdentity keeps local identity when a pin step fails', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock({ failOn: ['/info/avatar'] });
  const result = await createUserIdentity(userStore, { name: 'Alice', avatar: AVATAR_DATA_URL }, baseDeps(pinMock));

  assert.equal(result.success, true);
  assert.equal(result.chainSync.success, false);
  assert.deepEqual(result.chainSync.failedSteps, ['avatar']);
  assert.ok(userStore.get());
  // Remaining steps still attempted after the failure.
  assert.equal(pinMock.calls.length, 3);
  store.close();
});

test('createUserIdentity rejects when an identity already exists', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(pinMock));
  const again = await createUserIdentity(userStore, { name: 'Bob' }, baseDeps(pinMock));
  assert.equal(again.success, false);
  assert.equal(again.error, 'USER_IDENTITY_EXISTS');
  store.close();
});

test('importUserIdentity with on-chain profile reuses it and publishes nothing', async () => {
  const { store, userStore } = await makeStores();
  const wallet = await createMetaBotWallet({ mnemonic: TEST_MNEMONIC });
  const pinMock = makePinMock();
  const result = await importUserIdentity(
    userStore,
    { mnemonic: TEST_MNEMONIC },
    {
      ...baseDeps(pinMock),
      fetchProfile: async () => ({
        name: 'On Chain Alice',
        avatarDataUrl: AVATAR_DATA_URL,
        metabotInfoPinId: null,
        chatpubkeyPinId: 'chat-pin-1',
        bio: {},
        raw: { chatpubkey: wallet.chat_public_key },
      }),
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.profileSource, 'chain');
  assert.equal(result.identity.name, 'On Chain Alice');
  assert.equal(result.identity.chat_public_key_pin_id, 'chat-pin-1');
  assert.equal(pinMock.calls.length, 0);
  store.close();
});

test('importUserIdentity without on-chain profile imports with empty name, publishes only chatpubkey', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const deps = {
    ...baseDeps(pinMock),
    fetchProfile: async () => { throw new Error('CHAIN_INFO_EMPTY'); },
  };

  const result = await importUserIdentity(userStore, { mnemonic: TEST_MNEMONIC }, deps);
  assert.equal(result.success, true);
  assert.equal(result.profileSource, 'local');
  assert.equal(result.identity.name, '');
  assert.equal(result.identity.avatar, null);
  const paths = pinMock.calls.map((c) => c.metaidData.path);
  assert.deepEqual(paths, ['/info/chatpubkey']);
  store.close();
});

test('importUserIdentity accepts a valid 24-word mnemonic (Metalet-compatible)', async () => {
  const { store, userStore } = await makeStores();
  const wallet24 = await createMetaBotWallet({ mnemonic: TEST_MNEMONIC_24 });
  const pinMock = makePinMock();
  const result = await importUserIdentity(
    userStore,
    { mnemonic: TEST_MNEMONIC_24 },
    {
      ...baseDeps(pinMock),
      fetchProfile: async () => ({
        name: 'Twenty Four',
        avatarDataUrl: null,
        metabotInfoPinId: null,
        chatpubkeyPinId: 'chat-pin-24',
        bio: {},
        raw: { chatpubkey: wallet24.chat_public_key },
      }),
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.identity.name, 'Twenty Four');
  assert.equal(userStore.get()?.mvc_address, wallet24.mvc_address);
  store.close();
});

test('importUserIdentity rejects chat pubkey mismatch (wrong derivation path)', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const result = await importUserIdentity(
    userStore,
    { mnemonic: TEST_MNEMONIC },
    {
      ...baseDeps(pinMock),
      fetchProfile: async () => ({
        name: 'On Chain Alice',
        avatarDataUrl: null,
        metabotInfoPinId: null,
        chatpubkeyPinId: 'chat-pin-1',
        bio: {},
        raw: { chatpubkey: 'deadbeef' },
      }),
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.error, 'CHAT_PUBKEY_MISMATCH');
  assert.equal(userStore.get(), null);
  store.close();
});

test('importUserIdentity rejects invalid mnemonics and surfaces fetch failures', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();

  const bad = await importUserIdentity(userStore, { mnemonic: 'foo bar baz' }, baseDeps(pinMock));
  assert.equal(bad.error, 'INVALID_MNEMONIC');

  const wrongChecksum = await importUserIdentity(
    userStore,
    { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon' },
    baseDeps(pinMock),
  );
  assert.equal(wrongChecksum.error, 'INVALID_MNEMONIC');

  // 15 words is a valid BIP39 length but intentionally unsupported (12/24 only).
  const fifteenWords = await importUserIdentity(
    userStore,
    { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon admit' },
    baseDeps(pinMock),
  );
  assert.equal(fifteenWords.error, 'INVALID_MNEMONIC');

  const fetchDown = await importUserIdentity(userStore, { mnemonic: TEST_MNEMONIC }, {
    ...baseDeps(pinMock),
    fetchProfile: async () => { throw new Error('network down'); },
  });
  assert.equal(fetchDown.success, false);
  assert.equal(fetchDown.error, 'network down');
  store.close();
});

test('logout deletes the identity and allows a fresh create', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(pinMock));
  assert.equal(logoutUserIdentity(userStore), true);
  assert.equal(userStore.get(), null);
  assert.equal(logoutUserIdentity(userStore), false);

  const recreated = await createUserIdentity(userStore, { name: 'Alice 2' }, baseDeps(pinMock));
  assert.equal(recreated.success, true);
  store.close();
});

test('buildUserInfoSyncSteps only republishes missing chatpubkey on retry', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock({ failOn: ['/info/chatpubkey'] });
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(pinMock));

  const identity = userStore.get();
  assert.equal(identity.chat_public_key_pin_id, null);
  const steps = buildUserInfoSyncSteps(identity, { includeProfileSteps: false });
  assert.deepEqual(steps.map((s) => s.key), ['chatpubkey']);

  const retryMock = makePinMock();
  const retry = await syncUserIdentityToChain(userStore, { includeProfileSteps: false }, baseDeps(retryMock));
  assert.equal(retry.success, true);
  assert.equal(retryMock.calls.length, 1);
  assert.equal(userStore.get().chat_public_key_pin_id, 'pin-1');
  store.close();
});

test('updateUserIdentityName publishes /info/name first, then updates local', async () => {
  const { store, userStore } = await makeStores();
  const createPinMock = makePinMock();
  await importUserIdentity(userStore, { mnemonic: TEST_MNEMONIC }, {
    ...baseDeps(createPinMock),
    fetchProfile: async () => { throw new Error('CHAIN_INFO_EMPTY'); },
  });
  assert.equal(userStore.get().name, '');

  const renameMock = makePinMock();
  const result = await updateUserIdentityName(userStore, { name: '  Alice Named  ' }, baseDeps(renameMock));
  assert.equal(result.success, true);
  assert.equal(result.identity.name, 'Alice Named');
  assert.equal(renameMock.calls.length, 1);
  assert.equal(renameMock.calls[0].metaidData.path, '/info/name');
  assert.equal(renameMock.calls[0].metaidData.payload, 'Alice Named');
  assert.equal(userStore.get().name, 'Alice Named');
  store.close();
});

test('updateUserIdentityName keeps local name when the pin fails', async () => {
  const { store, userStore } = await makeStores();
  const createPinMock = makePinMock();
  await createUserIdentity(userStore, { name: 'Original' }, baseDeps(createPinMock));

  const failMock = { fn: async () => { throw new Error('worker died'); }, calls: [] };
  const result = await updateUserIdentityName(userStore, { name: 'New Name' }, baseDeps(failMock));
  assert.equal(result.success, false);
  assert.equal(result.error, 'worker died');
  assert.equal(userStore.get().name, 'Original');
  store.close();
});

test('updateUserIdentityName validates input and identity presence', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();

  const missing = await updateUserIdentityName(userStore, { name: 'X' }, baseDeps(pinMock));
  assert.equal(missing.error, 'USER_IDENTITY_MISSING');

  await createUserIdentity(userStore, { name: 'Original' }, baseDeps(pinMock));
  const empty = await updateUserIdentityName(userStore, { name: '   ' }, baseDeps(pinMock));
  assert.equal(empty.error, 'NAME_EMPTY');

  const same = await updateUserIdentityName(userStore, { name: 'Original' }, baseDeps(pinMock));
  assert.equal(same.success, true);
  assert.equal(userStore.get().name, 'Original');
  store.close();
});

test('createUserIdentity skips on-chain pins when subsidy fails and keeps identity', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  const result = await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.subsidy.success, false);
  assert.equal(result.chainSync, undefined);
  assert.equal(pinMock.calls.length, 0);
  const saved = userStore.get();
  assert.equal(saved.subsidy_state, 'failed');
  assert.equal(saved.subsidy_error, 'not enough balance');
  assert.equal(saved.sync_state, 'failed');
  store.close();
});

test('retryUserIdentitySubsidy re-claims the subsidy and clears the error', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );
  assert.equal(userStore.get().subsidy_state, 'failed');

  const result = await retryUserIdentitySubsidy(userStore, baseDeps(pinMock));
  assert.equal(result.success, true);
  assert.equal(result.subsidy.success, true);
  assert.equal(userStore.get().subsidy_state, 'claimed');
  assert.equal(userStore.get().subsidy_error, null);
  // Retry subsidy alone never writes pins.
  assert.equal(pinMock.calls.length, 0);
  store.close();
});

test('resumeUserIdentitySetup claims subsidy then publishes only missing pins', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );
  assert.equal(userStore.get().subsidy_state, 'failed');
  assert.equal(pinMock.calls.length, 0);

  const resumeMock = makePinMock();
  const resumed = await resumeUserIdentitySetup(userStore, baseDeps(resumeMock));
  assert.equal(resumed.subsidy.success, true);
  assert.equal(resumed.chainSync.success, true);
  assert.equal(userStore.get().subsidy_state, 'claimed');
  assert.equal(userStore.get().chat_public_key_pin_id, 'pin-2');
  assert.equal(userStore.get().name_pin_id, 'pin-1');
  assert.equal(userStore.get().sync_state, 'synced');
  assert.deepEqual(resumeMock.calls.map((c) => c.metaidData.path), ['/info/name', '/info/chatpubkey']);
  store.close();
});

test('resumeUserIdentitySetup only republishes pins that are still missing', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock({ failOn: ['/info/name'] });
  await createUserIdentity(userStore, { name: 'Alice' }, baseDeps(pinMock));
  // name failed (no avatar supplied); chatpubkey succeeded.
  assert.equal(userStore.get().name_pin_id, null);
  assert.equal(userStore.get().avatar_pin_id, null);
  assert.equal(userStore.get().chat_public_key_pin_id, 'pin-2');

  const retryMock = makePinMock();
  const resumed = await resumeUserIdentitySetup(userStore, baseDeps(retryMock));
  assert.equal(resumed.success, true);
  assert.equal(resumed.chainSync.success, true);
  assert.deepEqual(retryMock.calls.map((c) => c.metaidData.path), ['/info/name']);
  assert.equal(userStore.get().name_pin_id, 'pin-1');
  store.close();
});

test('updateUserIdentityName rejects with SUBSIDY_NOT_CLAIMED when subsidy failed', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );
  assert.equal(userStore.get().subsidy_state, 'failed');

  const result = await updateUserIdentityName(userStore, { name: 'Bob' }, baseDeps(pinMock));
  assert.equal(result.success, false);
  assert.equal(result.error, 'SUBSIDY_NOT_CLAIMED');
  assert.equal(pinMock.calls.length, 0);
  assert.equal(userStore.get().name, 'Alice');
  store.close();
});

test('retryChainSync (resume) still reports failure when subsidy cannot be claimed', async () => {
  const { store, userStore } = await makeStores();
  const pinMock = makePinMock();
  await createUserIdentity(
    userStore,
    { name: 'Alice' },
    {
      ...baseDeps(pinMock),
      requestSubsidy: async () => ({ success: false, error: 'not enough balance' }),
    },
  );

  const resumed = await resumeUserIdentitySetup(userStore, {
    ...baseDeps(pinMock),
    requestSubsidy: async () => ({ success: false, error: 'still not enough balance' }),
  });
  assert.equal(resumed.subsidy.success, false);
  assert.equal(resumed.chainSync.success, false);
  assert.equal(userStore.get().subsidy_state, 'failed');
  assert.equal(pinMock.calls.length, 0);
  store.close();
});
