// Surrogate-safe text truncation for LLM request bodies.
//
// 2026-08-24 user report: a Twin Worker bio longer than 200 UTF-16 units was
// capped by capText's `text.slice(0, 199)`, which split the 🌐 surrogate pair
// and stranded a lone high surrogate in the system prompt. JSON.stringify
// serialized it as a `\ud83c` hex escape and DeepSeek's strict parser
// rejected the whole request — "lone leading surrogate in hex escape",
// HTTP 400, surfaced to the user as a generic
// "DSH turn failed: DeepSeek API error (HTTP 400)".
//
// Covers the llmSafeText helpers, the Twin roster regression (roster
// block from an over-cap bio with an emoji at the cut), and the
// native-adapter route gate (a 'deepseek'-keyed provider on a custom proxy
// base URL must stay on the generic pi-ai route).
// Requires: npm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)

// eslint-disable-next-line no-misleading-character-class
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => process.cwd(),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      llmSafeText: require('../dist-electron/main/libs/llmSafeText.js'),
      twinWorkerDirectoryService: require('../dist-electron/main/services/twinWorkerDirectoryService.js'),
      coworkDshTurn: require('../dist-electron/main/libs/coworkDshTurn.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

test('truncateUtf16Units: plain cuts unchanged, surrogate pairs never split', () => {
  const { truncateUtf16Units } = loadModules().llmSafeText
  assert.equal(truncateUtf16Units('abcdef', 3), 'abc')
  assert.equal(truncateUtf16Units('abcdef', 10), 'abcdef')
  assert.equal(truncateUtf16Units('abcdef', 0), '')
  assert.equal(truncateUtf16Units('abcdef', -1), '')
  // Cut boundary INSIDE a pair: the pair is dropped whole, one unit shorter.
  const splitAtPair = 'a'.repeat(199) + '🌐' + 'b'.repeat(10)
  const cut = truncateUtf16Units(splitAtPair, 200)
  assert.equal(cut.length, 199)
  assert.equal(cut, 'a'.repeat(199))
  assert.equal(LONE_SURROGATE_RE.test(cut), false)
  // Cut boundary NOT inside a pair: exact length preserved.
  const pairFirst = '🌐' + 'a'.repeat(199)
  const cutPairFirst = truncateUtf16Units(pairFirst, 200)
  assert.equal(cutPairFirst.length, 200)
  assert.equal(cutPairFirst, '🌐' + 'a'.repeat(198))
})

test('truncateUtf16UnitsFromEnd: tail never starts on a stranded low surrogate', () => {
  const { truncateUtf16UnitsFromEnd } = loadModules().llmSafeText
  const text = 'a'.repeat(300) + '🌐' + 'b'
  // Naive text.slice(text.length - 2) starts on the pair's low half.
  const tail = truncateUtf16UnitsFromEnd(text, 2)
  assert.equal(tail, 'b')
  assert.equal(LONE_SURROGATE_RE.test(tail), false)
  // Boundary outside a pair: exact tail preserved.
  assert.equal(truncateUtf16UnitsFromEnd('abcdef', 3), 'def')
  assert.equal(truncateUtf16UnitsFromEnd('abcdef', 10), 'abcdef')
  assert.equal(truncateUtf16UnitsFromEnd('abcdef', 0), '')
})

test('stripLoneSurrogates: drops halves, keeps valid pairs and BMP', () => {
  const { stripLoneSurrogates } = loadModules().llmSafeText
  assert.equal(stripLoneSurrogates('a\uD83Cb'), 'ab')
  assert.equal(stripLoneSurrogates('\uDC00b'), 'b')
  assert.equal(stripLoneSurrogates('好🌐!'), '好🌐!')
  // High half at end of string, low half at start of string.
  assert.equal(stripLoneSurrogates('x\uD83C'), 'x')
  assert.equal(stripLoneSurrogates('\uDC00x'), 'x')
})

test('twin roster: an over-cap bio with an emoji at the cut carries no lone surrogate', () => {
  const { buildTwinLocalRosterBlock } = loadModules().twinWorkerDirectoryService
  // The reported shape: bio > 200 UTF-16 units with 🌐 straddling unit 199
  // (the pre-fix capText slice point). Documents the failure mode first.
  const bio = 'x'.repeat(198) + '🌐 worldwide automation hub ' + 'y'.repeat(80)
  assert.ok(bio.length > 200)
  const legacyCap = `${bio.slice(0, 199)}…`
  assert.equal(LONE_SURROGATE_RE.test(legacyCap), true)

  const directory = {
    requester: { sessionId: 's1', twinId: 1, ownerGlobalMetaId: 'id_owner' },
    workers: [{
      id: 913,
      name: 'Worker A',
      type: 'worker',
      enabled: true,
      globalMetaID: 'id_worker_a',
      ownerGlobalMetaId: 'id_owner',
      ownerBindingVerified: true,
      role: 'a'.repeat(198) + '🌐',
      bio,
      goal: 'g'.repeat(198) + '🌐',
      personaSummary: '',
      skills: ['web'],
      chatSkills: [],
      capabilityEvidence: [],
      availability: 'available',
      activeOrchestrationSteps: 0,
    }],
  }
  const roster = buildTwinLocalRosterBlock(directory)
  assert.ok(roster.includes('Worker A'))
  assert.equal(LONE_SURROGATE_RE.test(roster), false)
  // The wire form must be free of lone-surrogate hex escapes too.
  assert.equal(LONE_SURROGATE_RE.test(JSON.stringify(roster)), false)
})

test('isNativeDeepSeekChatRoute: only the official api.deepseek.com host rides the native adapter', () => {
  const { isNativeDeepSeekChatRoute } = loadModules().coworkDshTurn
  // Official host, chat-completions shape (dshApiRootOf keeps /v1) → native.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiFormat: 'openai' }), true)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai' }), true)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'responses' }), true)
  // Custom proxy base URL under the 'deepseek' key → generic pi-ai route.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://relay.example.com/v1', apiFormat: 'openai' }), false)
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'http://127.0.0.1:48795/v1', apiFormat: 'openai' }), false)
  // Anthropic-format official endpoint → pi-ai anthropic-messages.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic' }), false)
  // Another provider keyed on the official host is not the deepseek route.
  assert.equal(isNativeDeepSeekChatRoute({ provider: 'opencode', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai' }), false)
})
