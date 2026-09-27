// Unit test: JSON-safe truncation in idbots-tool-result-shaping (issue #50).
//
// Zero dependencies, no network, no runtime boot: the plugin is imported
// directly and driven through a fake ctx that captures the tools/post-execute
// waterfall handler, then every assertion inspects the returned decision.
//
// Run: node test/tool-result-shaping.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import { apply, MARKER_KEY, ENVELOPE_KEY } from '../plugins/idbots-tool-result-shaping.mjs'

const MARKER_TEXT = 'tool result trimmed'
const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const check = (name, fn) => {
  try {
    fn()
    record(name, true)
  } catch (error) {
    record(name, false, String(error?.message ?? error))
  }
}

// The documented legacy contract, written independently of the plugin: a single
// text block is replaced by head + marker + tail.
const legacyMarker = (original) => `\n[idbots: tool result trimmed, ${original} chars total — head+tail shown]\n`
const legacySingleBlock = (text, maxChars = 20000, tailChars = 4000) => {
  const budget = Math.min(text.length, maxChars)
  const keepTail = Math.min(tailChars, Math.floor(budget / 4))
  return text.slice(0, budget - keepTail) + legacyMarker(text.length) + text.slice(-keepTail)
}

const harness = (config = {}) => {
  const handlers = []
  apply({ on: (event, handler, options) => handlers.push({ event, handler, options }) }, config)
  const entry = handlers.find((h) => h.event === 'tools/post-execute')
  assert.ok(entry, 'tools/post-execute handler registered')
  assert.equal(entry.options?.global, true, 'handler registered globally')
  return {
    run: (content, { isError = false, decision = { kind: 'accept' }, name = 'probe_tool' } = {}) =>
      entry.handler({ name }, { content, isError }, async () => decision),
  }
}

const textOf = (decision) => decision?.content?.[0]?.text
const parseOf = (decision) => JSON.parse(textOf(decision))
const parseOk = (text) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const blob = 'x'.repeat(60000)
const objectPayload = JSON.stringify({ head: 'BIG-BLOB-START', blob, tail: 'BIG-BLOB-END', note: '' })
const workers = (count, pad = 200) => Array.from({ length: count }, (_, i) => ({ index: i, name: `worker-${i}`, meta: 'm'.repeat(pad) }))
const listPayload = JSON.stringify(workers(200))
const numbers = Array.from({ length: 30000 }, (_, i) => i)
const sized = (chars) => JSON.stringify({ pad: 'y'.repeat(chars - JSON.stringify({ pad: '' }).length) })

const main = async () => {
  const shaper = harness()

  // ---- JSON path: root object with one oversized string member ------------
  const shapedObject = await shaper.run([{ type: 'text', text: objectPayload }])
  const objectText = textOf(shapedObject)
  const objectJson = parseOf(shapedObject)
  record('JSON source chars', true, `${objectPayload.length} chars`)

  check('root object: shaped text still parses as JSON', () => assert.equal(parseOk(objectText), true))
  check('root object: shaped text is inside the budget including the marker', () => assert.ok(objectText.length <= 20000, `${objectText.length} chars`))
  check('root object: marker is a top-level sibling and tool keys are untouched', () => {
    assert.equal(objectJson[MARKER_KEY]?.truncated, true)
    assert.equal(objectJson.head, 'BIG-BLOB-START')
    assert.equal(objectJson.tail, 'BIG-BLOB-END')
    assert.equal(objectJson.note, '')
    assert.deepEqual(Object.keys(objectJson), ['head', 'blob', 'tail', 'note', MARKER_KEY])
  })
  check('root object: marker names the trimmed path and its units', () => {
    const marker = objectJson[MARKER_KEY]
    assert.equal(marker.kind, 'string')
    assert.equal(marker.path, '$.blob')
    assert.equal(marker.total, 60000)
    assert.ok(marker.returned > 0 && marker.returned < 60000, `returned ${marker.returned}`)
    assert.equal(marker.originalChars, objectPayload.length)
    assert.ok(marker.note.includes(MARKER_TEXT), `note: ${marker.note}`)
    assert.deepEqual(marker.trims, [{ path: '$.blob', kind: 'string', returned: marker.returned, total: 60000 }])
  })
  check('root object: the shortened member is an exact prefix of the source', () => {
    assert.equal(blob.startsWith(objectJson.blob), true)
    assert.equal(objectJson.blob.length, objectJson[MARKER_KEY].returned)
  })

  // ---- JSON path: root array (envelope + sibling marker) ------------------
  const shapedList = await shaper.run([{ type: 'text', text: listPayload }])
  const listText = textOf(shapedList)
  const listJson = parseOf(shapedList)
  const keptElements = listJson[ENVELOPE_KEY]
  check('root array: payload rides the envelope and the marker is its sibling', () => {
    assert.ok(Array.isArray(keptElements), `${typeof keptElements}`)
    assert.equal(listJson[MARKER_KEY].kind, 'array')
    assert.equal(listJson[MARKER_KEY].path, '$')
    assert.equal(listJson[MARKER_KEY].total, 200)
    assert.equal(listJson[MARKER_KEY].returned, keptElements.length)
    assert.ok(parseOk(listText))
    assert.ok(listText.length <= 20000, `${listText.length} chars`)
  })
  check('root array: only whole elements are dropped, kept part = source prefix', () => {
    assert.ok(keptElements.length > 0 && keptElements.length < 200, `kept ${keptElements.length}/200`)
    assert.deepEqual(keptElements, workers(200).slice(0, keptElements.length))
  })
  check('root array: array-of-array element shapes are never half an element', () => {
    for (const element of keptElements) {
      assert.deepEqual(Object.keys(element), ['index', 'name', 'meta'])
      assert.equal(typeof element.meta, 'string')
      assert.equal(element.meta.length, 200)
    }
  })

  // ---- JSON path: nested array keeps dot/bracket path ---------------------
  const nestedPayload = JSON.stringify({ page: 1, data: { items: workers(200) }, ok: true })
  const shapedNested = await shaper.run([{ type: 'text', text: nestedPayload }])
  const nestedJson = parseOf(shapedNested)
  check('nested array: path is dot form, neighbours survive, prefix deep-equal', () => {
    assert.equal(nestedJson.page, 1)
    assert.equal(nestedJson.ok, true)
    assert.equal(nestedJson[MARKER_KEY].kind, 'array')
    assert.equal(nestedJson[MARKER_KEY].path, '$.data.items')
    const kept = nestedJson.data.items
    assert.ok(kept.length > 0 && kept.length < 200, `kept ${kept.length}/200`)
    assert.deepEqual(kept, workers(200).slice(0, kept.length))
    assert.ok(textOf(shapedNested).length <= 20000)
  })

  // ---- JSON path: bare numeric root array ---------------------------------
  const shapedNumbers = await shaper.run([{ type: 'text', text: JSON.stringify(numbers) }])
  const numbersJson = parseOf(shapedNumbers)
  check('bare root array: whole-element prefix, deep-equal', () => {
    const kept = numbersJson[ENVELOPE_KEY]
    assert.ok(kept.length > 0 && kept.length < numbers.length, `kept ${kept.length}/${numbers.length}`)
    assert.deepEqual(kept, numbers.slice(0, kept.length))
    assert.equal(numbersJson[MARKER_KEY].returned, kept.length)
    assert.equal(numbersJson[MARKER_KEY].total, numbers.length)
  })

  // ---- JSON path: a JSON string document ---------------------------------
  const stringDoc = 'z'.repeat(60000)
  const shapedString = await shaper.run([{ type: 'text', text: JSON.stringify(stringDoc) }])
  const stringJson = parseOf(shapedString)
  check('JSON string document: envelope carries the char prefix, marker sibling', () => {
    assert.equal(typeof stringJson[ENVELOPE_KEY], 'string')
    assert.equal(stringDoc.startsWith(stringJson[ENVELOPE_KEY]), true)
    assert.equal(stringJson[MARKER_KEY].kind, 'string')
    assert.equal(stringJson[MARKER_KEY].path, '$')
    assert.equal(stringJson[MARKER_KEY].total, stringDoc.length)
    assert.ok(textOf(shapedString).length <= 20000)
  })

  // ---- JSON path: a single oversized array member -------------------------
  const oneMember = 'q'.repeat(60000)
  const shapedMember = await shaper.run([{ type: 'text', text: JSON.stringify([oneMember]) }])
  const memberJson = parseOf(shapedMember)
  check('single oversized member: no element is drained, the member string is shortened', () => {
    assert.equal(memberJson[ENVELOPE_KEY].length, 1)
    assert.equal(memberJson[MARKER_KEY].kind, 'string')
    assert.equal(memberJson[MARKER_KEY].path, '$[0]')
    assert.equal(oneMember.startsWith(memberJson[ENVELOPE_KEY][0]), true)
    assert.ok(textOf(shapedMember).length <= 20000)
  })

  // ---- JSON path: several oversized nodes (composed trims) ----------------
  const twoHuge = JSON.stringify([{ blob: 'a'.repeat(60000) }, { blob: 'b'.repeat(60000) }])
  const shapedTwo = await shaper.run([{ type: 'text', text: twoHuge }])
  const twoJson = parseOf(shapedTwo)
  check('several oversized nodes: trims compose and the document still parses', () => {
    assert.ok(textOf(shapedTwo).length <= 20000, `${textOf(shapedTwo).length} chars`)
    const marker = twoJson[MARKER_KEY]
    assert.equal(marker.path, '$')
    assert.equal(marker.kind, 'array')
    assert.equal(marker.total, 2)
    assert.ok(marker.returned >= 1 && marker.returned < 2, `returned ${marker.returned}`)
    assert.ok(marker.trims.length >= 1)
    const kept = twoJson[ENVELOPE_KEY]
    assert.ok(kept.length >= 1 && kept.length <= 2)
    // kept elements are whole source elements (a member may carry its own trim)
    assert.deepEqual(Object.keys(kept[0]), ['blob'])
    assert.equal('a'.repeat(60000).startsWith(kept[0].blob), true)
  })

  // ---- markers never collide with the tool's own keys ---------------------
  const ownedKey = JSON.stringify({ [MARKER_KEY]: 'tool-owned', blob })
  const shapedOwned = await shaper.run([{ type: 'text', text: ownedKey }])
  check('namespaced-key collision: legacy path instead of overwriting the tool key', () => {
    assert.equal(textOf(shapedOwned), legacySingleBlock(ownedKey))
    assert.ok(textOf(shapedOwned).includes(MARKER_TEXT))
  })

  const ownTruncated = JSON.stringify({ truncated: false, blob })
  const ownTruncatedJson = parseOf(await shaper.run([{ type: 'text', text: ownTruncated }]))
  check('a tool key literally named "truncated" survives at the root', () => {
    assert.equal(ownTruncatedJson.truncated, false)
    assert.equal(ownTruncatedJson[MARKER_KEY].truncated, true)
  })

  // ---- legacy path, byte for byte ----------------------------------------
  const plain = 'A'.repeat(30000)
  const shapedPlain = await shaper.run([{ type: 'text', text: plain }])
  check('non-JSON text: legacy head+tail, byte for byte', () => {
    assert.equal(textOf(shapedPlain), legacySingleBlock(plain))
    assert.equal(parseOk(textOf(shapedPlain)), false)
  })

  const trailingGarbage = objectPayload + '\n(trailing log line)'
  const shapedGarbage = await shaper.run([{ type: 'text', text: trailingGarbage }])
  check('text that only nearly parses: legacy head+tail, byte for byte', () => {
    assert.equal(textOf(shapedGarbage), legacySingleBlock(trailingGarbage))
  })

  const shapedTwoBlocks = await shaper.run([{ type: 'text', text: objectPayload }, { type: 'text', text: 'TAIL-BLOCK' }])
  check('two text blocks: legacy path, a JSON document is never split across blocks', () => {
    assert.equal(shapedTwoBlocks.content.length, 1)
    assert.equal(shapedTwoBlocks.content[0].text, objectPayload.slice(0, 20000) + legacyMarker(objectPayload.length))
    assert.equal(parseOk(shapedTwoBlocks.content[0].text), false)
  })

  // ---- untouched decision shapes -----------------------------------------
  const atBudget = sized(20000)
  const decisionAtBudget = { kind: 'accept' }
  const resultAtBudget = await shaper.run([{ type: 'text', text: atBudget }], { decision: decisionAtBudget })
  check('exactly at budget: decision untouched (identity)', () => {
    assert.equal(atBudget.length, 20000)
    assert.equal(resultAtBudget, decisionAtBudget)
  })

  const overBudget = sized(20001)
  const resultOverBudget = await shaper.run([{ type: 'text', text: overBudget }])
  check('budget + 1: shaping engages and stays inside the budget', () => {
    assert.equal(overBudget.length, 20001)
    assert.ok(textOf(resultOverBudget).length <= 20000, `${textOf(resultOverBudget).length} chars`)
    assert.equal(parseOk(textOf(resultOverBudget)), true)
  })

  const decisionError = { kind: 'accept' }
  const resultError = await shaper.run([{ type: 'text', text: objectPayload }], { isError: true, decision: decisionError })
  check('error result: passed through verbatim (identity)', () => assert.equal(resultError, decisionError))

  const decisionReplace = { kind: 'replace', content: [{ type: 'text', text: 'downstream owns it' }] }
  const resultReplace = await shaper.run([{ type: 'text', text: objectPayload }], { decision: decisionReplace })
  check('non-accept decision: untouched (identity)', () => assert.equal(resultReplace, decisionReplace))

  const decisionContent = { kind: 'accept', content: [{ type: 'text', text: 'already shaped' }] }
  const resultContent = await shaper.run([{ type: 'text', text: objectPayload }], { decision: decisionContent })
  check('accept decision that already carries content: untouched (identity)', () => assert.equal(resultContent, decisionContent))

  const decisionContexts = { kind: 'accept', additionalContexts: [{ type: 'text', text: 'ctx' }] }
  const resultContexts = await shaper.run([{ type: 'text', text: objectPayload }], { decision: decisionContexts })
  check('JSON-safe accept keeps additionalContexts', () => {
    assert.deepEqual(resultContexts.additionalContexts, decisionContexts.additionalContexts)
    assert.equal(resultContexts.kind, 'accept')
  })

  // ---- whitespace-only overflow ------------------------------------------
  const tight = harness({ maxChars: 800, tailChars: 200 })
  let prettyDoc = null
  for (let pad = 1; pad <= 40 && prettyDoc === null; pad++) {
    const raw = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ i, label: 'l'.repeat(pad) })) }, null, 2)
    if (raw.length > 800 && JSON.stringify(JSON.parse(raw)).length <= 800) prettyDoc = raw
  }
  check('found a pretty-printed document that only overflows on whitespace', () => assert.ok(prettyDoc, 'fixture not found'))
  const shapedPretty = await tight.run([{ type: 'text', text: prettyDoc }])
  check('whitespace-only overflow: compacted, nothing lost, no marker', () => {
    const out = textOf(shapedPretty)
    assert.ok(out.length <= 800, `${out.length} chars`)
    assert.deepEqual(JSON.parse(out), JSON.parse(prettyDoc))
    assert.equal(Object.keys(JSON.parse(out)).includes(MARKER_KEY), false)
  })

  const tightPayload = JSON.stringify({ items: workers(50) })
  const shapedTight = await tight.run([{ type: 'text', text: tightPayload }])
  check('configured budget (800) is honoured by the JSON path', () => {
    assert.ok(textOf(shapedTight).length <= 800, `${textOf(shapedTight).length} chars`)
    assert.equal(parseOk(textOf(shapedTight)), true)
    assert.equal(parseOf(shapedTight)[MARKER_KEY].note.includes('budget 800 chars'), true)
  })

  check('default budget stays 20000 (unchanged defaults)', () => assert.ok(textOf(shapedObject).length <= 20000 && textOf(shapedObject).length > 19000))

  // ---- the plugin never mutates the source result ------------------------
  const sourceContent = [{ type: 'text', text: objectPayload }]
  await shaper.run(sourceContent)
  check('the source content blocks are left untouched', () => {
    assert.equal(sourceContent.length, 1)
    assert.equal(sourceContent[0].type, 'text')
    assert.equal(sourceContent[0].text, objectPayload)
  })

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[shaping-test] fatal:', error)
  process.exit(1)
})
