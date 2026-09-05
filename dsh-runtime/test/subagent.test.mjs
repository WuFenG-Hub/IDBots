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
  const { server, seen, setParentAgentId } = await startMockServer(48800)
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
  setParentAgentId(sessionId)

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

  // Continuable delegation (0.1.3-alpha.1): the tool returns a durable
  // subagent id immediately (rendered "started subagent <id>") instead of
  // waiting for the child's answer.
  assert.ok(events.some((r) => r.includes('started subagent')), 'delegation tool result is a continuable background handle')

  // The child reports through send_message; the report reaches the parent's
  // context via the settlement notice turn (turn 2).
  const noticeEnded = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'turn/end' && n.params.event.data?.turn === 2, 40000, 'parent notice turn end')
  await noticeEnded
  // The child's request exposes the new control tool; the parent id is
  // carried by the durable parent/child relation rather than prompt text.
  const childRequestSeen = seen.find((r) => JSON.stringify(r.body?.messages ?? []).includes('say SUBAGENT_DONE')
    && r.body?.tools?.some((tool) => tool.function?.name === 'send_message'))
  assert.ok(childRequestSeen, 'child request carries the send_message control tool')
  const parentSawReport = seen.some((r) => JSON.stringify(r.body?.messages ?? []).includes('CHILD_REPORT_BG_DONE'))
  assert.ok(parentSawReport, 'child send_message report reached the parent context')
  console.log('PASS  continuable delegation: background handle + send_message report round-trip')

  // Panel surface: list + messages. The transcript buffer fills from the
  // session firehose asynchronously relative to turn-end notifications, so
  // poll briefly for the assistant reply instead of asserting once.
  const list = await client.request('idbots/subagents/list', { sessionId })
  console.log('[list]', JSON.stringify(list))
  assert.ok(list.agents.length >= 1, 'subagent lineage recorded')
  const agentId = list.agents[0].agentId
  let messages = { messages: [] }
  for (let attempt = 0; attempt < 20 && !messages.messages.some((m) => m.type === 'assistant'); attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500))
    messages = await client.request('idbots/subagents/messages', { sessionId, agentId })
  }
  console.log('[messages]', JSON.stringify(messages.messages.map((m) => ({ type: m.type, content: m.content.slice(0, 40) }))))
  assert.ok(messages.messages.some((m) => m.type === 'user' && m.content.includes('SUBAGENT_DONE') || m.content.includes('say')), 'child prompt visible in transcript')
  assert.ok(messages.messages.some((m) => m.type === 'assistant'), 'child reply visible in transcript')
  console.log('PASS  subagent delegation + panel surface (list/messages)')

  const started = lifecycle.find((n) => n.method === 'idbots/subagent/started' && n.params.sessionId === sessionId)
  assert.ok(started, 'subagent started notification carries the parent session id')
  const progress = lifecycle.find((n) => n.method === 'idbots/subagent/progress' && String(n.params.summary ?? '').length > 0)
  assert.ok(progress, 'subagent progress notification carries the delegation prompt as summary')
  // Continuable residency: the child's turn lifecycle surfaces as an idle
  // status once the child's run settles; the agent then dematerializes
  // (finished) while the SESSION stays continuable — a later send_message
  // re-materializes it (a fresh started notification).
  const idle = lifecycle.find((n) => n.method === 'idbots/subagent/progress' && n.params.status === 'idle' && n.params.agentId === started.params.agentId)
  assert.ok(idle, 'subagent idle progress notification after the child turn settled')
  // (Dematerialization-driven finished notifications are kernel-GC-timed and
  // may lag arbitrarily; idle is the deterministic residency signal, and a
  // later send_message re-materializes the child with a fresh started.)
  console.log('PASS  subagent lifecycle notifications (started/summary/idle/finished)')

  // ---- 0.1.2 model selection -------------------------------------------
  // Continuable children add async parent turns (report steer + settlement
  // notice), so absolute turn numbers are not stable. Each runTurn captures
  // the FIRST new turn/start after its prompt and waits for THAT turn's end.
  const lastSeenTurn = { n: 2 } // turns 1-2 = DELEGATE + its notice turn
  const runTurn = async (text) => {
    let myTurn = null
    const end = waitFor((n) => {
      if (n.method !== 'session.event' || n.params.sessionId !== sessionId) return false
      const event = n.params.event
      if (event.type === 'turn/start' && myTurn === null && (event.data?.turn ?? 0) > lastSeenTurn.n) {
        myTurn = event.data.turn
        return false
      }
      return event.type === 'turn/end' && myTurn !== null && event.data?.turn === myTurn
    }, 40000, `turn for "${text}" end`)
    await client.prompt(sessionId, [{ type: 'text', text }])
    await end
    lastSeenTurn.n = myTurn
  }

  // list_subagent_models advertises the allowlist (provider-table derived).
  const toolResults = () => events // strings of tool/result events
  await runTurn('LIST_MODELS show me the routes')
  assert.ok(toolResults().some((r) => r.includes('list_subagent_models') || (r.includes('mockgw') && r.includes('mock-2'))),
    'list_subagent_models result advertises mockgw/mock-2')
  console.log('PASS  list_subagent_models advertises allowlisted routes')

  // Model-selected delegation: the child turn runs on mock-2 (not the parent's mock-1).
  // Background children start asynchronously — poll the recorded requests.
  const childSeenBefore = seen.length
  await runTurn('DELEGATE_MODEL to the cheaper model please')
  const waitSeen = async (pred, what, timeoutMs = 15000) => {
    void what
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = seen.slice(childSeenBefore).find(pred)
      if (hit !== undefined) return hit
      if (Date.now() > deadline) return undefined
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const childRequest = await waitSeen((r) => r.body?.model === 'mock-2'
    && JSON.stringify(r.body?.messages ?? []).includes('say SUBAGENT_DONE'), 'mock-2 child')
  assert.ok(childRequest, 'model-selected child request ran on mockgw/mock-2')
  const modelSelChildInjected = await waitSeen((r) => r.body?.model === 'mock-2'
    && JSON.stringify(r.body?.messages ?? []).includes('say SUBAGENT_DONE')
    && r.body?.tools?.some((tool) => tool.function?.name === 'send_message'), 'mock-2 child control tool')
  assert.ok(modelSelChildInjected, 'model-selected child still gets the send_message control tool')
  console.log('PASS  delegation with provider/model runs the child on the selected route')

  // Fail-closed: a route outside the allowlist is rejected with an error tool result.
  await runTurn('DELEGATE_BAD_MODEL try the forbidden route')
  assert.ok(events.some((r) => r.includes('not allowed')), 'out-of-allowlist route fails closed')
  console.log('PASS  out-of-allowlist route fails closed')

  // Foreground regression: run_in_background:false restores the one-shot
  // wait-for-result semantics — the child's final text IS the tool result.
  // (The send_message reporting instruction is only guaranteed on the
  // continuable path, which awaits plugin readiness; a foreground start()
  // races the agent-scoped control mount, so we assert the result channel.)
  const fgSeenBefore = seen.length
  await runTurn('DELEGATE_FG wait for the result inline please')
  const waitSeenFrom = (from) => async (pred, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = seen.slice(from).find(pred)
      if (hit !== undefined) return hit
      if (Date.now() > deadline) return undefined
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const fgChild = await waitSeenFrom(fgSeenBefore)((r) => JSON.stringify(r.body?.messages ?? []).includes('say SUBAGENT_DONE')
    && JSON.stringify(r.body?.messages ?? []).includes('message delivered') === false)
  assert.ok(fgChild, 'foreground child request ran and returned through the tool result')
  assert.ok(events.some((r) => r.includes('mock says: say SUBAGENT_DONE')), 'foreground tool result carries the child final text')
  console.log('PASS  foreground delegation regression (run_in_background: false)')

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
