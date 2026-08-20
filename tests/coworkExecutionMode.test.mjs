// Sandbox/auto execution modes are temporarily retired; every caller
// must resolve to local so leftover persisted values cannot boot the VM.
// Requires: npm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

function loadModule() {
  return require(path.join(here, '../dist-electron/main/libs/coworkExecutionMode.js'))
}

test('resolveCoworkExecutionMode always returns local', () => {
  const { resolveCoworkExecutionMode } = loadModule()
  assert.equal(resolveCoworkExecutionMode('sandbox'), 'local')
  assert.equal(resolveCoworkExecutionMode('auto'), 'local')
  assert.equal(resolveCoworkExecutionMode('container'), 'local')
  assert.equal(resolveCoworkExecutionMode('local'), 'local')
  assert.equal(resolveCoworkExecutionMode(undefined), 'local')
  assert.equal(resolveCoworkExecutionMode(null), 'local')
})
