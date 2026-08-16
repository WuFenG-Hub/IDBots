// ask_user_question bridge E2E: the model-facing tool (dsh-tool-ask-user over
// the dsh-user-questions seam) round-trips a question to the wire host —
// idbots/ask/request out, idbots/ask/respond back — and the answer reaches
// the model as the tool result (and the next provider request).
//
// Run: node test/ask-bridge.test.mjs   (from dsh-runtime/)

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
  const { server, seen } = await startMockServer(48796)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ask-'))

  // Composition must carry the user-questions service + tool consumer.
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48796/v1', apiKeyEnv: 'ASK_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    hostTools: [{
      name: 'host_echo_tool',
      description: 'Echo a message through the host bridge.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    }],
  })
  const names = JSON.stringify(config)
  record('generator mounts the user-questions service and tool',
    names.includes('@deepseek-ai/dsh-user-questions') && names.includes('@deepseek-ai/dsh-tool-ask-user'))

  const configPath = path.join(os.tmpdir(), `dsh-ask-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, ASK_KEY: 'sk-ask', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `ask-${Date.now().toString(36)}`

  const events = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      } else if (notification.method?.startsWith('idbots/')) {
        for (const wait of waiters) wait(notification)
      }
    }
  })()
  pumping.catch(() => {})
  const waitFor = (predicate, timeoutMs = 20000, what = 'notification') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (payload) => {
      if (predicate(payload)) { clearTimeout(timer); waiters.delete(wait); resolve(payload) }
    }
    waiters.add(wait)
  })

  // Turn 1: interactive answer round trip.
  const turn1 = waitFor((e) => e?.type === 'turn/end', 30000)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_ASK_TOOL please' }])
  const ask = await waitFor((n) => n.method === 'idbots/ask/request')
  record('ask_user_question arrives as idbots/ask/request',
    ask.params.sessionId === sessionId
    && ask.params.questions?.[0]?.id === 'q1'
    && ask.params.questions?.[0]?.options?.some((o) => o.label === 'Red'),
    JSON.stringify(ask.params.questions?.[0] ?? {}).slice(0, 80))
  await client.request('idbots/ask/respond', {
    id: ask.params.id,
    answers: [{ id: 'q1', selected: ['Blue'] }],
  })
  await turn1
  const answerResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('Blue'))
  record('selected option reaches the model-visible tool result', Boolean(answerResult))
  const followUp = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('CALL_ASK_TOOL')).at(-1)
  record('answer rides the next provider request', Boolean(
    followUp && JSON.stringify(followUp.body?.messages ?? []).includes('Blue')
  ))

  // Turn 2: host-side decline — no selection, decline note as the custom answer.
  const turn2 = waitFor((e) => e?.type === 'turn/end' && e.data?.turn === 2, 30000)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_ASK_TOOL again' }])
  const ask2 = await waitFor((n) => n.method === 'idbots/ask/request' && n.params.id !== ask.params.id)
  await client.request('idbots/ask/respond', {
    id: ask2.params.id,
    answers: [{ id: 'q1', selected: [], custom: 'The user declined to answer.' }],
  })
  await turn2
  const declined = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('declined'))
  record('declined answer surfaces in the tool result', Boolean(declined))

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
  console.error('[ask-test] fatal:', error)
  process.exit(1)
})
