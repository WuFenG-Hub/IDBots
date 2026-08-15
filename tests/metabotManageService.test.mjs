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
  applyMetabotUpdateLocal,
  buildEditSyncFlags,
  updateMetaBotCore,
  deleteMetaBotCore,
  listMetabotsForManagement,
  listConfiguredLlmProviders,
  requireMetabotLlmIdForCreate,
  assertCanCreateMetabot,
} = require('../dist-electron/main/services/metabotManageService.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metabot-manage-'));

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

/** Seed a wallet + metabot directly via the store (bypasses on-chain create). */
const seedMetabot = (store, { name, type = 'worker', llm_id = 'deepseek', n = Math.floor(Math.random() * 1e9) }) => {
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
    metabot_type: type,
    created_by: '0000',
    role: '',
    soul: '',
    llm_id: llm_id,
  });
};

/** Map an edit-sync input's true flags to real step keys (matches main's syncedSteps format). */
const STEP_FLAG_PAIRS = [
  ['name', 'syncName'],
  ['avatar', 'syncAvatar'],
  ['bio', 'syncBio'],
  ['persona', 'syncPersona'],
  ['llm', 'syncLlm'],
  ['chatSkills', 'syncChatSkills'],
  ['homepage', 'syncHomepage'],
  ['owner', 'syncOwner'],
];

const stepsFromInput = (input) =>
  STEP_FLAG_PAIRS.filter(([, flag]) => input[flag] === true).map(([step]) => step);

/** Mock chain deps; each field is overridable per-test. */
const mockDeps = (store, overrides = {}) => ({
  store,
  createWallet: overrides.createWallet ?? (async () => fakeWallet(1000)),
  requestSubsidy: overrides.requestSubsidy ?? (async () => ({ success: true })),
  signOwnerBinding:
    overrides.signOwnerBinding ?? (async () => ({ payload: 'signed-owner-payload' })),
  syncToChain:
    overrides.syncToChain ??
    (async () => ({ success: true, txids: ['tx-create-1'] })),
  syncEditChanges:
    overrides.syncEditChanges ??
    (async (_store, input) => ({
      success: true,
      txids: ['tx-edit-1'],
      syncedSteps: stepsFromInput(input),
    })),
  onAfterMutation: overrides.onAfterMutation ?? (() => {}),
  getOwnerGlobalMetaId: overrides.getOwnerGlobalMetaId ?? (() => 'owner_gmid'),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('requireMetabotLlmIdForCreate throws on empty and trims valid input', () => {
  assert.throws(() => requireMetabotLlmIdForCreate('  '), /LLM Brain is required/);
  assert.throws(() => requireMetabotLlmIdForCreate(undefined), /LLM Brain is required/);
  assert.equal(requireMetabotLlmIdForCreate('  deepseek  '), 'deepseek');
});

test('assertCanCreateMetabot is a no-op under the limit', () => {
  // A fresh store has 0 bots; should not throw.
  const store = { listMetabots: () => [] };
  assert.doesNotThrow(() => assertCanCreateMetabot(store));
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('createMetaBotOnChainCore: success persists bot, refreshes P2P, returns subsidy', async () => {
  const store = await openStore();
  let afterCalled = 0;
  const deps = mockDeps(store, { onAfterMutation: async () => { afterCalled += 1; } });
  const res = await createMetaBotOnChainCore(
    { name: 'Alice', llm_id: 'deepseek' },
    deps,
  );
  assert.equal(res.success, true);
  assert.equal(res.metabot.name, 'Alice');
  assert.equal(res.metabot.llm_id, 'deepseek');
  assert.equal(afterCalled, 1);
  // Persisted in store.
  const found = store.getMetabotById(res.metabot.id);
  assert.ok(found, 'created bot must be persisted');
  assert.equal(found.metabot_type, 'worker');
});

test('createMetaBotOnChainCore: mandatory chain failure rolls back the DB row', async () => {
  const store = await openStore();
  const deps = mockDeps(store, {
    syncToChain: async () => ({ success: false, canSkip: false, error: 'name pin failed' }),
  });
  const res = await createMetaBotOnChainCore({ name: 'Bob', llm_id: 'deepseek' }, deps);
  assert.equal(res.success, false);
  assert.equal(res.error, 'name pin failed');
  // Rolled back: no bots remain.
  assert.equal(store.listMetabots().length, 0);
});

test('createMetaBotOnChainCore: partial publish (canSkip) keeps the bot and surfaces chainError', async () => {
  const store = await openStore();
  const deps = mockDeps(store, {
    syncToChain: async () => ({ success: false, canSkip: true, error: 'avatar pin failed' }),
  });
  const res = await createMetaBotOnChainCore({ name: 'Cyndi', llm_id: 'deepseek' }, deps);
  assert.equal(res.success, true);
  assert.equal(res.chainPartial, true);
  assert.equal(res.chainError, 'avatar pin failed');
  assert.equal(store.listMetabots().length, 1);
});

test('createMetaBotOnChainCore: missing llm_id returns an error without creating', async () => {
  const store = await openStore();
  const res = await createMetaBotOnChainCore({ name: 'NoBrain' }, mockDeps(store));
  assert.equal(res.success, false);
  assert.match(res.error, /LLM Brain is required/);
  assert.equal(store.listMetabots().length, 0);
});

// ---------------------------------------------------------------------------
// update (local + flags + core)
// ---------------------------------------------------------------------------

test('applyMetabotUpdateLocal: writes fields and normalizes fallback llm', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Dev', llm_id: 'deepseek' });
  const res = applyMetabotUpdateLocal(store, m.id, {
    name: 'Dev2',
    fallback_llm_id: '  openai  ',
    bio: 'updated bio',
  }, { getOwnerGlobalMetaId: () => 'owner_gmid' });
  assert.equal(res.success, true);
  assert.equal(res.metabot.name, 'Dev2');
  assert.equal(res.metabot.fallback_llm_id, 'openai');
  assert.equal(res.metabot.bio, 'updated bio');
});

test('applyMetabotUpdateLocal: owner mismatch is rejected', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Ed' });
  const res = applyMetabotUpdateLocal(store, m.id, { boss_global_metaid: 'someone_else' }, {
    getOwnerGlobalMetaId: () => 'owner_gmid',
  });
  assert.equal(res.success, false);
  assert.equal(res.error, 'OWNER_IDENTITY_MISMATCH');
});

test('applyMetabotUpdateLocal: matching owner is accepted', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Ed' });
  const res = applyMetabotUpdateLocal(store, m.id, { boss_global_metaid: 'owner_gmid' }, {
    getOwnerGlobalMetaId: () => 'owner_gmid',
  });
  assert.equal(res.success, true);
});

test('buildEditSyncFlags: only changed fields are flagged', () => {
  const before = {
    id: 7, name: 'Old', avatar: 'a1', bio: 'b1', role: 'r1', soul: 's1', goal: 'g1',
    llm_id: 'deepseek', fallback_llm_id: '', allow_chat_skills: ['x'], homepage: null,
    boss_global_metaid: 'owner_gmid',
  };
  // Change only the name.
  const flags = buildEditSyncFlags(before, { name: 'New' });
  assert.equal(flags.syncName, true);
  assert.equal(flags.syncAvatar, false);
  assert.equal(flags.syncBio, false);
  assert.equal(flags.syncPersona, false);
  assert.equal(flags.syncLlm, false);
  assert.equal(flags.syncChatSkills, false);
  assert.equal(flags.syncHomepage, false);
  assert.equal(flags.syncOwner, false);
});

test('buildEditSyncFlags: persona + llm + chatSkills changes detected', () => {
  const before = {
    id: 7, name: 'N', avatar: '', bio: '', role: 'r', soul: 's', goal: 'g',
    llm_id: 'deepseek', fallback_llm_id: '', allow_chat_skills: [], homepage: null,
    boss_global_metaid: null,
  };
  const flags = buildEditSyncFlags(before, {
    role: 'r2',
    soul: 's2',
    llm_id: 'openai',
    allow_chat_skills: ['new'],
  });
  assert.equal(flags.syncPersona, true);
  assert.equal(flags.syncLlm, true);
  assert.equal(flags.syncChatSkills, true);
  assert.equal(flags.syncName, false);
});

test('updateMetaBotCore: local-only change (metabot_type) skips chain sync', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Flo', type: 'worker' });
  let syncCalls = 0;
  const deps = mockDeps(store, {
    syncEditChanges: async () => { syncCalls += 1; return { success: true }; },
  });
  const res = await updateMetaBotCore(m.id, { metabot_type: 'worker' }, deps);
  assert.equal(res.success, true);
  assert.equal(res.sync.skipped, true);
  assert.deepEqual(res.sync.attemptedStepKeys, []);
  assert.equal(syncCalls, 0);
});

test('updateMetaBotCore: name change triggers edit sync with syncName', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Gio' });
  let captured = null;
  const deps = mockDeps(store, {
    syncEditChanges: async (_s, input) => { captured = input; return { success: true, txids: ['t1'], syncedSteps: stepsFromInput(input) }; },
  });
  const res = await updateMetaBotCore(m.id, { name: 'GioRenamed' }, deps);
  assert.equal(res.success, true);
  assert.equal(res.sync.skipped, false);
  assert.equal(captured.syncName, true);
  assert.equal(res.metabot.name, 'GioRenamed');
  // New unified-path fields: the plan surfaces what it attempted and nothing remains.
  assert.deepEqual(res.sync.attemptedStepKeys, ['name']);
  const remaining = res.sync.remainingSyncInput;
  assert.equal(remaining.syncName, false);
});

test('updateMetaBotCore: auto-retries only the still-unsynced steps', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Gio', llm_id: 'deepseek' });
  const calls = [];
  const deps = mockDeps(store, {
    // Change name + llm. First attempt publishes name only and fails; the
    // retry must republish ONLY the remaining llm step, then succeed.
    syncEditChanges: async (_s, input) => {
      calls.push({ ...input });
      if (calls.length === 1) {
        return { success: false, syncedSteps: ['name'], error: 'llm pin failed' };
      }
      return { success: true, syncedSteps: stepsFromInput(input), txids: ['t-retry'] };
    },
  });
  const res = await updateMetaBotCore(m.id, { name: 'GioRenamed', llm_id: 'openai' }, deps);
  assert.equal(res.success, true);
  assert.equal(calls.length, 2);
  // First attempt: name + llm both requested.
  assert.equal(calls[0].syncName, true);
  assert.equal(calls[0].syncLlm, true);
  // Retry: name already synced, so only llm remains.
  assert.equal(calls[1].syncName, false);
  assert.equal(calls[1].syncLlm, true);
  assert.deepEqual(res.sync.attemptedStepKeys, ['name', 'llm']);
  assert.equal(res.sync.remainingSyncInput.syncName, false);
  assert.equal(res.sync.remainingSyncInput.syncLlm, false);
});

test('updateMetaBotCore: remaining steps survive a failed auto-retry for the manual Retry', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Gio', llm_id: 'deepseek' });
  const deps = mockDeps(store, {
    // Both attempts fail to publish llm; name confirms on the first.
    syncEditChanges: async (_s, input) => ({
      success: false,
      syncedSteps: input.syncName && input.syncLlm ? ['name'] : [],
      error: 'llm pin failed',
    }),
  });
  const res = await updateMetaBotCore(m.id, { name: 'GioRenamed', llm_id: 'openai' }, deps);
  assert.equal(res.success, false);
  assert.equal(res.metabot.name, 'GioRenamed'); // local write persisted
  // The remaining plan should still flag llm (so the UI's manual Retry re-publishes only llm).
  const remaining = res.sync.remainingSyncInput;
  assert.equal(remaining.syncName, false);
  assert.equal(remaining.syncLlm, true);
  assert.deepEqual(res.sync.attemptedStepKeys, ['name', 'llm']);
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

test('deleteMetaBotCore: refuses to delete the last remaining bot', async () => {
  const store = await openStore();
  const m = seedMetabot(store, { name: 'Solo' });
  const res = await deleteMetaBotCore(m.id, { store, onAfterMutation: async () => {} });
  assert.equal(res.success, false);
  assert.match(res.error, /last remaining MetaBot/i);
  assert.equal(store.listMetabots().length, 1);
});

test('deleteMetaBotCore: deletes when more than one bot remains', async () => {
  const store = await openStore();
  const m1 = seedMetabot(store, { name: 'One', n: 1 });
  seedMetabot(store, { name: 'Two', n: 2 });
  let afterCalled = 0;
  const res = await deleteMetaBotCore(m1.id, { store, onAfterMutation: async () => { afterCalled += 1; } });
  assert.equal(res.success, true);
  assert.equal(afterCalled, 1);
  assert.equal(store.listMetabots().length, 1);
});

test('deleteMetaBotCore: missing bot reports not found', async () => {
  const store = await openStore();
  const res = await deleteMetaBotCore(999, { store, onAfterMutation: async () => {} });
  assert.equal(res.success, false);
  assert.match(res.error, /not found/);
});

test('deleteMetaBotCore: invokes onAfterDelete with the deleted bot', async () => {
  const store = await openStore();
  const welcome = seedMetabot(store, { name: 'I.D', type: 'welcome', n: 1 });
  seedMetabot(store, { name: 'Twin', type: 'twin', n: 2 });
  let deletedType = null;
  let deletedId = null;
  const res = await deleteMetaBotCore(welcome.id, {
    store,
    onAfterMutation: async () => {},
    onAfterDelete: async (deletedMetabot) => {
      deletedType = deletedMetabot.metabot_type;
      deletedId = deletedMetabot.id;
    },
  });
  assert.equal(res.success, true);
  assert.equal(deletedType, 'welcome');
  assert.equal(deletedId, welcome.id);
});

// ---------------------------------------------------------------------------
// list + providers
// ---------------------------------------------------------------------------

test('listMetabotsForManagement: returns sanitized editable fields', async () => {
  const store = await openStore();
  seedMetabot(store, { name: 'Hygenist', type: 'twin', llm_id: 'openai' });
  const list = listMetabotsForManagement(store);
  assert.equal(list.length, 1);
  const m = list[0];
  assert.equal(m.name, 'Hygenist');
  assert.equal(m.type, 'twin');
  assert.equal(m.llm_id, 'openai');
  assert.ok(Array.isArray(m.allow_chat_skills));
  assert.equal(m.bio, null);
});

test('listConfiguredLlmProviders: filters by enabled + apiKey (non-ollama)', () => {
  const providers = {
    openai: { enabled: true, apiKey: 'sk-xxx' },
    deepseek: { enabled: true, apiKey: 'ds-yyy' },
    disabled1: { enabled: false, apiKey: 'k' },
    nokey: { enabled: true, apiKey: '' },
    ollama: { enabled: true }, // ollama never requires apiKey
  };
  const list = listConfiguredLlmProviders(providers);
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes('openai'));
  assert.ok(ids.includes('deepseek'));
  assert.ok(ids.includes('ollama'));
  assert.ok(!ids.includes('disabled1'));
  assert.ok(!ids.includes('nokey'));
  // Labels are capitalized keys.
  assert.ok(list.find((p) => p.id === 'openai').label === 'Openai');
});

test('listConfiguredLlmProviders: undefined providers yields empty list', () => {
  assert.deepEqual(listConfiguredLlmProviders(undefined), []);
});
