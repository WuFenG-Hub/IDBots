import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LLM_FREE_PROVIDER_KEY,
  LLM_RELAY_WELCOME_BOT_ID_KEY,
  getFreeProviderModelCanonical,
  getFreeProviderModelDisplayName,
  isFreeProviderConfigured,
  planFreeQuotaProvisioning,
} from '../src/renderer/services/llmFreeQuotaGate.js';
import { getDefaultOnboardingProvider } from '../src/renderer/components/onboarding/onboardingDefaults.js';

test('constants stay stable (backend + kv contracts)', () => {
  assert.equal(LLM_FREE_PROVIDER_KEY, 'metaid-free');
  assert.equal(LLM_RELAY_WELCOME_BOT_ID_KEY, 'llmRelay.welcomeBotId');
});

test('getFreeProviderModelDisplayName maps relay wire ids to product names', () => {
  assert.equal(getFreeProviderModelDisplayName('deepseek-chat'), 'deepseek-v4-flash');
  assert.equal(getFreeProviderModelDisplayName('another-relay-model'), 'another-relay-model');
  assert.equal(getFreeProviderModelDisplayName(undefined), undefined);
});

test('getFreeProviderModelCanonical mirrors the deepseek-v4-flash preset for the relay wire id', () => {
  // The relay bootstrap payload still reports the legacy V3 wire values
  // (64K context / 4K output) for deepseek-chat while actually serving
  // deepseek-v4-flash; the canonical config must match the deepseek
  // provider's deepseek-v4-flash preset (1M context, 32K output, thinking on
  // at max effort).
  const canonical = getFreeProviderModelCanonical('deepseek-chat');
  assert.ok(canonical);
  assert.equal(canonical.contextWindow, 1_000_000);
  assert.equal(canonical.maxOutputTokens, 32_768);
  assert.equal(canonical.supportsImage, false);
  assert.equal(canonical.options.reasoningEffort, 'max');
  assert.deepEqual(canonical.options.thinking, { type: 'enabled' });
  // Fresh object per call: mutating the result must not pollute the table.
  canonical.options.thinking.type = 'disabled';
  assert.equal(getFreeProviderModelCanonical('deepseek-chat').options.thinking.type, 'enabled');
});

test('getFreeProviderModelCanonical returns null for unknown relay ids', () => {
  assert.equal(getFreeProviderModelCanonical('another-relay-model'), null);
  assert.equal(getFreeProviderModelCanonical(undefined), null);
});

test('isFreeProviderConfigured requires credentials and models', () => {
  assert.equal(isFreeProviderConfigured(undefined), false);
  assert.equal(isFreeProviderConfigured({ enabled: false, apiKey: 'k', baseUrl: 'u', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: '', baseUrl: 'u', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: '', models: [{ id: 'm' }] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: 'u', models: [] }), false);
  assert.equal(isFreeProviderConfigured({ enabled: true, apiKey: 'k', baseUrl: 'u', models: [{ id: 'm' }] }), true);
});

test('plan: already provisioned => none (deletion-respecting)', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, welcomeBotId: 7, providerConfigured: true }),
    'none',
  );
  // Even if the user deleted the bot (count back to 0), the persisted id wins.
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, welcomeBotId: 7, providerConfigured: false }),
    'none',
  );
});

test('plan: existing installs are never touched', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 3, welcomeBotId: null, providerConfigured: false }),
    'none',
  );
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 1, welcomeBotId: null, providerConfigured: true }),
    'none',
  );
});

test('plan: fresh install bootstraps; partial state only creates the bot', () => {
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, welcomeBotId: null, providerConfigured: false }),
    'bootstrap-and-create-bot',
  );
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: 0, welcomeBotId: null, providerConfigured: true }),
    'create-bot-only',
  );
});

test('plan: degenerate inputs fall back safely', () => {
  assert.equal(planFreeQuotaProvisioning({}), 'bootstrap-and-create-bot');
  assert.equal(
    planFreeQuotaProvisioning({ metabotCount: Number.NaN, welcomeBotId: Number.NaN }),
    'bootstrap-and-create-bot',
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
