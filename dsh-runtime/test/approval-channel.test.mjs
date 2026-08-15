// M2 approval-channel wire test: proves the full ask round trip over stdio —
// a tool gated by a `tools/pre-execute` ask decision surfaces as an
// `idbots/approval/request` notification, the client answers via
// `idbots/approval/respond`, and the outcome drives execution (allowed-once),
// denial (rejected), or dialog dismissal (turn cancelled while pending).
// Audit events approval/asked + approval/decided must ride the session feed.
//
// Run: node test/approval-channel.test.mjs   (from dsh-runtime/)

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessClient, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const main = async () => {
  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), path.join(runtimeDir, 'cordis.test.yml')],
    env: { ...process.env, SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'fake', model: 'fake-1' })

  const sessionId = `m2-approval-${Date.now().toString(36)}`

  // Notification pump: routes by method into per-method waiters.
  const waiters = new Set()
  const sessionEvents = []
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        sessionEvents.push(notification.params.event)
        for (const wait of waiters) wait(notification)
      } else if (notification.method.startsWith('idbots/')) {
        for (const wait of waiters) wait(notification)
      }
    }
  })()
  pumping.catch(() => {})

  const waitFor = (predicate, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for notification (${sessionEvents.length} session events seen)`)), timeoutMs)
    const wait = (notification) => {
      if (predicate(notification)) {
        clearTimeout(timer)
        waiters.delete(wait)
        resolve(notification)
      }
    }
    waiters.add(wait)
  })

  const waitForSessionEvent = (predicate, timeoutMs = 20000) =>
    waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId && predicate(n.params.event), timeoutMs)

  const approvalRound = async (marker, outcome) => {
    await client.prompt(sessionId, [{ type: 'text', text: marker }])
    const ask = await waitFor((n) => n.method === 'idbots/approval/request')
    const respond = await client.request('idbots/approval/respond', { id: ask.params.id, outcome })
    return { ask: ask.params, respond }
  }

  const turnEnd = () => waitForSessionEvent((e) => e.type === 'turn/end')

  // ---- A. allow path --------------------------------------------------------
  const allowEnd = turnEnd()
  const a = await approvalRound('TOOL:DANGEROUS', 'allowed-once')
  record('approval request notified with tool identity', a.ask.toolName === 'dangerous_tool' && Boolean(a.ask.id) && a.ask.sessionId === sessionId,
    `id=${a.ask.id} reason=${JSON.stringify(a.ask.reason)}`)
  record('respond accepted', a.respond?.answered === true)
  await allowEnd
  const allowedResult = sessionEvents.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('executed'))
  record('allowed-once executes the tool', Boolean(allowedResult))
  const askedEvent = sessionEvents.find((e) => e.type === 'approval/asked')
  const decidedAllowed = sessionEvents.find((e) => e.type === 'approval/decided' && JSON.stringify(e).includes('allowed-once'))
  record('audit pair approval/asked + approval/decided in session feed', Boolean(askedEvent && decidedAllowed))

  // ---- B. reject path -------------------------------------------------------
  const rejectEnd = turnEnd()
  const before = sessionEvents.length
  const b = await approvalRound('TOOL:DANGEROUS', 'rejected')
  await rejectEnd
  const rejectedResult = sessionEvents.slice(before).find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('the user rejected tool'))
  record('rejected denies with human-readable reason', Boolean(rejectedResult))
  const decidedRejected = sessionEvents.slice(before).find((e) => e.type === 'approval/decided' && JSON.stringify(e).includes('rejected'))
  record('audit decision records rejected', Boolean(decidedRejected))

  // ---- C. cancel while ask pending -----------------------------------------
  // Register every waiter BEFORE the cancel request: the runtime can emit the
  // dismissal notification and turn/end faster than the cancel response
  // round-trips, and waitFor has no replay buffer.
  const cancelEnd = turnEnd()
  await client.prompt(sessionId, [{ type: 'text', text: 'TOOL:DANGEROUS' }])
  const ask = await waitFor((n) => n.method === 'idbots/approval/request')
  const cancelledNote = waitFor((n) => n.method === 'idbots/approval/cancelled' && n.params.id === ask.params.id, 10000)
  await client.request('session/cancel', { sessionId, cause: 'm2 cancel during ask' })
  await cancelledNote
  record('pending ask dismissed on turn cancel (idbots/approval/cancelled)', true)
  const ended = await cancelEnd
  const reason = ended.params?.event?.data?.reason
  record('cancelled turn closes as aborted', reason?.kind === 'aborted', JSON.stringify(reason))
  const cancelledDecided = sessionEvents.find((e) => e.type === 'approval/decided' && JSON.stringify(e).includes('cancelled'))
  record('audit decision records cancelled', Boolean(cancelledDecided))

  // ---- D. invalid responds --------------------------------------------------
  try {
    await client.request('idbots/approval/respond', { id: 'nope', outcome: 'allowed-once' }, 5000)
    record('unknown approval id rejected', false, 'unexpectedly succeeded')
  } catch (error) {
    record('unknown approval id rejected', error instanceof JsonRpcResponseError, String(error.message).slice(0, 60))
  }
  try {
    await client.request('idbots/approval/respond', { id: 'x', outcome: 'yolo' }, 5000)
    record('invalid outcome rejected', false, 'unexpectedly succeeded')
  } catch (error) {
    record('invalid outcome rejected', error instanceof JsonRpcResponseError, String(error.message).slice(0, 60))
  }

  subscription.close()
  await client.close()
  record('clean close', true)

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[m2-test] fatal:', error)
  process.exit(1)
})
