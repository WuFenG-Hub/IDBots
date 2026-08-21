// Local cowork is DSH-only: isDshKernelEnabled always returns true so a
// leftover `dshKernelEnabled: false` in app_config cannot resurrect the
// Claude Agent SDK kernel.
//
// Requires: npm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => process.cwd(),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return { claudeSettings: require('../dist-electron/main/libs/claudeSettings.js') }
  } finally {
    Module._load = originalLoad
  }
}

test('isDshKernelEnabled: always DSH regardless of persisted config', () => {
  const { claudeSettings } = loadModules()
  claudeSettings.setStoreGetter(() => ({ get: (key) => undefined }))
  assert.equal(claudeSettings.isDshKernelEnabled(), true, 'no app_config → DSH')
  claudeSettings.setStoreGetter(() => ({ get: (key) => (key === 'app_config' ? {} : undefined) }))
  assert.equal(claudeSettings.isDshKernelEnabled(), true, 'app_config without the key → DSH')
  claudeSettings.setStoreGetter(() => ({ get: (key) => (key === 'app_config' ? { dshKernelEnabled: false } : undefined) }))
  assert.equal(claudeSettings.isDshKernelEnabled(), true, 'leftover false cannot resurrect Claude')
  claudeSettings.setStoreGetter(() => ({ get: (key) => (key === 'app_config' ? { dshKernelEnabled: true } : undefined) }))
  assert.equal(claudeSettings.isDshKernelEnabled(), true, 'explicit true → DSH')
})

test('isDshKernelEnabled: env override is ignored because DSH is the only kernel', () => {
  const { claudeSettings } = loadModules()
  claudeSettings.setStoreGetter(() => ({ get: (key) => (key === 'app_config' ? { dshKernelEnabled: false } : undefined) }))
  const prevEnv = process.env.IDBOTS_DSH_KERNEL
  process.env.IDBOTS_DSH_KERNEL = '0'
  try {
    assert.equal(claudeSettings.isDshKernelEnabled(), true)
  } finally {
    if (prevEnv === undefined) delete process.env.IDBOTS_DSH_KERNEL
    else process.env.IDBOTS_DSH_KERNEL = prevEnv
  }
})
