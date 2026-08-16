// DSH reasoning-effort mapping: UI auto/low/medium/high/max + thinking
// toggle → pi-ai ReasoningEffortId.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)

function loadMapper() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/dshReasoningEffort.js')
  } finally {
    Module._load = originalLoad
  }
}

test('mapDshReasoningEffort: auto (null) omits effort so the route default applies', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort(null), undefined)
  assert.equal(mapDshReasoningEffort(undefined), undefined)
  assert.equal(mapDshReasoningEffort(''), undefined)
  assert.equal(mapDshReasoningEffort('  '), undefined)
})

test('mapDshReasoningEffort: generic dialect passes UI levels through as DSH ids', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort('low'), 'low')
  assert.equal(mapDshReasoningEffort('medium'), 'medium')
  assert.equal(mapDshReasoningEffort('high'), 'high')
  assert.equal(mapDshReasoningEffort('max'), 'max')
  assert.equal(mapDshReasoningEffort('MAX'), 'max')
})

test('mapDshReasoningEffort: DeepSeek dialect maps 快速/标准 onto off/high', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort('low', undefined, 'deepseek'), 'off')
  assert.equal(mapDshReasoningEffort('minimal', undefined, 'deepseek'), 'off')
  assert.equal(mapDshReasoningEffort('medium', undefined, 'deepseek'), 'high')
  assert.equal(mapDshReasoningEffort('high', undefined, 'deepseek'), 'high')
  assert.equal(mapDshReasoningEffort('max', undefined, 'deepseek'), 'max')
  assert.equal(mapDshReasoningEffort('LOW', undefined, 'deepseek'), 'off')
})

test('mapDshReasoningEffort: DeepSeek 快速 wins over model thinking-enabled default', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort('low', { type: 'enabled' }, 'deepseek'), 'off')
})

test('mapDshReasoningEffort: thinking disabled forces off', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort('max', { type: 'disabled' }), 'off')
  assert.equal(mapDshReasoningEffort(null, { type: 'disabled' }), 'off')
  assert.equal(mapDshReasoningEffort('none'), 'off')
})

test('mapDshReasoningEffort: unknown values are dropped', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort('turbo'), undefined)
})
