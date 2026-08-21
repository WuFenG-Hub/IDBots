import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveWin32BashProgram, withWin32SpawnOptions } from '../lib/win32-spawn-shim.mjs'

test('withWin32SpawnOptions always sets windowsHide', () => {
  assert.equal(withWin32SpawnOptions(undefined).windowsHide, true)
  assert.equal(withWin32SpawnOptions({ cwd: '/tmp', windowsHide: false }).windowsHide, true)
  assert.equal(withWin32SpawnOptions({ cwd: '/tmp' }).cwd, '/tmp')
})

test('resolveWin32BashProgram rewrites bare bash when the env path exists', () => {
  assert.equal(resolveWin32BashProgram('python', {}), 'python')
  assert.equal(resolveWin32BashProgram('bash', {}), 'bash')
  const missing = path.join(os.tmpdir(), 'idbots-missing-bash.exe')
  assert.equal(resolveWin32BashProgram('bash', { CLAUDE_CODE_GIT_BASH_PATH: missing }), 'bash')
  const existing = existsSync('/bin/bash') ? '/bin/bash' : process.execPath
  assert.equal(
    resolveWin32BashProgram('bash', { CLAUDE_CODE_GIT_BASH_PATH: existing }),
    existing,
  )
  assert.equal(
    resolveWin32BashProgram('bash.exe', { IDBOTS_BASH_PATH: existing }),
    existing,
  )
})
