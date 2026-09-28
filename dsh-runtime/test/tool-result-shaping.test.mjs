// Unit tests: idbots-tool-result-shaping spill cooperation (2026-09-28,
// cowork session 540635be). The recovery channel must hold the FULL
// original — never the shaped copy — and the shaped inline must price
// strictly under the spill-policy cap so the policy's "Full formatted
// result stored at:" notice can never describe a trimmed paste again.
//
// Run: node test/tool-result-shaping.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import { apply } from '../plugins/idbots-tool-result-shaping.mjs'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'

const OVER_CAP = 'HEAD-MARK ' + 'x'.repeat(40000) + ' TAIL-MARK'
const tokenPrice = (blocks) => blocks.reduce((sum, block) => sum + (block.type === 'text' ? estimateContent([block]) : 0), 0)
const textOf = (content) => content.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block))).join('')

function harness({ spillStore, config = {} } = {}) {
  const handlers = {}
  const ctx = {
    on: (event, handler) => { handlers[event] = handler },
    get: (service) => (service === 'spillStore' ? spillStore : undefined),
  }
  apply(ctx, config)
  const exec = { name: 'big_tool', callId: 'call-1', agent: { session: { header: { id: 'session-1' } } } }
  const run = (content) => handlers['tools/post-execute'](
    exec,
    { isError: false, content },
    async () => ({ kind: 'accept' }),
  )
  return { run }
}

const saved = []
const store = {
  async saveText(input) {
    const ref = {
      locator: `/tmp/spill/session-1/big_tool-${saved.length + 1}.txt`,
      bytes: input.content.length,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
    saved.push({ ...input, ref })
    return ref
  },
}

const main = async () => {
  // 1. Oversize result with a spill store: the FULL original is saved, the
  //    marker carries its locator, and the shaped inline prices strictly
  //    under the spill-policy cap (no re-spill of the trimmed copy).
  {
    const decision = await harness({ spillStore: store }).run([{ type: 'text', text: OVER_CAP }])
    assert.equal(saved.length, 1, 'exactly one spill save')
    assert.equal(saved[0].content, OVER_CAP, 'spill file received the FULL original')
    assert.equal(saved[0].owner.sessionId, 'session-1', 'spill saved under the session owner')
    const text = textOf(decision.content)
    assert.ok(text.includes('tool result trimmed'), 'marker present')
    assert.ok(text.includes(`full original stored at: ${saved[0].ref.locator}`), 'marker carries the locator')
    assert.ok(text.includes('HEAD-MARK') && text.includes('TAIL-MARK'), 'head and tail survive')
    assert.ok(tokenPrice(decision.content) <= 2048 - 128, `shaped copy prices under the policy cap (${tokenPrice(decision.content)} tokens)`)
  }

  // 2. saveText failure degrades to the legacy trim (bounded, no locator).
  {
    const failing = { async saveText() { throw new Error('disk full') } }
    const decision = await harness({ spillStore: failing }).run([{ type: 'text', text: OVER_CAP }])
    const text = textOf(decision.content)
    assert.ok(text.includes('tool result trimmed'), 'legacy marker present')
    assert.ok(!text.includes('full original stored at:'), 'no locator promised on spill failure')
    assert.ok(text.length < 21000, `legacy trim bounds history (${text.length} chars)`)
  }

  // 3. No spill store mounted: byte-for-byte legacy behavior.
  {
    const decision = await harness().run([{ type: 'text', text: OVER_CAP }])
    const text = textOf(decision.content)
    assert.ok(text.includes('[idbots: tool result trimmed, 40020 chars total — head+tail shown]'), 'legacy marker verbatim')
    assert.equal(saved.length, 1, 'no extra spill saves')
  }

  // 4. Under-cap results pass through untouched.
  {
    const decision = await harness({ spillStore: store }).run([{ type: 'text', text: 'small result' }])
    assert.equal(decision.content, undefined, 'plain accept returned unshaped')
  }

  // 5. Multi-block results: the original is saved whole; the inline keeps the
  //    front-loaded head and the locator covers whatever the budget dropped.
  {
    const blocks = [
      { type: 'text', text: 'A-HEAD ' + 'a'.repeat(15000) },
      { type: 'text', text: 'B-HEAD ' + 'b'.repeat(15000) },
    ]
    const decision = await harness({ spillStore: store }).run(blocks)
    assert.equal(saved.at(-1).content, blocks.map((block) => block.text).join(''), 'multi-block original saved whole')
    const text = textOf(decision.content)
    assert.ok(text.includes('A-HEAD'), 'head budget front-loaded across blocks')
    assert.ok(text.includes('full original stored at:'), 'locator present for everything the budget dropped')
    assert.ok(tokenPrice(decision.content) <= 2048 - 128, `multi-block copy prices under the policy cap (${tokenPrice(decision.content)} tokens)`)
  }

  console.log('tool-result-shaping.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
