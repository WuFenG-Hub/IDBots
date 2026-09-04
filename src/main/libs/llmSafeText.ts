// Surrogate-safe text handling for anything that ends up in an LLM request
// body. JSON.stringify serializes an unpaired UTF-16 surrogate as a lone
// `\ud83c`-style hex escape; strict server-side JSON parsers reject the whole
// body at parse time (DeepSeek's serde_json: "lone leading surrogate in hex
// escape") and answer HTTP 400 with a non-`{"error":{...}}` body, which the
// adapter surfaces as the generic "DeepSeek API error (HTTP 400)" turn
// failure (2026-08-24 report: a Worker bio capped at 200 UTF-16 units split
// the 🌐 pair, and every Twin turn on that installation 400'd). Truncating
// user-editable free text on a prompt path MUST go through these helpers —
// a plain `.slice(0, n)` cuts on code-unit boundaries and can split a
// surrogate pair in half.

/**
 * Remove unpaired high/low surrogates (half an emoji, corrupted tails).
 *
 * Greedy left-to-right pairing: in a corrupt run like high + low + high the
 * first two halves recombine into a DIFFERENT (invalid but whole) pair and
 * only the tail is dropped. The result therefore never contains a lone
 * surrogate — the guarantee the upstream JSON parsers need — but callers who
 * require byte-identical cleanup of already-corrupted rows should not rely on
 * recombined halves vanishing.
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * UTF-16-unit prefix cut that never splits a surrogate pair: when the cut
 * boundary lands between a high surrogate and its low half, the pair is
 * dropped whole and the result is one unit shorter than requested.
 */
export function truncateUtf16Units(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  return isHighSurrogate(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
}

/**
 * UTF-16-unit suffix cut (tail of `text.length - maxUnits` onward) that never
 * starts on a low surrogate whose high half fell off — the mirror image of
 * truncateUtf16Units for head+tail "snipped" previews.
 */
export function truncateUtf16UnitsFromEnd(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(text.length - maxUnits);
  return isLowSurrogate(cut.charCodeAt(0)) ? cut.slice(1) : cut;
}
