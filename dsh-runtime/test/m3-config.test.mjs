// M3 test: provider mapping + prompt sections + commit-time result shaping,
// all through a GENERATED runtime config (lib/generate-runtime-config.mjs)
// booted against a local OpenAI-compatible mock gateway — the real pi-ai
// request path, no fake LLM involved.
//
//  1. unit: generator maps all three IDBots apiFormats onto pi-ai protocols
//  2. E2E: sections ride the system prompt to the gateway; reply streams back
//  3. E2E: a tool-call round trip shapes the oversized result BEFORE it enters
//     history — the follow-up request the gateway receives carries the trimmed
//     tool result (≤ cap, with the trim marker), not the 60k blob
//
// Run: node test/m3-config.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- 1. generator unit checks ---------------------------------------------
const unit = generateRuntimeConfig({
  sessionRoot: '/tmp/x',
  providers: [
    { key: 'openai-gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm1', contextWindow: 64000 }] },
    { key: 'opencode', apiFormat: 'responses', baseUrl: 'https://b.example/v1', apiKeyEnv: 'K2', models: [{ id: 'm2', contextWindow: 128000, maxOutputTokens: 8192 }] },
    { key: 'claude-direct', apiFormat: 'anthropic', baseUrl: 'https://c.example', apiKeyEnv: 'K3', models: [{ id: 'm3', contextWindow: 200000 }] },
    { key: 'deepseek', native: true, apiFormat: 'responses', baseUrl: 'https://api.deepseek.com/anthropic/v1', apiKeyEnv: 'K4', models: [{ id: 'deepseek-v4-pro', contextWindow: 128000 }] },
  ],
  sections: [{ name: 'persona:metabot', order: 0, text: 'You are Alice.' }],
})
const piEntry = unit.find((e) => e.name === '@deepseek-ai/dsh-llm-pi-ai')
record('generator: three apiFormats map to three pi-ai protocols',
  piEntry.config.providers['openai-gw'].api === 'openai-completions'
  && piEntry.config.providers.opencode.api === 'openai-responses'
  && piEntry.config.providers['claude-direct'].api === 'anthropic-messages')
// Since f80b128e the official DeepSeek route rides the first-party
// dsh-llm-deepseek-api-key plugin (native off/low/high/max effort ladder) and never
// enters the pi-ai providers dict; since 0.1.7 the adapter is Messages-API
// only, so the generator normalizes any DeepSeek base URL onto the Messages
// root (`<origin>/anthropic`) and declares systemPromptUpdate: in-history on
// every catalog model (changed system snapshots append after the cached
// prefix instead of rewriting the leading system message).
const nativeEntry = unit.find((e) => e.name === '@deepseek-ai/dsh-llm-deepseek-api-key')
record('generator: native DeepSeek route rides dsh-llm-deepseek (never pi-ai)',
  nativeEntry !== undefined
  && piEntry.config.providers.deepseek === undefined
  && nativeEntry.config.apiKeyEnv === 'K4'
  && nativeEntry.config.baseURL === 'https://api.deepseek.com/anthropic'
  && nativeEntry.config.thinking === 'enabled'
  && nativeEntry.config.reasoningEffort === 'high'
  && nativeEntry.config.models[0].maxTokens === 32768
  && nativeEntry.config.models[0].systemPromptUpdate === 'in-history'
  && nativeEntry.config.models[0].toolUpdate === 'in-history'
  && piEntry.config.providers.opencode.models[0].maxTokens === 8192)
const visionNative = generateRuntimeConfig({
  sessionRoot: '/tmp/x',
  providers: [{
    key: 'deepseek', native: true, apiFormat: 'openai', baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'K4',
    models: [{ id: 'deepseek-v4-flash-vision-exp', contextWindow: 1_000_000, input: ['text', 'image'] }],
  }],
}).find((e) => e.name === '@deepseek-ai/dsh-llm-deepseek-api-key')
record('generator: native vision catalog emits inputModalities + image budgets',
  Array.isArray(visionNative?.config?.models?.[0]?.inputModalities)
  && visionNative.config.models[0].inputModalities.includes('image')
  && visionNative.config.models[0].imagePixelBudget === 640000
  && visionNative.config.models[0].imageMaxBytes === 1048576)
// 0.1.7 Messages-API migration: every historical chat-completions-era base
// URL shape collapses onto the `<origin>/anthropic` Messages root; an empty
// base URL omits the key so the adapter default applies.
const nativeBaseURLFor = (baseUrl) => generateRuntimeConfig({
  sessionRoot: '/tmp/x',
  providers: [{ key: 'deepseek', native: true, apiFormat: 'openai', baseUrl, apiKeyEnv: 'K4', models: [{ id: 'm', contextWindow: 128000 }] }],
  sections: [],
}).find((e) => e.name === '@deepseek-ai/dsh-llm-deepseek-api-key')?.config?.baseURL
record('generator: legacy DeepSeek base URL shapes migrate to the Messages root',
  nativeBaseURLFor('https://api.deepseek.com') === 'https://api.deepseek.com/anthropic'
  && nativeBaseURLFor('https://api.deepseek.com/') === 'https://api.deepseek.com/anthropic'
  && nativeBaseURLFor('https://api.deepseek.com/v1') === 'https://api.deepseek.com/anthropic'
  && nativeBaseURLFor('https://api.deepseek.com/chat/completions') === 'https://api.deepseek.com/anthropic'
  && nativeBaseURLFor('https://api.deepseek.com/responses') === 'https://api.deepseek.com/anthropic'
  && nativeBaseURLFor('https://api.deepseek.com/anthropic') === 'https://api.deepseek.com/anthropic'
  && nativeBaseURLFor('https://api.deepseek.com/anthropic/v1') === 'https://api.deepseek.com/anthropic'
  && nativeBaseURLFor('https://api.deepseek.com/anthropic/v1/') === 'https://api.deepseek.com/anthropic'
  && nativeBaseURLFor('') === undefined)
record('generator: dsh-authorization is never mounted',
  !unit.some((e) => e.name === '@deepseek-ai/dsh-authorization'))
// 0.1.7 experimental backends: off by default, mounted on demand.
record('generator: browser-use + computer-use stay unmounted by default',
  !unit.some((e) => String(e.name).includes('browser-use') || String(e.name).includes('computer-use')))
const withBrowser = generateRuntimeConfig({
  sessionRoot: '/tmp/x',
  providers: [{ key: 'openai-gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm1', contextWindow: 64000 }] }],
  sections: [],
  browserUse: { mode: 'launch', headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  computerUse: true,
})
const browserEntry = withBrowser.find((e) => e.name === '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp')
record('generator: browserUse mounts the service + Playwright MCP provider',
  withBrowser.some((e) => e.name === '@deepseek-ai/dsh-browser-use')
  && browserEntry?.config?.mode === 'launch'
  && browserEntry?.config?.headless === true
  && browserEntry?.config?.executablePath === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const attachEntry = generateRuntimeConfig({
  sessionRoot: '/tmp/x',
  providers: [{ key: 'openai-gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm1', contextWindow: 64000 }] }],
  sections: [],
  browserUse: { mode: 'attach', endpoint: 'http://127.0.0.1:9222' },
}).find((e) => e.name === '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp')
record('generator: attach mode carries the debugging endpoint',
  attachEntry?.config?.mode === 'attach' && attachEntry?.config?.endpoint === 'http://127.0.0.1:9222')
record('generator: computerUse mounts the service + cua native provider',
  withBrowser.some((e) => e.name === '@deepseek-ai/dsh-computer-use')
  && withBrowser.some((e) => e.name === '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'))
record('generator: sections config emitted', unit.some((e) => e.config?.sections?.[0]?.name === 'persona:metabot'))
record('generator: plugin paths are absolute (config location-independent)',
  unit.every((e) => !String(e.name).startsWith('./')))
record('generator: no webSearch input → no web entries mounted',
  !unit.some((e) => ['@deepseek-ai/dsh-web', '@deepseek-ai/dsh-web-search-deepseek', '@deepseek-ai/dsh-tool-web'].includes(e.name)))
const withWeb = generateRuntimeConfig({
  sessionRoot: '/tmp/x',
  providers: [{ key: 'deepseek', apiFormat: 'responses', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'K', models: [{ id: 'deepseek-v4-pro', contextWindow: 128000 }] }],
  webSearch: { apiKeyEnv: 'IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY', baseURL: 'https://api.deepseek.com/anthropic/v1', model: 'deepseek-v4-flash' },
})
record('generator: webSearch mounts the dsh-web trio (provider pinned, key via env name)',
  withWeb.some((e) => e.id === 'web' && e.name === '@deepseek-ai/dsh-web' && e.config?.searchProvider === 'deepseek-official')
  && withWeb.some((e) => e.id === 'web-search-deepseek' && e.name === '@deepseek-ai/dsh-web-search-deepseek'
    && e.config?.apiKeyEnv === 'IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY'
    && e.config?.baseURL === 'https://api.deepseek.com/anthropic/v1'
    && e.config?.model === 'deepseek-v4-flash')
  && withWeb.some((e) => e.id === 'tool-web' && e.name === '@deepseek-ai/dsh-tool-web' && e.config?.fetch === false && e.config?.searchTimeoutMs === 60000))
try {
  generateRuntimeConfig({ sessionRoot: '/tmp/x', providers: [{ key: 'bad', apiFormat: 'grpc', baseUrl: 'x', apiKeyEnv: 'K', models: [{ id: 'm', contextWindow: 1 }] }] })
  record('generator: unsupported apiFormat rejected', false)
} catch {
  record('generator: unsupported apiFormat rejected', true)
}

// ---- 2+3. E2E with the generated config ------------------------------------
const main = async () => {
  const { server, seen } = await startMockServer(48788)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-m3-sessions-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw',
      apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:48788/v1',
      apiKeyEnv: 'MOCK_API_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [
      { name: 'persona:metabot', order: 0, text: 'You are Alice, an on-chain assistant.' },
      { name: 'idbots:memory-strategy', order: 20, text: 'Memory policy: recall before acting.' },
    ],
    shaping: { maxChars: 8000, tailChars: 1000 },
    webSearch: { apiKeyEnv: 'MOCK_WEB_KEY', baseURL: 'http://127.0.0.1:48788/anthropic/v1', model: 'mock-1' },
    extraEntries: [{ id: 'idbots-big-tool', name: path.join(runtimeDir, 'test/fixtures/big-tool.mjs') }],
  })
  const configPath = path.join(os.tmpdir(), `idbots-m3-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, MOCK_API_KEY: 'sk-mock-123', MOCK_WEB_KEY: 'sk-web-mock-456', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `m3-e2e-${Date.now().toString(36)}`

  const events = []
  const waiters = new Set()
  const waiters2 = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      } else if (notification.method === 'session.status' && notification.params.sessionId === sessionId) {
        for (const wait of waiters2) wait(notification)
      }
    }
  })()
  pumping.catch(() => {})
  const waitForEvent = (predicate, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for session event (${events.length} seen)`)), timeoutMs)
    const wait = (payload) => {
      if (payload?.type !== undefined && predicate(payload)) {
        clearTimeout(timer)
        waiters.delete(wait)
        resolve(payload)
      }
    }
    waiters.add(wait)
  })

  // Plain turn: sections must reach the gateway's system prompt.
  const reply1 = waitForEvent((e) => e.type === 'assistant/message')
  await client.prompt(sessionId, [{ type: 'text', text: 'HELLO_MOCK' }])
  await reply1
  const firstRequest = seen.find((r) => r.body?.messages?.some((m) => m.role === 'system'))
  const systemText = firstRequest?.body?.messages?.find((m) => m.role === 'system')?.content ?? ''
  record('E2E: generated sections ride the system prompt to the gateway',
    systemText.includes('You are Alice, an on-chain assistant.') && systemText.includes('Memory policy'),
    `${systemText.length} chars`)
  record('E2E: streamed reply traversed the loop',
    events.some((e) => e.type === 'assistant/message' && JSON.stringify(e).includes('mock says')))

  // Tool round trip: shaping must bound the result before the follow-up request.
  // Wait for whole-agent idle first so the turn/end waiter can't swallow turn 1's.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for idle after turn 1')), 20000)
    const wait = (notification) => {
      if (notification.method === 'session.status' && notification.params.sessionId === sessionId && notification.params.status === 'idle') {
        clearTimeout(timer)
        waiters2.delete(wait)
        resolve()
      }
    }
    waiters2.add(wait)
  })
  const turn2 = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_BIG_TOOL please' }])
  await turn2
  // tool/result carries the callId (0.1.7: top-level message.toolCallId), not the tool name; the tool/call event carries the name.
  const bigCall = events.find((e) => e.type === 'tool/call' && e.data?.name === 'big_output_tool')
  const toolResult = bigCall ? events.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === bigCall.data.callId) : undefined
  record('E2E: tool executed through the real pi-ai path', Boolean(toolResult))
  const shapedLogText = JSON.stringify(toolResult ?? {})
  record('E2E: session log carries the shaped result (marker + bounded)',
    shapedLogText.includes('tool result trimmed') && shapedLogText.length < 20000,
    `${shapedLogText.length} chars`)
  const followUp = seen.filter((r) => r.body?.messages?.some((m) => m.role === 'tool')).at(-1)
  const toolMsg = followUp?.body?.messages?.find((m) => m.role === 'tool')
  const toolContent = typeof toolMsg?.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg?.content ?? '')
  record('E2E: follow-up request carries the trimmed tool result (≤ cap, marker present)',
    toolContent.includes('tool result trimmed') && toolContent.length <= 9500,
    `${toolContent.length} chars`)
  record('E2E: full blob never left the runtime', !toolContent.includes('BIG-BLOB-END') || toolContent.length < 9000)

  // Web-search round trip: the model-facing web_search tool (dsh-web trio)
  // must reach the gateway's tool list, and executing it must POST the aux
  // Anthropic-compatible search call (native web_search_20250305 server tool,
  // key via the dedicated env var) and return formatted sources to the model.
  const firstTools = firstRequest?.body?.tools ?? []
  record('E2E: web_search rides the tool list to the gateway (web_fetch absent)',
    firstTools.some((t) => t?.function?.name === 'web_search' || t?.name === 'web_search')
    && !JSON.stringify(firstTools).includes('web_fetch'))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for idle after big-tool turn')), 20000)
    const wait = (notification) => {
      if (notification.method === 'session.status' && notification.params.sessionId === sessionId && notification.params.status === 'idle') {
        clearTimeout(timer)
        waiters2.delete(wait)
        resolve()
      }
    }
    waiters2.add(wait)
  })
  const turn3 = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_WEB_SEARCH please' }])
  await turn3
  const auxSearch = seen.find((r) => r.method === 'POST' && String(r.url).endsWith('/messages'))
  record('E2E: aux search call hit the Anthropic-compat endpoint with the server tool + env key',
    Boolean(auxSearch)
    && auxSearch.body?.tools?.[0]?.type === 'web_search_20250305'
    && auxSearch.body?.tools?.[0]?.max_uses === 5
    && auxSearch.body?.model === 'mock-1'
    && auxSearch.auth === 'Bearer sk-web-mock-456',
    auxSearch ? `${auxSearch.url}` : 'no /messages request seen')
  const webCall = events.find((e) => e.type === 'tool/call' && e.data?.name === 'web_search')
  const webResult = webCall ? events.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === webCall.data.callId) : undefined
  const webResultText = JSON.stringify(webResult ?? {})
  record('E2E: web_search tool executed with formatted sources',
    webResultText.includes('Sources:') && webResultText.includes('nodejs.org/en/blog/release/v26.0.0'))
  const followUpWeb = seen.filter((r) => r.body?.messages?.some((m) => m.role === 'tool')).at(-1)
  const webToolMsg = followUpWeb?.body?.messages?.filter((m) => m.role === 'tool').at(-1)
  const webToolContent = typeof webToolMsg?.content === 'string' ? webToolMsg.content : JSON.stringify(webToolMsg?.content ?? '')
  record('E2E: follow-up request carries the web_search result to the model',
    webToolContent.includes('Sources:') && webToolContent.includes('nodejs.org'))

  // Web-search failure diagnostics (0.1.2): when the aux endpoint fails, the
  // tool result error must carry the actual endpoint and recovery guidance
  // (searchEndpointError) so the model — and through it the user — can see
  // WHERE the search call went, not just that it failed.
  const turn4 = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_WEB_SEARCH_FAIL please' }])
  await turn4
  const failCalls = events.filter((e) => e.type === 'tool/call' && e.data?.name === 'web_search')
  const failCall = failCalls.at(-1)
  // The mock reuses `call_web_search_1` across turns — match by seq order.
  const failResult = failCall ? events.find((e) => e.type === 'tool/result'
    && e.data?.message?.toolCallId === failCall.data.callId && e.seq > failCall.seq) : undefined
  const failText = JSON.stringify(failResult ?? {})
  record('E2E: web_search failure reports the endpoint and guidance',
    failText.includes('/anthropic/v1/messages')
      && failText.toLowerCase().includes('endpoint')
      && (failText.includes('overloaded') || failText.includes('503')),
    failText.slice(0, 120))

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  record('clean close', true)

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[m3-test] fatal:', error)
  process.exit(1)
})
