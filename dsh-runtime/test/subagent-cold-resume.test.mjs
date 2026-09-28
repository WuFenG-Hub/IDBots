// Continuable-subagent COLD resume across a runtime restart.
//
// A continuable child's live activation dies with the runtime process; a
// later follow-up (send_message from the parent) must resume the child from
// its PERSISTED log. That path (dsh-subagent deliverToChild → coldResume)
// resolves the log through ctx.sessionQuery — a service the composition
// never mounted, so before the fix every follow-up to a dematerialized
// child failed closed with CONTINUATION_UNAVAILABLE ("continuable
// subagents require session query"; 2026-09-28 session 540635be: the chair
// could not wake its persisted workers after a runtime handoff).
//
// The generator now mounts @deepseek-ai/dsh-session-query next to the
// persistence backend. This test proves the full cold path: phase A creates
// a continuable child and lets it settle; phase B boots a FRESH runtime on
// the same sessionRoot (no live activations), resumes the parent via
// session/ensure, and delivers a follow-up — the cold-resumed child must
// run a real turn on the provider.
//
// Run: node test/subagent-cold-resume.test.mjs   (from dsh-runtime/)

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  const { server, seen } = await startMockServer(48806)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cold-resume-'))
  const configJson = JSON.stringify(generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48806/v1', apiKeyEnv: 'SUBAGENT_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
  }))
  // Generator-level gate: the query engine rides the composition.
  assert.ok(configJson.includes('@deepseek-ai/dsh-session-query'),
    'generator mounts the session-query engine entry')
  assert.ok(configJson.includes('@deepseek-ai/dsh-session-persistence-jsonl'),
    'persistence backend still mounted (the query engine reads through it)')
  const configPath = path.join(os.tmpdir(), `dsh-cold-resume-${Date.now()}.json`)
  fs.writeFileSync(configPath, configJson)

  const env = () => ({ ...process.env, SUBAGENT_KEY: 'sk-subagent', SPIKE_QUIET: '1' })
  const bootRuntime = async () => {
    const client = runtimeClient({ args: [path.join(runtimeDir, 'bin.mjs'), configPath], env: env() })
    client.start()
    await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
    return client
  }

  // ---- Phase A: parent + continuable child, child settles, process exits.
  const clientA = await bootRuntime()
  const sessionId = `cold-resume-${Date.now().toString(36)}`
  const waiters = new Set()
  const subscribe = (client) => {
    const subscription = client.subscribe()
    const pumping = (async () => {
      for (;;) {
        const notification = await subscription.next()
        for (const wait of waiters) wait(notification)
      }
    })()
    pumping.catch(() => {})
    return subscription
  }
  const waitFor = (predicate, timeoutMs = 40000, what = 'notification') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (payload) => { if (predicate(payload)) { clearTimeout(timer); waiters.delete(wait); resolve(payload) } }
    waiters.add(wait)
  })
  // Policy gate auto-allow (keep the loop harmless).
  void (async () => { for (;;) { try { const r = await waitFor((n) => n.method === 'idbots/policy/request', 60000); await clientA.request('idbots/policy/respond', { id: r.params.id, decision: 'allow' }) } catch { return } } })().catch(() => undefined)

  const subscriptionA = subscribe(clientA)
  const noticeEnded = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'turn/end' && n.params.event.data?.turn === 2, 40000, 'parent notice turn end')
  await clientA.prompt(sessionId, [{ type: 'text', text: 'DELEGATE the task please' }])
  await noticeEnded

  const list = await clientA.request('idbots/subagents/list', { sessionId })
  assert.ok(list.agents.length >= 1, 'subagent lineage recorded in phase A')
  const childId = list.agents[0].agentId
  // The child's report round-trip proves it ran AND settled before the exit.
  assert.ok(seen.some((r) => JSON.stringify(r.body?.messages ?? []).includes('CHILD_REPORT_BG_DONE')),
    'phase A child reported through send_message')

  subscriptionA.close()
  await clientA.close()
  await sleep(500) // session.lock flocks die with the process; give the OS a beat

  // ---- Phase B: fresh process, resume the parent, cold-resume the child.
  const clientB = await bootRuntime()
  const subscriptionB = subscribe(clientB)
  void (async () => { for (;;) { try { const r = await waitFor((n) => n.method === 'idbots/policy/request', 60000); await clientB.request('idbots/policy/respond', { id: r.params.id, decision: 'allow' }) } catch { return } } })().catch(() => undefined)
  void subscriptionB

  const ensure = await clientB.request('session/ensure', { sessionId })
  assert.equal(ensure.resumed, true, 'the parent session resumed from its persisted log in the fresh process')

  const seenBeforeFollowup = seen.length
  const followupEnded = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'turn/end', 40000, 'parent follow-up turn end')
  await clientB.prompt(sessionId, [{ type: 'text', text: `FOLLOWUP_AGENT:${childId} continue please` }])
  await followupEnded

  // The cold-resumed CHILD ran a real provider turn: its request carries the
  // delivered follow-up content plus the child-marker instruction. Without
  // the mounted session-query engine this request never happens — the
  // send_message tool result dies with CONTINUATION_UNAVAILABLE instead.
  const deadline = Date.now() + 20000
  let childFollowupRequest = undefined
  for (;;) {
    childFollowupRequest = seen.slice(seenBeforeFollowup)
      .find((r) => JSON.stringify(r.body?.messages ?? []).includes('FOLLOWUP_PING')
        && JSON.stringify(r.body?.messages ?? []).includes('Your parent agent id is'))
    if (childFollowupRequest !== undefined || Date.now() > deadline) break
    await sleep(500)
  }
  assert.ok(childFollowupRequest, 'the persisted child cold-resumed and ran a turn on the delivered follow-up')

  subscriptionB.close()
  await clientB.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('PASS  continuable subagent cold-resume across runtime restart (session-query mounted)')
  process.exit(0)
}

main().catch((error) => {
  console.error('[subagent-cold-resume-test] fatal:', error)
  process.exit(1)
})
