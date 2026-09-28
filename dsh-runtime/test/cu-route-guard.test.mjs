// cu-route-guard E2E (0.2.0): the idbots-cu-route-guard plugin mounts with the
// computer-use composition and refuses the pointer-moving cua-driver routes at
// tools/pre-execute — BEFORE the provider's approval gate — so an approved
// desktop tool can never silently grab the user's physical mouse.
//
// Unit phase (no runtime): the route table + plugin wiring + config-gen mount.
// Wire phase (mock gateway, computerUse: true; denied calls never dispatch,
// so no macOS grants are needed):
//   F. click with delivery_mode:"foreground" -> deny, no approval ask
//   G. drag                                   -> deny, no approval ask
//   H. move_cursor (window scope)             -> deny (overlay unavailable)
//   I. read-only observation tool             -> falls through the guard
//
// Run: node test/cu-route-guard.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'
import { apply as applyGuard, cuRouteViolation, name as guardName } from '../plugins/idbots-cu-route-guard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------- unit phase -------------------------------------------------------

const unitPhase = async () => {
  // Config-gen: the guard rides the computerUse switch, after the CU pair.
  const base = {
    sessionRoot: '/tmp/unused',
    providers: [{ key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'X', models: [{ id: 'mock-1', contextWindow: 32768 }] }],
    sections: [],
  }
  const withCu = JSON.stringify(generateRuntimeConfig({ ...base, computerUse: true }))
  const withoutCu = JSON.stringify(generateRuntimeConfig(base))
  record('unit: guard mounts only with computerUse', withCu.includes('idbots-cu-route-guard.mjs') && !withoutCu.includes('idbots-cu-route-guard'))

  // Route table.
  const cases = [
    ['click foreground denied', 'click', { delivery_mode: 'foreground' }, 'physical mouse pointer'],
    ['double_click desktop scope denied', 'double_click', { scope: 'desktop' }, 'real OS pointer'],
    ['click desktop target denied', 'click', { target: { kind: 'desktop', display_id: 'primary' } }, 'real OS pointer'],
    ['drag denied (no background drag)', 'drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }, 'no background drag'],
    ['drag foreground denied as foreground', 'drag', { fromX: 1, fromY: 2, toX: 3, toY: 4, delivery_mode: 'foreground' }, 'physical mouse pointer'],
    ['modifier click denied', 'click', { modifier: ['shift'] }, 'Modifier-key clicks'],
    ['modifiers (plural) click denied', 'click', { modifiers: ['cmd'] }, 'Modifier-key clicks'],
    ['set_config denied', 'set_config', { key: 'experimental_pip', value: 'true' }, 'driver-level configuration'],
    ['replay_trajectory denied', 'replay_trajectory', {}, 'recorded input'],
    ['move_cursor window scope denied (overlay)', 'move_cursor', { x: 10, y: 10 }, 'facility_unavailable'],
    ['move_cursor desktop scope denied (pointer)', 'move_cursor', { x: 10, y: 10, scope: 'desktop' }, 'real OS pointer'],
    ['set_agent_cursor_theme denied (overlay)', 'set_agent_cursor_theme', { session: 's', theme_id: 'cua.default' }, 'facility_unavailable'],
    ['get_agent_cursor_state denied (overlay)', 'get_agent_cursor_state', { session: 's' }, 'facility_unavailable'],
    ['background click falls through', 'click', { x: 10, y: 10 }, null],
    ['type_text falls through', 'type_text', { text: 'hello' }, null],
    ['scroll background falls through', 'scroll', { dx: 0, dy: -3 }, null],
    ['get_desktop_state falls through', 'get_desktop_state', {}, null],
  ]
  let failures = 0
  for (const [label, short, args, expected] of cases) {
    const reason = cuRouteViolation(short, args)
    const ok = expected === null ? reason === null : (reason ?? '').includes(expected)
    if (!ok) failures += 1
    record(`unit: ${label}`, ok, expected === null ? `reason=${JSON.stringify(reason)}` : undefined)
  }

  // Plugin wiring: one global pre-execute listener, one prompt section;
  // non-cua tools and background cua calls delegate to next().
  const listeners = []
  const sections = []
  applyGuard({
    on: (event, fn, opts) => listeners.push({ event, fn, opts }),
    systemPrompt: { section: (s) => sections.push(s) },
  })
  const pre = listeners.find((l) => l.event === 'tools/pre-execute')
  record('unit: registers a global tools/pre-execute listener', Boolean(pre) && pre.opts?.global === true)
  const boundary = sections.find((s) => s.name === 'idbots:computer-use-boundary')
  record('unit: registers the boundary prompt section',
    Boolean(boundary) && boundary.text.includes('BACKGROUND mode only') && boundary.text.includes('delivery_mode'))

  const nextAllow = async () => ({ kind: 'allow' })
  const denyDecision = pre ? await pre.fn({ name: 'cua_driver_native__click', arguments: { delivery_mode: 'foreground' } }, nextAllow) : null
  record('unit: listener denies a foreground click with the reason',
    denyDecision?.kind === 'deny' && denyDecision.reason.includes('physical mouse pointer'))
  const passDecision = pre ? await pre.fn({ name: 'cua_driver_native__click', arguments: { x: 1, y: 2 } }, nextAllow) : null
  record('unit: listener passes a background click through', passDecision?.kind === 'allow')
  const foreignDecision = pre ? await pre.fn({ name: 'bash', arguments: { command: 'echo hi' } }, nextAllow) : null
  record('unit: non-cua tools are untouched', foreignDecision?.kind === 'allow')
  const noArgsDecision = pre ? await pre.fn({ name: 'cua_driver_native__click' }, nextAllow) : null
  record('unit: a call with no arguments falls through', noArgsDecision?.kind === 'allow')
  return failures
}

// ---------- wire phase -------------------------------------------------------

const wirePhase = async () => {
  // Same availability probe as automation-approval: mounting loads the driver
  // in-process, so skip cleanly where it cannot start at all.
  try {
    const { CuaDriver } = await import('@trycua/cua-driver')
    const driver = CuaDriver.create(undefined)
    await driver.listToolsJson({ signal: new AbortController().signal })
    await driver.shutdown?.().catch(() => {})
    driver.uniffiDestroy?.()
  } catch (error) {
    console.log(`SKIP  wire phase — cua driver unavailable: ${String(error).slice(0, 120)}`)
    return
  }

  const { server } = await startMockServer(48819)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cuguard-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48819/v1', apiKeyEnv: 'CUGUARD_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    computerUse: true,
  })
  const configJson = JSON.stringify(config)
  assert.ok(configJson.includes('idbots-cu-route-guard.mjs'), 'generated config mounts the route guard')
  const configPath = path.join(os.tmpdir(), `dsh-cuguard-${Date.now()}.json`)
  fs.writeFileSync(configPath, configJson)

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, CUGUARD_KEY: 'sk-cuguard', SPIKE_QUIET: '1' },
    initializeTimeoutMs: 60000,
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })

  const approvalRequests = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'idbots/approval/request') approvalRequests.push(notification.params)
      for (const wait of waiters) wait(notification)
    }
  })()
  pumping.catch(() => {})
  const waitForSessionEvent = (sessionId, pred, ms = 120000, what = 'event') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms)
    const wait = (n) => {
      if (n.method === 'session.event' && n.params.sessionId === sessionId && pred(n.params.event)) {
        clearTimeout(timer); waiters.delete(wait); resolve(n)
      }
    }
    waiters.add(wait)
  })

  try {
    // ---- F. foreground click is denied before any approval ask ---------------
    const sF = `cuguard-f-${Date.now().toString(36)}`
    const approvalsBeforeF = approvalRequests.length
    await client.prompt(sF, [{ type: 'text', text: 'CALL_CUA_FG:click please' }])
    const resultF = await waitForSessionEvent(sF, (e) => e.type === 'tool/result', 120000, 'denied foreground click result')
    record('F: foreground click denied with the physical-pointer reason',
      JSON.stringify(resultF.params.event).includes('physical mouse pointer'))
    await waitForSessionEvent(sF, (e) => e.type === 'turn/end', 120000, 'turn end after deny')
    record('F: denial fired before the approval gate (no ask)',
      approvalRequests.length === approvalsBeforeF)

    // ---- G. drag is denied (no background drag on macOS) ----------------------
    const sG = `cuguard-g-${Date.now().toString(36)}`
    await client.prompt(sG, [{ type: 'text', text: 'CALL_CUA:drag please' }])
    const resultG = await waitForSessionEvent(sG, (e) => e.type === 'tool/result', 120000, 'denied drag result')
    record('G: drag denied with the no-background-drag reason',
      JSON.stringify(resultG.params.event).includes('no background drag'))
    await waitForSessionEvent(sG, (e) => e.type === 'turn/end', 120000, 'turn end after drag deny')

    // ---- H. move_cursor is denied (overlay unavailable in-process) ------------
    const sH = `cuguard-h-${Date.now().toString(36)}`
    await client.prompt(sH, [{ type: 'text', text: 'CALL_CUA:move_cursor please' }])
    const resultH = await waitForSessionEvent(sH, (e) => e.type === 'tool/result', 120000, 'denied move_cursor result')
    record('H: move_cursor denied with the overlay-unavailable reason',
      JSON.stringify(resultH.params.event).includes('facility_unavailable'))
    await waitForSessionEvent(sH, (e) => e.type === 'turn/end', 120000, 'turn end after move_cursor deny')

    // ---- I. read-only observation tool falls through the guard ----------------
    const sI = `cuguard-i-${Date.now().toString(36)}`
    const approvalsBeforeI = approvalRequests.length
    await client.prompt(sI, [{ type: 'text', text: 'CALL_CUA:get_cursor_position please' }])
    const resultI = await waitForSessionEvent(sI, (e) => e.type === 'tool/result', 120000, 'read-only cua result')
    const jsonI = JSON.stringify(resultI.params.event)
    record('I: observation tool not touched by the guard (no deny reason, no ask)',
      !jsonI.includes('refused by host policy') && approvalRequests.length === approvalsBeforeI,
      jsonI.slice(0, 140))
    await waitForSessionEvent(sI, (e) => e.type === 'turn/end', 120000, 'turn end after read-only call')
  } finally {
    subscription.close()
    await Promise.race([client.close(), new Promise((resolve) => setTimeout(resolve, 10000))]).catch(() => {})
    server.closeAllConnections?.()
    await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => setTimeout(resolve, 5000))])
    fs.rmSync(sessionRoot, { recursive: true, force: true })
    fs.rmSync(configPath, { force: true })
  }
}

const main = async () => {
  await unitPhase()
  await wirePhase()
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[cu-route-guard] fatal:', error)
  process.exit(1)
})
