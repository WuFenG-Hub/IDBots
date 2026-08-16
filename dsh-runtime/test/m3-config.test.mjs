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
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
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
    { key: 'deepseek-gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', thinkingFormat: 'deepseek', models: [{ id: 'm1', contextWindow: 64000 }] },
    { key: 'opencode', apiFormat: 'responses', baseUrl: 'https://b.example/v1', apiKeyEnv: 'K2', models: [{ id: 'm2', contextWindow: 128000, maxOutputTokens: 8192 }] },
    { key: 'claude-direct', apiFormat: 'anthropic', baseUrl: 'https://c.example', apiKeyEnv: 'K3', models: [{ id: 'm3', contextWindow: 200000 }] },
  ],
  sections: [{ name: 'persona:metabot', order: 0, text: 'You are Alice.' }],
})
const piEntry = unit.find((e) => e.name === '@deepseek-ai/dsh-llm-pi-ai')
record('generator: three apiFormats map to three pi-ai protocols',
  piEntry.config.providers['deepseek-gw'].api === 'openai-completions'
  && piEntry.config.providers.opencode.api === 'openai-responses'
  && piEntry.config.providers['claude-direct'].api === 'anthropic-messages')
record('generator: thinkingFormat compat + model caps pass through',
  piEntry.config.providers['deepseek-gw'].compat.thinkingFormat === 'deepseek'
  && piEntry.config.providers['deepseek-gw'].compat.supportsReasoningEffort === true
  && piEntry.config.providers['deepseek-gw'].reasoning === 'high'
  && piEntry.config.providers['deepseek-gw'].models[0].reasoningEfforts.max === 'max'
  && piEntry.config.providers['deepseek-gw'].models[0].reasoningEfforts.off === null
  && piEntry.config.providers.opencode.models[0].maxTokens === 8192
  && piEntry.config.providers.opencode.models[0].reasoningEfforts === undefined)
record('generator: sections config emitted', unit.some((e) => e.config?.sections?.[0]?.name === 'persona:metabot'))
record('generator: plugin paths are absolute (config location-independent)',
  unit.every((e) => !String(e.name).startsWith('./')))
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
    extraEntries: [{ id: 'idbots-big-tool', name: path.join(runtimeDir, 'test/fixtures/big-tool.mjs') }],
  })
  const configPath = path.join(os.tmpdir(), `idbots-m3-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, MOCK_API_KEY: 'sk-mock-123', SPIKE_QUIET: '1' },
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
  // tool/result carries the callId, not the tool name; the tool/call event carries the name.
  const bigCall = events.find((e) => e.type === 'tool/call' && e.data?.name === 'big_output_tool')
  const toolResult = bigCall ? events.find((e) => e.type === 'tool/result' && e.data?.message?.content?.[0]?.toolCallId === bigCall.data.callId) : undefined
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
