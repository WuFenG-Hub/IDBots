// Contract test: the host declares its IANA zone on every DSH prompt and in
// the runtime config, so dsh-time-context can resolve the request zone instead
// of reporting it unavailable (see dsh-runtime/test/time-context.test.mjs for
// the runtime half).
//
// Static assertions keep the plumbing from being dropped silently: the kernel
// prompt must send `clientTimeZone`, and the generator must mount the clock
// plugin whenever the host provides a zone.
//
// Run: node --test tests/dshClientTimeZone.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const { currentClientTimeZone } = await import(
  path.join(repoRoot, 'dist-electron', 'main', 'libs', 'dshKernel', 'clientTimeZone.js')
)

const test = (name, fn) => {
  try {
    fn()
    console.log(`✔ ${name}`)
  } catch (error) {
    console.error(`✖ ${name}`)
    throw error
  }
}

test('currentClientTimeZone returns a canonical IANA zone or undefined', () => {
  const zone = currentClientTimeZone()
  if (zone === undefined) return // a host without a resolvable zone is allowed
  assert.equal(typeof zone, 'string')
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  assert.equal(canonical, zone, 'the returned zone must be canonical — the kernel throws otherwise')
})

test('the kernel prompt declares clientTimeZone on the idbots/prompt request', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'libs', 'dshKernel', 'dshKernel.ts'), 'utf8')
  assert.match(source, /request\('idbots\/prompt'/, 'text prompts ride the zone-capable extension')
  assert.match(source, /clientTimeZone/, 'the request carries the client zone')
  assert.match(source, /from '\.\/clientTimeZone'/, 'the zone helper is the single source')
})

test('the runtime config carries the same zone for the clock plugin', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'libs', 'coworkDshTurn.ts'), 'utf8')
  assert.match(source, /timeContext:\s*\{\s*timeZone:\s*currentClientTimeZone\(\)\s*\}/, 'config input pins the clock zone')
})

test('the plugin validates the zone before forwarding it', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'dsh-runtime', 'plugins', 'idbots-sdk-server.mjs'), 'utf8')
  assert.match(source, /canonicalClientTimeZone/, 'the wire value is canonicalized')
  assert.match(source, /clientTimeZone: zone/, 'the user message source carries the zone')
  assert.match(source, /if \(zone === undefined\) return this\.prompt\(/, 'no zone keeps the stock prompt path')
})

console.log('dshClientTimeZone.test.mjs: all assertions passed')
