// Subprocess OutputCollector spill resilience (kernel patch regression test).
//
// Incident (2026-09-24): an external tmp cleanup removed the runtime's private
// `dsh-subprocess-*` spill directory while the shared DSH runtime process was
// serving turns. The next overflowing bash stdout hit `openSync(..., "wx")`
// ENOENT inside the socket data handler; the uncaught throw killed the whole
// runtime process and cascaded "DSH runtime is not running" into every active
// conversation for minutes.
//
// The kernel patch (`scripts/dsh-kernel-patches/@deepseek-ai+dsh-subprocess-local+<version>.patch`)
// makes the collector (1) self-heal once by recreating the vanished directory
// and (2) degrade to the in-memory tail (spill disabled, "(unavailable)"
// recovery path) when the spill target stays unavailable — a missing directory
// must never take down the host process.
//
// Run: node test/subprocess-spill-resilience.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

// The bundle file name carries a content hash that changes per kernel
// version — resolve it instead of hardcoding COYGu0Dl-style names.
const runnerLaunchDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib')
const runnerLaunchFile = readdirSync(runnerLaunchDir).find((name) => /^runner-launch-.*\.js$/.test(name))
assert.ok(runnerLaunchFile, 'runner-launch bundle found under dsh-subprocess-local/lib')
// The bundle minifies export names (`spawnSubprocess` is exported as `E`).
const { E: spawnSubprocess } = await import(pathToFileURL(path.join(runnerLaunchDir, runnerLaunchFile)).href)

const TAIL_CAP = 4096
const SPILL_CAP = 1 << 20

const spawnCollector = (spillDir, script) => spawnSubprocess({
  argv: [process.execPath, '-e', script],
  cwd: os.tmpdir(),
  env: { PATH: process.env.PATH },
  graceMs: 5000,
  stdio: {
    stdin: 'ignore',
    stdout: { maxBytes: TAIL_CAP, spill: { maxBytes: SPILL_CAP } },
    stderr: 'inherit',
  },
}, { spillDir })

const main = async () => {
  // ---- Case 1: the exact incident — spill dir deleted between binding and
  // the first overflowing chunk. Pre-patch this crashes the process with an
  // uncaught ENOENT; post-patch the collector recreates the directory and
  // the full output stays recoverable from the spill file.
  {
    const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spill-resilience-'))
    const marker = 'HEAD-BURST\n'
    const burst = 'x'.repeat(TAIL_CAP * 8)
    const script = `
      process.stdout.write(${JSON.stringify(marker)});
      setTimeout(() => process.stdout.write(${JSON.stringify(burst)}), 500);
    `
    const handle = spawnCollector(spillDir, script)
    // The first burst stays under the in-memory cap, so the spill file is
    // opened only when the second burst arrives — after this deletion.
    await new Promise((resolve) => setTimeout(resolve, 200))
    fs.rmSync(spillDir, { recursive: true, force: true })

    const outcome = await handle.done
    assert.equal(outcome.exitCode, 0, 'child exits cleanly after mid-stream spill-dir deletion')
    const collected = handle.collected.stdout.finalize()
    assert.ok(collected.spillPath, 'healed spill file is advertised')
    assert.ok(fs.existsSync(collected.spillPath), 'healed spill file exists on disk')
    const spilled = fs.readFileSync(collected.spillPath, 'utf8')
    assert.ok(spilled.startsWith(marker), 'spill file covers the stream head')
    assert.equal(spilled.length, marker.length + burst.length, 'spill file holds the complete output')
  }

  // ---- Case 2: spill dir cannot be recreated (parent is a regular file) —
  // the collector degrades to the in-memory tail instead of throwing. This
  // exercises the pre-patch crash path (ENOENT inside the socket data
  // handler): reaching the assertions at all proves the process survived.
  {
    const blockedParent = path.join(os.tmpdir(), `spill-resilience-blocked-${Date.now()}`)
    fs.writeFileSync(blockedParent, 'not a directory')
    const spillDir = path.join(blockedParent, 'spill')
    const burst = 'y'.repeat(TAIL_CAP * 4)
    const handle = spawnCollector(spillDir, `process.stdout.write(${JSON.stringify(burst)})`)

    const outcome = await handle.done
    assert.equal(outcome.exitCode, 0, 'child exits cleanly when spilling is unavailable')
    const collected = handle.collected.stdout.finalize()
    assert.equal(collected.spillPath, undefined, 'degraded collector advertises no spill path')
    assert.equal(collected.truncated, true, 'degraded collector reports truncation')
    assert.ok(collected.text.length <= TAIL_CAP, `degraded collector keeps the bounded tail (${collected.text.length} chars)`)
    fs.rmSync(blockedParent, { force: true })
  }

  console.log('subprocess-spill-resilience.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
