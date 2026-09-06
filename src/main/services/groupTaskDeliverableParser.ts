/**
 * Group Task [DELIVERABLE] line parser (round 6).
 *
 * Strictly LINE-scoped: ONLY lines that START with the [DELIVERABLE] protocol
 * tag are scanned. Task #63 reset the contract to the protocol standard the
 * bots are taught (one artifact per tag, tag at line start): a deliverable is
 * what the sender CREATED and published on-chain for THIS task — URIs the
 * message merely CITES (earlier tasks' products, other members' artifacts,
 * upstream inputs) must never mint ledger rows. Round 5's body-line sweep
 * (any scheme URI on any non-tag line of a tagged message) is REMOVED: it is
 * exactly how task #63's ledger absorbed yesterday's MetaApp out of a testing
 * note and a second member's promo citation as duplicate rows.
 *
 * Citation escape hatches: tags inside fenced code blocks are protocol
 * documentation, never deliveries; and a tag must LEAD the (trimmed) line —
 * markdown emphasis before the tag is fine (`**[DELIVERABLE] …**`), any words
 * before it make the mention prose ("任务完成：**[DELIVERABLE]…"). Inline
 * backtick spans stay intact: real deliveries wrap payloads (paths, URIs) in
 * backticks.
 *
 * One bounded exception (the #62 shape): when the leading tag line's own text
 * has no URI verdict, the FIRST non-blank line right below it may supply the
 * URI — the "description line + blank line + URI line" delivery format.
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

/**
 * Task #63: strip FENCED code blocks before scanning — a fenced block is
 * protocol documentation (an example receipt), never a delivery. Inline
 * backtick spans stay: real deliveries legitimately wrap payloads (local file
 * paths, URIs) in backticks, and a backticked tag is never TAG_LED anyway
 * (the quote mark breaks the lead check). Mirrors the daemon's
 * stripFencedCodeBlocks (kept local to avoid a daemon→parser import cycle).
 */
function stripQuotedCode(content: string): string {
  return String(content ?? '').replace(/```[\s\S]*?(?:```|$)/g, '');
}

/** Non-global (no lastIndex state) for test(); split uses the global variant. */
const DELIVERABLE_TAG_TEST = /\[DELIVERABLE\]/i;
const DELIVERABLE_TAG_SPLIT = /\[DELIVERABLE\]/gi;
/**
 * Round 6 (task #63): a PROTOCOL tag line — the tag leads the trimmed line,
 * optionally behind markdown emphasis (`**[DELIVERABLE] …**` is the same
 * bold-wrapping habit that produced task #63's `**[STATUS:REVIEW]**` miss).
 * A tag preceded by other words ("任务完成：**[DELIVERABLE]…") is a prose
 * citation, never a delivery.
 */
const TAG_LED_LINE_RE = /^[\s*_]*\[deliverable\]/i;

/**
 * URI token characters excluded everywhere: whitespace, angle/square brackets
 * (placeholders), parens (annotations, incl. full-width), curly brackets,
 * ellipsis (truncation), backticks and markdown emphasis (never part of a URI).
 */
const URI_TOKEN_EXCLUDES = `\\s\\[\\]<>()（）「」『』【】{}…\`*_，。；：！？、`;
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
 * One [DELIVERABLE] tag occurrence in a message.
 */
interface ScannedTagSegment {
  /** Same-line text after the tag, trimmed (never empty — empty parts are skipped). */
  segment: string;
  /**
   * Bounded lookahead for the multi-line delivery format
   * ("[DELIVERABLE] <description>：\n\n<uri>"): the first non-blank line after
   * the tag line, within a 3-line window and never past the next
   * [DELIVERABLE]-carrying line. null when that window holds no candidate.
   * Only the LAST tag occurrence on a line carries the lookahead — the block
   * below the line belongs to the trailing tag.
   */
  nextLine: string | null;
}

/**
 * Scan a full group message for every [DELIVERABLE] tag occurrence. A line
 * contributes ONLY when its trimmed text STARTS with the tag — mid-line
 * mentions are prose citations ("上条 [DELIVERABLE] 即为回应", "无
 * [DELIVERABLE] 属正常等待" — both minted bogus ledger rows in task #63) and
 * never count. One entry per tag occurrence on such a line; entries are
 * index-aligned across parseDeliverableLines / parseDeliverableSegments —
 * candidate[i] is the parse of segment[i].
 */
function scanDeliverableTagSegments(content: string): ScannedTagSegment[] {
  const text = stripQuotedCode(String(content ?? ''));
  if (!DELIVERABLE_TAG_TEST.test(text)) return [];
  const lines = text.split('\n');
  const entries: ScannedTagSegment[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!TAG_LED_LINE_RE.test(line.trimStart())) continue;
    const parts = line.split(DELIVERABLE_TAG_SPLIT);
    for (let p = 1; p < parts.length; p += 1) {
      const segment = parts[p].trim();
      if (!segment) continue;
      let nextLine: string | null = null;
      if (p === parts.length - 1) {
        for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j += 1) {
          if (DELIVERABLE_TAG_TEST.test(lines[j])) break;
          const trimmed = lines[j].trim();
          if (trimmed) {
            nextLine = trimmed;
            break;
          }
        }
      }
      entries.push({ segment, nextLine });
    }
  }
  return entries;
}

/**
 * Parse a full group message: every leading [DELIVERABLE] tag line, one
 * candidate per tag occurrence, in document order. Invalid candidates are
 * returned with valid=false so callers can skip them without losing the valid
 * siblings.
 *
 * Bounded multi-line upgrade: a tag line whose description leaves the URI to
 * the next non-blank line ("[DELIVERABLE] <desc>：\n\n<uri>" — task #62 msg
 * c48d2eb6 delivered a skill pin in that shape) is re-parsed over the segment
 * + lookahead line. Upgrade-ONLY: a clean URI on the lookahead line replaces
 * a text/invalid same-line verdict; anything ambiguous there (placeholder,
 * truncated hex) keeps the same-line result, so the strict P1-4 semantics
 * never gain new invalid rows. Only the FIRST URI of the lookahead line is
 * taken — one tag announces one artifact (round-6 contract).
 */
export function parseDeliverableLines(content: string): ParsedDeliverable[] {
  return scanDeliverableTagSegments(content).map(({ segment, nextLine }) => {
    const candidate = parseSegment(segment);
    if (candidate.valid && candidate.uri) return candidate;
    if (!nextLine) return candidate;
    const upgraded = parseSegment(`${segment}\n${nextLine}`);
    return upgraded.valid && upgraded.uri ? upgraded : candidate;
  });
}

/**
 * Task #63: a deliverable URI's 64-hex+i0 pinid token IS the on-chain artifact
 * identity (`pin://X` and `metaapp://X` are the same object; `.zip` suffixes
 * ride along). Extracted for the ledger/UI dedupe — one artifact, one row,
 * one author (the publisher that first recorded it).
 */
export function extractPinidToken(uri: string | null | undefined): string | null {
  const token = PINID_TOKEN_RE.exec(String(uri ?? ''))?.[0];
  return token ? token.toLowerCase() : null;
}

/**
 * Raw segment text behind each parsed candidate, index-aligned with
 * parseDeliverableLines (same document order, same skipping rules). Empty
 * when the message carries no [DELIVERABLE] tag.
 */
export function parseDeliverableSegments(content: string): string[] {
  return scanDeliverableTagSegments(content).map((entry) => entry.segment);
}

/**
 * Task #63: does this message carry at least one PROTOCOL [DELIVERABLE] line
 * (tag-led, outside code quotes)? The single source of truth for gating —
 * responder wakeups and ledger collection must agree with the parser, so a
 * prose citation ("无 [DELIVERABLE] 属正常等待") is never treated as a
 * delivery anywhere.
 */
export function hasDeliverableTagLine(content: string): boolean {
  const text = stripQuotedCode(String(content ?? ''));
  return text
    .split('\n')
    .some((line) => TAG_LED_LINE_RE.test(line.trimStart()));
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
const LOCAL_PATH_TOKEN_RE = /(?<![:/.\w])(~\/|\/(?!\/)|[A-Za-z]:\\)[^\s"'`<>[\]{}|*（）]+/g;
/** Paths that are NOT local files: on-chain schemes and protocol routes. */
const NON_LOCAL_PATH_PREFIXES = [
  'metaapp:', 'metafile:', 'metaid:', 'http:', 'https:', 'pin:', 'map:',
  'buzz:', 'nostr:', 'ftp:',
  '/protocols/', '/api/', '/browser/', '/buzz/', '/metaapp/', '/metaid/',
];
/** File tokens without a directory separator are not paths. */
const HAS_SEPARATOR_RE = /[\\/]/;

/** True when the token is a plausible LOCAL file path (absolute or ~/). */
function looksLikeLocalPath(token: string): boolean {
  if (NON_LOCAL_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) return false;
  if (!HAS_SEPARATOR_RE.test(token)) return false;
  if (token.endsWith('/') || token.endsWith('\\')) return false;
  // `foo/bar` relative tokens resolve nowhere without a base — only absolute
  // or home-relative paths are actionable for the uploader.
  return token.startsWith('/') || token.startsWith('~/') || /^[A-Za-z]:\\/.test(token);
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
