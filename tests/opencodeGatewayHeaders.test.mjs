// Main-process OpenCode Go gateway header helper.
// Requires: npm run compile:electron (imports dist-electron/main/libs/...).
import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = Module.createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const helperPath = path.resolve(here, '..', 'dist-electron', 'main', 'libs', 'opencodeGatewayHeaders.js')
const { isOpenCodeGoBaseUrl, buildOpenCodeGoHeaders } = require(helperPath)

test('isOpenCodeGoBaseUrl: OpenCode Go gateway host only', () => {
  assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1'), true)
  assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1/responses'), true)
  assert.equal(isOpenCodeGoBaseUrl('https://api.opencode.ai/v1/messages'), true)
  assert.equal(isOpenCodeGoBaseUrl('https://api.deepseek.com'), false)
  assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai.evil.example/x'), false)
  assert.equal(isOpenCodeGoBaseUrl(null), false)
  assert.equal(isOpenCodeGoBaseUrl(''), false)
})

test('buildOpenCodeGoHeaders: gateway requests carry x-opencode-session', () => {
  const headers = buildOpenCodeGoHeaders('https://opencode.ai/zen/go/v1')
  assert.ok(headers['x-opencode-session'])
  assert.ok(headers['x-opencode-session'].length > 0)
  // Stable session id passthrough for conversation-scoped calls.
  const stable = buildOpenCodeGoHeaders('https://opencode.ai/zen/go/v1', 'conv-123')
  assert.equal(stable['x-opencode-session'], 'conv-123')
})

test('buildOpenCodeGoHeaders: non-gateway targets get nothing', () => {
  assert.deepEqual(buildOpenCodeGoHeaders('https://api.deepseek.com', 'conv-123'), {})
  assert.deepEqual(buildOpenCodeGoHeaders(null, 'conv-123'), {})
})
