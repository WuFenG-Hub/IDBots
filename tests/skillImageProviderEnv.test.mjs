import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildImageSkillEnvOverrides } = require('../dist-electron/main/libs/skillImageProviderEnv.js');

const EMPTY_ENV = {};

test('ARK key mirrors the volcengine provider for seedance/seedream turns', () => {
  const appConfig = { providers: { volcengine: { enabled: true, apiKey: 'ark-app-key' } } };

  for (const activeSkillIds of [['seedream'], ['seedance'], ['baoyu-image-studio'], [], undefined]) {
    const overrides = buildImageSkillEnvOverrides({ activeSkillIds, appConfig, processEnv: EMPTY_ENV });
    assert.equal(overrides.ARK_API_KEY, 'ark-app-key', `ARK key for activeSkillIds=${JSON.stringify(activeSkillIds)}`);
  }
});

test('ARK key falls back to the process env when no volcengine provider is configured', () => {
  const overrides = buildImageSkillEnvOverrides({
    activeSkillIds: ['seedream'],
    appConfig: { providers: {} },
    processEnv: { ARK_API_KEY: 'ark-env-key' },
  });
  assert.equal(overrides.ARK_API_KEY, 'ark-env-key');
});

test('disabled volcengine provider is ignored in favor of the process env', () => {
  const overrides = buildImageSkillEnvOverrides({
    activeSkillIds: ['seedance'],
    appConfig: { providers: { volcengine: { enabled: false, apiKey: 'ark-app-key' } } },
    processEnv: { ARK_API_KEY: 'ark-env-key' },
  });
  assert.equal(overrides.ARK_API_KEY, 'ark-env-key');
});

test('app-provider ARK key wins over the process env and over the baoyu chain', () => {
  const overrides = buildImageSkillEnvOverrides({
    activeSkillIds: ['baoyu-image-studio'],
    appConfig: { providers: { volcengine: { enabled: true, apiKey: 'ark-app-key' } } },
    processEnv: { ARK_API_KEY: 'ark-env-key' },
  });
  assert.equal(overrides.ARK_API_KEY, 'ark-app-key');
});

test('baoyu chain resolution stays intact alongside the ARK key', () => {
  const overrides = buildImageSkillEnvOverrides({
    activeSkillIds: ['baoyu-image-studio'],
    appConfig: { providers: { openai: { enabled: true, apiKey: 'sk-openai' } } },
    processEnv: { ARK_API_KEY: 'ark-env-key' },
  });
  assert.equal(overrides.BAOYU_IMAGE_PROVIDER, 'openai');
  assert.equal(overrides.OPENAI_API_KEY, 'sk-openai');
  assert.equal(overrides.ARK_API_KEY, 'ark-env-key');
});

test('non-image pinned skill without any resolvable key yields no overrides', () => {
  const overrides = buildImageSkillEnvOverrides({
    activeSkillIds: ['docx'],
    appConfig: { providers: {} },
    processEnv: EMPTY_ENV,
  });
  assert.deepEqual(overrides, {});
});
