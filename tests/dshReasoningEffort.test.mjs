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

// The first-party dsh-llm-deepseek adapter ladder (off/low/high/max on the
// chat-completions wire). Since the app-wide effort vocabulary was aligned
// onto that ladder (2026-08-19), the four canonical values map one-to-one;
// only legacy five-step values (medium, xhigh, minimal) keep their historical
// alignment (标准→low, 极限→max, 快速-minimal→off).
test('mapDshReasoningEffort: deepseek-native dialect aligns onto the adapter ladder', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort('off', undefined, 'deepseek-native'), 'off')
  assert.equal(mapDshReasoningEffort('low', undefined, 'deepseek-native'), 'low', '低 → low')
  assert.equal(mapDshReasoningEffort('high', undefined, 'deepseek-native'), 'high', '高 → high')
  assert.equal(mapDshReasoningEffort('max', undefined, 'deepseek-native'), 'max', '最高 → max (true wire max)')
  // Legacy five-step values keep their historical alignment.
  assert.equal(mapDshReasoningEffort('medium', undefined, 'deepseek-native'), 'low', '标准 → low')
  assert.equal(mapDshReasoningEffort('minimal', undefined, 'deepseek-native'), 'off')
  assert.equal(mapDshReasoningEffort('xhigh', undefined, 'deepseek-native'), 'max')
  assert.equal(mapDshReasoningEffort('MAX', undefined, 'deepseek-native'), 'max')
})

test('mapDshReasoningEffort: explicit low effort rides with thinking default enabled', () => {
  const { mapDshReasoningEffort } = loadMapper()
  assert.equal(mapDshReasoningEffort('low', { type: 'enabled' }, 'deepseek-native'), 'low')
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
