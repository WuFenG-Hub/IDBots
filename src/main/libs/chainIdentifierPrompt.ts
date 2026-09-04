/**
 * Shared chain-identifier output rule, injected into every bot-facing system
 * prompt (cowork sessions via the prompt composer, group-task turns via
 * buildGroupTaskSystemPrompt).
 *
 * Why: bots habitually truncate pinids/txids when quoting them in reports and
 * chat ("4c42c177…ba49b" instead of all 66 characters). Host tooling and other
 * participants match these identifiers exactly — the deliverable ledger, the
 * [DEPENDS_ON] dependency gate, and on-chain verification all broke on
 * truncated pins in the wild (task #58: a 60-hex `metafile://` prefix armed a
 * false 15-minute dependency wait). The host now also tolerates prefixes, but
 * the correct output is the verbatim identifier.
 */

export const CHAIN_IDENTIFIER_VERBATIM_RULE = [
  '## Chain identifiers are load-bearing',
  '',
  'A pinid is EXACTLY 64 lowercase hex characters followed by `i0` (66 characters total); a txid is EXACTLY 64 lowercase hex characters. When you mention, quote, or report a pinid/txid — bare or inside `pin://`, `metafile://`, `metaapp://` URIs — copy it from the source VERBATIM. Never truncate it, never shorten it "for readability", never abbreviate the middle or tail with `…`, and never split it across lines. Shortening it inside a code block is still truncation.',
  'Host tooling and other participants match these identifiers exactly: a truncated pinid breaks deliverable matching, dependency waits, and on-chain verification. If you need to talk about an identifier in prose, you may add a short label like "(pin 44942d92)" AROUND the full value, but the full value itself must always appear intact wherever the identifier is the reference.',
].join('\n');
