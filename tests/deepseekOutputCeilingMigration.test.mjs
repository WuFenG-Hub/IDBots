import assert from 'node:assert/strict';
import test from 'node:test';

// Compiled-output tests: run `pnpm run compile:electron` first.
// Self-skip when the compiled service is absent (mirrors dshKernelRuntime tests).

let migration;
try {
  ({ migration } = {
    migration: await import('../dist-electron/main/services/deepseekOutputCeilingMigration.js'),
  });
} catch {
  migration = undefined;
}

test('deepseek output ceiling migration rewrites legacy 32K rows to 256K and leaves everything else alone', async (t) => {
  if (!migration) return t.skip('dist-electron not compiled');

  const config = {
    providers: {
      deepseek: {
        models: [
          { id: 'deepseek-flash', contextWindow: 1_000_000, maxOutputTokens: 32_768 },
          { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 32_768 },
          // user-customized ceiling — must stay untouched
          { id: 'deepseek-v4.1-flash-custom', maxOutputTokens: 16_000 },
          // already migrated — no-op
          { id: 'deepseek-flash-preview', maxOutputTokens: 256_000 },
          // non-deepseek family — untouched
          { id: 'gpt-5.6-sol', maxOutputTokens: 32_768 },
        ],
      },
      metaid: {
        models: [{ id: 'deepseek-chat', maxOutputTokens: 32_768 }],
      },
    },
    model: {
      availableModels: [
        { id: 'deepseek/deepseek-flash', maxOutputTokens: 32_768 },
        { id: 'glm-5.3-flash', maxOutputTokens: 32_768 },
      ],
    },
  };

  let saved = null;
  const result = migration.migrateDeepSeekOutputCeiling({
    getAppConfig: () => config,
    setAppConfig: (value) => { saved = value; },
  });

  assert.equal(result.migrated, 3);
  assert.equal(saved, config, 'rewrites and persists the SAME config object');
  const rows = config.providers.deepseek.models;
  assert.equal(rows[0].maxOutputTokens, 256_000);
  assert.equal(rows[1].maxOutputTokens, 256_000);
  assert.equal(rows[2].maxOutputTokens, 16_000, 'custom ceilings untouched');
  assert.equal(rows[3].maxOutputTokens, 256_000);
  assert.equal(rows[4].maxOutputTokens, 32_768, 'non-deepseek rows untouched');
  assert.equal(config.providers.metaid.models[0].maxOutputTokens, 32_768, 'deepseek-chat is not V4 family');
  assert.equal(config.model.availableModels[0].maxOutputTokens, 256_000, 'gateway-prefixed family id migrates');
  assert.equal(config.model.availableModels[1].maxOutputTokens, 32_768);

  // Idempotent: second run finds nothing to do and does not re-persist.
  let secondSave = null;
  const second = migration.migrateDeepSeekOutputCeiling({
    getAppConfig: () => config,
    setAppConfig: (value) => { secondSave = value; },
  });
  assert.equal(second.migrated, 0);
  assert.equal(secondSave, null);
});

test('deepseek output ceiling migration no-ops when config is unavailable', async (t) => {
  if (!migration) return t.skip('dist-electron not compiled');

  let saved = null;
  const result = migration.migrateDeepSeekOutputCeiling({
    getAppConfig: () => null,
    setAppConfig: (value) => { saved = value; },
  });
  assert.equal(result.migrated, 0);
  assert.equal(saved, null);
});
