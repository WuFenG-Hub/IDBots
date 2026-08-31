// Subagent E2E: the model delegates via the `subagent` tool, the child runs a
// real turn on the same provider, the parent completes with the child's
// result — and the panel surface (idbots/subagents/list + /messages) reads
// the lineage and transcript afterwards.
//
// Run: node test/subagent.test.mjs   (from dsh-runtime/)

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
  const { server, seen } = await startMockServer(48800)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48800/v1', apiKeyEnv: 'SUBAGENT_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
  })
  const configPath = path.join(os.tmpdir(), `dsh-subagent-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, SUBAGENT_KEY: 'sk-subagent', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `subagent-${Date.now().toString(36)}`

  const waiters = new Set()
  const events = []
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      for (const wait of waiters) wait(notification)
    }
  })()
  pumping.catch(() => {})
  const waitFor = (predicate, timeoutMs = 30000, what = 'notification') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (payload) => { if (predicate(payload)) { clearTimeout(timer); waiters.delete(wait); resolve(payload) } }
    waiters.add(wait)
  })
  waiters.add((n) => {
    if (n.method === 'session.event' && n.params.event.type === 'tool/result') events.push(JSON.stringify(n.params.event))
  })

  // Policy gate auto-allow (bash not involved, but keep the loop harmless).
  void (async () => { for (;;) { try { const r = await waitFor((n) => n.method === 'idbots/policy/request', 60000); await client.request('idbots/policy/respond', { id: r.params.id, decision: 'allow' }) } catch { return } } })().catch(() => undefined)

  const ended = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId && n.params.event.type === 'turn/end', 40000, 'parent turn end')
  // Live task rows: the runtime must notify the host on child lifecycle.
  const lifecycle = []
  waiters.add((n) => {
    if (n.method === 'idbots/subagent/started' || n.method === 'idbots/subagent/progress' || n.method === 'idbots/subagent/finished') {
      lifecycle.push(n)
    }
  })
  await client.prompt(sessionId, [{ type: 'text', text: 'DELEGATE the task please' }])
  await ended

  // The child's reply must reach the parent as the tool result.
  assert.ok(events.some((r) => r.includes('SUBAGENT_DONE') || r.includes('mock says')), 'child result reached the parent tool result')

  // Panel surface: list + messages (post-hoc, turn already finished).
  const list = await client.request('idbots/subagents/list', { sessionId })
  console.log('[list]', JSON.stringify(list))
  assert.ok(list.agents.length >= 1, 'subagent lineage recorded')
  const agentId = list.agents[0].agentId
  const messages = await client.request('idbots/subagents/messages', { sessionId, agentId })
  console.log('[messages]', JSON.stringify(messages.messages.map((m) => ({ type: m.type, content: m.content.slice(0, 40) }))))
  assert.ok(messages.messages.some((m) => m.type === 'user' && m.content.includes('SUBAGENT_DONE') || m.content.includes('say')), 'child prompt visible in transcript')
  assert.ok(messages.messages.some((m) => m.type === 'assistant'), 'child reply visible in transcript')

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('PASS  subagent delegation + panel surface (list/messages)')

  const started = lifecycle.find((n) => n.method === 'idbots/subagent/started' && n.params.sessionId === sessionId)
  assert.ok(started, 'subagent started notification carries the parent session id')
  const progress = lifecycle.find((n) => n.method === 'idbots/subagent/progress')
  assert.ok(progress && String(progress.params.summary ?? '').includes('SUBAGENT_DONE') || (progress && progress.params.summary?.length > 0),
    'subagent progress notification carries the delegation prompt as summary')
  const finished = lifecycle.find((n) => n.method === 'idbots/subagent/finished' && n.params.agentId === started.params.agentId)
  assert.ok(finished, 'subagent finished notification for the same agent id')
  console.log('PASS  subagent lifecycle notifications (started/progress/finished)')
  process.exit(0)
}

main().catch((error) => {
  console.error('[subagent-test] fatal:', error)
  process.exit(1)
})
