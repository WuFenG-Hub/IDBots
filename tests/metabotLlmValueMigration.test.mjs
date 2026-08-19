// Legacy llm_id VALUE migration: pre-0.4.x metabots rows hold PROVIDER ids
// (e.g. 'opencode', 'deepseek') in llm_id / fallback_llm_id; the startup
// migration (services/llmBrainMigration) rewrites them to model ids through
// the MetabotStore update path — idempotently, with per-change logging.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);

const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { migrateLegacyLlmBrainValues } = require('../dist-electron/main/services/llmBrainMigration.js');

const APP_CONFIG = {
  model: { defaultModel: 'deepseek-v4-pro' },
  providers: {
    deepseek: {
      enabled: true,
      models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
    },
    opencode: {
      enabled: true,
      models: [{ id: 'deepseek-v4-flash' }],
    },
    // Disabled provider: legacy 'qwen' values cannot be mapped.
    qwen: {
      enabled: false,
      models: [{ id: 'qwen3.7-plus' }],
    },
  },
};

const makeHarness = async (appConfig = APP_CONFIG) => {
  const { db, store, cleanup } = await createSqliteStore();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  if (appConfig) store.set('app_config', appConfig);
  const logs = [];
  const warns = [];
  const run = () =>
    migrateLegacyLlmBrainValues({
      metabotStore,
      getAppConfig: () => store.get('app_config') ?? null,
      log: (message) => logs.push(message),
      warn: (message) => warns.push(message),
    });
  return { db, store, metabotStore, logs, warns, run, cleanup };
};

let seedCounter = 0;
const seedBot = (metabotStore, { name, llm_id = null, llm_provider = null, fallback_llm_id = null, fallback_llm_provider = null }) => {
  seedCounter += 1;
  const n = seedCounter;
  const wallet = metabotStore.insertMetabotWallet({ mnemonic: `mnemonic-${n}`, path: "m/44'/10001'/0'/0/0" });
  return metabotStore.createMetabot({
    wallet_id: wallet.id,
    mvc_address: `mvc-${n}`,
    btc_address: `btc-${n}`,
    doge_address: `doge-${n}`,
    public_key: `pk-${n}`,
    chat_public_key: `cpk-${n}`,
    chat_public_key_pin_id: null,
    name,
    enabled: true,
    metaid: `metaid-${n}`,
    globalmetaid: `gmid-${n}`,
    metabot_type: 'worker',
    created_by: '0000',
    role: '',
    soul: '',
    llm_id,
    llm_provider,
    fallback_llm_id,
    fallback_llm_provider,
  });
};

test('migration rewrites legacy provider keys to model ids per the Fallback-1 model-choice rule', async () => {
  const { metabotStore, logs, warns, run, cleanup } = await makeHarness();
  try {
    // opencode does not offer the global default model -> its FIRST model.
    const botA = seedBot(metabotStore, { name: 'MigA', llm_id: 'opencode' });
    // deepseek offers the global default model -> the default model wins.
    const botB = seedBot(metabotStore, { name: 'MigB', llm_id: 'deepseek', llm_provider: 'deepseek' });

    const result = run();
    assert.equal(result.migrated, 2);
    assert.equal(result.unresolvable, 0);

    const a = metabotStore.getMetabotById(botA.id);
    assert.equal(a.llm_id, 'deepseek-v4-flash');
    assert.equal(a.llm_provider, 'opencode', 'empty provider hint filled with the matched provider key');
    const b = metabotStore.getMetabotById(botB.id);
    assert.equal(b.llm_id, 'deepseek-v4-pro');
    assert.equal(b.llm_provider, 'deepseek', 'existing provider hint kept');

    assert.ok(
      logs.some((m) => m === `[llm-brain-migration] bot ${botA.id} (MigA): llm_id 'opencode' -> 'deepseek-v4-flash' (provider opencode)`),
      `per-change log line missing: ${JSON.stringify(logs)}`,
    );
    assert.ok(logs.some((m) => /\[llm-brain-migration\] done: 2 migrated/.test(m)));
    assert.equal(warns.length, 0);
  } finally {
    cleanup();
  }
});

test('migration rewrites fallback_llm_id independently and keeps an existing fallback provider hint', async () => {
  const { metabotStore, run, cleanup } = await makeHarness();
  try {
    const bot = seedBot(metabotStore, {
      name: 'MigFallback',
      llm_id: 'deepseek-v4-flash', // already a model id
      fallback_llm_id: 'opencode',
      fallback_llm_provider: 'deepseek', // explicit hint must survive
    });

    const result = run();
    assert.equal(result.migrated, 1);
    assert.equal(result.alreadyNew, 1);

    const after = metabotStore.getMetabotById(bot.id);
    assert.equal(after.llm_id, 'deepseek-v4-flash', 'primary untouched');
    assert.equal(after.fallback_llm_id, 'deepseek-v4-flash');
    assert.equal(after.fallback_llm_provider, 'deepseek', 'existing hint names the provider and wins');
  } finally {
    cleanup();
  }
});

test('migration fills an empty fallback provider hint with the matched provider key', async () => {
  const { metabotStore, run, cleanup } = await makeHarness();
  try {
    const bot = seedBot(metabotStore, { name: 'MigFallbackHint', fallback_llm_id: 'opencode' });
    const result = run();
    assert.equal(result.migrated, 1);
    const after = metabotStore.getMetabotById(bot.id);
    assert.equal(after.fallback_llm_id, 'deepseek-v4-flash');
    assert.equal(after.fallback_llm_provider, 'opencode');
  } finally {
    cleanup();
  }
});

test('migration is idempotent: a second run migrates 0', async () => {
  const { metabotStore, logs, run, cleanup } = await makeHarness();
  try {
    seedBot(metabotStore, { name: 'MigIdem', llm_id: 'opencode', fallback_llm_id: 'deepseek' });
    const first = run();
    assert.equal(first.migrated, 2);

    logs.length = 0;
    const second = run();
    assert.equal(second.migrated, 0);
    assert.equal(second.alreadyNew, 2);
    assert.ok(logs.some((m) => /\[llm-brain-migration\] done: 0 migrated, 2 already-new/.test(m)));
  } finally {
    cleanup();
  }
});

test('migration leaves values of disabled/absent providers as-is and warns', async () => {
  const { metabotStore, warns, run, cleanup } = await makeHarness();
  try {
    const botDisabled = seedBot(metabotStore, { name: 'MigDisabled', llm_id: 'qwen' }); // provider disabled
    const botGone = seedBot(metabotStore, { name: 'MigGone', llm_id: 'removed-provider' });

    const result = run();
    assert.equal(result.migrated, 0);
    assert.equal(result.unresolvable, 2);

    assert.equal(metabotStore.getMetabotById(botDisabled.id).llm_id, 'qwen', 'left as-is');
    assert.equal(metabotStore.getMetabotById(botGone.id).llm_id, 'removed-provider', 'left as-is');
    assert.ok(
      warns.some((m) => m.includes(`bot ${botDisabled.id} (MigDisabled): llm_id 'qwen' left as-is`)),
      `warning missing: ${JSON.stringify(warns)}`,
    );
    assert.ok(warns.some((m) => m.includes(`llm_id 'removed-provider' left as-is`)));
  } finally {
    cleanup();
  }
});

test('migration writes through the store: in-memory read and persisted row agree', async () => {
  const { db, metabotStore, run, cleanup } = await makeHarness();
  try {
    const bot = seedBot(metabotStore, { name: 'MigStore', llm_id: 'opencode' });
    run();

    const viaStore = metabotStore.getMetabotById(bot.id);
    const viaDb = getRow(db, 'SELECT llm_id, llm_provider FROM metabots WHERE id = ?', [bot.id]);
    assert.equal(viaStore.llm_id, 'deepseek-v4-flash');
    assert.deepEqual(viaDb, { llm_id: 'deepseek-v4-flash', llm_provider: 'opencode' });
  } finally {
    cleanup();
  }
});

test('migration skips cleanly when no provider config exists yet', async () => {
  const { metabotStore, logs, run, cleanup } = await makeHarness(null);
  try {
    seedBot(metabotStore, { name: 'MigNoConfig', llm_id: 'opencode' });
    const result = run();
    assert.deepEqual(result, { migrated: 0, alreadyNew: 0, unresolvable: 0 });
    assert.equal(metabotStore.listMetabots()[0].llm_id, 'opencode', 'untouched');
    assert.ok(logs.some((m) => /skipped: no provider config/.test(m)));
  } finally {
    cleanup();
  }
});
