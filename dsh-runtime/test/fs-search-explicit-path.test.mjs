// Regression test: grep with an explicit `path` must not be silently pruned
// by gitignore rules (BL-01: parent-dir + include=*.html returned
// "No matches found" while the files existed — .gitignore:322 METAAPPs/*).
//
// Run from dsh-runtime/ with dependencies installed:
//   node test/fs-search-explicit-path.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { parseGrepArgs, buildGrepCommand, resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'

// Mirrors the production spawn shape in runRipgrep: stdin "ignore" (rg then
// searches the cwd for ambient calls instead of waiting on a pipe forever).
const run = async (rg, argv, cwd) => new Promise((resolve, reject) => {
  const child = spawn(rg, ['--no-config', ...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.on('close', () => resolve(stdout))
  child.on('error', reject)
})

const main = async () => {
  const rg = await resolveRgPath()

  // Fixture: tmp tree whose build/ subdir is gitignored, needle inside.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fssearch-repro-'))
  fs.mkdirSync(path.join(root, 'build'))
  execSync('git init -q', { cwd: root })  // rg only honors .gitignore inside a real repo
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/*\n')
  fs.writeFileSync(path.join(root, 'build', 'a.html'), 'xx NEEDLE_BL01 yy\n')

  // 1) The contract: an explicitly named search target is actually searched.
  const input = parseGrepArgs({ pattern: 'NEEDLE_BL01', path: path.join(root, 'build'), include: '*.html' })
  const argv = buildGrepCommand(input)
  assert.ok(argv.includes('--no-ignore'), 'explicit path must add --no-ignore')
  const out = await run(rg, argv, root)
  assert.ok(out.includes('NEEDLE_BL01'), `explicit path must find the needle, got: ${out.slice(0, 200)}`)

  // 2) Ambient scan (no path) keeps ignore semantics — the ignore rule holds.
  const ambientArgv = buildGrepCommand(parseGrepArgs({ pattern: 'NEEDLE_BL01' }))
  assert.ok(!ambientArgv.includes('--no-ignore'), 'ambient scan must NOT add --no-ignore')
  const ambientOut = await run(rg, ambientArgv, root)
  assert.ok(!ambientOut.includes('NEEDLE_BL01'), 'gitignored tree stays pruned for ambient scans')

  console.log('fs-search-explicit-path: 2/2 PASS (explicit path searched, ambient scan still ignores)')
}

main().catch(error => { console.error(error); process.exit(1) })
