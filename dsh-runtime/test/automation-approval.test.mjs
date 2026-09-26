// Automation-approval E2E (TICKET-2026-09-04): the kernel patches on the
// experimental browser-use / computer-use providers route every MUTATING
// tool call through the kernel's fail-closed approval seam before execution.
//
// Browser phase (real headless Chromium via the mock gateway):
//   A. rejected approval -> navigate never runs, tool errors "not approved"
//   B. allowed-once      -> navigate runs, page snapshot comes back
//   C. observation tool (browser_network_requests) -> no approval ask at all
// Computer-use phase (cua-driver native, no macOS grants needed for the
// reject path — the gate fires before the driver is called):
//   D. rejected approval -> desktop action never runs
//   E. observation tool  -> no approval ask at all
//
// Requires a Chrome/Chromium executable for the browser phase — skipped
// cleanly when none is found. Run: node test/automation-approval.test.mjs
// (from dsh-runtime/)

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

const CHROME_CANDIDATES = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : process.platform === 'win32'
    ? [process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe', process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const chromePath = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p))

// Keep in sync with the kernel patch's READ_ONLY_TOOLS in
// @deepseek-ai/dsh-experimental-computer-use-cua-driver-native — a drift
// makes phase E fail loudly (its pick would prompt), which is the point.
const CUA_READ_ONLY = new Set([
  'list_apps', 'list_windows', 'get_window_state', 'get_screen_size',
  'verify_state', 'get_desktop_state', 'get_cursor_position', 'get_accessibility_tree',
  'get_browser_state', 'clipboard_read', 'check_permissions', 'health_report',
  'get_config', 'get_agent_cursor_state', 'get_recording_state',
  'get_session', 'list_sessions', 'get_session_state',
])

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** One runtime + mock gateway + notification pump, shared by a phase's sessions. */
const bootPhase = async ({ port, configInput }) => {
  const { server } = await startMockServer(port)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoappr-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'AUTOAPPR_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    ...configInput,
  })
  const configPath = path.join(os.tmpdir(), `dsh-autoappr-${Date.now()}-${port}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, AUTOAPPR_KEY: 'sk-autoappr', SPIKE_QUIET: '1' },
    // Heaviest compositions in the suite; keep the boot budget generous.
    initializeTimeoutMs: 60000,
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })

  const events = []
  const approvalRequests = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event') {
        events.push(notification.params)
        for (const wait of waiters) wait(notification)
      } else if (notification.method === 'idbots/approval/request') {
        approvalRequests.push(notification.params)
        for (const wait of waiters) wait(notification)
      }
    }
  })()
  pumping.catch(() => {})

  const waitFor = (pred, ms = 120000, what = 'notification') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what} (events: ${events.map((e) => e.event?.type).join(',')})`)), ms)
    const wait = (notification) => { if (pred(notification)) { clearTimeout(timer); waiters.delete(wait); resolve(notification) } }
    waiters.add(wait)
  })
  const waitForSessionEvent = (sessionId, pred, ms, what) =>
    waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId && pred(n.params.event), ms, what)
  const nextApproval = () =>
    waitFor((n) => n.method === 'idbots/approval/request', 120000, 'approval request').then((n) => n.params)

  const close = async () => {
    subscription.close()
    await Promise.race([client.close(), new Promise((resolve) => setTimeout(resolve, 10000))]).catch(() => {})
    server.closeAllConnections?.()
    await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => setTimeout(resolve, 5000))])
    fs.rmSync(sessionRoot, { recursive: true, force: true })
    fs.rmSync(configPath, { force: true })
  }

  return { client, events, approvalRequests, waitForSessionEvent, nextApproval, close }
}

const browserPhase = async () => {
  const phase = await bootPhase({
    port: 48817,
    configInput: { browserUse: { mode: 'launch', headless: true, executablePath: chromePath } },
  })
  try {
    // ---- A. rejected approval blocks the navigation -------------------------
    const sA = `autoappr-a-${Date.now().toString(36)}`
    await phase.client.prompt(sA, [{ type: 'text', text: 'CALL_BROWSER_NAV please' }])
    const askA = await phase.nextApproval()
    record('A: mutating browser_navigate asks approval with tool identity',
      askA.toolName === 'mcp__playwright-mcp__browser_navigate' && askA.sessionId === sA && String(askA.reason ?? '').includes('browser_navigate'),
      `tool=${askA.toolName} reason=${JSON.stringify(askA.reason)}`)
    await phase.client.request('idbots/approval/respond', { id: askA.id, outcome: 'rejected' })
    const resultA = await phase.waitForSessionEvent(sA, (e) => e.type === 'tool/result', 120000, 'rejected tool result')
    record('A: rejected navigate errors "not approved" and never executes',
      JSON.stringify(resultA.params.event).includes('was not approved')
        && !JSON.stringify(resultA.params.event).includes('BROWSER_SMOKE_OK'))
    await phase.waitForSessionEvent(sA, (e) => e.type === 'turn/end', 120000, 'turn end after rejection')
    const decidedA = phase.events.find((e) => e.sessionId === sA && e.event?.type === 'approval/decided' && JSON.stringify(e.event).includes('rejected'))
    record('A: audit pair lands on the session feed (approval/decided rejected)', Boolean(decidedA))

    // ---- B. allowed-once lets the navigation through ------------------------
    const sB = `autoappr-b-${Date.now().toString(36)}`
    await phase.client.prompt(sB, [{ type: 'text', text: 'CALL_BROWSER_NAV please' }])
    const askB = await phase.nextApproval()
    await phase.client.request('idbots/approval/respond', { id: askB.id, outcome: 'allowed-once' })
    const resultB = await phase.waitForSessionEvent(sB, (e) => e.type === 'tool/result', 120000, 'allowed tool result')
    record('B: allowed-once navigates and returns the page snapshot',
      JSON.stringify(resultB.params.event).includes('BROWSER_SMOKE_OK'))
    await phase.waitForSessionEvent(sB, (e) => e.type === 'turn/end', 120000, 'turn end after grant')

    // ---- C. observation tools never ask --------------------------------------
    const sC = `autoappr-c-${Date.now().toString(36)}`
    const approvalsBefore = phase.approvalRequests.length
    await phase.client.prompt(sC, [{ type: 'text', text: 'CALL_BROWSER_READ please' }])
    await phase.waitForSessionEvent(sC, (e) => e.type === 'tool/result', 120000, 'read-only tool result')
    await phase.waitForSessionEvent(sC, (e) => e.type === 'turn/end', 120000, 'turn end after read-only call')
    record('C: observation tool (browser_network_requests) runs without an approval ask',
      phase.approvalRequests.length === approvalsBefore)
  } finally {
    await phase.close()
  }
}

const computerUsePhase = async () => {
  // Discover the real catalog names from the driver itself (in-process; the
  // runtime's own driver lives in the child process, so no contention).
  let catalog
  try {
    const { CuaDriver } = await import('@trycua/cua-driver')
    const driver = CuaDriver.create(undefined)
    catalog = JSON.parse(await driver.listToolsJson({ signal: new AbortController().signal }))
    await driver.shutdown?.().catch(() => {})
    driver.uniffiDestroy?.()
  } catch (error) {
    console.log(`SKIP  computer-use phase — cua driver catalog unavailable: ${String(error).slice(0, 120)}`)
    return
  }
  const names = (catalog.tools ?? []).map((t) => t.name)
  const mutating = names.find((n) => !CUA_READ_ONLY.has(n))
  const readonly = names.find((n) => CUA_READ_ONLY.has(n))
  if (!mutating || !readonly) {
    console.log(`SKIP  computer-use phase — catalog lacks a mutating/readonly pair (${names.join(',') || 'empty'})`)
    return
  }

  const phase = await bootPhase({ port: 48818, configInput: { computerUse: true } })
  try {
    // ---- D. rejected approval blocks the desktop action ----------------------
    const sD = `autoappr-d-${Date.now().toString(36)}`
    await phase.client.prompt(sD, [{ type: 'text', text: `CALL_CUA:${mutating} please` }])
    const askD = await phase.nextApproval()
    record('D: mutating desktop tool asks approval with tool identity',
      askD.toolName === `cua_driver_native__${mutating}` && String(askD.reason ?? '').includes(mutating),
      `tool=${askD.toolName}`)
    await phase.client.request('idbots/approval/respond', { id: askD.id, outcome: 'rejected' })
    const resultD = await phase.waitForSessionEvent(sD, (e) => e.type === 'tool/result', 120000, 'rejected cua tool result')
    record('D: rejected desktop action errors "not approved" and never executes',
      JSON.stringify(resultD.params.event).includes('was not approved'))
    await phase.waitForSessionEvent(sD, (e) => e.type === 'turn/end', 120000, 'turn end after cua rejection')

    // ---- E. observation tools never ask ---------------------------------------
    const sE = `autoappr-e-${Date.now().toString(36)}`
    const approvalsBefore = phase.approvalRequests.length
    await phase.client.prompt(sE, [{ type: 'text', text: `CALL_CUA:${readonly} please` }])
    // The read itself may fail on missing macOS grants — irrelevant here; what
    // matters is that the approval gate stayed out of the way.
    await phase.waitForSessionEvent(sE, (e) => e.type === 'tool/result', 120000, 'read-only cua tool result')
    await phase.waitForSessionEvent(sE, (e) => e.type === 'turn/end', 120000, 'turn end after cua read')
    record('E: observation desktop tool runs without an approval ask',
      phase.approvalRequests.length === approvalsBefore)
  } finally {
    await phase.close()
  }
}

const main = async () => {
  if (chromePath === undefined) {
    console.log('SKIP  no Chrome/Chromium executable found — browser phase not applicable on this machine')
  } else {
    await browserPhase()
  }
  await computerUsePhase()
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[automation-approval] fatal:', error)
  process.exit(1)
})
