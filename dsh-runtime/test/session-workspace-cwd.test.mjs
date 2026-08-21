// Two DSH sessions on one runtime must bash/write into THEIR workspace, not
// initialize's sessionRoot and not the first composition plugin cwd.
//
// Pre-fix: session/ensure created agents with meta.cwd = initialize cwd
// (the JSONL sessionRoot). Twin then Worker mixed artifacts. Composition
// bash/fs config.cwd is still first-pinned on purpose (plugin load; restart
// would kill in-flight turns) — execution cwd is session.header.cwd.
//
// Run: node test/session-workspace-cwd.test.mjs   (from dsh-runtime/)

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

const markerOf = (dir) => {
  const file = path.join(dir, 'marker.txt')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null
}

const main = async () => {
  const { server } = await startMockServer(48824)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-sess-'))
  const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-a-'))
  const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-b-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48824/v1', apiKeyEnv: 'WSCWD_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    // Pin composition plugins to A — the bug was session B inheriting A (or
    // sessionRoot). B must still write into workspaceB.
    workspace: { cwd: workspaceA },
  })
  const configPath = path.join(os.tmpdir(), `dsh-wscwd-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, WSCWD_KEY: 'sk-wscwd', SPIKE_QUIET: '1' },
    requestTimeoutMs: 30000,
  })
  client.start()
  await client.initialize({ cwd: sessionRoot, provider: 'mockgw', model: 'mock-1' })

  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      for (const wait of waiters) wait(notification)
    }
  })()
  pumping.catch(() => {})

  const waitFor = (predicate, timeoutMs = 25000, what = 'notification') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (payload) => {
      if (predicate(payload)) { clearTimeout(timer); waiters.delete(wait); resolve(payload) }
    }
    waiters.add(wait)
  })

  const policyRace = (async () => {
    for (;;) {
      try {
        const request = await waitFor((n) => n.method === 'idbots/policy/request', 60000)
        await client.request('idbots/policy/respond', { id: request.params.id, decision: 'allow' })
      } catch { return }
    }
  })()
  policyRace.catch(() => undefined)
  const approvalRace = (async () => {
    for (;;) {
      try {
        const ask = await waitFor((n) => n.method === 'idbots/approval/request', 60000)
        await client.request('idbots/approval/respond', { id: ask.params.id, outcome: 'allowed-once' })
      } catch { return }
    }
  })()
  approvalRace.catch(() => undefined)

  const runWriteTurn = async (sessionId, cwd, token) => {
    await client.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1', cwd })
    const turnDone = waitFor(
      (n) => n.method === 'session.event' && n.params?.sessionId === sessionId && n.params?.event?.type === 'turn/end',
      30000,
      `turn end ${sessionId}`,
    )
    await client.prompt(sessionId, [{ type: 'text', text: `RUN_BASH_WRITE:${token}` }])
    const end = await turnDone
    return end
  }

  const sessionA = `ws-a-${Date.now().toString(36)}`
  const sessionB = `ws-b-${Date.now().toString(36)}`
  const endA = await runWriteTurn(sessionA, workspaceA, 'twin')
  const endB = await runWriteTurn(sessionB, workspaceB, 'worker')
  record('session A turn completed', endA?.params?.event?.data?.reason?.kind === 'completed'
    || endA?.params?.event?.type === 'turn/end', JSON.stringify(endA?.params?.event?.data?.reason ?? endA?.params?.event?.type))
  record('session B turn completed', endB?.params?.event?.data?.reason?.kind === 'completed'
    || endB?.params?.event?.type === 'turn/end', JSON.stringify(endB?.params?.event?.data?.reason ?? endB?.params?.event?.type))

  record('session A wrote into workspace A', markerOf(workspaceA) === 'twin', `got ${markerOf(workspaceA)}`)
  record('session B wrote into workspace B', markerOf(workspaceB) === 'worker', `got ${markerOf(workspaceB)}`)
  record('session A did not receive B marker', markerOf(workspaceA) !== 'worker')
  record('session B did not receive A marker', markerOf(workspaceB) !== 'twin')
  record('neither session wrote into the shared sessionRoot', markerOf(sessionRoot) === null)

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(configPath, { force: true })
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(workspaceA, { recursive: true, force: true })
  fs.rmSync(workspaceB, { recursive: true, force: true })

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[session-workspace-cwd] fatal:', error)
  process.exit(1)
})
