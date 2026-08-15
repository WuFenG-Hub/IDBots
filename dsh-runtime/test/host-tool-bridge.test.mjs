// Host tool bridge wire test: a config-declared tool proxy is callable by the
// model; execution round-trips to the wire host (idbots/tool/request →
// idbots/tool/respond), and a host error becomes an error tool result the
// model sees.
//
// Run: node test/host-tool-bridge.test.mjs   (from dsh-runtime/)

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
  const { server, seen } = await startMockServer(48793)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hosttool-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48793/v1', apiKeyEnv: 'HOSTTOOL_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    hostTools: [{
      name: 'host_echo_tool',
      description: 'Echo a message through the host bridge.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    }],
    extraEntries: [{ id: 'idbots-test-tools', name: path.join(runtimeDir, 'test/fixtures/test-tools.mjs') }],
  })
  const configPath = path.join(os.tmpdir(), `dsh-hosttool-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, HOSTTOOL_KEY: 'sk-hosttool', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `hosttool-${Date.now().toString(36)}`

  const waiters = new Set()
  const events = []
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
  const waitForEvent = (predicate, timeoutMs = 20000) =>
    waitFor((p) => p?.type !== undefined && predicate(p), timeoutMs)

  // Turn 1: successful host round trip.
  const turn1 = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_HOST_TOOL please' }])
  const request = await waitFor((n) => n.method === 'idbots/tool/request')
  record('host tool call arrives as idbots/tool/request', request.params.name === 'host_echo_tool'
    && request.params.arguments.message === 'ping the host'
    && request.params.sessionId === sessionId, JSON.stringify(request.params).slice(0, 80))
  await client.request('idbots/tool/respond', { id: request.params.id, ok: true, text: 'HOST-ECHO: ping the host' })
  await turn1
  const result = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('HOST-ECHO'))
  record('host result reaches the model-visible tool result', Boolean(result))
  const followUp = seen.filter((r) => r.body?.messages?.some((m) => m.role === 'tool')).at(-1)
  const toolMsg = followUp?.body?.messages?.find((m) => m.role === 'tool')
  record('follow-up request carries the host result', String(typeof toolMsg?.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg?.content)).includes('HOST-ECHO'))

  // Turn 2: host error path.
  const turn2 = waitForEvent((e) => e.type === 'turn/end' && e.data?.turn === 2)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_HOST_TOOL again' }])
  const request2 = await waitFor((n) => n.method === 'idbots/tool/request' && n.params.id !== request.params.id)
  await client.request('idbots/tool/respond', { id: request2.params.id, ok: false, error: 'host exploded' })
  await turn2
  const errorResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('host exploded'))
  record('host error becomes an error tool result', Boolean(errorResult))

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
  console.error('[hosttool-test] fatal:', error)
  process.exit(1)
})
