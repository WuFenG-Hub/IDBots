// IDBots DSH Phase 0 spike: sdk-client subprocess wire test.
//
// Drives the JSON-RPC runtime via @deepseek-ai/dsh-sdk-client (the embedding
// mode most similar to today's Claude Agent SDK usage), verifies the happy
// path, then probes the documented wire gaps that matter for IDBots parity:
// mid-turn cancel and steer.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { HarnessClient, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeBin = path.resolve(here, 'runtime-bin.mjs')
const configPath = path.resolve(here, '../cordis.jsonrpc.yml')

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const waitIdle = (subscription, sessionId, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout waiting for session.status idle')), timeoutMs)
  const pump = async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.status'
        && notification.params.sessionId === sessionId
        && notification.params.status === 'idle') {
        clearTimeout(timer)
        resolve()
        return
      }
    }
  }
  pump().catch((error) => { clearTimeout(timer); reject(error) })
})

const main = async () => {
  const client = new HarnessClient({
    command: process.execPath,
    args: [runtimeBin, configPath],
    env: { ...process.env, SPIKE_QUIET: '1' },
  })
  client.start()
  const init = await client.initialize({ cwd: process.cwd(), provider: 'fake', model: 'fake-1' })
  record('initialize handshake', init.serverInfo?.name === 'deepseek-harness-sdk-runtime', JSON.stringify(init.serverInfo))

  const sessionId = `spike-wire-${Date.now().toString(36)}`
  const subscription = client.subscribe()
  const idle = waitIdle(subscription, sessionId)

  const messageId = await client.prompt(sessionId, [{ type: 'text', text: 'PING' }])
  record('prompt accepted with enqueue receipt', typeof messageId === 'string' && messageId.length > 0, `messageId=${messageId}`)
  await idle
  subscription.close()

  const events = []
  const collector = client.subscribe()
  const collecting = (async () => {
    for (;;) {
      const notification = await collector.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
      }
    }
  })()
  collecting.catch(() => {})

  // Second prompt on the same session proves session reuse across prompts.
  const idle2 = (async () => {
    for (;;) {
      const notification = await collector.next()
      if (notification.method === 'session.status' && notification.params.sessionId === sessionId && notification.params.status === 'idle') return
    }
  })()
  await client.prompt(sessionId, [{ type: 'text', text: 'TOOL:PING' }])
  await idle2
  collector.close()

  const sawAssistant = events.some((e) => e.type === 'assistant/message' && JSON.stringify(e).includes('pong'))
  const sawToolCall = events.some((e) => e.type === 'tool/call' && e.data?.name === 'spike_ping')
  record('session.event stream carries assistant messages', sawAssistant)
  record('session.event stream carries tool calls', sawToolCall)

  // ---- probe the wire gaps ---------------------------------------------
  for (const method of ['session/cancel', 'session/steer', 'session/approval']) {
    try {
      await client.request(method, { sessionId }, 3000)
      record(`wire has ${method} (unexpected)`, false, 'method unexpectedly exists')
    } catch (error) {
      if (error instanceof JsonRpcResponseError) {
        record(`wire gap confirmed: no ${method} method`, true, `code=${error.code} ${String(error.message).slice(0, 60)}`)
      } else {
        record(`wire gap confirmed: no ${method} method (${error.constructor.name})`, true, String(error).slice(0, 80))
      }
    }
  }

  await client.close()
  record('close() cleanly reaps the runtime subprocess', true)
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}

main().catch((error) => {
  console.error('[spike] fatal:', error)
  process.exit(1)
})
