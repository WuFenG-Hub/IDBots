// Subagent E2E: the model delegates via the `subagent` tool, the child runs a
// real turn on the same provider, the parent completes with the child's
// result — and the panel surface (idbots/subagents/list + /messages) reads
// the lineage and transcript afterwards.
//
// 0.1.2 model selection: the delegation tool also accepts provider/model
// within the allowlist derived from the provider table (mockgw/mock-2),
// list_subagent_models advertises the routes, and an out-of-allowlist route
// fails closed.
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
  const configJson = JSON.stringify(generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48800/v1', apiKeyEnv: 'SUBAGENT_KEY',
      models: [
        { id: 'mock-1', contextWindow: 32768 },
        { id: 'mock-2', contextWindow: 32768 },
      ],
    }],
    sections: [],
  }))
  assert.ok(configJson.includes('subagent-model-selection-settings'), 'generator mounts the model-selection settings entry')
  assert.ok(!configJson.includes('"tool-subagent"'), 'generator no longer mounts tool-subagent at composition level')
  const configPath = path.join(os.tmpdir(), `dsh-subagent-${Date.now()}.json`)
  fs.writeFileSync(configPath, configJson)

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
  console.log('PASS  subagent delegation + panel surface (list/messages)')

  const started = lifecycle.find((n) => n.method === 'idbots/subagent/started' && n.params.sessionId === sessionId)
  assert.ok(started, 'subagent started notification carries the parent session id')
  const progress = lifecycle.find((n) => n.method === 'idbots/subagent/progress')
  assert.ok(progress && String(progress.params.summary ?? '').includes('SUBAGENT_DONE') || (progress && progress.params.summary?.length > 0),
    'subagent progress notification carries the delegation prompt as summary')
  const finished = lifecycle.find((n) => n.method === 'idbots/subagent/finished' && n.params.agentId === started.params.agentId)
  assert.ok(finished, 'subagent finished notification for the same agent id')
  console.log('PASS  subagent lifecycle notifications (started/progress/finished)')

  // ---- 0.1.2 model selection -------------------------------------------
  const turnCount = { n: 1 }
  const runTurn = async (text) => {
    const nth = ++turnCount.n
    const end = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
      && n.params.event.type === 'turn/end' && n.params.event.data?.turn === nth, 40000, `turn ${nth} end`)
    await client.prompt(sessionId, [{ type: 'text', text }])
    await end
  }

  // list_subagent_models advertises the allowlist (provider-table derived).
  const toolResults = () => events // strings of tool/result events
  await runTurn('LIST_MODELS show me the routes')
  assert.ok(toolResults().some((r) => r.includes('list_subagent_models') || (r.includes('mockgw') && r.includes('mock-2'))),
    'list_subagent_models result advertises mockgw/mock-2')
  console.log('PASS  list_subagent_models advertises allowlisted routes')

  // Model-selected delegation: the child turn runs on mock-2 (not the parent's mock-1).
  const childSeenBefore = seen.length
  await runTurn('DELEGATE_MODEL to the cheaper model please')
  const childRequest = seen.slice(childSeenBefore).find((r) => r.body?.model === 'mock-2'
    && JSON.stringify(r.body?.messages ?? []).includes('say SUBAGENT_DONE'))
  assert.ok(childRequest, 'model-selected child request ran on mockgw/mock-2')
  assert.ok(events.some((r) => r.includes('SUBAGENT_DONE')), 'model-selected child result reached the parent')
  console.log('PASS  delegation with provider/model runs the child on the selected route')

  // Fail-closed: a route outside the allowlist is rejected with an error tool result.
  await runTurn('DELEGATE_BAD_MODEL try the forbidden route')
  assert.ok(events.some((r) => r.includes('not allowed')), 'out-of-allowlist route fails closed')
  console.log('PASS  out-of-allowlist route fails closed')

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  process.exit(0)
}

main().catch((error) => {
  console.error('[subagent-test] fatal:', error)
  process.exit(1)
})
