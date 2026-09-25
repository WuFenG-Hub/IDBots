// Time-context E2E (0.1.7): dsh-time-context appends a durable clock reading
// (ISO timestamp + zone + elapsed) to the provider request, and the client
// time zone the host declares on the prompt's user-message source resolves the
// request-zone line from "unavailable / ask the user" to the actual zone.
//
// Two cases:
//   1. idbots/prompt with clientTimeZone — the reading names that zone.
//   2. idbots/prompt without a zone — the reading falls back to upstream's
//      "unavailable" policy line (documents the pre-integration behavior).
//
// Run: node test/time-context.test.mjs   (from dsh-runtime/)

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

const main = async () => {
  const { server, seen } = await startMockServer(48794)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clock-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48794/v1', apiKeyEnv: 'CLOCK_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    timeContext: { timeZone: 'Asia/Shanghai' },
  })
  const clockEntry = config.find((e) => e.name === '@deepseek-ai/dsh-time-context')
  assert.equal(clockEntry?.config?.timeZone, 'Asia/Shanghai', 'clock plugin mounted with the host zone')
  const configPath = path.join(os.tmpdir(), `dsh-clock-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, CLOCK_KEY: 'sk-clock', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `clock-${Date.now().toString(36)}`

  const events = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      // Both sessions in this test run on one runtime; forward every session
      // event (the waiters filter by event type).
      if (notification.method === 'session.event') {
        events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      }
    }
  })()
  pumping.catch(() => {})
  const waitForEvent = (pred, ms = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for event (${events.map((e) => e.type).join(',')})`)), ms)
    const wait = (event) => { if (pred(event)) { clearTimeout(timer); waiters.delete(wait); resolve(event) } }
    waiters.add(wait)
  })
  const turnEnd = () => waitForEvent((e) => e.type === 'turn/end')
  /** Clock reading for one request: a user message mentioning the sampled time. */
  const clockReading = (request) => (request?.body?.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .find((text) => text.includes('Time sampled while preparing turn'))
  const requestCount = () => seen.filter((r) => r.body?.messages?.length > 0).length
  /** The CONVERSATION request carrying `marker` (not the title/compaction aux calls). */
  const conversationRequest = (marker) => seen.find((r) => {
    const messages = r.body?.messages ?? []
    if (!messages.some((m) => m.role === 'system')) return false
    if (/session title/i.test(String(messages[0]?.content ?? ''))) return false
    return messages.some((m) => typeof m.content === 'string' && m.content.includes(marker))
  })

  try {
    await client.request('session/ensure', { sessionId })

    // ---- 1. zone declared on the prompt -------------------------------------
    const before = requestCount()
    const end1 = turnEnd()
    await client.request('idbots/prompt', { sessionId, text: 'HELLO_MOCK', clientTimeZone: 'Asia/Shanghai' })
    await end1
    const req1 = conversationRequest('HELLO_MOCK')
    assert.ok(requestCount() > before, 'the prompt produced a provider request')
    const reading1 = clockReading(req1)
    assert.ok(reading1, `clock reading present in the request (roles: ${(req1?.body?.messages ?? []).map((m) => m.role).join(',')})`)
    assert.match(reading1, /Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\[Asia\/Shanghai\]/, 'ISO timestamp uses the host zone')
    assert.match(reading1, /Browser time zone for this request: Asia\/Shanghai\. Interpret otherwise-unqualified dates and times in this zone\./, 'request zone resolves from the prompt source')

    // ---- 2. no zone on the prompt: upstream's unavailable policy ------------
    const session2 = `${sessionId}-nozone`
    await client.request('session/ensure', { sessionId: session2 })
    const end2 = waitForEvent((e) => e.type === 'turn/end')
    await client.request('idbots/prompt', { sessionId: session2, text: 'HELLO_MOCK_NOZONE' })
    await end2
    const req2 = conversationRequest('HELLO_MOCK_NOZONE')
    const reading2 = clockReading(req2)
    assert.ok(reading2, 'clock reading present without a declared zone too')
    assert.match(reading2, /Browser time zone for this request: unavailable\./, 'without a zone the reading keeps the upstream unavailable policy')
  } finally {
    subscription.close()
    await Promise.race([client.close(), new Promise((resolve) => setTimeout(resolve, 10000))]).catch(() => {})
    server.closeAllConnections?.()
    await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => setTimeout(resolve, 5000))])
    fs.rmSync(sessionRoot, { recursive: true, force: true })
    fs.rmSync(configPath, { force: true })
  }
  console.log('time-context.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
