// Unit tests for the DSH plugin directory resolver and peer-linker: the pure
// halves of the install flow. The npm-spawn halves are thin wrappers around
// child_process and are covered by the runtime E2E (plugin-mount) for the
// composition contract.
//
// Requires: npm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const {
  resolveDshPluginEntries,
  linkDshPluginPeers,
  readDshPluginRegistry,
  dshPluginsDirFor,
} = require('../dist-electron/main/libs/dshPluginManager.js')

const makePackage = (pluginsDir, name, { main = 'lib/index.js', peers, withEntry = true, withManifest = true } = {}) => {
  const pkgDir = path.join(pluginsDir, 'node_modules', '@deepseek-ai', ...name.replace(/^@deepseek-ai\//, '').split('/'))
  fs.mkdirSync(pkgDir, { recursive: true })
  if (withManifest) {
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name,
      version: '1.2.3',
      main,
      ...(peers ? { peerDependencies: peers } : {}),
    }))
  }
  if (withEntry) {
    fs.mkdirSync(path.dirname(path.join(pkgDir, main)), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, main), 'export const name = "x"\n')
  }
  return pkgDir
}

const makeRuntimePeer = (runtimeNodeModules, peer) => {
  const dir = path.join(runtimeNodeModules, ...peer.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: peer, version: '0.1.0-rc.6' }))
  return dir
}

test('resolveDshPluginEntries returns entry-file entries for installed packages', () => {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpm-resolve-'))
  makePackage(pluginsDir, '@deepseek-ai/dsh-time-context')
  makePackage(pluginsDir, '@deepseek-ai/dsh-web', { main: 'lib/entry.mjs' })
  const entries = resolveDshPluginEntries(pluginsDir)
  assert.equal(entries.length, 2)
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]))
  assert.match(byId['plugin-dsh-time-context'].name, /dsh-time-context\/lib\/index\.js$/)
  assert.match(byId['plugin-dsh-web'].name, /dsh-web\/lib\/entry\.mjs$/)
  assert.deepEqual(entries.map((e) => e.config), [{}, {}])
  fs.rmSync(pluginsDir, { recursive: true, force: true })
})

test('resolveDshPluginEntries skips packages without manifest or entry file', () => {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpm-skip-'))
  makePackage(pluginsDir, '@deepseek-ai/broken-no-manifest', { withManifest: false })
  makePackage(pluginsDir, '@deepseek-ai/broken-no-entry', { withEntry: false })
  makePackage(pluginsDir, '@deepseek-ai/healthy')
  const entries = resolveDshPluginEntries(pluginsDir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'plugin-healthy')
  fs.rmSync(pluginsDir, { recursive: true, force: true })
})

test('resolveDshPluginEntries tolerates a missing plugin directory', () => {
  assert.deepEqual(resolveDshPluginEntries(path.join(os.tmpdir(), 'dshpm-does-not-exist')), [])
})

test('linkDshPluginPeers symlinks missing peers to the runtime copies', () => {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpm-link-'))
  const runtimeNodeModules = path.join(pluginsDir, 'runtime-node_modules')
  makePackage(pluginsDir, '@deepseek-ai/dsh-time-context', {
    peers: {
      '@deepseek-ai/cordis': '^4.0.1-rc.1',
      '@deepseek-ai/dsh-session': '^0.0.1-rc.1',
      '@deepseek-ai/dsh-missing-peer': '^1.0.0',
    },
  })
  const cordis = makeRuntimePeer(runtimeNodeModules, '@deepseek-ai/cordis')
  makeRuntimePeer(runtimeNodeModules, '@deepseek-ai/dsh-session')
  // A real dependency already occupying a slot must be preserved.
  const occupied = makePackage(pluginsDir, '@deepseek-ai/dsh-session', { peers: undefined })
  void occupied

  const linked = linkDshPluginPeers(pluginsDir, runtimeNodeModules)
  assert.ok(linked.includes('@deepseek-ai/cordis'), 'cordis linked')
  assert.ok(!linked.includes('@deepseek-ai/dsh-session'), 'occupied slot untouched')
  assert.ok(!linked.includes('@deepseek-ai/dsh-missing-peer'), 'peer missing from the runtime is skipped')
  assert.equal(fs.readlinkSync(path.join(pluginsDir, 'node_modules', '@deepseek-ai', 'cordis')), cordis)
  fs.rmSync(pluginsDir, { recursive: true, force: true })
})

test('readDshPluginRegistry survives a corrupt registry file', () => {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpm-registry-'))
  fs.writeFileSync(path.join(pluginsDir, 'registry.json'), '{not json')
  assert.deepEqual(readDshPluginRegistry(pluginsDir), { plugins: {} })
  fs.writeFileSync(path.join(pluginsDir, 'registry.json'), JSON.stringify({
    plugins: { '@deepseek-ai/dsh-web': { version: '0.0.1-rc.1', installedAt: 123 }, bogus: { nope: true } },
  }))
  const registry = readDshPluginRegistry(pluginsDir)
  assert.deepEqual(Object.keys(registry.plugins), ['@deepseek-ai/dsh-web'])
  assert.equal(registry.plugins['@deepseek-ai/dsh-web'].installedAt, 123)
  fs.rmSync(pluginsDir, { recursive: true, force: true })
})

test('dshPluginsDirFor points under userData', () => {
  assert.equal(dshPluginsDirFor('/tmp/userData'), path.join('/tmp/userData', 'dsh-plugins'))
})
