// Live session/ensure must rebind provider/model, not just effort.
//
// Pre-fix: a second session/ensure on a live agent only updated reasoning
// effort. The loop kept seeding from the first-turn request header, so the
// next prompt stayed on the original provider/model (Cowork "only the first
// model still works"; qwen + inherited "max" → UNSUPPORTED_REASONING_EFFORT).
//
// Run: node test/session-model-switch.test.mjs   (from dsh-runtime/)

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

const main = async () => {
  const { server, seen } = await startMockServer(48794)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-modelswitch-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [
      {
        key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48794/v1', apiKeyEnv: 'SWITCH_KEY',
        models: [{ id: 'mock-1', contextWindow: 32768 }],
      },
      {
        key: 'mockgw-b', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48794/v1', apiKeyEnv: 'SWITCH_KEY',
        models: [{ id: 'mock-2', contextWindow: 32768 }],
      },
    ],
    sections: [],
  })
  const configPath = path.join(os.tmpdir(), `dsh-modelswitch-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, SWITCH_KEY: 'sk-switch', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `switch-${Date.now().toString(36)}`

  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        for (const wait of waiters) wait(notification.params.event)
      }
    }
  })()
  pumping.catch(() => {})

  const waitForEvent = (predicate, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for session event`)), timeoutMs)
    const wait = (event) => {
      if (predicate(event)) {
        clearTimeout(timer)
        waiters.delete(wait)
        resolve(event)
      }
    }
    waiters.add(wait)
  })

  const waitForRequest = async (needle, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes(needle)).at(-1)
      if (hit) return hit
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return undefined
  }

  await client.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1' })
  const turn1 = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'first turn on mock-1' }])
  await turn1
  const first = await waitForRequest('first turn on mock-1')
  record('first turn uses mock-1', first?.body?.model === 'mock-1', `model=${first?.body?.model}`)

  // Live ensure on the SAME session: this is the Cowork model-picker path.
  await client.request('session/ensure', { sessionId, provider: 'mockgw-b', model: 'mock-2' })
  const turn2 = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'second turn on mock-2' }])
  const ended2 = await turn2
  record('second turn still completes after the live model switch', ended2?.data?.reason?.kind === 'completed', JSON.stringify(ended2?.data?.reason))
  const second = await waitForRequest('second turn on mock-2')
  record('second turn uses mock-2 (pre-fix this stayed mock-1)', second?.body?.model === 'mock-2', `model=${second?.body?.model}`)

  await client.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1' })
  const turn3 = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'third turn back on mock-1' }])
  await turn3
  const third = await waitForRequest('third turn back on mock-1')
  record('switching back uses mock-1 again', third?.body?.model === 'mock-1', `model=${third?.body?.model}`)

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(configPath, { force: true })

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[session-model-switch] fatal:', error)
  process.exit(1)
})
