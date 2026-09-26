// App-level kill-switch for the experimental automation backends (reviewer
// P2): static wiring contract (service -> provider gates -> IPC -> preload
// -> Settings toggle -> i18n) plus functional accessor behavior against the
// compiled service with a fake kv store.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const here = import.meta.dirname
const readSrc = (rel) => fs.readFileSync(path.resolve(here, '..', rel), 'utf8')

test('kill-switch wiring: service exports, provider gates, IPC, preload, UI, i18n', () => {
  const pref = readSrc('src/main/services/coworkAutomationPreference.ts')
  assert.match(pref, /EXPERIMENTAL_AUTOMATION_GLOBAL_KEY = 'automation\.experimentalEnabled'/)
  assert.match(pref, /export function isExperimentalAutomationAllowed/)
  assert.match(pref, /export function setExperimentalAutomationAllowed/)

  const main = readSrc('src/main/main.ts')
  // Both runtime providers consult the global gate before the per-bot switch.
  const browserGate = main.match(/browserAutomationProvider:[\s\S]*?detectSystemChromium\(\)/)?.[0] ?? ''
  assert.match(browserGate, /isExperimentalAutomationAllowed\(getStoreOrNull\(\)\)\) return undefined/)
  const cuGate = main.match(/computerUseProvider:[\s\S]*?isCoworkComputerUseEnabled[\s\S]*?\n\s*\},/)?.[0] ?? ''
  assert.match(cuGate, /isExperimentalAutomationAllowed\(getStoreOrNull\(\)\)\) return false/)
  assert.match(main, /ipcMain\.handle\('app:getExperimentalAutomation'/)
  assert.match(main, /ipcMain\.handle\('app:setExperimentalAutomation'/)

  const preload = readSrc('src/main/preload.ts')
  assert.match(preload, /experimentalAutomation:\s*\{/)
  assert.match(preload, /ipcRenderer\.invoke\('app:getExperimentalAutomation'\)/)
  assert.match(preload, /ipcRenderer\.invoke\('app:setExperimentalAutomation', enabled\)/)

  const types = readSrc('src/renderer/types/electron.d.ts')
  assert.match(types, /experimentalAutomation:\s*\{/)

  const settings = readSrc('src/renderer/components/Settings.tsx')
  assert.match(settings, /window\.electron\.experimentalAutomation\.get\(\)/)
  assert.match(settings, /window\.electron\.experimentalAutomation\.set\(next\)/)
  assert.match(settings, /i18nService\.t\('experimentalAutomation'\)/)

  const i18n = readSrc('src/renderer/services/i18n.ts')
  assert.equal((i18n.match(/experimentalAutomation: '/g) ?? []).length, 2, 'ZH + EN label')
  assert.equal((i18n.match(/experimentalAutomationDescription: '/g) ?? []).length, 2, 'ZH + EN description')
})

test('kill-switch accessors: default allow, explicit kill, fail-open on store errors', (t) => {
  const compiled = path.resolve(here, '..', 'dist-electron/main/services/coworkAutomationPreference.js')
  if (!fs.existsSync(compiled)) {
    t.skip('dist-electron not compiled (run npm run compile:electron)')
    return
  }
  const {
    EXPERIMENTAL_AUTOMATION_GLOBAL_KEY,
    isExperimentalAutomationAllowed,
    setExperimentalAutomationAllowed,
  } = require(compiled)

  // Missing key / missing store => allowed (per-bot opt-ins stay the default-off guard).
  assert.equal(isExperimentalAutomationAllowed(null), true)
  assert.equal(isExperimentalAutomationAllowed(undefined), true)
  const kv = new Map()
  const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) }
  assert.equal(isExperimentalAutomationAllowed(store), true)

  // Roundtrip: kill, then re-allow.
  setExperimentalAutomationAllowed(store, false)
  assert.equal(kv.get(EXPERIMENTAL_AUTOMATION_GLOBAL_KEY), '0')
  assert.equal(isExperimentalAutomationAllowed(store), false)
  setExperimentalAutomationAllowed(store, true)
  assert.equal(isExperimentalAutomationAllowed(store), true)

  // Tolerates a stored boolean false (hand-edited kv) and a throwing store.
  kv.set(EXPERIMENTAL_AUTOMATION_GLOBAL_KEY, false)
  assert.equal(isExperimentalAutomationAllowed(store), false)
  const broken = { get: () => { throw new Error('store not ready') } }
  assert.equal(isExperimentalAutomationAllowed(broken), true)
  // A failing writer must not throw either (next read falls back to allow).
  const brokenWriter = { get: () => undefined, set: () => { throw new Error('readonly') } }
  setExperimentalAutomationAllowed(brokenWriter, false)
})
