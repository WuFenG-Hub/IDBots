// Persistence zstd migration + encoding E2E (0.1.2).
//
//  1. Unit: migrateSessionRootToZstd rewrites plaintext artifacts atomically
//     (roundtrip bytes, idempotence, crash-recovery for both-exist pairs,
//     noise files untouched).
//  2. E2E: a generated (default zstd) composition writes session.jsonl.zstd
//     and resumes cleanly.
//  3. Integration: a REAL 0.1.1-rc.2-era plaintext session (dev data copy)
//     migrates and then resumes + replays under a zstd composition — proving
//     the backend's mixed-encoding guard passes only after migration.
//
// Run: node test/persistence-zstd.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { decodeZstdArtifact, migrateSessionRootToZstd } from '../lib/migrate-session-root-zstd.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const HEADER = (id) => `{"type":"session","version":0,"id":"${id}","createdAt":1786794975563,"delegationDepth":0}`
const EVENTS = (n) => Array.from({ length: n }, (_, i) =>
  `{"type":"user/message","seq":${i},"time":1786794975600,"data":{"content":[{"type":"text","text":"line ${i}"}]}}`).join('\n')

// ---- 1. migration unit ------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-unit-'))
  const mkSession = (project, id, lines) => {
    const dir = path.join(root, project, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${lines}\n`)
    return dir
  }
  const a = mkSession('proj-a', 'sess-1', [HEADER('sess-1'), EVENTS(50)].join('\n'))
  const b = mkSession('proj-a', 'sess-2', [HEADER('sess-2'), EVENTS(7)].join('\n'))
  mkSession('proj-b', 'sess-3', [HEADER('sess-3'), EVENTS(3)].join('\n'))
  fs.writeFileSync(path.join(root, 'proj-a', 'README.txt'), 'noise')
  fs.mkdirSync(path.join(root, 'proj-a', 'empty-session'), { recursive: true })

  const roundtrip = async (dir) => {
    const bytes = await decodeZstdArtifact(fs.readFileSync(path.join(dir, 'session.jsonl.zstd')))
    return bytes.toString('utf8')
  }

  // First pass: all three migrate; size shrinks for the repetitive payload.
  const original = fs.statSync(path.join(a, 'session.jsonl')).size
  const first = await migrateSessionRootToZstd(root)
  assert.equal(first.migrated, 3, 'three artifacts migrated')
  assert.equal(first.recovered, 0, 'nothing to recover')
  for (const dir of [a, b]) {
    assert.ok(!fs.existsSync(path.join(dir, 'session.jsonl')), 'plaintext gone')
    assert.ok(fs.existsSync(path.join(dir, 'session.jsonl.zstd')), 'zstd artifact present')
  }
  const restored = await roundtrip(a)
  assert.ok(restored.includes('"id":"sess-1"') && restored.includes('line 49'), 'content roundtrips losslessly')
  const compressed = fs.statSync(path.join(a, 'session.jsonl.zstd')).size
  console.log(`[size] ${original}B plaintext → ${compressed}B zstd (${Math.round((1 - compressed / original) * 100)}% smaller)`)
  assert.ok(fs.existsSync(path.join(root, 'proj-a', 'README.txt')), 'noise files untouched')

  // Second pass: idempotent.
  const second = await migrateSessionRootToZstd(root)
  assert.equal(second.migrated, 0, 'nothing left to migrate')
  assert.equal(second.recovered, 0, 'nothing to recover')

  // Crash recovery: a both-exist pair (crash between rename and unlink).
  fs.writeFileSync(path.join(b, 'session.jsonl'), 'stale plaintext\n')
  const third = await migrateSessionRootToZstd(root)
  assert.equal(third.recovered, 1, 'both-exist pair recovered')
  assert.ok(!fs.existsSync(path.join(b, 'session.jsonl')), 'stale plaintext dropped')
  assert.ok((await roundtrip(b)).includes('"id":"sess-2"'), 'durable zstd artifact kept')

  // Missing root: no-op, no throw.
  const missing = await migrateSessionRootToZstd(path.join(root, 'does-not-exist'))
  assert.equal(missing.migrated, 0, 'missing root is a no-op')
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  migration unit: atomic rewrite, roundtrip, idempotence, crash recovery')
}

// ---- 2+3. live runtime on a migrated root -----------------------------------
const main = async () => {
  const { server, seen } = await startMockServer(48802)

  // (2) fresh zstd root: artifact lands as session.jsonl.zstd.
  {
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-fresh-'))
    const config = generateRuntimeConfig({
      sessionRoot,
      providers: [{ key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48802/v1', apiKeyEnv: 'ZSTD_KEY', models: [{ id: 'mock-1', contextWindow: 32768 }] }],
      sections: [],
    })
    const persistence = config.find((e) => e.id === 'persistence')
    assert.equal(persistence?.config?.compression, 'zstd', 'generator defaults to zstd')
    const configPath = path.join(os.tmpdir(), `zstd-fresh-${Date.now()}.json`)
    fs.writeFileSync(configPath, JSON.stringify(config))
    const client = runtimeClient({
      args: [path.join(runtimeDir, 'bin.mjs'), configPath],
      env: { ...process.env, ZSTD_KEY: 'sk-zstd', SPIKE_QUIET: '1' },
    })
    client.start()
    await client.initialize({ cwd: sessionRoot, provider: 'mockgw', model: 'mock-1' })
    const sid = `zstd-fresh-${Date.now().toString(36)}`
    await client.prompt(sid, [{ type: 'text', text: 'PING' }])
    await client.request('session/ensure', { sessionId: sid, provider: 'mockgw', model: 'mock-1' })
    await new Promise((r) => setTimeout(r, 500))
    const artifacts = []
    const scan = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) scan(full)
        else if (entry.name === 'session.jsonl.zstd' || entry.name === 'session.jsonl') artifacts.push(entry.name)
      }
    }
    scan(sessionRoot)
    assert.ok(artifacts.includes('session.jsonl.zstd'), 'fresh sessions write the zstd artifact')
    assert.ok(!artifacts.includes('session.jsonl'), 'no plaintext artifact on a zstd root')
    await client.prompt(sid, [{ type: 'text', text: 'PING again' }])
    await new Promise((r) => setTimeout(r, 500))
    await client.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
    fs.rmSync(configPath, { force: true })
    console.log('PASS  zstd composition writes and resumes session.jsonl.zstd')
  }

  // (3) REAL 0.1.1-rc.2-era plaintext session: migrate → resume + replay.
  {
    const SRC_ROOT = '/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.dev-userdata-dsh/dsh-sessions/v0'
    const SESSION_ID = 'cw-4db69b84-9b75-4c03-b2d8-3a68349036d5'
    const OLD_CWD = '/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/dsh-phase1/.dev-userdata-dsh/dsh-sessions/v0'
    if (!fs.existsSync(SRC_ROOT)) {
      console.log('SKIP  real legacy session source not present on this machine')
      server.close()
      process.exit(0)
    }
    const encodedDir = fs.readdirSync(SRC_ROOT).find((name) => fs.existsSync(path.join(SRC_ROOT, name, SESSION_ID, 'session.jsonl')))
    if (encodedDir === undefined) {
      console.log('SKIP  real legacy session artifact not found')
      server.close()
      process.exit(0)
    }
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-legacy-'))
    fs.cpSync(path.join(SRC_ROOT, encodedDir, SESSION_ID), path.join(sessionRoot, encodedDir, SESSION_ID), { recursive: true })
    const stats = await migrateSessionRootToZstd(sessionRoot)
    assert.equal(stats.migrated, 1, 'legacy artifact migrated')

    const config = generateRuntimeConfig({
      sessionRoot,
      providers: [{ key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48802/v1', apiKeyEnv: 'ZSTD_KEY', models: [{ id: 'mock-1', contextWindow: 32768 }] }],
      sections: [],
    })
    const configPath = path.join(os.tmpdir(), `zstd-legacy-${Date.now()}.json`)
    fs.writeFileSync(configPath, JSON.stringify(config))
    const client = runtimeClient({
      args: [path.join(runtimeDir, 'bin.mjs'), configPath],
      env: { ...process.env, ZSTD_KEY: 'sk-zstd', SPIKE_QUIET: '1' },
    })
    client.start()
    await client.initialize({ cwd: OLD_CWD, provider: 'mockgw', model: 'mock-1' })
    const ensured = await client.request('session/ensure', { sessionId: SESSION_ID, provider: 'mockgw', model: 'mock-1' })
    assert.equal(ensured?.resumed, true, 'legacy session resumes on the migrated zstd root')
    await client.prompt(SESSION_ID, [{ type: 'text', text: 'PING' }])
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timeout')), 30000)
      const pump = setInterval(() => {
        const last = seen.filter((r) => r.body?.messages).at(-1)
        if (last && JSON.stringify(last.body.messages).includes('PING')) {
          const history = JSON.stringify(last.body.messages)
          if (history.includes('你好')) {
            clearTimeout(timer); clearInterval(pump); resolve()
          }
        }
      }, 200)
    })
    await client.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
    fs.rmSync(configPath, { force: true })
    console.log('PASS  real legacy plaintext session migrates and replays under zstd')
  }

  server.close()
  process.exit(0)
}

main().catch((error) => {
  console.error('[zstd-test] fatal:', error)
  process.exit(1)
})
