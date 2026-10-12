import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREBELLUM_DEFAULT_BASE_URL,
  CEREBELLUM_DEFAULT_MODEL,
  resolveCerebellumConfig,
} from '../src/main/libs/cerebellumConfig.ts';

test('resolveCerebellumConfig returns null for missing configs', () => {
  assert.equal(resolveCerebellumConfig(undefined), null);
  assert.equal(resolveCerebellumConfig(null), null);
  assert.equal(resolveCerebellumConfig({}), null);
  assert.equal(resolveCerebellumConfig('cerebellum'), null);
  assert.equal(resolveCerebellumConfig(42), null);
});

test('resolveCerebellumConfig returns null when disabled', () => {
  assert.equal(
    resolveCerebellumConfig({
      cerebellum: {
        enabled: false,
        provider: 'typesafe-jev',
        apiKey: 'sk-jev',
        baseUrl: CEREBELLUM_DEFAULT_BASE_URL,
        model: CEREBELLUM_DEFAULT_MODEL,
      },
    }),
    null,
  );
  // Missing enabled flag counts as disabled.
  assert.equal(
    resolveCerebellumConfig({ cerebellum: { provider: 'typesafe-jev', apiKey: 'sk-jev' } }),
    null,
  );
});

test('resolveCerebellumConfig returns null without an api key', () => {
  const base = { enabled: true, provider: 'typesafe-jev', baseUrl: CEREBELLUM_DEFAULT_BASE_URL };
  assert.equal(resolveCerebellumConfig({ cerebellum: base }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { ...base, apiKey: '' } }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { ...base, apiKey: '   ' } }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { ...base, apiKey: 123 } }), null);
});

test('resolveCerebellumConfig resolves a fully configured cerebellum', () => {
  const resolved = resolveCerebellumConfig({
    cerebellum: {
      enabled: true,
      provider: 'typesafe-jev',
      apiKey: ' sk-jev ',
      baseUrl: 'https://jev.example.com',
      model: 'jev-fast',
    },
  });
  assert.deepEqual(resolved, {
    provider: 'typesafe-jev',
    apiKey: 'sk-jev',
    baseUrl: 'https://jev.example.com',
    model: 'jev-fast',
  });
});

test('resolveCerebellumConfig strips trailing slashes from the base URL', () => {
  const resolved = resolveCerebellumConfig({
    cerebellum: {
      enabled: true,
      provider: 'typesafe-jev',
      apiKey: 'sk-jev',
      baseUrl: 'https://jev.example.com///',
      model: 'jev-latest',
    },
  });
  assert.equal(resolved?.baseUrl, 'https://jev.example.com');
});

test('resolveCerebellumConfig fills default base URL and model when blank', () => {
  const resolved = resolveCerebellumConfig({
    cerebellum: {
      enabled: true,
      provider: 'typesafe-jev',
      apiKey: 'sk-jev',
      baseUrl: '',
      model: '  ',
    },
  });
  assert.equal(resolved?.baseUrl, CEREBELLUM_DEFAULT_BASE_URL);
  assert.equal(resolved?.model, CEREBELLUM_DEFAULT_MODEL);
});

test('resolveCerebellumConfig rejects malformed shapes', () => {
  assert.equal(resolveCerebellumConfig({ cerebellum: 'typesafe-jev' }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: ['typesafe-jev'] }), null);
  assert.equal(resolveCerebellumConfig({ cerebellum: { enabled: 'yes', provider: 'typesafe-jev', apiKey: 'sk' } }), null);
  // Unknown providers are not resolvable until a provider adapter lands.
  assert.equal(
    resolveCerebellumConfig({ cerebellum: { enabled: true, provider: 'other', apiKey: 'sk' } }),
    null,
  );
});
