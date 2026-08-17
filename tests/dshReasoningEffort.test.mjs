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

// The Responses wire (DeepSeek's current default route): pi-ai forces
// reasoning.effort='none' when no effort rides the request, so the UI ladder
// must map onto real wire values — none/low/medium/high per product decision.
test('mapDshReasoningEffort: DeepSeek Responses dialect shifts the ladder onto the wire', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort('low', undefined, 'deepseek-responses'), 'off', '快速 → none')
  assert.equal(mapDshReasoningEffort('minimal', undefined, 'deepseek-responses'), 'off')
  assert.equal(mapDshReasoningEffort('medium', undefined, 'deepseek-responses'), 'low', '标准 → low')
  assert.equal(mapDshReasoningEffort('high', undefined, 'deepseek-responses'), 'medium', '深度 → medium')
  assert.equal(mapDshReasoningEffort('max', undefined, 'deepseek-responses'), 'high', '极限 → high (wire max stays unused)')
  assert.equal(mapDshReasoningEffort('xhigh', undefined, 'deepseek-responses'), 'high')
  assert.equal(mapDshReasoningEffort('MAX', undefined, 'deepseek-responses'), 'high')
  // 'off' is a legal DSH id on this dialect too (model default may store it).
  assert.equal(mapDshReasoningEffort('off', undefined, 'deepseek-responses'), 'off')
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
