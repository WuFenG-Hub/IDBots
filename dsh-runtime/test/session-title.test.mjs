// Session-title E2E (0.1.5): with the dsh-session-title service and its
// first-prompt LLM provider composed, the first human message must log a
// deterministic fallback title immediately and an auxiliary-LLM refinement
// once the provider call settles — both mirrored over the wire as log-only
// session/title session.event notifications with their source attribution.
// The provider inherits the session's logged request route (no explicit
// provider/model in config), so the mock gateway serves both the main turn
// and the title call.
//
// Run: node test/session-title.test.mjs   (from dsh-runtime/)

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
  const { server } = await startMockServer(48813)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-title-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48813/v1', apiKeyEnv: 'TITLE_KEY',
      models: [{ id: 'mock-1', contextWindow: 32000 }],
    }],
    sections: [],
  })
  const configPath = path.join(os.tmpdir(), `dsh-title-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, TITLE_KEY: 'sk-title', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `title-${Date.now().toString(36)}`

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

  const titles = []
  const titleWaiters = new Set()
  waiters.add((event) => {
    if (event.type !== 'session/title') return
    titles.push(event.data)
    for (const wait of [...titleWaiters]) wait()
  })
  const waitForTitle = (predicate, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label} title`)), 30000)
    const check = () => {
      const found = titles.find(predicate)
      if (found) { clearTimeout(timer); titleWaiters.delete(check); resolve(found) }
    }
    titleWaiters.add(check)
    check()
  })
  const waitForTurnEnd = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for turn end')), 30000)
    const wait = (event) => { if (event.type === 'turn/end') { clearTimeout(timer); waiters.delete(wait); resolve(event) } }
    waiters.add(wait)
  })

  const ended = waitForTurnEnd()
  const fallbackTitle = waitForTitle((t) => t?.source?.kind === 'fallback', 'fallback')
  const providerTitle = waitForTitle((t) => t?.source?.kind === 'provider', 'provider')
  await client.prompt(sessionId, [{ type: 'text', text: 'refactor the cowork sidebar title pipeline' }])
  await ended

  // The fallback lands deterministically from the first human message.
  const fallback = await fallbackTitle
  assert.ok(typeof fallback.title === 'string' && fallback.title.trim().length > 0, 'fallback title non-empty')
  assert.ok(fallback.title.includes('refactor'), 'fallback derives from the first prompt text')
  assert.ok(Array.isArray(fallback.messageSeqs) && fallback.messageSeqs.length > 0, 'fallback attributes its source message seqs')

  // The first-prompt provider then refines it through the auxiliary call: the
  // mock gateway answers every chat completion with "mock says: <prompt head>",
  // which normalizes into a valid title. Route inheritance must target the
  // session route (mockgw/mock-1), proving the provider rode request/header.
  const provider = await providerTitle
  assert.ok(typeof provider.title === 'string' && provider.title.trim().length > 0, 'provider title non-empty')
  assert.ok(provider.title.includes('mock says'), 'provider title came from the mock LLM reply')
  assert.equal(provider.source?.model?.provider, 'mockgw', 'provider inherited the session request provider')
  assert.equal(provider.source?.model?.model, 'mock-1', 'provider inherited the session request model')

  // Second turn: first-prompt cadence never re-generates, so no third title.
  const countAfterTwo = (async () => {
    const again = waitForTurnEnd()
    await client.prompt(sessionId, [{ type: 'text', text: 'now polish the empty state' }])
    await again
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return titles.length
  })()
  assert.equal(await countAfterTwo, 2, 'first-prompt cadence titles the session exactly once')

  await client.close()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  console.log('session-title.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
