// session/ensure contention hardening (2026-09-21 A2A incident).
//
// Two app instances sharing one userData (a packaged build + a dev instance
// with the single-instance lock disabled) both ran the private-chat daemon
// for the same bot identity; each dispatched turns for the same
// conversation into its own DSH runtime process. The non-owner's
// session/ensure then died instantly on the owner's session.lock flock with
// `session "<id>" is already owned by an active write handle`, retrying
// forever while the owner's resident agent kept the lock.
//
// Fixes under test (plugins/idbots-sdk-server.mjs):
//  1. Concurrent ensures for one session id are chained in-process — the
//     loser awaits the winner and reuses the published agent instead of
//     bouncing off the winner's in-flight write claim.
//  2. A foreign-held write claim is retried with a bounded backoff: a
//     disposing/restarting owner releases the flock within seconds, so the
//     handover heals instead of erroring the turn.
//  3. A persistently foreign-owned session still fails with the original
//     error after the budget — no silent hang.
//
// Run: node test/session-ensure-contention.test.mjs   (from dsh-runtime/)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')
const PORT = 48796

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const bootRuntime = (sessionRoot) => {
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [
      {
        key: 'mockgw', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKeyEnv: 'CONTENTION_KEY',
        models: [{ id: 'mock-1', contextWindow: 32768 }],
      },
    ],
    sections: [],
  })
  const configPath = path.join(sessionRoot, `cordis.contention-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))
  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, CONTENTION_KEY: 'sk-contention', SPIKE_QUIET: '1' },
  })
  client.start()
  return client
}

const main = async () => {
  const { server } = await startMockServer(PORT)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contention-'))
  const clientA = bootRuntime(sessionRoot)
  let clientB = null
  try {
    await clientA.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
    const sessionId = `contention-${Date.now().toString(36)}`

    // 1. Concurrent in-process ensures: both settle, neither throws.
    const [r1, r2] = await Promise.all([
      clientA.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1' }),
      clientA.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1' }),
    ])
    record(
      'concurrent ensures on one session both settle',
      r1?.ensured === true && r2?.ensured === true,
      `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`,
    )

    // The session is live on A: a prompt runs a turn to completion.
    const subscription = clientA.subscribe()
    const turnDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for turn/end')), 30_000)
      ;(async () => {
        for (;;) {
          const notification = await subscription.next()
          if (notification.method === 'session.event'
            && notification.params?.sessionId === sessionId
            && notification.params?.event?.type === 'turn/end') {
            clearTimeout(timer)
            resolve(notification.params.event)
          }
        }
      })().catch(reject)
    })
    await clientA.prompt(sessionId, [{ type: 'text', text: 'hello alpha' }])
    await turnDone
    record('owner runtime completes a turn on the ensured session', true)

    // 2. A second runtime on the SAME session root is the foreign owner case:
    // its ensure is refused while A's resident agent holds the flock, and the
    // refusal only lands after the bounded retry budget (not instantly).
    clientB = bootRuntime(sessionRoot)
    await clientB.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
    const startedAt = Date.now()
    const foreign = await clientB.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1' })
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error?.message ?? error) }),
      )
    const foreignMs = Date.now() - startedAt
    record(
      'foreign-owned ensure fails with the write-claim error',
      foreign.ok === false && /already owned by an active write handle/.test(foreign.error ?? ''),
      foreign.ok ? 'unexpectedly succeeded' : (foreign.error ?? '').slice(0, 120),
    )
    record(
      'foreign-owned ensure only fails after the retry budget',
      foreign.ok === false && foreignMs >= 6000,
      `took ${foreignMs}ms`,
    )

    // 3. Handover heal: while B's ensure sits inside its retry budget, A
    // disposing the session releases the flock and B's retry resumes it.
    const handover = clientB.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1' })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await clientA.request('session/dispose', { sessionId })
    const handoverResult = await handover
    record(
      'ensure retries across the owner dispose and resumes the session',
      handoverResult?.ensured === true && handoverResult?.resumed === true,
      JSON.stringify(handoverResult),
    )

    // B now owns the session and can run a turn on it.
    const subscriptionB = clientB.subscribe()
    const turnDoneB = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for turn/end on B')), 30_000)
      ;(async () => {
        for (;;) {
          const notification = await subscriptionB.next()
          if (notification.method === 'session.event'
            && notification.params?.sessionId === sessionId
            && notification.params?.event?.type === 'turn/end') {
            clearTimeout(timer)
            resolve(notification.params.event)
          }
        }
      })().catch(reject)
    })
    await clientB.prompt(sessionId, [{ type: 'text', text: 'hello from the successor' }])
    await turnDoneB
    record('successor runtime runs a turn on the handed-over session', true)
  } catch (error) {
    record('test body completed without harness errors', false, String(error?.stack ?? error))
  } finally {
    await Promise.allSettled([clientA.close(), clientB?.close()])
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
