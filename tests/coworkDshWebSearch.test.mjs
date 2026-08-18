// Host-side wiring for DeepSeek server-side web search on the DSH kernel: an
// official-DeepSeek provider route must mount the dsh-web trio into the
// runtime composition (credential via a dedicated child-env var, never the
// config file on disk), the model must see the `web_search` tool, and a
// search round trip must execute against the Anthropic-compatible endpoint.
// A later non-DeepSeek turn must NOT unmount the trio (sticky, like MCP
// servers). Requires: npm run compile:electron + dsh-runtime/node_modules.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = Module.createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))
const PORT = 48795

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `websearch-${name}`),
        },
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

test('deepseek web search: URL normalization + route detection', () => {
  const { deepSeekWebSearchBaseURL, isOfficialDeepSeekRoute } = loadModules()
  assert.equal(deepSeekWebSearchBaseURL('https://api.deepseek.com'), 'https://api.deepseek.com/anthropic/v1')
  assert.equal(deepSeekWebSearchBaseURL('https://api.deepseek.com/'), 'https://api.deepseek.com/anthropic/v1')
  assert.equal(deepSeekWebSearchBaseURL('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic/v1')
  assert.equal(deepSeekWebSearchBaseURL('https://api.deepseek.com/anthropic/v1'), 'https://api.deepseek.com/anthropic/v1')
  assert.equal(deepSeekWebSearchBaseURL('https://api.deepseek.com/responses'), 'https://api.deepseek.com/anthropic/v1')
  assert.equal(isOfficialDeepSeekRoute({ key: 'deepseek', baseUrl: 'http://relay.example/v1' }), true)
  assert.equal(isOfficialDeepSeekRoute({ key: 'opencode', baseUrl: 'https://api.deepseek.com/anthropic' }), true)
  assert.equal(isOfficialDeepSeekRoute({ key: 'opencode', baseUrl: 'http://127.0.0.1:48795/v1' }), false)
})

test('deepseek web search: hub mounts the dsh-web trio and executes a search round trip',
  { skip: !runtimeReady && 'dsh-runtime node_modules not installed' },
  async () => {
    const { DshTurnHub } = loadModules()
    const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
    const { server, seen } = await startMockServer(PORT)
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-websearch-'))
    const messages = []
    const hub = new DshTurnHub({ runtimeDir, sessionRoot, log: () => undefined })
    const callbacks = {
      onMessage: (message) => { messages.push(message); return `msg-${messages.length}` },
      onMessageUpdate: () => undefined,
      onMessageFinalize: () => undefined,
      onUsage: () => undefined,
      onApprovalRequest: () => undefined,
      onApprovalCancelled: () => undefined,
    }
    const runOneTurn = (dshSessionId, provider, prompt) => hub.runTurn({
      sessionId: `cowork-${dshSessionId}`,
      dshSessionId,
      prompt,
      provider,
      sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      callbacks,
    })

    try {
      const outcome = await runOneTurn(`ws-${Date.now().toString(36)}`, {
        key: 'deepseek',
        apiFormat: 'openai',
        baseUrl: `http://127.0.0.1:${PORT}`,
        apiKey: 'sk-web-test',
        model: 'mock-1',
      }, 'CALL_WEB_SEARCH please')
      assert.notEqual(outcome.kind, 'error', `turn failed: ${outcome.reason}`)

      // Composition file: the trio is mounted with the env-name indirection —
      // the key itself must never appear in cordis.runtime.json.
      const raw = fs.readFileSync(path.join(sessionRoot, 'cordis.runtime.json'), 'utf8')
      const cfg = JSON.parse(raw)
      const web = cfg.find((e) => e.name === '@deepseek-ai/dsh-web')
      assert.ok(web, 'dsh-web entry mounted')
      assert.equal(web.config.searchProvider, 'deepseek-official')
      const search = cfg.find((e) => e.name === '@deepseek-ai/dsh-web-search-deepseek')
      assert.ok(search, 'web-search-deepseek entry mounted')
      assert.equal(search.config.apiKeyEnv, 'IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY')
      assert.equal(search.config.baseURL, `http://127.0.0.1:${PORT}/anthropic/v1`)
      assert.equal(search.config.model, 'deepseek-v4-flash')
      const toolWeb = cfg.find((e) => e.name === '@deepseek-ai/dsh-tool-web')
      assert.ok(toolWeb, 'tool-web entry mounted')
      assert.equal(toolWeb.config.fetch, false)
      assert.ok(!raw.includes('sk-web-test'), 'API key never enters the config file')

      // The aux search call hit the Anthropic-compat endpoint with the native
      // server tool and the env-carried credential.
      const aux = seen.find((r) => r.method === 'POST' && String(r.url).endsWith('/messages'))
      assert.ok(aux, 'aux anthropic search request seen')
      assert.equal(aux.body?.tools?.[0]?.type, 'web_search_20250305')
      assert.equal(aux.body?.tools?.[0]?.name, 'web_search')
      assert.equal(aux.body?.model, 'deepseek-v4-flash')
      assert.equal(aux.auth, 'Bearer sk-web-test')

      // The model saw the tool and the formatted sources landed in history.
      assert.ok(messages.some((m) => m.type === 'tool_use' && m.metadata?.toolName === 'web_search'), 'web_search tool_use recorded')
      assert.ok(messages.some((m) => m.type === 'tool_result' && String(m.content).includes('Sources:')), 'formatted sources recorded')
      const followUp = seen.filter((r) => r.body?.messages?.some((m) => m.role === 'tool')).at(-1)
      const toolMsg = followUp?.body?.messages?.filter((m) => m.role === 'tool').at(-1)
      const toolContent = typeof toolMsg?.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg?.content ?? '')
      assert.match(toolContent, /Sources:/, 'follow-up request carries the search result to the model')

      // Stickiness: a non-DeepSeek provider on the same runtime never
      // unmounts the trio (config-change restarts are provider-env only).
      await runOneTurn(`ws2-${Date.now().toString(36)}`, {
        key: 'mockgw',
        apiFormat: 'openai',
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        apiKey: 'sk-other',
        model: 'mock-1',
      }, 'HELLO_MOCK')
      const cfg2 = JSON.parse(fs.readFileSync(path.join(sessionRoot, 'cordis.runtime.json'), 'utf8'))
      assert.ok(cfg2.some((e) => e.name === '@deepseek-ai/dsh-web'), 'web trio stays mounted after a non-deepseek turn')
    } finally {
      await hub.close()
      server.close()
      fs.rmSync(sessionRoot, { recursive: true, force: true })
    }
  })
