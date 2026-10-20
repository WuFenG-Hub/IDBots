// DSH pi-ai route-key agreement: the runtime config generator
// (dsh-runtime/lib/generate-runtime-config.mjs) and the host turn pipeline
// (claudeSettings.resolveDshProviderRoute) must compute the SAME route key
// for every provider, because the generator names the llm-pi-ai providers
// dict entry and every DSH turn passes route.provider from the host — a
// mismatch means the session asks for a route that does not exist.
//
// The remap under test closes the v1.0.2 "unknown variant `tool removal`"
// wedge: a user provider named after a pi-ai catalog vendor ('anthropic') on
// the anthropic apiFormat inherits the vendor catalog compat — including
// supportsMidConvoToolChanges, withheld from configuration — when pointed at
// a third-party gateway, and the resulting tool_addition/tool_removal blocks
// poison every later replay on gateways that do not implement them. Official
// endpoints keep the bare vendor key; everything else is suffixed '-gw'.
//
// Requires: pnpm run compile:electron (imports dist-electron).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const claudeSettings = await import('../dist-electron/main/libs/claudeSettings.js');
const generator = await import(
  pathToFileURL(path.join(process.cwd(), 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href
);

const { dshPiAiRouteKey: hostKey, resolveDshProviderRoute, setStoreGetter, PI_AI_VENDOR_OFFICIAL_HOSTS } = claudeSettings;
const { dshPiAiRouteKey: runtimeKey, PI_AI_VENDOR_OFFICIAL_HOSTS: runtimeHosts } = generator;

const MATRIX = [
  // [providerKey, apiFormat, baseUrl, expected]
  ['anthropic', 'anthropic', 'https://api.anthropic.com', 'anthropic'],
  ['anthropic', 'anthropic', 'https://api.anthropic.com/v1', 'anthropic'],
  ['anthropic', 'anthropic', 'https://gw.example.com/anthropic', 'anthropic-gw'],
  ['anthropic', 'anthropic', 'https://Api.Example.COM', 'anthropic-gw'],
  ['anthropic', 'anthropic', 'not a url', 'anthropic-gw'],
  ['anthropic', 'openai', 'https://gw.example.com/v1', 'anthropic'],
  ['anthropic', 'responses', 'https://gw.example.com/v1', 'anthropic'],
  ['moonshot', 'anthropic', 'https://api.moonshot.cn/anthropic', 'moonshot'],
  ['my relay!', 'anthropic', 'https://gw.example.com', 'my-relay-'],
];

test('host and runtime generator agree on every route key in the matrix', () => {
  for (const [providerKey, apiFormat, baseUrl, expected] of MATRIX) {
    const host = hostKey(providerKey, apiFormat, baseUrl);
    const runtime = runtimeKey({ key: providerKey, apiFormat, baseUrl });
    assert.equal(host, expected, `host dshPiAiRouteKey(${providerKey}, ${apiFormat}, ${baseUrl})`);
    assert.equal(runtime, expected, `generator dshPiAiRouteKey({key: ${providerKey}, ...})`);
  }
});

test('the vendor official-host tables stay identical on both sides', () => {
  assert.deepEqual(
    { ...PI_AI_VENDOR_OFFICIAL_HOSTS },
    { ...runtimeHosts },
    'the mirrored constant in claudeSettings.ts drifted from generate-runtime-config.mjs',
  );
});

test('resolveDshProviderRoute applies the remap to the DSH turn route key', () => {
  const providers = {
    anthropic: {
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://gw.example.com/anthropic',
      apiFormat: 'anthropic',
      models: [{ id: 'claude-sonnet-5' }],
    },
  };
  setStoreGetter(() => ({
    get: (key) => (key === 'app_config'
      ? { model: { defaultModel: 'claude-sonnet-5', availableModels: [] }, providers }
      : null),
  }));
  try {
    const route = resolveDshProviderRoute('claude-sonnet-5');
    assert.ok(route, 'route resolved');
    assert.equal(route.provider, 'anthropic-gw');
    assert.equal(route.apiFormat, 'anthropic');
  } finally {
    setStoreGetter(() => null);
  }
});

test('resolveDshProviderRoute keeps the bare vendor key for the official endpoint', () => {
  const providers = {
    anthropic: {
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic',
      models: [{ id: 'claude-sonnet-5' }],
    },
  };
  setStoreGetter(() => ({
    get: (key) => (key === 'app_config'
      ? { model: { defaultModel: 'claude-sonnet-5', availableModels: [] }, providers }
      : null),
  }));
  try {
    const route = resolveDshProviderRoute('claude-sonnet-5');
    assert.ok(route, 'route resolved');
    assert.equal(route.provider, 'anthropic');
  } finally {
    setStoreGetter(() => null);
  }
});
