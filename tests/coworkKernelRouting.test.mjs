// M5 unit test: kernel routing decision (flag + apiType eligibility + handle
// stickiness) and the `dsh:` session-handle helpers.

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

test('flag gates new sessions; handle pins existing ones', () => {
  assert.equal(resolveKernelChoice({ enabled: false, apiType: 'openai' }), 'claude')
  assert.equal(resolveKernelChoice({ enabled: true, apiType: 'openai' }), 'dsh')
  assert.equal(resolveKernelChoice({ enabled: true, apiType: 'anthropic' }), 'unavailable')
  assert.equal(resolveKernelChoice({ enabled: false, apiType: 'anthropic' }), 'unavailable')
  // Stickiness wins over the flag: a DSH session keeps its kernel even when
  // the flag is later switched off (its handle only exists in the DSH runtime).
  assert.equal(resolveKernelChoice({ enabled: false, apiType: 'openai', sessionHandle: 'dsh:cw-1' }), 'dsh')
  // Anthropic-direct is not routed back to Claude.
  assert.equal(resolveKernelChoice({ enabled: true, apiType: 'anthropic', sessionHandle: 'sdk-123' }), 'unavailable')
})
