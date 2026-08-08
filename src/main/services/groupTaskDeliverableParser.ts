/**
 * Group Task [DELIVERABLE] line parser (round 4).
 *
 * Strictly LINE-scoped: ONLY lines carrying the [DELIVERABLE] protocol tag are
 * scanned. The message body (directory paths like `metaapp/`, example tokens,
 * truncated copy, quoted replies) can never influence the recorded URI, kind,
 * or rejection decision (P1-4 r2 heritage).
 *
 * Round-4 fixes over the round-2/3 extractor:
 * - One row PER tag occurrence. A message with two tag lines yields two
 *   candidates, and a line with two [DELIVERABLE] tags yields two candidates —
 *   the old whole-message single-row dedupe dropped real URIs (e.g. #7 msg94
 *   carried a real metaapp:// pinid AND a share link on two tag lines, only one
 *   row was recorded).
 * - Strict format validation: a candidate URI must contain a `[0-9a-f]{64}i0`
 *   pinid token (metaapp/metafile/bare pinid) or be an `^https?://` URL with a
 *   non-empty host. Placeholders (`metaapp://<pinId>`, `metaapp://[PINID]`),
 *   scheme-only fragments (`metaapp://`), ellipsis truncation
 *   (`metafile://…zip`) and truncated pinids without `i0` are INVALID and must
 *   never be recorded.
 * - Trailing markdown/punctuation is never captured into the URI
 *   (`metaapp://…25i0**` stays clean); full-width paren annotations
 *   (`（pinid: …）`) are trimmed.
 * - Kind is taken from the candidate's own URI scheme; a tag line with NO
 *   uri-shaped token at all stays a valid `text` deliverable (uri null).
 */

export type DeliverableKind = 'metaapp' | 'metafile' | 'url' | 'pinid' | 'text';

export interface ParsedDeliverable {
  kind: DeliverableKind;
  /** Clean URI (no trailing markdown/punctuation, no annotation). null only for text. */
  uri: string | null;
  /** false → placeholder/truncated/example token; must NOT be recorded. */
  valid: boolean;
  /** Human-readable reason when invalid (test/debug aid). */
  note: string | null;
}

/** Non-global (no lastIndex state) for test(); split uses the global variant. */
const DELIVERABLE_TAG_TEST = /\[DELIVERABLE\]/i;
const DELIVERABLE_TAG_SPLIT = /\[DELIVERABLE\]/gi;

/**
 * URI token characters excluded everywhere: whitespace, angle/square brackets
 * (placeholders), parens (annotations, incl. full-width), curly brackets,
 * ellipsis (truncation), backticks and markdown emphasis (never part of a URI).
 */
const URI_TOKEN_EXCLUDES = `\\s\\[\\]<>()（）「」『』【】{}…\`*_`;
const SCHEME_URI_RE = new RegExp(`(metaapp|metafile)://([^${URI_TOKEN_EXCLUDES}]+)`, 'i');
const HTTP_URI_RE = new RegExp(`(https?)://([^${URI_TOKEN_EXCLUDES}]+)`, 'i');
const BARE_PINID_RE = /\b[0-9a-f]{64}i0\b/i;
const PINID_TOKEN_RE = /[0-9a-f]{64}i0/i;

/** A segment carries an uri-SHAPED token even when the token itself is malformed. */
const HAS_SCHEME_TOKEN_RE = /(?:metaapp|metafile):\/\//i;
const HAS_HTTP_TOKEN_RE = /https?:\/\//i;
/** Hex-ish fragment (truncated pinid) that can never validate without `i0`. */
const HAS_HEXISH_RE = /[0-9a-f]{16,}/i;

const PLACEHOLDER_RE = /[<>[\]]/;
const ELLIPSIS_RE = /…/;
/** Three-or-more-dot truncation — only meaningful for hex-payload URIs. */
const DOTS_TRUNCATION_RE = /\.{3,}/;

/** Trailing punctuation that may follow a real URI in prose. */
const TRAILING_PUNCT_RE = /[，。；、！？!?.,;:：)）]+$/;

function stripTrailingPunct(uri: string): string {
  let cleaned = uri;
  for (let i = 0; i < 3; i += 1) {
    const next = cleaned.replace(TRAILING_PUNCT_RE, '');
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function invalid(kind: DeliverableKind, note: string): ParsedDeliverable {
  return { kind, uri: null, valid: false, note };
}

function valid(kind: DeliverableKind, uri: string): ParsedDeliverable {
  return { kind, uri, valid: true, note: null };
}

/**
 * Parse one [DELIVERABLE] segment (text after a single tag).
 * Returns the first VALID candidate; when the segment carries an uri-shaped
 * token that fails validation the whole candidate is INVALID (placeholder /
 * truncated / example), never a text deliverable.
 */
function parseSegment(segment: string): ParsedDeliverable {
  const text = segment.trim();
  if (!text) return invalid('text', 'empty segment');

  const schemeMatch = SCHEME_URI_RE.exec(text);
  if (schemeMatch) {
    const kind = schemeMatch[1].toLowerCase() as 'metaapp' | 'metafile';
    const payload = stripTrailingPunct(schemeMatch[2]);
    if (PLACEHOLDER_RE.test(payload)) return invalid(kind, 'placeholder token in URI');
    if (ELLIPSIS_RE.test(payload) || DOTS_TRUNCATION_RE.test(payload)) {
      return invalid(kind, 'ellipsis/truncation in URI');
    }
    // metaapp/metafile URIs are only real when they carry a full 64-hex + i0 pinid.
    const pinidToken = payload.match(PINID_TOKEN_RE)?.[0];
    if (!pinidToken) return invalid(kind, 'missing 64-hex+i0 pinid token');
    // Canonical pinids are lowercase hex — normalize the token (keep suffixes
    // like `.png` untouched).
    const normalizedPayload = pinidToken === pinidToken.toLowerCase()
      ? payload
      : payload.replace(pinidToken, pinidToken.toLowerCase());
    return valid(kind, `${kind}://${normalizedPayload}`);
  }

  const httpMatch = HTTP_URI_RE.exec(text);
  if (httpMatch) {
    const scheme = httpMatch[1].toLowerCase();
    const payload = stripTrailingPunct(httpMatch[2]);
    if (PLACEHOLDER_RE.test(payload)) return invalid('url', 'placeholder token in URL');
    if (ELLIPSIS_RE.test(payload)) return invalid('url', 'ellipsis/truncation in URL');
    if (!payload) return invalid('url', 'empty URL host');
    return valid('url', `${scheme}://${payload}`);
  }

  const pinidMatch = BARE_PINID_RE.exec(text);
  if (pinidMatch) {
    return valid('pinid', pinidMatch[0].toLowerCase());
  }

  // uri-shaped but malformed → placeholder/truncated/example, never text.
  if (HAS_SCHEME_TOKEN_RE.test(text)) return invalid('metaapp', 'malformed scheme token');
  if (HAS_HTTP_TOKEN_RE.test(text)) return invalid('url', 'malformed http token');
  if (HAS_HEXISH_RE.test(text)) return invalid('pinid', 'truncated pinid token');
  if (PLACEHOLDER_RE.test(text)) return invalid('text', 'placeholder token');

  return { kind: 'text', uri: null, valid: true, note: null };
}

/**
 * Parse a full group message: every [DELIVERABLE] tag line, one candidate per
 * tag occurrence, in document order. Invalid candidates are returned with
 * valid=false so callers can skip them without losing the valid siblings.
 */
export function parseDeliverableLines(content: string): ParsedDeliverable[] {
  const text = String(content ?? '');
  if (!DELIVERABLE_TAG_TEST.test(text)) return [];
  const results: ParsedDeliverable[] = [];
  for (const line of text.split('\n')) {
    if (!DELIVERABLE_TAG_TEST.test(line)) continue;
    const parts = line.split(DELIVERABLE_TAG_SPLIT);
    for (const part of parts.slice(1)) {
      const segment = part.trim();
      if (!segment) continue;
      results.push(parseSegment(segment));
    }
  }
  return results;
}

/** Text deliverables (valid, uri null) only — helper for callers that skip them. */
export function isTextDeliverable(candidate: ParsedDeliverable): boolean {
  return candidate.valid && candidate.kind === 'text' && candidate.uri === null;
}
