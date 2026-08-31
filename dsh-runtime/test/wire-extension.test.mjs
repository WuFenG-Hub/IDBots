// M1 wire test: drives the dsh-runtime bin through @deepseek-ai/dsh-sdk-client
// and proves the idbots-sdk-server extensions work over the real stdio wire.
//
//  1. idbots/ping canary answers with the extension list
//  2. session/steer mid-turn (while slow_tool runs) is consumed at the step
//     boundary — the steer text appears as a user/message session event
//  3. session/cancel mid-stream aborts the turn with our cause recorded
//  4. stock behavior intact: unknown methods still -32603, clean close
//
// Run: node test/wire-extension.test.mjs   (from dsh-runtime/)

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'
import { runtimeClient } from './helpers/runtime-client.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const main = async () => {
  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), path.join(runtimeDir, 'cordis.test.yml')],
    env: { ...process.env, SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'fake', model: 'fake-1' })

  // ---- 1. extension canary ------------------------------------------------
  const ping = await client.request('idbots/ping')
  record('idbots/ping canary', ping?.pong === true && Array.isArray(ping?.extensions))

  const sessionId = `m1-wire-${Date.now().toString(36)}`

  // Shared notification pump: records session events + resolves waiters.
  const events = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method !== 'session.event') continue
      const { sessionId: sid, event } = notification.params
      events.push({ sid, event })
      for (const wait of waiters) wait({ sid, event })
    }
  })()
  pumping.catch(() => {})

  const waitFor = (predicate, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for session event (${events.length} seen)`)), timeoutMs)
    const wait = (entry) => {
      if (predicate(entry)) {
        clearTimeout(timer)
        waiters.delete(wait)
        resolve(entry)
      }
    }
    waiters.add(wait)
  })

  // ---- 2. steer mid-turn ---------------------------------------------------
  const turnEndPromise = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn never ended')), 25000)
    const wait = ({ sid, event }) => {
      if (sid === sessionId && event.type === 'turn/end') {
        clearTimeout(timer); waiters.delete(wait); resolve(event)
      }
    }
    waiters.add(wait)
  })

  const steerTurnEnd = turnEndPromise()

  await client.prompt(sessionId, [{ type: 'text', text: 'STEER_TEST' }])
  await waitFor(({ sid, event }) => sid === sessionId && event.type === 'tool/call' && event.data?.name === 'slow_tool')
  const steerReceipt = await client.request('session/steer', {
    sessionId,
    contentBlocks: [{ type: 'text', text: 'STEERED_OVER_WIRE' }],
  })
  record('session/steer accepted mid-turn', steerReceipt?.steered === true, `messageId=${steerReceipt?.messageId}`)

  await steerTurnEnd
  const steerConsumed = events.some(({ sid, event }) =>
    sid === sessionId && event.type === 'user/message' && JSON.stringify(event).includes('STEERED_OVER_WIRE'))
  record('steer message consumed into the session (user/message event)', steerConsumed)
  const turnClean = events.some(({ sid, event }) =>
    sid === sessionId && event.type === 'turn/end' && event.data?.reason?.kind === 'completed')
  record('steered turn still completes cleanly', turnClean)

  // ---- 3. cancel mid-stream ------------------------------------------------
  await client.prompt(sessionId, [{ type: 'text', text: 'CANCEL_TEST' }])
  await waitFor(({ sid, event }) => sid === sessionId && event.type === 'assistant/chunk')
  const cancelReceipt = await client.request('session/cancel', { sessionId, cause: 'm1 wire cancel' })
  record('session/cancel accepted mid-stream', cancelReceipt?.cancelled === true)

  const ended = await turnEndPromise()
  const abortedWithCause = ended.data?.reason?.kind === 'aborted' && JSON.stringify(ended).includes('m1 wire cancel')
  record('cancelled turn closes as aborted with our cause', abortedWithCause, JSON.stringify(ended.data?.reason))

  // ---- 4. stock behavior intact -------------------------------------------
  try {
    await client.request('session/approval', { sessionId }, 3000)
    record('unknown method still rejected', false, 'unexpectedly succeeded')
  } catch (error) {
    const isJsonRpcError = error instanceof JsonRpcResponseError
    record('unknown method still rejected (-32603)', isJsonRpcError && error.code === -32603, String(error.message).slice(0, 60))
  }

  subscription.close()
  await client.close()
  record('clean close', true)

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[m1-test] fatal:', error)
  process.exit(1)
})
