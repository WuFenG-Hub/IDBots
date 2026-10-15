import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LLM_FREE_PROVIDER_KEY,
  getFreeProviderModelCanonical,
  getFreeProviderModelDisplayName,
  getFreeProviderModelLegacyLimitRewrites,
  isFreeProviderConfigured,
  planFreeProviderCatalogSync,
  planFreeQuotaProvisioning,
} from '../src/renderer/services/llmFreeQuotaGate.js';
import { getDefaultOnboardingProvider } from '../src/renderer/components/onboarding/onboardingDefaults.js';

test('constants stay stable (backend contract)', () => {
  assert.equal(LLM_FREE_PROVIDER_KEY, 'metaid-free');
});

test('getFreeProviderModelDisplayName maps relay wire ids to product names', () => {
  assert.equal(getFreeProviderModelDisplayName('deepseek-chat'), 'deepseek-flash');
  // The 2026-10-16 catalog rename: the public id shows the same product name
  // as the legacy alias (the two never coexist in one catalog).
  assert.equal(getFreeProviderModelDisplayName('deepseek-4.1-flash'), 'deepseek-flash');
  assert.equal(getFreeProviderModelDisplayName('another-relay-model'), 'another-relay-model');
  assert.equal(getFreeProviderModelDisplayName(undefined), undefined);
});

test('getFreeProviderModelCanonical pins the upgraded 1M window and the 100K declared output ceiling', () => {
  // context_window: the upstream relay previously enforced 64K (server-
  // confirmed 2026-10-04); the owner confirmed on 2026-10-09 that it has
  // been upgraded past that limit, so the canonical mirrors the DeepSeek V4
  // flash family's 1M and compaction re-arms at
  // min(0.8*1M, 1M-100K-40K) = 800K tokens.
  // max_output_tokens: 100K declared ceiling (owner decision 2026-10-09) —
  // thinking shares the output budget and the old 4096 pin truncated
  // effort-max turns after a couple of sentences. At the 1M window the
  // resolution-time clamp (32% tier) leaves the full 100K effective.
  const canonical = getFreeProviderModelCanonical('deepseek-chat');
  assert.ok(canonical);
  assert.equal(canonical.contextWindow, 1_000_000);
  assert.equal(canonical.maxOutputTokens, 100_000);
  assert.equal(canonical.supportsImage, false);
  assert.equal(canonical.options.reasoningEffort, 'max');
  assert.deepEqual(canonical.options.thinking, { type: 'enabled' });
  // Fresh object per call: mutating the result must not pollute the table.
  canonical.options.thinking.type = 'disabled';
  assert.equal(getFreeProviderModelCanonical('deepseek-chat').options.thinking.type, 'enabled');
});

test('getFreeProviderModelLegacyLimitRewrites flags only machine-pinned legacy stored values', () => {
  // Eras that wrote free-model rows machine-side: the pre-2026-10-04
  // deepseek-flash mirror (1M/32768) and the 2026-10-04 pin (64000/4096 —
  // also what the relay payload reported). The output pins move to the 100K
  // declared ceiling and the 64K window pin bumps to the upgraded 1M;
  // anything else on the row (user edits included) must survive untouched.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 1_000_000, maxOutputTokens: 32_768,
    }),
    { contextWindow: false, maxOutputTokens: true },
  );
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 64_000, maxOutputTokens: 4_096,
    }),
    { contextWindow: true, maxOutputTokens: true },
  );
  // User-tuned values (manual 100K window edit, custom output ceiling) stay.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({
      id: 'deepseek-chat', contextWindow: 100_000, maxOutputTokens: 100_000,
    }),
    { contextWindow: false, maxOutputTokens: false },
  );
  // Unknown relay ids have no legacy table.
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'future-relay-model', contextWindow: 1_000_000 }),
    { contextWindow: false, maxOutputTokens: false },
  );
  // Degenerate rows never throw.
  assert.deepEqual(getFreeProviderModelLegacyLimitRewrites(undefined), {
    contextWindow: false,
    maxOutputTokens: false,
  });
  assert.deepEqual(
    getFreeProviderModelLegacyLimitRewrites({ id: 'deepseek-chat' }),
    { contextWindow: false, maxOutputTokens: false },
  );
});

test('getFreeProviderModelCanonical returns null for unknown relay ids', () => {
  assert.equal(getFreeProviderModelCanonical('another-relay-model'), null);
  assert.equal(getFreeProviderModelCanonical(undefined), null);
});

test('getFreeProviderModelCanonical gives deepseek-4.1-flash the same profile as the legacy alias', () => {
  // The 2026-10-16 relay catalog rename kept the wire family, so the new
  // flagship id inherits the exact deepseek-chat client profile.
  const canonical = getFreeProviderModelCanonical('deepseek-4.1-flash');
  assert.ok(canonical);
  assert.equal(canonical.contextWindow, 1_000_000);
  assert.equal(canonical.maxOutputTokens, 100_000);
  assert.equal(canonical.supportsImage, false);
  assert.deepEqual(canonical.options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });
});

test('isFreeProviderConfigured requires credentials and models', () => {
  assert.equal(isFreeProviderConfigured(undefined), false);
  assert.equal(isFreeProviderConfigured({ enabled: false, apiKey: 'k', baseUrl: 'u', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: '', baseUrl: 'u', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: '', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: 'u', models: [] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: 'u', models: [{ id: 'm' }] }), true);
});

test('plan: an already provisioned provider needs nothing', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, providerConfigured: true }),
    'none',
  );
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 5, providerConfigured: true }),
    'none',
  );
});

test('plan: existing installs are never touched', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 3, providerConfigured: false }),
    'none',
  );
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 1, providerConfigured: false }),
    'none',
  );
});

test('plan: only a fresh install with no free provider bootstraps', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, providerConfigured: false }),
    'bootstrap',
  );
});

test('plan: degenerate inputs fall back safely', () => {
  assert.equal(planFreeQuotaProvisioning({}), 'bootstrap');
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: Number.NaN }),
    'bootstrap',
  );
});

test('onboarding default: provisioned free provider wins, else legacy defaults', () => {
  const provisioned = { 'metaid-free': { enabled: true, apiKey: 'mrk_x', baseUrl: 'https://relay' } };
  assert.equal(getDefaultOnboardingProvider('zh', provisioned), 'metaid-free');
  assert.equal(getDefaultOnboardingProvider('en', provisioned), 'metaid-free');
  const unprovisioned = { 'metaid-free': { enabled: false, apiKey: '', baseUrl: '' } };
  assert.equal(getDefaultOnboardingProvider('zh', unprovisioned), 'deepseek');
  assert.equal(getDefaultOnboardingProvider('en', unprovisioned), 'openai');
  assert.equal(getDefaultOnboardingProvider('zh'), 'deepseek');
  assert.equal(getDefaultOnboardingProvider('en'), 'openai');
});

// The 2026-10-16 production relay directory every quota/bootstrap response
// now reports (assist-base-service, live 2026-10-16).
const RELAY_CATALOG_2026_10_16 = [
  { id: 'deepseek-4.1-flash', contextWindow: 1_000_000, maxOutputTokens: 100_000 },
  { id: 'glm-5.3-flash', contextWindow: 1_048_576, maxOutputTokens: 128_000 },
  { id: 'longcat-2.5-preview-free', contextWindow: 262_144, maxOutputTokens: 32_768 },
  { id: 'step-5-preview-free', contextWindow: 262_144, maxOutputTokens: 32_768 },
  { id: 'cat-jam-free', contextWindow: 131_072, maxOutputTokens: 16_384 },
  { id: 'glyph-cluster-free', contextWindow: 131_072, maxOutputTokens: 16_384 },
  { id: 'laguna-s-2.1-free', contextWindow: 131_072, maxOutputTokens: 16_384 },
  { id: 'ling-3.0-flash-sante-free', contextWindow: 131_072, maxOutputTokens: 16_384 },
];

const storedLegacyProvider = () => ({
  enabled: true,
  apiKey: 'mrk_legacy-install',
  baseUrl: 'https://www.metaso.network/assist-open-api/v2/assist/llm/v1',
  apiFormat: 'openai',
  name: 'IDBots-Free',
  models: [
    {
      id: 'deepseek-chat',
      name: 'deepseek-flash',
      contextWindow: 1_000_000,
      maxOutputTokens: 100_000,
      supportsImage: false,
      options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
    },
  ],
});

test('catalog sync: quota directory change refreshes provider.models', () => {
  const provider = storedLegacyProvider();
  const next = planFreeProviderCatalogSync(provider, RELAY_CATALOG_2026_10_16);

  assert.ok(next, 'the frozen single-model catalog must be rewritten');
  // The relay list IS the directory: legacy alias dropped, new ids in relay order.
  assert.deepEqual(next.map((model) => model.id), RELAY_CATALOG_2026_10_16.map((model) => model.id));
  // Known id gets the canonical client profile over the relay-reported limits.
  const flagship = next[0];
  assert.equal(flagship.name, 'deepseek-flash');
  assert.equal(flagship.contextWindow, 1_000_000);
  assert.equal(flagship.maxOutputTokens, 100_000);
  assert.equal(flagship.supportsImage, false);
  assert.deepEqual(flagship.options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });
  // Unknown ids keep the relay-reported values bare (id is the display name).
  const glm = next[1];
  assert.equal(glm.name, 'glm-5.3-flash');
  assert.equal(glm.contextWindow, 1_048_576);
  assert.equal(glm.maxOutputTokens, 128_000);
  assert.equal('options' in glm, false);
  // The stored provider object itself is never mutated.
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].id, 'deepseek-chat');
});

test('catalog sync: matching directory is a no-op, unusable inputs never empty-replace', () => {
  const synced = RELAY_CATALOG_2026_10_16.map((entry) => ({
    id: entry.id,
    name: entry.id,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
  }));
  const provider = { ...storedLegacyProvider(), models: synced };
  assert.equal(planFreeProviderCatalogSync(provider, RELAY_CATALOG_2026_10_16), null);

  // Empty/absent relay lists and unprovisioned providers never produce a write.
  assert.equal(planFreeProviderCatalogSync(storedLegacyProvider(), []), null);
  assert.equal(planFreeProviderCatalogSync(storedLegacyProvider(), undefined), null);
  assert.equal(planFreeProviderCatalogSync(undefined, RELAY_CATALOG_2026_10_16), null);
  assert.equal(planFreeProviderCatalogSync({ enabled: true, apiKey: 'k', baseUrl: 'u' }, RELAY_CATALOG_2026_10_16), null);

  // Blank ids and duplicates drop out; a surviving id keeps its stored row.
  const next = planFreeProviderCatalogSync(
    storedLegacyProvider(),
    [{ id: '  ' }, { id: 'deepseek-chat' }, { id: 'deepseek-chat' }, { id: 'glm-5.3-flash' }],
  );
  assert.deepEqual(next.map((model) => model.id), ['deepseek-chat', 'glm-5.3-flash']);
  assert.deepEqual(next[0].options, { reasoningEffort: 'max', thinking: { type: 'enabled' } });
});

test('catalog sync: surviving ids keep user-tuned rows, removals drop silently', () => {
  const provider = storedLegacyProvider();
  // A user downgraded the stored row's thinking: it must survive a sync that
  // only adds another relay id (mirror of mergeSyncedProviderModels semantics).
  provider.models[0].options = { reasoningEffort: 'low', thinking: { type: 'enabled' } };
  const next = planFreeProviderCatalogSync(provider, [
    { id: 'deepseek-chat', contextWindow: 999, maxOutputTokens: 999 },
    { id: 'cat-jam-free' },
  ]);
  assert.deepEqual(next.map((model) => model.id), ['deepseek-chat', 'cat-jam-free']);
  assert.deepEqual(next[0].options, { reasoningEffort: 'low', thinking: { type: 'enabled' } });
  // Relay-reported limits do not overwrite the surviving row.
  assert.equal(next[0].contextWindow, 1_000_000);
  assert.equal(next[0].maxOutputTokens, 100_000);
});
