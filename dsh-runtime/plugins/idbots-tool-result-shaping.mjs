// idbots-tool-result-shaping: bounds tool-result content at commit time.
//
// This replaces the OpenAICompatProxy's per-session tool_result trimming
// (tier-1 compression) for DSH sessions — with an architectural correction:
// DSH deep-freezes loop-built requests and forbids request-time rewrites (the
// request must stay a pure function of the session log), so shaping happens
// where the result is produced, on the tools/post-execute waterfall, before it
// is materialized into the durable log and derived history. The model-visible
// history stays bounded; the session log stays consistent with what the model
// saw.
//
// Policy: a successful result whose rendered text blocks exceed `maxChars`
// total is replaced with head + tail slices joined by an ellipsis marker that
// records the original length. Error results pass through untouched (deny
// reasons are short and must stay verbatim). Registered { global: true }:
// tools/post-execute dispatches through the agent's scope carrier (Phase 0 F5).

export const name = 'idbots-tool-result-shaping'
export const inject = ['tools']

const DEFAULT_MAX_CHARS = 20000
const DEFAULT_TAIL_CHARS = 4000
const MARKER = (original) => `\n[idbots: tool result trimmed, ${original} chars total — head+tail shown]\n`

const textLength = (content) => content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)

export function apply(ctx, config = {}) {
  const maxChars = Number.isFinite(config.maxChars) ? config.maxChars : DEFAULT_MAX_CHARS
  const tailChars = Number.isFinite(config.tailChars) ? config.tailChars : DEFAULT_TAIL_CHARS
  if (maxChars <= tailChars) {
    throw new Error(`idbots-tool-result-shaping: maxChars (${maxChars}) must exceed tailChars (${tailChars})`)
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // Shape only a plain accept: a downstream decision that already replaced
    // content or value owns the result, and errors must stay verbatim.
    if (decision?.kind !== 'accept' || decision.content !== undefined || decision.value !== undefined) return decision
    if (result.isError) return decision
    if (textLength(result.content ?? []) <= maxChars) return decision

    let remaining = maxChars
    const shaped = []
    for (let i = 0; i < result.content.length; i++) {
      const block = result.content[i]
      if (block.type !== 'text') {
        shaped.push(block)
        continue
      }
      const budget = Math.min(block.text.length, remaining)
      if (budget <= 0) break
      const keepTail = i === result.content.length - 1 ? Math.min(tailChars, Math.floor(budget / 4)) : 0
      const head = block.text.slice(0, budget - keepTail)
      const tail = keepTail > 0 ? block.text.slice(-keepTail) : ''
      shaped.push({ type: 'text', text: head + MARKER(block.text.length) + tail })
      remaining -= budget
    }
    console.error(`[idbots-tool-result-shaping] ${exec.name}: ${textLength(result.content)} chars -> ${textLength(shaped)}`)
    return {
      kind: 'accept',
      content: shaped,
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  }, { global: true })
}
