// Mid-conversation Cowork model switch on a live DSH session.
//
// Pre-fix: session/ensure on a live agent only rebound reasoning effort, so
// the next turn kept the original provider/model from the persisted session
// header. Switching away then back was the only way to keep talking — and
// switching onto a DeepSeek "max" effort while the agent was still on qwen
// threw UNSUPPORTED_REASONING_EFFORT. Same-provider model overwrites also
// dropped the original model from the runtime route table.
//
// This file covers the host-side union (mergeProviderRoute) and an E2E of
// the shared hub: two turns on ONE dsh session id, second turn a different
// provider/model, mock sees the new model id.
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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-modelswitch-${name}`),
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

function startModelRecordingMock(port) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* ignore */ }
      seen.push({ method: req.method, url: req.url, body: parsed })
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-1', object: 'model' }, { id: 'mock-2', object: 'model' }],
        }))
        return
      }
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const model = parsed.model ?? 'mock-1'
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model }
      frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      frame({ ...base, choices: [{ index: 0, delta: { content: `ok:${model}` }, finish_reason: null }] })
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      frame({ ...base, choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } })
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, seen }))
  })
}

test('mergeProviderRoute unions models instead of replacing the route', () => {
  const { mergeProviderRoute } = loadModules()
  const first = {
    key: 'qwen',
    apiFormat: 'openai',
    baseUrl: 'http://qwen.example/v1',
    apiKeyEnv: 'IDBOTS_DSH_KEY_QWEN',
    models: [{ id: 'qwen3.7-plus', contextWindow: 1000000 }],
  }
  const second = {
    key: 'qwen',
    apiFormat: 'openai',
    baseUrl: 'http://qwen.example/v1',
    apiKeyEnv: 'IDBOTS_DSH_KEY_QWEN',
    models: [{ id: 'qwen3.6-plus', contextWindow: 1000000, maxOutputTokens: 8192 }],
  }
  const merged = mergeProviderRoute(first, second)
  assert.equal(merged.key, 'qwen')
  assert.deepEqual(merged.models.map((model) => model.id), ['qwen3.7-plus', 'qwen3.6-plus'])
  const switchedBack = mergeProviderRoute(merged, first)
  assert.deepEqual(switchedBack.models.map((model) => model.id), ['qwen3.7-plus', 'qwen3.6-plus'])
  assert.equal(mergeProviderRoute(undefined, first), first)
})

test('live DSH session switches provider/model on the next turn', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { DshTurnHub } = loadModules()
  const { server, seen } = await startModelRecordingMock(48812)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-modelswitch-'))
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    mcpServersProvider: () => [],
    log: () => undefined,
  })

  const route = (key, model) => ({
    key,
    apiFormat: 'openai',
    baseUrl: 'http://127.0.0.1:48812/v1',
    apiKey: 'sk-mock',
    model,
    contextWindow: 64000,
  })
  const run = (provider, prompt) => hub.runTurn({
    sessionId: 'cowork-switch',
    dshSessionId: 'cw-switch',
    provider,
    sections: [],
    prompt,
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
    const first = await run(route('gw-a', 'mock-1'), 'first turn on mock-1')
    assert.equal(first.kind, 'completed', `turn 1 should complete, got ${JSON.stringify(first)}`)
    const second = await run(route('gw-b', 'mock-2'), 'second turn on mock-2')
    assert.equal(second.kind, 'completed', `turn 2 should complete after model switch, got ${JSON.stringify(second)}`)
    const third = await run(route('gw-a', 'mock-1'), 'third turn back on mock-1')
    assert.equal(third.kind, 'completed', `turn 3 should complete after switching back, got ${JSON.stringify(third)}`)

    const completionCalls = seen.filter((r) => r.method === 'POST' && r.url.endsWith('/chat/completions'))
    assert.ok(completionCalls.length >= 3, `expected >=3 completion calls, got ${completionCalls.length}`)
    const models = completionCalls.map((r) => r.body?.model)
    assert.equal(models[0], 'mock-1', `first turn must use mock-1, got ${models[0]}`)
    assert.equal(models[1], 'mock-2', `second turn must switch to mock-2 (pre-fix this stayed mock-1), got ${models[1]}`)
    assert.equal(models[2], 'mock-1', `third turn must switch back to mock-1, got ${models[2]}`)
  } finally {
    await hub.close?.().catch(() => undefined)
    await new Promise((resolve) => server.close(resolve))
  }
})
