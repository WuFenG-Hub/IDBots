// Regression test: the shared DSH runtime must serve EVERY provider route
// with ITS OWN API key.
//
// Pre-fix behavior: every route's generated config referenced ONE shared env
// var (IDBOTS_DSH_API_KEY), and the runtime child env carried only the key of
// whichever provider last (re)started the runtime. Turn sequence
// A → B → A then sent B's key to A's upstream: cross-provider 401 "Invalid
// API key" while the very same key worked via curl (the opencode/deepseek
// incident, group task #27). The fix gives every route a stable per-provider
// env name (dshProviderApiKeyEnv) and accumulates every seen route's key into
// the child env.
//
// The test drives the REAL hub + runtime against a key-validating mock
// gateway: turn A → turn B → turn A again. Under the old code the third turn
// 401s (mock rejects B's key on A's route); under the fix all three succeed.
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const here = path.dirname(new URL(import.meta.url).pathname)
const runtimeDir = path.resolve(here, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-perroute-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkDshTurn.js')
  } finally {
    Module._load = originalLoad
  }
}

/** OpenAI-compatible mock that rejects any key other than the expected ones
 *  with a real 401 — the discriminator for the shared-env-var bug. */
function startKeyValidatingMock(port) {
  const seen = []
  const validKeys = new Set(['key-a', 'key-b'])
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* ignore */ }
      const auth = req.headers.authorization ?? '(none)'
      seen.push({ method: req.method, url: req.url, auth, body: parsed })
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }))
        return
      }
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }))
        return
      }
      const key = (auth.match(/^Bearer\s+(.+)$/) ?? [])[1] ?? ''
      if (!validKeys.has(key)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'AuthError', message: 'Invalid API key.' } }))
        return
      }
      // OpenAI chat.completion.chunk SSE stream (same shape the shared
      // mock-openai fixture serves) with a usage trailer so pi-ai's stream
      // finalizer accepts the turn.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: 'mock-1' }
      frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      frame({ ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      frame({ ...base, choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } })
      res.end(`data: [DONE]\n\n`)
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, seen }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('every provider route rides its own credential; A→B→A all succeed', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { DshTurnHub } = loadModules()
  const { server, seen } = await startKeyValidatingMock(48811)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-perroute-'))
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    mcpServersProvider: () => [],
    log: () => undefined,
  })

  const route = (key, apiKey, model) => ({
    key,
    apiFormat: 'openai',
    baseUrl: 'http://127.0.0.1:48811/v1',
    apiKey,
    model,
    contextWindow: 64000,
  })
  const turn = (provider) => hub.runTurn({
    sessionId: `s-${provider.key}`,
    dshSessionId: `dsh-${provider.key}`,
    provider,
    sections: [],
    prompt: 'reply with ok',
    workspace: { cwd: sessionRoot },
    callbacks: {
      onMessage: () => 'm1',
      onMessageUpdate: () => undefined,
      onMessageFinalize: () => undefined,
      onUsage: () => undefined,
      onApprovalRequest: () => undefined,
      onApprovalCancelled: () => undefined,
      onError: () => undefined,
    },
  })

  try {
    // Turn 1 on provider A with A's key: baseline.
    const first = await turn(route('gw-a', 'key-a', 'mock-1'))
    assert.equal(first.kind, 'completed', `turn A (first) should complete, got ${JSON.stringify(first)}`)
    // Turn 2 on provider B: its key must NOT displace A's credential.
    const second = await turn(route('gw-b', 'key-b', 'mock-1'))
    assert.equal(second.kind, 'completed', `turn B should complete, got ${JSON.stringify(second)}`)
    // Turn 3 on A again: the regression — pre-fix this sent B's key to A's
    // route (shared env var held only the last restarting provider's key)
    // and the mock answered 401.
    const third = await turn(route('gw-a', 'key-a', 'mock-1'))
    assert.equal(third.kind, 'completed', `turn A (after B) must still complete — pre-fix it 401'd with B's key, got ${JSON.stringify(third)}`)

    const completionCalls = seen.filter((r) => r.method === 'POST' && r.url.endsWith('/chat/completions'))
    assert.ok(completionCalls.length >= 3, `expected >=3 completion calls, got ${completionCalls.length}`)
    const auths = completionCalls.map((r) => r.auth)
    // Every request must carry the expected per-route key: A→B→A.
    assert.equal(auths[0], 'Bearer key-a')
    assert.equal(auths[1], 'Bearer key-b')
    assert.equal(auths[2], 'Bearer key-a')
    assert.ok(completionCalls.every((r) => r.auth !== '(none)'), 'no request may go out without a credential')
  } finally {
    await hub.close?.().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
  }
})

test('dshProviderApiKeyEnv derives stable, distinct per-route env names', () => {
  const { dshProviderApiKeyEnv } = loadModules()
  const a = dshProviderApiKeyEnv('opencode')
  const b = dshProviderApiKeyEnv('deepseek')
  assert.notEqual(a, b)
  assert.equal(dshProviderApiKeyEnv('opencode'), a, 'env name must be stable per route key')
  assert.equal(dshProviderApiKeyEnv('deepseek'), b)
  // Sanitized for dsh-credentials: refs must match /^[A-Za-z_][A-Za-z0-9_]*$/.
  assert.match(dshProviderApiKeyEnv('custom-scnet'), /^IDBOTS_DSH_KEY_[A-Z0-9_]+$/)
  assert.doesNotMatch(dshProviderApiKeyEnv('metaid-free'), /-/, 'dash is not a legal credential-ref character')
})
