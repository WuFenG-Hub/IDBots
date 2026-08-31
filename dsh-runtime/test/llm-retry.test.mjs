// Retry policy E2E: a transient 503 from the provider must be retried and the
// turn must complete, instead of the pre-retry behavior where one timeout/5xx
// killed the whole turn.
//
// Run: node test/llm-retry.test.mjs   (from dsh-runtime/)

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
  const { server, seen } = await startMockServer(48795)
  startMockServer.retryServed = false
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retry-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48795/v1', apiKeyEnv: 'RETRY_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
  })
  const configPath = path.join(os.tmpdir(), `dsh-retry-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, RETRY_KEY: 'sk-retry', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `retry-${Date.now().toString(36)}`

  const events = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      }
    }
  })()
  pumping.catch(() => {})
  const waitForEvent = (predicate, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for turn end')), timeoutMs)
    const wait = (event) => { if (predicate(event)) { clearTimeout(timer); waiters.delete(wait); resolve(event) } }
    waiters.add(wait)
  })

  const ended = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'RETRY_ME please' }])
  const end = await ended

  const attempts = seen.filter((r) => r.body?.messages?.some((m) => String(m.content).includes('RETRY_ME'))).length
  console.log(`attempts seen by gateway: ${attempts}`)
  console.log(`turn end reason: ${JSON.stringify(end.data?.reason)}`)
  assert.equal(end.data?.reason?.kind, 'completed', 'turn completed despite transient 503')
  assert.ok(attempts >= 2, 'gateway saw a retried request')

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('PASS  transient provider failure retried; turn completed')
  process.exit(0)
}

main().catch((error) => {
  console.error('[retry-test] fatal:', error)
  process.exit(1)
})
