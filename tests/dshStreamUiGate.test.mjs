// DSH stream UI gate: throttle renderer updates, persist only on finalize,
// and keep live overlays so session switch still shows the current tokens.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)

function loadGate() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
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
    return require('../dist-electron/main/libs/dshStreamUiGate.js')
  } finally {
    Module._load = originalLoad
  }
}

function createClock() {
  let now = 1_000
  const queued = []
  return {
    now: () => now,
    schedule: (fn, delayMs) => {
      const item = { at: now + delayMs, fn, cancelled: false }
      queued.push(item)
      return () => {
        item.cancelled = true
      }
    },
    advance(ms) {
      now += ms
      for (const item of queued) {
        if (item.cancelled || item.at > now) continue
        item.cancelled = true
        item.fn()
      }
    },
  }
}

test('rapid DSH chunks emit at most once per throttle window and persist only on finalize', () => {
  const { DshStreamUiGate } = loadGate()
  const clock = createClock()
  const emitted = []
  const persisted = []
  const gate = new DshStreamUiGate({
    throttleMs: 90,
    emitUpdate: (sessionId, messageId, content, metadata) => emitted.push({ sessionId, messageId, content, metadata }),
    persistFinalize: (sessionId, messageId, content) => persisted.push({ sessionId, messageId, content }),
    clock,
  })

  gate.onUpdate('s1', 'm1', 'Hel')
  gate.onUpdate('s1', 'm1', 'Hell')
  gate.onUpdate('s1', 'm1', 'Hello')
  assert.equal(emitted.length, 1, 'leading emit once')
  assert.equal(emitted[0].content, 'Hel')
  assert.equal(persisted.length, 0, 'no persist during stream')

  clock.advance(90)
  assert.equal(emitted.length, 2, 'trailing flush after throttle')
  assert.equal(emitted[1].content, 'Hello')
  assert.equal(persisted.length, 0)

  gate.onFinalize('s1', 'm1', 'Hello world')
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].content, 'Hello world')
  assert.equal(emitted.at(-1).content, 'Hello world')
  assert.deepEqual(emitted.at(-1).metadata, { isStreaming: false, isFinal: true })
})

test('live overlays let session switch see unpersisted streaming content', () => {
  const { DshStreamUiGate } = loadGate()
  const emitted = []
  const gate = new DshStreamUiGate({
    throttleMs: 90,
    emitUpdate: (_s, _m, content) => emitted.push(content),
    persistFinalize: () => undefined,
  })

  gate.onUpdate('s1', 'm1', 'alpha')
  gate.onUpdate('s2', 'm2', 'other-session')
  const viewed = gate.applyOverlays({
    id: 's1',
    messages: [
      { id: 'm0', content: 'user', role: 'user' },
      { id: 'm1', content: '', role: 'assistant' },
    ],
  })
  assert.equal(viewed.messages[1].content, 'alpha')
  assert.equal(viewed.messages[0].role, 'user', 'extra fields preserved')
  assert.equal(viewed.messages[1].role, 'assistant')

  const other = gate.applyOverlays({
    id: 's2',
    messages: [{ id: 'm2', content: '' }],
  })
  assert.equal(other.messages[0].content, 'other-session')
})

test('clearSession drops overlays and cancels a pending trailing flush', () => {
  const { DshStreamUiGate } = loadGate()
  const clock = createClock()
  const emitted = []
  const gate = new DshStreamUiGate({
    throttleMs: 90,
    emitUpdate: (_s, _m, content) => emitted.push(content),
    persistFinalize: () => undefined,
    clock,
  })

  gate.onUpdate('s1', 'm1', 'a')
  gate.onUpdate('s1', 'm1', 'ab')
  assert.equal(emitted.length, 1)
  gate.clearSession('s1')
  clock.advance(90)
  assert.equal(emitted.length, 1, 'cancelled trailing flush does not emit')
  const viewed = gate.applyOverlays({ id: 's1', messages: [{ id: 'm1', content: '' }] })
  assert.equal(viewed.messages[0].content, '')
})
