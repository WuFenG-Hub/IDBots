// DSH-only kernel routing: Anthropic Messages is unavailable (no Claude SDK
// fallback); everything else including sticky `dsh:` handles runs on DSH.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const {
  DSH_SESSION_PREFIX,
  isDshSessionHandle,
  dshSessionIdOf,
  makeDshSessionHandle,
  isDshEligibleApiType,
  resolveKernelChoice,
} = require('../dist-electron/main/libs/coworkKernelRouting.js')

test('session handle helpers round-trip', () => {
  const handle = makeDshSessionHandle('cw-42')
  assert.ok(handle.startsWith(DSH_SESSION_PREFIX))
  assert.equal(isDshSessionHandle(handle), true)
  assert.equal(isDshSessionHandle('classic-sdk-session-id'), false)
  assert.equal(isDshSessionHandle(null), false)
  assert.equal(dshSessionIdOf(handle), 'cw-42')
  assert.equal(dshSessionIdOf('classic'), null)
})

test('apiType eligibility: openai-compatible routes only', () => {
  assert.equal(isDshEligibleApiType('openai'), true)
  assert.equal(isDshEligibleApiType('responses'), true)
  assert.equal(isDshEligibleApiType('anthropic'), false)
  assert.equal(isDshEligibleApiType(undefined), false)
})

test('local cowork is DSH-only; Anthropic Messages is unavailable', () => {
  assert.equal(resolveKernelChoice({ apiType: 'openai' }), 'dsh')
  assert.equal(resolveKernelChoice({ apiType: 'responses' }), 'dsh')
  assert.equal(resolveKernelChoice({ apiType: 'anthropic' }), 'unavailable')
  assert.equal(resolveKernelChoice({ apiType: undefined }), 'dsh')
  // Stickiness: a DSH session keeps its kernel even on Anthropic-direct
  // (its handle only exists in the DSH runtime).
  assert.equal(resolveKernelChoice({ apiType: 'anthropic', sessionHandle: 'dsh:cw-1' }), 'dsh')
  assert.equal(resolveKernelChoice({ apiType: 'anthropic', sessionHandle: 'sdk-123' }), 'unavailable')
})
