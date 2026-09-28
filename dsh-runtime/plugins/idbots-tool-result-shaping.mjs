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
//
// Spill cooperation (2026-09-28, cowork session 540635be): the spill-policy
// cap sits under this plugin's 20K, so an oversized result took the shaping
// trim FIRST and spill-policy then spilled the ALREADY-TRIMMED text into its
// "Full formatted result stored at:" file — the recovery channel silently
// held a head+tail paste, and a cowork chair that extracted code from it
// produced a corrupted file (the trim marker was found mid-file in the
// "full" spill). Now, when a spillStore service is mounted, shaping saves
// the FULL original through it BEFORE slicing and the marker carries the
// same locator + retrieval hint the spill notice uses; the shaped inline is
// then token-bounded to sit under the spill-policy cap (inlineTokenBudget
// mirrors the policy's maxInlineTokens via generate-runtime-config) so the
// policy never re-spills the trimmed copy and its "full result" promise
// stays true. Without a spillStore (no workspace composition) the legacy
// 20K behavior is kept byte-for-byte.

import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'

export const name = 'idbots-tool-result-shaping'
export const inject = ['tools']

const DEFAULT_MAX_CHARS = 20000
const DEFAULT_TAIL_CHARS = 4000
const DEFAULT_INLINE_TOKEN_BUDGET = 2048
// Headroom inside the inline token budget for framing and estimator drift —
// the shaped copy must price strictly under the spill-policy cap, or the
// policy re-spills the trimmed text as "Full formatted result" and the
// locator ends up pointing at the wrong (trimmed) copy.
const TOKEN_RESERVE = 128
const MARKER = (original) => `\n[idbots: tool result trimmed, ${original} chars total — head+tail shown]\n`
const SPILL_MARKER = (original, ref) =>
  `\n[idbots: tool result trimmed, ${original} chars total — head+tail shown; full original stored at: ${ref.locator}. ${ref.retrievalHint}]\n`

const textLength = (content) => content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
const tokenPrice = (content) => content.reduce((sum, block) => sum + (block.type === 'text' ? estimateContent([block]) : 0), 0)

/** Head+tail render with the original block walk: the char budget is
 *  front-loaded across blocks and the last block keeps a tail slice. */
function renderShaped(content, markerFor, totalChars, tailChars) {
  let remaining = totalChars
  const shaped = []
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (block.type !== 'text') {
      shaped.push(block)
      continue
    }
    const budget = Math.min(block.text.length, remaining)
    if (budget <= 0) break
    const keepTail = i === content.length - 1 ? Math.min(tailChars, Math.floor(budget / 4)) : 0
    const head = block.text.slice(0, budget - keepTail)
    const tail = keepTail > 0 ? block.text.slice(-keepTail) : ''
    shaped.push({ type: 'text', text: head + markerFor(block) + tail })
    remaining -= budget
  }
  return shaped
}

export function apply(ctx, config = {}) {
  const maxChars = Number.isFinite(config.maxChars) ? config.maxChars : DEFAULT_MAX_CHARS
  const tailChars = Number.isFinite(config.tailChars) ? config.tailChars : DEFAULT_TAIL_CHARS
  const inlineTokenBudget = Number.isFinite(config.inlineTokenBudget) && config.inlineTokenBudget > 0
    ? config.inlineTokenBudget
    : DEFAULT_INLINE_TOKEN_BUDGET
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

    // Recoverable trim: persist the FULL original before any slice drops it.
    // Best-effort — a spill failure degrades to the legacy trim instead of
    // failing an otherwise-successful tool result.
    let ref
    const spillStore = ctx.get('spillStore')
    const sessionId = exec.agent?.session?.header?.id
    if (spillStore !== undefined && sessionId !== undefined) {
      try {
        ref = await spillStore.saveText({
          owner: { sessionId },
          source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'shaping' },
          suggestedName: `${exec.name}.txt`,
          content: result.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
        })
      } catch (error) {
        console.error(`[idbots-tool-result-shaping] ${exec.name}: spill save failed (${String(error)}); trimming without a recovery path`)
      }
    }

    const markerFor = ref
      ? (block) => SPILL_MARKER(block.text.length, ref)
      : (block) => MARKER(block.text.length)
    let totalChars = maxChars
    let shaped = renderShaped(result.content, markerFor, totalChars, tailChars)
    if (ref) {
      // Shrink the copy until it prices under the spill-policy cap (minus
      // reserve) so the policy's under-cap early-return keeps our marker —
      // locator included — verbatim in history. The 500-char floor keeps the
      // loop finite; an estimator-pathological result may still overflow and
      // take the policy's re-bound, which bounds history either way.
      const budget = inlineTokenBudget - TOKEN_RESERVE
      while (tokenPrice(shaped) > budget && totalChars > 500) {
        totalChars = Math.floor(totalChars * 0.7)
        shaped = renderShaped(result.content, markerFor, totalChars, Math.min(tailChars, Math.floor(totalChars / 4)))
      }
    }

    console.error(`[idbots-tool-result-shaping] ${exec.name}: ${textLength(result.content)} chars -> ${textLength(shaped)}${ref ? ` (full original: ${ref.locator})` : ''}`)
    return {
      kind: 'accept',
      content: shaped,
      ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    }
  }, { global: true })
}
