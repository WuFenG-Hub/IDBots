// IDBots DSH Phase 0 spike driver.
//
// Boots the minimal runtime in-process via dsh-app-boot, then exercises the
// control plane IDBots needs from a kernel:
//   1. create agent + followup + session event stream (turn/step/chunk/tool)
//   2. tool registration + execution (wallet service consumed by a tool)
//   3. permission deny via tools/pre-execute
//   4. steer mid-turn (step-boundary consumption)
//   5. cancel mid-stream
//   6. resume within the same process, and cross-process via RESUME_SESSION_ID
//
// Usage:
//   node scripts/run-agent.mjs                 # full scripted run
//   RESUME_SESSION_ID=<id> node scripts/run-agent.mjs --resume-only
//
// The script prints a PASS/FAIL summary at the end; every line is meant to be
// evidence for the Phase 0 report.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'

const here = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.resolve(here, '../cordis.yml')
const resumeOnly = process.argv.includes('--resume-only')
const resumeSessionId = process.env.RESUME_SESSION_ID

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const summary = (envelope) => {
  const event = envelope.data ?? envelope
  switch (envelope.type) {
    case 'turn/start': return `turn=${event.turn}`
    case 'turn/end': return `turn=${event.turn} ${JSON.stringify(event.reason ?? event.outcome ?? {}).slice(0, 80)}`
    case 'step/start': return `turn=${event.turn} step=${event.step}`
    case 'user/message': return (event.message?.content ?? []).map((b) => b.text ?? b.type).join(' ').slice(0, 60)
    case 'assistant/chunk': return `${event.chunk?.type ?? '?'}${event.chunk?.text ? ` "${String(event.chunk.text).slice(0, 30)}"` : ''}`
    case 'assistant/message': return (event.message?.content ?? []).map((b) => b.type === 'text' ? b.text : b.type).join(' ').slice(0, 90)
    case 'tool/call': return `${event.call?.name ?? '?'} ${String(event.call?.arguments ?? '').slice(0, 60)}`
    case 'tool/result': return `${event.call?.name ?? event.result?.call?.name ?? '?'} isError=${(event.result ?? event).isError ?? false} ${JSON.stringify((event.result ?? event).value ?? '').slice(0, 80)}`
    case 'request/header': return `provider=${event.header?.provider ?? event.provider ?? '?'} model=${event.header?.model ?? event.model ?? '?'}`
    default: return JSON.stringify(event).slice(0, 70)
  }
}

const waitFor = (predicate, events, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for event (${events.length} seen)`)), timeoutMs)
  const check = (event) => {
    if (predicate(event)) {
      clearTimeout(timer)
      resolve(event)
    }
  }
  pendingChecks.add(check)
})

// Simple event bus so waitFor can observe everything logged below.
const pendingChecks = new Set()

const main = async () => {
  console.log(`[spike] booting config: ${configPath}`)
  const ctx = await boot('idbots-spike', configPath)
  console.log('[spike] runtime booted; plugin tree active')

  const events = []
  const dumped = new Set()
  ctx.on('session/event', (session, event) => {
    events.push(event)
    for (const check of pendingChecks) check(event)
    console.log(`  [event] ${event.type} ${summary(event)}`)
    if (['tool/call', 'tool/result', 'user/message', 'turn/end', 'request/header'].includes(event.type) && !dumped.has(event.type)) {
      dumped.add(event.type)
      console.log(`  [event-dump] ${event.type} ${JSON.stringify(event).slice(0, 600)}`)
    }
  })

  const userMessage = (id, text) => ({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })

  let agent
  let sessionId

  if (resumeOnly) {
    if (!resumeSessionId) throw new Error('--resume-only requires RESUME_SESSION_ID')
    console.log(`[spike] resuming cross-process session ${resumeSessionId}`)
    const handle = await ctx.agents.resume({ resumeSessionId, agentOptions: { provider: 'fake', model: 'fake-1' } })
    agent = handle.agent
    sessionId = agent.id
    agent.followup(userMessage('u-resume', 'AFTER_RESUME'))
    await agent.whenIdle()
    const historySeen = events.some((e) => e.type === 'assistant/message')
    record('cross-process resume: turn ran after reload', historySeen)
    console.log(`[spike] resume run complete; ${events.length} events this process`)
    await ctx.get('sessions')?.flush(agent.session)
    process.exit(0)
  }

  // ---- 1. create + plain text turn ------------------------------------
  sessionId = `spike-${Date.now().toString(36)}`
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: 'fake', model: 'fake-1' },
  })
  agent = handle.agent
  console.log(`[spike] agent created: ${agent.id} status=${agent.status}`)

  agent.followup(userMessage('u1', 'PING'))
  await agent.whenIdle()
  const pong = events.find((e) => e.type === 'assistant/message' && JSON.stringify(e).includes('PONG'))
  record('turn 1: plain text reply streamed + assembled', Boolean(pong))
  const sawChunk = events.some((e) => e.type === 'assistant/chunk' && (e.data?.chunk ?? e.chunk)?.type === 'text-delta')
  record('turn 1: token-level chunk events observed', sawChunk)
  const sawHeader = events.some((e) => e.type === 'request/header')
  record('turn 1: request/header (context snapshot) emitted', sawHeader)

  // ---- 2. tool call + wallet service ----------------------------------
  agent.followup(userMessage('u2', 'TOOL:WALLET'))
  await agent.whenIdle()
  const toolResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('alice'))
  record('turn 2: wallet_balance executed via ctx.idbotsWallet', Boolean(toolResult))
  const toolSummary = events.find((e) => e.type === 'assistant/message' && JSON.stringify(e).includes('TOOL_RESULT_SEEN'))
  record('turn 2: model received tool result in next step', Boolean(toolSummary))

  // ---- 3. permission deny ---------------------------------------------
  agent.followup(userMessage('u3', 'TOOL:GATED'))
  await agent.whenIdle()
  const denied = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('spike policy'))
  record('turn 3: pre-execute deny surfaced as error tool result', Boolean(denied))

  // ---- 4. steer mid-turn ----------------------------------------------
  events.length = 0
  agent.followup(userMessage('u4', 'STEER_TEST'))
  await waitFor((e) => e.type === 'tool/call' && e.data?.name === 'slow_tool', events)
  agent.steer(userMessage('u5', 'STEERED_NOW drop the current plan'))
  console.log('[spike] steer queued while slow_tool is running')
  await agent.whenIdle()
  const steerSeen = events.filter((e) => e.type === 'user/message')
    .some((e) => JSON.stringify(e).includes('STEERED_NOW'))
  record('turn 4: steer message consumed during turn (step boundary)', steerSeen)

  // ---- 5. cancel mid-stream -------------------------------------------
  events.length = 0
  agent.followup(userMessage('u6', 'CANCEL_TEST'))
  await waitFor((e) => e.type === 'assistant/chunk', events)
  agent.cancel('spike driver cancel')
  console.log('[spike] cancel issued mid-stream')
  await agent.whenIdle()
  const cancelled = events.some((e) => e.type === 'turn/end' && JSON.stringify(e).includes('spike driver cancel'))
  record('turn 5: mid-stream cancel closes the turn with cause', cancelled)

  // ---- 6. resume same-session in-process ------------------------------
  const countBefore = events.filter((e) => e.type === 'user/message').length
  await handle.dispose()
  console.log('[spike] agent disposed; resuming from persistence')
  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'fake', model: 'fake-1' } })
  resumed.agent.followup(userMessage('u7', 'AFTER_RESUME'))
  await resumed.agent.whenIdle()
  const afterResume = events.filter((e) => e.type === 'assistant/message').pop()
  record('turn 6: same-process resume + followup works', Boolean(afterResume))

  console.log('\n[spike] ==== summary ====')
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  const failed = results.filter((r) => !r.pass).length
  console.log(`[spike] ${results.length - failed}/${results.length} checks passed; session=${sessionId}`)
  console.log(`[spike] cross-process resume check: RESUME_SESSION_ID=${sessionId} node scripts/run-agent.mjs --resume-only`)

  await ctx.get('sessions')?.flush(agent.session)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[spike] fatal:', error)
  process.exitCode = 1
})
