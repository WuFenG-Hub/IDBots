// Host tool bridge wire test: a config-declared tool proxy is callable by the
// model; execution round-trips to the wire host (idbots/tool/request →
// idbots/tool/respond), a host error becomes an error tool result the model
// sees, and image payloads on a respond reach the model as image blocks via
// the attachment store — or degrade to a text note on a text-only route.
//
// Run: node test/host-tool-bridge.test.mjs   (from dsh-runtime/)

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

// 1x1 transparent PNG.
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

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
    providers: [
      {
        key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48793/v1', apiKeyEnv: 'HOSTTOOL_KEY',
        models: [{ id: 'mock-1', contextWindow: 32768, input: ['text', 'image'] }],
      },
      {
        // Same gateway, but the route declares text-only input: image responds
        // on this route must degrade to a note instead of image blocks.
        key: 'mockgw-text', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48793/v1', apiKeyEnv: 'HOSTTOOL_KEY',
        models: [{ id: 'mock-1', contextWindow: 32768 }],
      },
    ],
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
      if (notification.method === 'session.event') {
        // `events` collects the primary session only; waiters observe every
        // session (the text-route turn below rides a second DSH session).
        if (notification.params.sessionId === sessionId) events.push(notification.params.event)
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

  // Turn 3: image respond on an image-capable route. The bytes commit to the
  // attachment store, the tool result carries an image block, and the next
  // provider request carries the image as an image_url data URL.
  const turn3 = waitForEvent((e) => e.type === 'turn/end' && e.data?.turn === 3)
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_HOST_TOOL_IMAGE please' }])
  const request3 = await waitFor((n) => n.method === 'idbots/tool/request' && n.params.id !== request2.params.id)
  await client.request('idbots/tool/respond', {
    id: request3.params.id,
    ok: true,
    text: 'HOST-SHOT: captured 1x1',
    images: [{ data: PNG_1x1_BASE64, mediaType: 'image/png', name: 'shot' }],
  })
  await turn3
  const imageResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('HOST-SHOT'))
  const imageBlock = imageResult && JSON.stringify(imageResult).includes('"type":"image"')
    ? JSON.stringify(imageResult)
    : null
  record('image respond renders an image block in the tool result', Boolean(imageBlock))
  const expectedHash = crypto.createHash('sha256').update(Buffer.from(PNG_1x1_BASE64, 'base64')).digest('hex')
  const stored = fs.existsSync(path.join(sessionRoot, 'attachments', `${expectedHash}.bin`))
  record('image bytes are content-addressed in the attachment store', stored)
  const imageFollowUp = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('data:image/png;base64,')).at(-1)
  record('follow-up provider request carries the image_url data URL', Boolean(imageFollowUp))

  // Turn 4: same image respond on a TEXT-ONLY route — the result must degrade
  // to the omission note with no image block (an image on this route would
  // poison the durable history with a permanent conversion error).
  // Session-event waiters receive the bare event (no sessionId), but turns 1-3
  // already settled, so the next omitted-bearing tool/result can only be the
  // text-route session's.
  const textSessionId = `${sessionId}-text`
  await client.request('session/ensure', { sessionId: textSessionId, provider: 'mockgw-text', model: 'mock-1' })
  const degradedSettled = waitForEvent((e) => e.type === 'tool/result' && JSON.stringify(e).includes('omitted'), 20000)
  await client.prompt(textSessionId, [{ type: 'text', text: 'CALL_HOST_TOOL_IMAGE on text route' }])
  const request4 = await waitFor((n) => n.method === 'idbots/tool/request' && n.params.sessionId === textSessionId)
  await client.request('idbots/tool/respond', {
    id: request4.params.id,
    ok: true,
    text: 'HOST-SHOT: captured 1x1',
    images: [{ data: PNG_1x1_BASE64, mediaType: 'image/png' }],
  })
  await degradedSettled
  const degradedJson = JSON.stringify(await degradedSettled)
  record('text-only route degrades the image to an omission note',
    degradedJson.includes('omitted') && degradedJson.includes('HOST-SHOT') && !degradedJson.includes('"type":"image"'))
  const textRouteRequests = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('on text route'))
  record('text-only route never sends an image_url upstream',
    textRouteRequests.length > 0 && textRouteRequests.every(
      (r) => !JSON.stringify(r.body?.messages ?? []).includes('data:image/png;base64,')
    ))

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
