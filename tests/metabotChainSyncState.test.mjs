/**
 * Chain-sync partial state (FR4, wish-team-builder phase 1).
 *
 * Covers the no-balance-pre-gate create contract, the duplicate-name gate, and
 * the persisted chainSyncPending plan that powers the My Bots partial badge and
 * the one-click re-sync. Runs against the compiled electron output like the
 * other metabot manage tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const {
  createMetaBotOnChainCore,
  updateMetaBotCore,
  readChainSyncPending,
  deriveChainSyncState,
  getMetabotChainSyncState,
  applyChainSyncProgress,
  recordFullSyncOutcome,
} = require('../dist-electron/main/services/metabotManageService.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-chain-sync-'));

const openStore = async () => {
  const tempDir = makeTempDir();
  const sqlite = await SqliteStore.create(tempDir);
  return new MetabotStore(sqlite.getDatabase(), sqlite.getSaveFunction());
};

const fakeWallet = (n) => ({
  mnemonic: `mnemonic-${n}`,
  path: "m/44'/10001'/0'/0/0",
  mvc_address: `mvc-${n}`,
  btc_address: `btc-${n}`,
  doge_address: `doge-${n}`,
  public_key: `pk-${n}`,
  chat_public_key: `cpk-${n}`,
  metaid: `metaid-${n}`,
  globalmetaid: `gmid-${n}`,
});

const seedMetabot = (store, { name, infoPinId = null, n = Math.floor(Math.random() * 1e9) }) => {
  const wallet = store.insertMetabotWallet({ mnemonic: fakeWallet(n).mnemonic, path: fakeWallet(n).path });
  return store.createMetabot({
    wallet_id: wallet.id,
    mvc_address: fakeWallet(n).mvc_address,
    btc_address: fakeWallet(n).btc_address,
    doge_address: fakeWallet(n).doge_address,
    public_key: fakeWallet(n).public_key,
    chat_public_key: fakeWallet(n).chat_public_key,
    chat_public_key_pin_id: null,
    name,
    enabled: true,
    metaid: fakeWallet(n).metaid,
    globalmetaid: fakeWallet(n).globalmetaid,
    metabot_info_pinid: infoPinId,
    metabot_type: 'worker',
    created_by: '0000',
    role: '',
    soul: '',
    llm_id: 'deepseek',
  });
};

const mockDeps = (store, overrides = {}) => ({
  store,
  createWallet: overrides.createWallet ?? (async () => fakeWallet(3000)),
  requestSubsidy: overrides.requestSubsidy ?? (async () => ({ success: true })),
  signOwnerBinding: async () => ({ payload: 'signed-owner-payload' }),
  syncToChain:
    overrides.syncToChain ??
    (async () => ({
      success: true,
      txids: ['tx-1'],
      plannedSteps: ['name', 'chatpubkey', 'llm'],
      syncedSteps: ['name', 'chatpubkey', 'llm'],
    })),
  syncEditChanges:
    overrides.syncEditChanges ??
    (async (_store, input) => ({
      success: true,
      txids: ['tx-edit-1'],
      syncedSteps: Object.entries(input)
        .filter(([key, value]) => key.startsWith('sync') && value === true)
        .map(([key]) => key.replace('sync', '').toLowerCase()),
    })),
  onAfterMutation: () => {},
  getOwnerGlobalMetaId: () => 'owner_gmid',
  getLlmProviders: () => undefined,
});

// ---------------------------------------------------------------------------
// create: no balance pre-gate
// ---------------------------------------------------------------------------

test('create: proceeds with no balance pre-gate — an unfunded wallet is stopped by the chain broadcast, not locally', async () => {
  const store = await openStore();
  // A stray balance reader on deps must be ignored: the FR4-era local gate
  // misread MVC's permanently-0-conf subsidy funds as "no money" and rejected
  // every fresh wallet (the 2026-09 v0.6.1 creation outage). The real guard
  // is the mandatory name-pin broadcast failing and rolling the DB back.
  const deps = {
    ...mockDeps(store),
    checkWalletBalance: async () => 0,
  };
  const res = await createMetaBotOnChainCore({ name: 'ZeroConf', llm_id: 'deepseek' }, deps);
  assert.equal(res.success, true);
  assert.equal(store.listMetabots().length, 1);
});

// ---------------------------------------------------------------------------
// create: duplicate-name gate
// ---------------------------------------------------------------------------

test('create: duplicate name refuses with NAME_ALREADY_EXISTS before wallet generation', async () => {
  const store = await openStore();
  seedMetabot(store, { name: 'Trend Scout' });
  let walletCalls = 0;
  const deps = mockDeps(store, {
    createWallet: async () => {
      walletCalls += 1;
      return fakeWallet(4000);
    },
  });
  const res = await createMetaBotOnChainCore({ name: 'Trend Scout', llm_id: 'deepseek' }, deps);
  assert.equal(res.success, false);
  assert.match(res.error, /NAME_ALREADY_EXISTS/);
  assert.equal(walletCalls, 0, 'rejected before wallet generation');
  assert.equal(store.listMetabots().length, 1, 'no second row created');
});

// ---------------------------------------------------------------------------
// create: partial publish persistence
// ---------------------------------------------------------------------------

test('create: partial publish persists the unpublished steps as chainSyncPending', async () => {
  const store = await openStore();
  const deps = mockDeps(store, {
    // name confirmed, the rest of the plan failed -> canSkip partial.
    syncToChain: async () => ({
      success: false,
      canSkip: true,
      error: 'insufficient fee',
      txids: ['tx-name'],
      plannedSteps: ['name', 'chatpubkey', 'llm'],
      syncedSteps: ['name'],
    }),
  });
  const res = await createMetaBotOnChainCore({ name: 'Partial', llm_id: 'deepseek' }, deps);
  assert.equal(res.success, true);
  assert.equal(res.chainPartial, true);
  const bot = store.listMetabots().find((m) => m.name === 'Partial');
  assert.ok(bot, 'partial bot kept locally');
  const pending = readChainSyncPending(store, bot.id);
  assert.deepEqual(pending.remainingSteps.sort(), ['chatpubkey', 'llm']);
  assert.equal(pending.error, 'insufficient fee');
  // Derived view: pending wins over any pin id.
  const view = getMetabotChainSyncState(store, bot);
  assert.equal(view.state, 'partial');
  assert.deepEqual(view.pendingSteps.sort(), ['chatpubkey', 'llm']);
});

test('create: fully confirmed create clears chainSyncPending', async () => {
  const store = await openStore();
  const deps = mockDeps(store);
  const res = await createMetaBotOnChainCore({ name: 'Clean', llm_id: 'deepseek' }, deps);
  assert.equal(res.success, true);
  const bot = store.listMetabots().find((m) => m.name === 'Clean');
  assert.equal(readChainSyncPending(store, bot.id), null);
});

// ---------------------------------------------------------------------------
// deriveChainSyncState: chain-honest, never a false synced
// ---------------------------------------------------------------------------

test('deriveChainSyncState: synced requires a confirmed pin id', () => {
  assert.equal(deriveChainSyncState({ metabot_info_pinid: 'abc', globalmetaid: 'g' }, null).state, 'synced');
  assert.equal(
    deriveChainSyncState({ metabot_info_pinid: '  ', globalmetaid: 'g' }, null).state,
    'partial',
    'blank pin id is partial (legacy badge fallback)',
  );
  assert.equal(
    deriveChainSyncState({ metabot_info_pinid: null, globalmetaid: 'g' }, null).state,
    'partial',
  );
});

test('deriveChainSyncState: a pending plan wins over a pin id', () => {
  const view = deriveChainSyncState(
    { metabot_info_pinid: 'pin-1', globalmetaid: 'g' },
    { remainingSteps: ['bio'], updatedAt: 1 },
  );
  assert.equal(view.state, 'partial');
  assert.deepEqual(view.pendingSteps, ['bio']);
});

test('readChainSyncPending: empty step list reads as null (cleared marker)', async () => {
  const store = await openStore();
  const bot = seedMetabot(store, { name: 'Cleared' });
  store.setMetabotSetting(bot.id, 'chainSyncPending', JSON.stringify({ remainingSteps: [], updatedAt: 1 }));
  assert.equal(readChainSyncPending(store, bot.id), null);
  // And a derive over it falls back to the pin-id check.
  assert.equal(getMetabotChainSyncState(store, bot).state, 'partial', 'no pin id on record');
});

// ---------------------------------------------------------------------------
// applyChainSyncProgress / recordFullSyncOutcome (re-sync folding)
// ---------------------------------------------------------------------------

test('applyChainSyncProgress: folds confirmed steps and clears when the last one lands', async () => {
  const store = await openStore();
  const bot = seedMetabot(store, { name: 'Resync' });
  store.setMetabotSetting(
    bot.id,
    'chainSyncPending',
    JSON.stringify({ remainingSteps: ['bio', 'persona', 'llm'], updatedAt: 1 }),
  );
  applyChainSyncProgress(store, bot.id, ['bio']);
  assert.deepEqual(readChainSyncPending(store, bot.id).remainingSteps.sort(), ['llm', 'persona']);
  applyChainSyncProgress(store, bot.id, ['llm', 'persona']);
  assert.equal(readChainSyncPending(store, bot.id), null, 'plan cleared once nothing is left');
  // Further progress on a cleared plan is a no-op.
  applyChainSyncProgress(store, bot.id, ['bio']);
  assert.equal(readChainSyncPending(store, bot.id), null);
});

test('recordFullSyncOutcome: full resync outcome replaces the plan', async () => {
  const store = await openStore();
  const bot = seedMetabot(store, { name: 'FullResync', infoPinId: 'pin-old' });
  store.setMetabotSetting(
    bot.id,
    'chainSyncPending',
    JSON.stringify({ remainingSteps: ['llm'], updatedAt: 1 }),
  );
  recordFullSyncOutcome(store, bot.id, {
    plannedSteps: ['name', 'chatpubkey', 'llm'],
    syncedSteps: ['name', 'chatpubkey', 'llm'],
  });
  assert.equal(readChainSyncPending(store, bot.id), null);
});

// ---------------------------------------------------------------------------
// updateMetaBotCore: partial edit persistence
// ---------------------------------------------------------------------------

test('updateMetaBotCore: partial edit persists pending; complete edit clears it', async () => {
  const store = await openStore();
  const bot = seedMetabot(store, { name: 'Editor', infoPinId: 'pin-1' });

  // Partial edit: only persona of (persona, bio) confirmed. The core's
  // auto-retry re-calls the same mock, which re-confirms persona, so the
  // persisted plan holds exactly the still-unpublished step: bio.
  const partialDeps = mockDeps(store, {
    syncEditChanges: async () => ({
      success: false,
      canSkip: true,
      error: 'fee too low',
      txids: ['tx-p'],
      syncedSteps: ['persona'],
    }),
  });
  const partial = await updateMetaBotCore(bot.id, { bio: 'new bio', soul: 'new soul' }, partialDeps);
  assert.equal(partial.success, true);
  let pending = readChainSyncPending(store, bot.id);
  assert.deepEqual(pending.remainingSteps, ['bio']);
  assert.equal(getMetabotChainSyncState(store, bot).state, 'partial');

  // Complete re-edit of the same fields clears the plan.
  const deps = mockDeps(store);
  const done = await updateMetaBotCore(bot.id, { bio: 'newer bio', soul: 'newer soul' }, deps);
  assert.equal(done.success, true);
  assert.equal(readChainSyncPending(store, bot.id), null, 'fully confirmed edit clears pending');
});
