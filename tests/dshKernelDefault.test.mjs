// Kernel default flip: isDshKernelEnabled treats UNSET app_config as DSH (the
// shipping default) while an explicit false (the user switched the pill to
// Claude) keeps the Claude kernel. Env override still wins for dev instances.
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

test('isDshKernelEnabled: unset config adopts the DSH default', () => {
  const { claudeSettings } = loadModules()
  claudeSettings.setStoreGetter(() => ({ get: (key) => undefined }))
  const prevEnv = process.env.IDBOTS_DSH_KERNEL
  delete process.env.IDBOTS_DSH_KERNEL
  try {
    assert.equal(claudeSettings.isDshKernelEnabled(), true, 'no app_config / no key → DSH')
    claudeSettings.setStoreGetter(() => ({ get: (key) => (key === 'app_config' ? {} : undefined) }))
    assert.equal(claudeSettings.isDshKernelEnabled(), true, 'app_config without the key → DSH')
  } finally {
    if (prevEnv !== undefined) process.env.IDBOTS_DSH_KERNEL = prevEnv
  }
})

test('isDshKernelEnabled: explicit user choice sticks', () => {
  const { claudeSettings } = loadModules()
  const prevEnv = process.env.IDBOTS_DSH_KERNEL
  delete process.env.IDBOTS_DSH_KERNEL
  try {
    claudeSettings.setStoreGetter(() => ({ get: (key) => (key === 'app_config' ? { dshKernelEnabled: false } : undefined) }))
    assert.equal(claudeSettings.isDshKernelEnabled(), false, 'explicit false → Claude kernel')
    claudeSettings.setStoreGetter(() => ({ get: (key) => (key === 'app_config' ? { dshKernelEnabled: true } : undefined) }))
    assert.equal(claudeSettings.isDshKernelEnabled(), true, 'explicit true → DSH kernel')
  } finally {
    if (prevEnv !== undefined) process.env.IDBOTS_DSH_KERNEL = prevEnv
  }
})

test('isDshKernelEnabled: env override still wins', () => {
  const { claudeSettings } = loadModules()
  claudeSettings.setStoreGetter(() => ({ get: (key) => (key === 'app_config' ? { dshKernelEnabled: false } : undefined) }))
  const prevEnv = process.env.IDBOTS_DSH_KERNEL
  process.env.IDBOTS_DSH_KERNEL = '1'
  try {
    assert.equal(claudeSettings.isDshKernelEnabled(), true)
  } finally {
    if (prevEnv === undefined) delete process.env.IDBOTS_DSH_KERNEL
    else process.env.IDBOTS_DSH_KERNEL = prevEnv
  }
})
