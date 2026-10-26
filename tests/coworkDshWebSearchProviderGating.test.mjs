// Regression test for the web-search provider gate (fix/websearch-provider-gating,
// owner ruling 2026-10-25 22:16): with a DeepSeek route active in the same hub, a
// non-DeepSeek chat provider (e.g. zhipu glm) must NOT get the DeepSeek server-side
// web search trio mounted into its runtime composition and must NOT be offered the
// web_search tool — the search endpoint is DeepSeek-account-bound, and an
// out-of-balance DeepSeek account turned every such call into an HTTP 402. The gate
// must log exactly one explanatory notice per non-DeepSeek slot (pointing at the
// browser-search skill fallback), must stay stable across later turns on that slot
// even after a DeepSeek route becomes active hub-wide, and must not affect the
// DeepSeek slot's own mount. Requires: npm run compile:electron +
// dsh-runtime/node_modules.

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
const PORT = 48796

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `websearch-gate-${name}`),
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

test('web search provider gate: non-DeepSeek slot never mounts the DeepSeek trio',
  { skip: !runtimeReady && 'dsh-runtime node_modules not installed' },
  async () => {
    const { DshTurnHub, dshRuntimeConfigFileName } = loadModules()
    const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
    const { server, seen } = await startMockServer(PORT)
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-websearch-gate-'))
    const messages = []
    const hubLogs = []
    const hub = new DshTurnHub({
      runtimeDir,
      sessionRoot,
      log: (level, event, data) => { hubLogs.push({ level, event, data }) },
    })
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
    const zhipuLike = () => ({
      key: 'zhipu-like',
      apiFormat: 'openai',
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      apiKey: 'sk-zhipu',
      model: 'mock-1',
    })

    try {
      // Turn 1 (zhipu-style provider, BEFORE any DeepSeek route exists): the
      // slot boots without the trio and says so exactly once.
      const first = await runOneTurn(`wg-${Date.now().toString(36)}`, zhipuLike(), 'HELLO_MOCK')
      assert.notEqual(first.kind, 'error', `turn failed: ${first.reason}`)
      let rawZhipu = fs.readFileSync(path.join(sessionRoot, dshRuntimeConfigFileName('zhipu-like')), 'utf8')
      assert.ok(!rawZhipu.includes('@deepseek-ai/dsh-web'), 'no dsh-web entry for the non-DeepSeek slot (boot before any DeepSeek route)')
      assert.ok(!rawZhipu.includes('IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY'), 'DeepSeek search key env never referenced for the non-DeepSeek slot')
      assert.equal(hubLogs.filter((l) => l.event === 'dshTurnHub.webSearchProviderGated').length, 1, 'one gate notice before any DeepSeek route exists')

      // Turn 2 (official DeepSeek route, same hub): the DeepSeek slot mounts
      // the trio and executes a real search round trip.
      const deep = await runOneTurn(`wg-ds-${Date.now().toString(36)}`, {
        key: 'deepseek',
        apiFormat: 'openai',
        baseUrl: `http://127.0.0.1:${PORT}`,
        apiKey: 'sk-web-test',
        model: 'mock-1',
      }, 'CALL_WEB_SEARCH please')
      assert.notEqual(deep.kind, 'error', `turn failed: ${deep.reason}`)
      const cfgDeep = JSON.parse(fs.readFileSync(path.join(sessionRoot, dshRuntimeConfigFileName('deepseek')), 'utf8'))
      assert.ok(cfgDeep.some((e) => e.name === '@deepseek-ai/dsh-web'), 'DeepSeek slot still mounts the web trio')
      assert.ok(messages.some((m) => m.type === 'tool_use' && m.metadata?.toolName === 'web_search'), 'DeepSeek turn executed web_search')
      assert.equal(hub.runtimeSlotCount, 2, 'two runtimes booted (one per provider)')

      // Turn 3 (zhipu-style again, AFTER the DeepSeek route became active
      // hub-wide): the pre-fix hub-level stickiness mounted the trio into
      // every runtime at this point; the per-slot gate must keep this slot
      // clean and must not re-notify.
      const third = await runOneTurn(`wg2-${Date.now().toString(36)}`, zhipuLike(), 'HELLO_MOCK')
      assert.notEqual(third.kind, 'error', `turn failed: ${third.reason}`)
      rawZhipu = fs.readFileSync(path.join(sessionRoot, dshRuntimeConfigFileName('zhipu-like')), 'utf8')
      assert.ok(!rawZhipu.includes('@deepseek-ai/dsh-web'), 'no dsh-web entry after a DeepSeek route became active hub-wide')
      assert.ok(!rawZhipu.includes('@deepseek-ai/dsh-tool-web'), 'no web tool (web_search/web_fetch) for the non-DeepSeek slot')

      // The non-DeepSeek turns' model-facing requests must not offer
      // web_search. (/v1/chat/completions is only the zhipu-like provider's
      // URL space in this test — the DeepSeek provider's chat and aux search
      // requests never carry the /v1 prefix.)
      const gwRequests = seen.filter((r) => r.method === 'POST' && String(r.url).endsWith('/v1/chat/completions'))
      assert.ok(gwRequests.length > 0, 'non-DeepSeek turns reached their gateway')
      for (const req of gwRequests) {
        const tools = req.body?.tools ?? []
        assert.ok(
          !tools.some((t) => t?.function?.name === 'web_search' || t?.name === 'web_search'),
          'no non-DeepSeek request offers web_search to the model',
        )
      }

      // Exactly one notice per gated slot lifetime (turn 3 rebuilt the config
      // but must not re-notify), and the notice names the fallback skill.
      const gateNotices = hubLogs.filter((l) => l.event === 'dshTurnHub.webSearchProviderGated')
      assert.equal(gateNotices.length, 1, 'exactly one gate notice across multiple non-DeepSeek turns')
      assert.equal(gateNotices[0]?.data?.runtime, 'zhipu-like')
      assert.equal(gateNotices[0]?.data?.detail?.includes('browser-search skill'), true, 'notice points at the browser-search skill fallback')
    } finally {
      await hub.close()
      server.close()
      fs.rmSync(sessionRoot, { recursive: true, force: true })
    }
  })
