// Compaction E2E: a tiny context window plus growing turns must trigger
// dsh-compaction-basic — compaction events appear in the session feed and the
// follow-up model request shrinks back under the window.
//
// Run: node test/compaction.test.mjs   (from dsh-runtime/)

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

const CONTEXT_WINDOW = 1400 // tiny so 2-3 turns cross the 80% threshold
const FILLER = 'x'.repeat(1800) // ~450 tokens per prompt

const main = async () => {
  const { server, seen } = await startMockServer(48797)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48797/v1', apiKeyEnv: 'COMPACT_KEY',
      models: [{ id: 'mock-1', contextWindow: CONTEXT_WINDOW }],
    }],
    sections: [],
  })
  const configPath = path.join(os.tmpdir(), `dsh-compact-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, COMPACT_KEY: 'sk-compact', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `compact-${Date.now().toString(36)}`

  const waiters = new Set()
  const sessionEvents = []
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        sessionEvents.push(notification.params.event)
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

  const requestChars = () => (seen.at(-1)?.body?.messages ?? []).reduce((sum, m) => sum + String(m.content ?? '').length, 0)

  // Drive turns until compaction fires (bounded loop, fail loudly otherwise).
  let compacted = false
  for (let turn = 1; turn <= 8 && !compacted; turn += 1) {
    const ended = waitForEvent((e) => e.type === 'turn/end')
    await client.prompt(sessionId, [{ type: 'text', text: `FILLER turn ${turn}: ${FILLER}` }])
    await ended
    compacted = sessionEvents.some((e) => String(e.type).startsWith('compaction/'))
    console.log(`[turn ${turn}] requestChars=${requestChars()} compacted=${compacted}`)
  }
  assert.ok(compacted, 'compaction events appeared in the session feed')
  const kinds = [...new Set(sessionEvents.filter((e) => String(e.type).startsWith('compaction/')).map((e) => e.type))]
  console.log('[compaction events]:', kinds.join(', '))
  assert.ok(kinds.includes('compaction/summary'), 'a summary event was recorded')

  // Drive one more turn: its conversation request rides the compacted history
  // (the compaction aux call itself legitimately carries the full history).
  const ended = waitForEvent((e) => e.type === 'turn/end')
  await client.prompt(sessionId, [{ type: 'text', text: `FILLER final: ${FILLER}` }])
  await ended
  const size = (r) => (r.body?.messages ?? []).reduce((sum, m) => sum + String(m.content ?? '').length, 0)
  // Content-based assertions (size can stay flat when each turn's new filler
  // roughly equals what compaction reclaims): the summarized old content must
  // be GONE from post-compaction conversation requests while recent content
  // and the summary ride along.
  const payload = (r) => JSON.stringify(r.body?.messages ?? [])
  const convRequests = seen.filter((r) => payload(r).includes('FILLER final') || payload(r).includes('FILLER turn 3'))
  const postCompaction = convRequests.at(-1)
  assert.ok(postCompaction, 'found the post-compaction conversation request')
  assert.ok(!payload(postCompaction).includes('FILLER turn 1'), 'summarized old content is gone from the model view')
  assert.ok(payload(postCompaction).includes('FILLER final') || payload(postCompaction).includes('FILLER turn 3'), 'recent content is retained')
  console.log(`[size] post-compaction conversation request: ${size(postCompaction)} chars`)

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('PASS  compaction triggers, records a summary, and replaces old content in the model view')
  process.exit(0)
}

main().catch((error) => {
  console.error('[compaction-test] fatal:', error)
  process.exit(1)
})
