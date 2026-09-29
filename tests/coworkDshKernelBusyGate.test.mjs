// Kernel-initiated turns (subagent-finished wakes, scheduled nudges) run with
// no host turn controller, so controller/activeSession-based busy checks are
// blind to them — a cross-session ORCH-NOTIFY drained mid-turn and sealed a
// still-streaming reply (2026-09-29 twinbot session df7d89d3). The gate fix
// tracks the runtime's session.status notifications per DSH session in
// DshKernel.busySessions and exposes them as DshTurnHub.isKernelSessionBusy;
// an idle edge releases the queued continuations via onSessionStatusChange.
//
// Requires: pnpm run compile:electron (loads dist-electron output). No real
// runtime is booted — the kernel is a fake isSessionBusy answer.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = Module.createRequire(import.meta.url)
const here = import.meta.dirname

function loadHub() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkDshTurn.js')
  } finally {
    Module._load = originalLoad
  }
}

test('isKernelSessionBusy resolves through the cowork mapping and scans live plus draining kernels', () => {
  const { DshTurnHub } = loadHub()
  const hub = new DshTurnHub({ sessionRoot: process.cwd() })
  hub.pinnedDshIds.set('cowork-1', 'dsh-1')
  const busy = new Set(['dsh-1'])
  const busyKernel = { isSessionBusy: (id) => busy.has(id) }
  hub.slots.set('slot-a', {
    kernel: { isSessionBusy: () => false },
    drainingKernels: [{ isSessionBusy: () => false }, busyKernel],
  })

  assert.equal(hub.isKernelSessionBusy('cowork-1'), true)
  busy.clear()
  assert.equal(hub.isKernelSessionBusy('cowork-1'), false)
  // No cowork→dsh mapping: nothing to be busy on.
  assert.equal(hub.isKernelSessionBusy('cowork-unknown'), false)
})

test('onStatus forwards owned session status transitions to onSessionStatusChange only', () => {
  const { DshTurnHub } = loadHub()
  const seen = []
  const hub = new DshTurnHub({
    sessionRoot: process.cwd(),
    onSessionStatusChange: (coworkId, status) => seen.push([coworkId, status]),
  })
  hub.pinnedDshIds.set('cowork-1', 'dsh-1')
  const handlers = hub.hubHandlers({ key: 'slot-a' }, () => null)

  handlers.onStatus('dsh-1', 'running')
  handlers.onStatus('dsh-1', 'idle')
  // Unmapped dsh session (e.g. a continuable child) must not leak onto a parent.
  handlers.onStatus('dsh-unmapped', 'running')

  assert.deepEqual(seen, [['cowork-1', 'running'], ['cowork-1', 'idle']])
})

test('dshKernel tracks session.status into a busy set cleared on restart and pump death (static wiring)', () => {
  const source = readFileSync(join(here, '..', 'src', 'main', 'libs', 'dshKernel', 'dshKernel.ts'), 'utf8')
  assert.ok(source.includes("method === 'session.status'"), 'kernel pump handles session.status')
  assert.ok(source.includes('this.busySessions.add(params.sessionId)'), 'running status marks the session busy')
  assert.ok(source.includes('this.busySessions.delete(params.sessionId)'), 'idle status clears the busy mark')
  assert.equal(
    source.split('this.busySessions.clear()').length - 1,
    2,
    'busy set is cleared on restart() AND on pump transport death',
  )
})

test('coworkRunner wires the kernel-busy gate into the drain and the shared busy guards (static wiring)', () => {
  const runnerSource = readFileSync(join(here, '..', 'src', 'main', 'libs', 'coworkRunner.ts'), 'utf8')
  assert.ok(
    runnerSource.includes('return this.dshTurnHub?.isKernelSessionBusy(sessionId) === true;'),
    'isCrossSessionTurnRunning / isSessionActive consult the kernel busy signal',
  )
  assert.ok(
    runnerSource.includes("if (status === 'idle') this.scheduleCrossSessionContinuationDrain(coworkSessionId);"),
    'a kernel idle edge releases queued cross-session continuations',
  )
})
