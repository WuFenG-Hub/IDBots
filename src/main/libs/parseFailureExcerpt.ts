/**
 * Forensic excerpt for LLM-output parse failures (observability, filed by the
 * peer review 2026-10-20: five weekly-consolidation parse failures left only
 * counters — countable, but the raw output was gone, so the failure could not
 * be located afterwards). When the nightly dream consolidation or the weekly
 * long dream cannot parse the model output, these helpers render ONE single
 * log line carrying the first and last characters of the raw output, so
 * length/format forensics (mid-stream truncation vs prose drift) stay
 * possible after the fact.
 *
 * Boundaries (head=tail=200 by default):
 *   len <= head+tail  → the whole string, escaped (lossless; head and tail
 *                       would overlap, so cutting gains nothing);
 *   len  > head+tail  → head + `…(+N chars omitted)…` + tail;
 * control characters are escaped so the record can never wrap the log line.
 */

export const PARSE_FAILURE_EXCERPT_HEAD_CHARS = 200;
export const PARSE_FAILURE_EXCERPT_TAIL_CHARS = 200;

/** Escape line-breaking and control characters so one log line stays one line. */
export function escapeForSingleLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default: {
        const code = ch.charCodeAt(0).toString(16).padStart(4, '0');
        return `\\u${code}`;
      }
    }
  });
}

/**
 * Render the head/tail excerpt of a raw (unparseable) LLM output for a log
 * line. `len` reported separately by the caller should be the RAW length
 * (before escaping) so truncation forensics see the model-side truth.
 */
export function formatParseFailureExcerpt(
  raw: string,
  headChars: number = PARSE_FAILURE_EXCERPT_HEAD_CHARS,
  tailChars: number = PARSE_FAILURE_EXCERPT_TAIL_CHARS,
): string {
  const text = String(raw ?? '');
  if (text.length <= headChars + tailChars) {
    return escapeForSingleLine(text);
  }
  const omitted = text.length - headChars - tailChars;
  const head = escapeForSingleLine(text.slice(0, headChars));
  const tail = escapeForSingleLine(text.slice(text.length - tailChars));
  return `${head}…(+${omitted} chars omitted)…${tail}`;
}
