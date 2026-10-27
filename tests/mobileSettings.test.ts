import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import {
  applyThemeMode,
  getThemeMode,
  setLanguage,
  setThemeMode,
} from '../src/mobile/app/services/settings.ts';
import { mobileI18n } from '../src/mobile/i18n.ts';

function installBridge(t: test.TestContext) {
  const bridge = createMobileMockBridge({ systemLocale: 'en-US' });
  Object.assign(globalThis, {
    window: {
      electron: bridge.electron,
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    },
    document: {
      documentElement: { classList: { toggle: () => undefined } },
    },
  });
  applyThemeMode('system');
  mobileI18n.setLanguage('en');
  t.after(() => bridge.destroy());
  return bridge.electron;
}

test('mobile language/theme writes are field-scoped and confirmed without clobbering provider/bootstrap config', async (t) => {
  const api = installBridge(t);
  await api.store.set('app_config', {
    language: 'en',
    language_initialized: true,
    theme: 'system',
    bootstrap: { workspace: '/data/workspace' },
    providers: {
      'metaid-free': {
        enabled: true,
        apiKey: 'fixture-relay-key',
        baseUrl: 'https://relay.fixture',
        apiFormat: 'openai',
        models: [{ id: 'model-a' }],
      },
    },
  });

  await setLanguage('zh');
  await setThemeMode('dark');

  const saved = await api.store.get('app_config');
  assert.equal(saved.language, 'zh');
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.language_initialized, true);
  assert.deepEqual(saved.bootstrap, { workspace: '/data/workspace' });
  assert.equal(saved.providers['metaid-free'].apiKey, 'fixture-relay-key');
  assert.equal(saved.providers['metaid-free'].baseUrl, 'https://relay.fixture');
  assert.equal(mobileI18n.getLanguage(), 'zh');
  assert.equal(getThemeMode(), 'dark');
});

test('mobile settings do not report local success when persistence fails', async (t) => {
  const api = installBridge(t);
  await api.store.set('app_config', { language: 'en', theme: 'system' });
  api.store.set = async () => {
    throw new Error('fixture offline');
  };

  await assert.rejects(setLanguage('zh'), /fixture offline/);
  await assert.rejects(setThemeMode('dark'), /fixture offline/);
  assert.equal(mobileI18n.getLanguage(), 'en');
  assert.equal(getThemeMode(), 'system');
});

test('mobile settings require a matching readback before applying locally', async (t) => {
  const api = installBridge(t);
  await api.store.set('app_config', { language: 'en', theme: 'system' });
  api.store.get = async () => ({ language: 'en', theme: 'system' });

  await assert.rejects(setThemeMode('dark'), /could not be confirmed/);
  assert.equal(getThemeMode(), 'system');
});

test('mock cowork memory config persists allowed global fields and preserves the rest', async (t) => {
  const api = installBridge(t);
  const before = await api.cowork.getConfig();
  assert.equal(before.success, true);

  const saved = await api.cowork.setConfig({ memoryEnabled: false, memoryLlmJudgeEnabled: true });
  assert.equal(saved.success, true);
  const after = await api.cowork.getConfig();
  assert.equal(after.config.memoryEnabled, false);
  assert.equal(after.config.memoryLlmJudgeEnabled, true);
  assert.equal(after.config.memoryImplicitUpdateEnabled, before.config.memoryImplicitUpdateEnabled);
  assert.equal(after.config.workingDirectory, before.config.workingDirectory);
});
