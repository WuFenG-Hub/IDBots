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
 *   pinid token (metaapp/metafile/pin/bare pinid) or be an `^https?://` URL with a
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
  /**
   * P0-1: non-blocking field-level hints (e.g. a buzz pinid wrapped in
   * `metaapp://` should be delivered as a buzz link). Warnings never
   * invalidate a candidate — the chair decides.
   */
  warnings?: string[];
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
const SCHEME_URI_RE = new RegExp(`(metaapp|metafile|pin)://([^${URI_TOKEN_EXCLUDES}]+)`, 'i');
const HTTP_URI_RE = new RegExp(`(https?)://([^${URI_TOKEN_EXCLUDES}]+)`, 'i');
const BARE_PINID_RE = /\b[0-9a-f]{64}i0\b/i;
const PINID_TOKEN_RE = /[0-9a-f]{64}i0/i;

/** A segment carries an uri-SHAPED token even when the token itself is malformed. */
const HAS_SCHEME_TOKEN_RE = /(?:metaapp|metafile|pin):\/\//i;
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

function valid(kind: DeliverableKind, uri: string, warnings: string[] = []): ParsedDeliverable {
  // warnings are omitted when empty so the candidate shape stays stable for
  // existing consumers (deepEqual tests, JSON payloads).
  return warnings.length > 0
    ? { kind, uri, valid: true, note: null, warnings }
    : { kind, uri, valid: true, note: null };
}

/** P0-1: a buzz pinid wrapped in metaapp:// (loop AI #4 lesson) — advise a pin:// link. */
function buzzWrappingWarnings(text: string, kind: DeliverableKind): string[] {
  if (!/buzz/i.test(text)) return [];
  if (kind === 'metaapp' || kind === 'pinid') {
    return [
      'buzz deliverable is best shared as a pin://<pinid> link (opens the post in the app\'s Bot Browser), not wrapped in metaapp://',
    ];
  }
  return [];
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
    const scheme = schemeMatch[1].toLowerCase();
    // pin:// is the universal fallback scheme for any pin — recorded under the
    // existing 'pinid' kind, but WITHOUT the buzz-wrapping warning (pin:// is
    // the recommended citation form for buzz posts too).
    const kind = (scheme === 'pin' ? 'pinid' : scheme) as 'metaapp' | 'metafile' | 'pinid';
    const payload = stripTrailingPunct(schemeMatch[2]);
    if (PLACEHOLDER_RE.test(payload)) return invalid(kind, 'placeholder token in URI');
    if (ELLIPSIS_RE.test(payload) || DOTS_TRUNCATION_RE.test(payload)) {
      return invalid(kind, 'ellipsis/truncation in URI');
    }
    // Scheme URIs are only real when they carry a full 64-hex + i0 pinid.
    const pinidToken = payload.match(PINID_TOKEN_RE)?.[0];
    if (!pinidToken) return invalid(kind, 'missing 64-hex+i0 pinid token');
    // Canonical pinids are lowercase hex — normalize the token (keep suffixes
    // like `.png` untouched).
    const normalizedPayload = pinidToken === pinidToken.toLowerCase()
      ? payload
      : payload.replace(pinidToken, pinidToken.toLowerCase());
    const warnings = scheme === 'pin' ? [] : buzzWrappingWarnings(text, kind);
    return valid(kind, `${scheme}://${normalizedPayload}`, warnings);
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
    return valid('pinid', pinidMatch[0].toLowerCase(), buzzWrappingWarnings(text, 'pinid'));
  }

  // uri-shaped but malformed → placeholder/truncated/example, never text.
  if (HAS_SCHEME_TOKEN_RE.test(text)) return invalid('metaapp', 'malformed scheme token');
  if (HAS_HTTP_TOKEN_RE.test(text)) return invalid('url', 'malformed http token');
  if (HAS_HEXISH_RE.test(text)) return invalid('pinid', 'truncated pinid token');
  if (PLACEHOLDER_RE.test(text)) return invalid('text', 'placeholder token');

  return { kind: 'text', uri: null, valid: true, note: null };
}

/**
 * Scan a full group message for every [DELIVERABLE] tag occurrence and return
 * the trimmed segment text AFTER each tag, in document order. One entry per
 * tag occurrence (a line with two tags yields two entries); empty segments
 * are skipped. Index-aligned with parseDeliverableLines — candidate[i] is the
 * parse of segment[i] — so callers can inspect the raw segment of any
 * candidate (e.g. the daemon's local-file delivery enhancement).
 */
function scanDeliverableSegments(content: string): string[] {
  const text = String(content ?? '');
  if (!DELIVERABLE_TAG_TEST.test(text)) return [];
  const segments: string[] = [];
  for (const line of text.split('\n')) {
    if (!DELIVERABLE_TAG_TEST.test(line)) continue;
    const parts = line.split(DELIVERABLE_TAG_SPLIT);
    for (const part of parts.slice(1)) {
      const segment = part.trim();
      if (!segment) continue;
      segments.push(segment);
    }
  }
  return segments;
}

/**
 * Parse a full group message: every [DELIVERABLE] tag line, one candidate per
 * tag occurrence, in document order. Invalid candidates are returned with
 * valid=false so callers can skip them without losing the valid siblings.
 */
export function parseDeliverableLines(content: string): ParsedDeliverable[] {
  return scanDeliverableSegments(content).map(parseSegment);
}

/**
 * Raw segment text behind each parsed candidate, index-aligned with
 * parseDeliverableLines (same document order, same skipping rules). Empty
 * when the message carries no [DELIVERABLE] tag.
 */
export function parseDeliverableSegments(content: string): string[] {
  return scanDeliverableSegments(content);
}

/** Text deliverables (valid, uri null) only — helper for callers that skip them. */
export function isTextDeliverable(candidate: ParsedDeliverable): boolean {
  return candidate.valid && candidate.kind === 'text' && candidate.uri === null;
}

// ---------------------------------------------------------------------------
// Local-file delivery enhancement (ledger fix, #14→#16 heritage)
// ---------------------------------------------------------------------------
// A worker often delivers a LOCAL file path (e.g. `/Users/me/work/index.html`
// or `~/notes/spec.md`) instead of an on-chain uri. The daemon upgrades such
// text deliverables to metafile:// on-chain evidence by uploading the file —
// this extractor isolates the path tokens so the daemon only has to verify
// existence and upload. Pure string extraction: no fs, no resolution.

// Full-width parens terminate a path token (a `（…` right after a path is
// almost always a prose annotation, e.g. `spec.md（含参数速查表）`). The
// lookbehind excludes anything that is NOT a standalone absolute path: the
// second slash of `scheme://…` (`/` or `:` before), URL path segments
// (`https://host/path` — `.` before), and relative tokens (`foo/bar` —
// word char before).
const LOCAL_PATH_TOKEN_RE = /(?<![:/.\w])(~\/|\/(?!\/))[^\s"'`<>[\]{}|*（）]+/g;
/** Paths that are NOT local files: on-chain schemes and protocol routes. */
const NON_LOCAL_PATH_PREFIXES = [
  'metaapp:', 'metafile:', 'metaid:', 'http:', 'https:', 'pin:', 'map:',
  'buzz:', 'nostr:', 'ftp:',
  '/protocols/', '/api/', '/browser/', '/buzz/', '/metaapp/', '/metaid/',
];
/** File tokens without a directory separator are not paths. */
const HAS_SEPARATOR_RE = /\//;

/** True when the token is a plausible LOCAL file path (absolute or ~/). */
function looksLikeLocalPath(token: string): boolean {
  if (NON_LOCAL_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) return false;
  if (!HAS_SEPARATOR_RE.test(token)) return false;
  if (token.endsWith('/') || token.endsWith('\\')) return false;
  // `foo/bar` relative tokens resolve nowhere without a base — only absolute
  // or home-relative paths are actionable for the uploader.
  return token.startsWith('/') || token.startsWith('~/');
}

/**
 * Extract local file path candidates from a [DELIVERABLE] segment (absolute
 * or `~/`-rooted only; scheme URIs, `/protocols/…` routes and API paths are
 * excluded). Trailing punctuation is trimmed. Existence is NOT checked here —
 * the caller (daemon) stats the files and uploads the first hit.
 */
export function extractLocalFilePaths(text: string): string[] {
  const content = String(text ?? '');
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(LOCAL_PATH_TOKEN_RE)) {
    const token = stripTrailingPunct(match[0]);
    if (!looksLikeLocalPath(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// P0-1: structured field-level validation for the send path / UI (non-blocking)
// ---------------------------------------------------------------------------

export interface DeliverableIssue {
  /** Which field carries the problem: pinid / url / kind / text. */
  field: 'pinid' | 'url' | 'kind' | 'text';
  /** Index of the [DELIVERABLE] candidate this issue belongs to. */
  index: number;
  message: string;
}

export interface DeliverableValidation {
  candidates: ParsedDeliverable[];
  /** Format failures (invalid candidates) — warn, do NOT block. */
  errors: DeliverableIssue[];
  /** Non-blocking hints (e.g. buzz pinid wrapped in metaapp://). */
  warnings: DeliverableIssue[];
}

function issueField(kind: DeliverableKind): DeliverableIssue['field'] {
  if (kind === 'url') return 'url';
  if (kind === 'metaapp' || kind === 'metafile' || kind === 'pinid') return 'pinid';
  return 'text';
}

/**
 * Validate every [DELIVERABLE] tag occurrence in a message. Returns field-level
 * errors (invalid candidates, each with the human-readable reason) and
 * non-blocking warnings. Callers may surface these to the sender but MUST NOT
 * block the chain write (warn-and-deliver; the chair decides).
 */
export function validateDeliverableLines(content: string): DeliverableValidation {
  const candidates = parseDeliverableLines(content);
  const errors: DeliverableIssue[] = [];
  const warnings: DeliverableIssue[] = [];
  candidates.forEach((candidate, index) => {
    if (!candidate.valid) {
      errors.push({
        field: issueField(candidate.kind),
        index,
        message: candidate.note ?? 'invalid deliverable format',
      });
      return;
    }
    for (const warning of candidate.warnings ?? []) {
      warnings.push({ field: issueField(candidate.kind), index, message: warning });
    }
  });
  return { candidates, errors, warnings };
}

// ---------------------------------------------------------------------------
// P0-3: [WORKING] / [STANDBY] protocol markers
// ---------------------------------------------------------------------------

export interface ParsedWorkingAck {
  acknowledged: boolean;
  /** Text after the [WORKING] tag (subtask label), trimmed/capped. */
  taskDescription: string | null;
  /** Estimated minutes parsed from e.g. "预计 15 分钟" / "15 min". */
  estimatedMinutes: number | null;
}

/**
 * P2-2: the [WORKING] tag optionally carries in-tag qualifiers, e.g.
 * `[WORKING long-task, ETA 45 min]` / `[WORKING 长任务 预计剩余45分钟]` — a
 * long-task heartbeat. Matches the tag with or without the qualifier body.
 */
const WORKING_TAG_RE = /\[WORKING(?:\s[^\]]*)?\]/i;

/**
 * Parse a [WORKING] ACK line: `[WORKING] 已接单：<subtask>，预计 <N> 分钟`,
 * or a long-task heartbeat: `[WORKING long-task, ETA <N> min]`.
 * Returns null when the message carries no [WORKING] tag.
 */
export function parseWorkingAck(content: string): ParsedWorkingAck | null {
  const text = String(content ?? '');
  const match = WORKING_TAG_RE.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  // The ETA may live inside the tag (heartbeat form) or after it (ACK form) —
  // scan the whole message for it.
  const minutesMatch = /\b(\d{1,3})\s*(?:分钟|min(?:ute)?s?)/i.exec(text);
  const description = rest.replace(/^[：:\s-]+/, '').trim().slice(0, 120);
  return {
    acknowledged: true,
    taskDescription: description || null,
    estimatedMinutes: minutesMatch ? Number(minutesMatch[1]) : null,
  };
}

/** True when the message carries the [STANDBY] protocol marker. */
export function hasStandbyMarker(content: string): boolean {
  return /\[STANDBY\]/i.test(String(content ?? ''));
}

// ---------------------------------------------------------------------------
// P0-8: integrity declarations (honest self-correction)
// ---------------------------------------------------------------------------

/** True when the message publicly declares a correction or honest report. */
const CORRECTION_RE = /更正|修正|纠正|补正|勘误|以…?为准|以此为准|请以此为准|\bcorrection\b|\berrata\b|\bcorrigendum\b|\brevised\b|\bsupersede[sd]?\b|take this as (?:the )?(?:canonical|correct)|this is the correct/i;
const HONEST_REPORT_RE = /诚实|如实|\bhonest report\b|\bto be clear\b|\bhonestly\b/i;
export function isIntegrityDeclaration(content: string): boolean {
  const text = String(content ?? '');
  return CORRECTION_RE.test(text) || HONEST_REPORT_RE.test(text);
}

/** True when the message is a correction (not merely an honest failure report). */
export function isCorrectionText(content: string): boolean {
  return CORRECTION_RE.test(String(content ?? ''));
}
