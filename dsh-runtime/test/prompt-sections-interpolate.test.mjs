// Regression (2026-10-22, A2A session 33c61c77): a peer message quoting the
// literal placeholders {{METABOT_SKILL_PIN}} / {{SKILL_ZIP_METAFILE}} rode the
// A2A conversation history embedded in the idbots:base section; at assembly,
// dsh-system-prompt's strict interpolator rejected the uppercase names and
// killed EVERY turn of the session with "malformed prompt variable reference".
//
// Sections carrying authored/untrusted content (idbots:base with the peer
// history, idbots:goal with user goal text) must register with
// interpolate:false so they render literally. This test replays the exact
// production failure through the REAL cordis Context + SystemPrompt plugin +
// idbots-prompt-sections passthrough:
//   A. with interpolate:false the quoted placeholders render verbatim
//   B. without the flag the exact production error still throws (test bites)
//   C. the plugin passes the flag through and omits it when unset
//
// Run: node test/prompt-sections-interpolate.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply as applySections } from '../plugins/idbots-prompt-sections.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// The exact payload shape from the incident session: brace groups a peer bot
// quoted while discussing unrendered placeholders in an on-chain tutorial.
const INCIDENT_PAYLOAD =
  'Bot-007: 「链上直装」段两个占位符在链上原文未渲染（{{METABOT_SKILL_PIN}} / {{SKILL_ZIP_METAFILE}}），读者按此装不了。'

const bootApp = async (sections) => {
  const app = new Context()
  await app.plugin(SystemPrompt, {})
  applySections(app, { sections })
  return app
}

// ---------- A: production replay with the fix -------------------------------

const fixedApp = await bootApp([
  { name: 'idbots:base', order: 0, text: INCIDENT_PAYLOAD, interpolate: false },
])
const fixedAssembly = await fixedApp.systemPrompt.assemble()
const rendered = renderPrompt(fixedAssembly)
record(
  'A. interpolate:false section renders quoted placeholders verbatim',
  rendered.includes('{{METABOT_SKILL_PIN}}') && rendered.includes('{{SKILL_ZIP_METAFILE}}'),
  rendered.includes(INCIDENT_PAYLOAD) ? 'full payload intact' : 'payload damaged',
)

// ---------- B: counter-case without the flag (the original bug) -------------

const bareApp = await bootApp([
  { name: 'idbots:base', order: 0, text: INCIDENT_PAYLOAD },
])
const bareAssembly = await bareApp.systemPrompt.assemble()
try {
  renderPrompt(bareAssembly)
  record('B. section without the flag throws the production error', false, 'renderPrompt did not throw')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  record(
    'B. section without the flag throws the production error',
    message.includes('malformed prompt variable reference')
      && message.includes('{{METABOT_SKILL_PIN}}')
      && message.includes('idbots:base'),
    message.slice(0, 90),
  )
}

// ---------- C: plugin passthrough shape --------------------------------------

const registered = []
const fakeCtx = { systemPrompt: { section: (s) => registered.push(s) } }
applySections(fakeCtx, {
  sections: [
    { name: 'idbots:base', order: 0, text: 'x', interpolate: false },
    { name: 'idbots:tool-use', order: 150, text: 'y' },
  ],
})
record(
  'C. plugin forwards interpolate:false and omits it when unset',
  registered.length === 2
    && registered[0].interpolate === false
    && !('interpolate' in registered[1]),
  `${registered.length} sections registered`,
)

// ---------- teardown ---------------------------------------------------------

// Best-effort shutdown (cordis Context teardown API varies by version); the
// recorded results above are already authoritative for the exit code.
for (const app of [fixedApp, bareApp]) {
  try { await app.stop?.() } catch { /* already settled */ }
}

const failed = results.filter((r) => !r.pass)
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} checks failed`)
  process.exit(1)
}
console.log(`\nAll ${results.length} checks passed (${path.basename(import.meta.filename)})`)
