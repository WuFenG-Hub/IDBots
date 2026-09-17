/**
 * SimpleLog protocol v1 (/protocols/simplelog) — shared writer/reader core.
 *
 * SimpleLog is the PROCESS record layer of multi-agent collaboration: one
 * entry per complete progress — who, on which task, did what, in which state,
 * with the evidence where. Knowledge (tutorials, announcements, post-mortems)
 * goes to simplenote instead: 过程进 log，知识进 note.
 *
 * The protocol shape lives HERE, once, so the write tool, the ledger extractor
 * and the pilot CLI cannot drift apart field by field:
 * - buildSimpleLogPayload()  — the writer contract (normalizes + rejects);
 * - validateSimpleLogPayload() / isSimpleLogRecord() — the reader contract;
 * - normalizeChainUriToken() — the URI discipline shared by both directions.
 *
 * Authority: /protocols/simplelog v1.0.0, pin
 * e741dad270ce9bd4f8b638386fbe33c15fbc6db5006ca01f7a57dd443fe0178ci0
 * (fields: v/kind/summary required, taskid|taskkey at least one, deliverables/
 * refs chain URIs only, content ~4 KiB budget).
 */

/** Registry path of the protocol. */
export const SIMPLELOG_PATH = '/protocols/simplelog';
/** v1 is the only version; the field is an integer, never a semver string. */
export const SIMPLELOG_VERSION = 1;

/**
 * Record kinds. A writer must pick one of these; a CONSUMER stays tolerant
 * (the protocol says unknown kinds are read as `note`), which is why
 * isSimpleLogRecord() accepts any non-empty kind string while the builder
 * rejects anything outside the set.
 */
export const SIMPLELOG_KINDS = ['handoff', 'status', 'review', 'close', 'note'] as const;
export type SimpleLogKind = (typeof SIMPLELOG_KINDS)[number];

/** Roles the protocol names for the writer. Unknown values are warned, not rejected. */
export const SIMPLELOG_ROLES = ['chair', 'worker', 'reviewer', 'observer'] as const;

/** Status word table (suggested only — consumers must tolerate free values). */
export const SIMPLELOG_STATUSES = ['executing', 'review', 'done', 'blocked', 'cancelled'] as const;

/** summary is ONE line, ≤200 characters (protocol field definition). */
export const SIMPLELOG_SUMMARY_MAX = 200;
/** content is the human-readable supplement; larger material belongs in a metafile + refs. */
export const SIMPLELOG_CONTENT_MAX_BYTES = 4096;

/** A bare task anchor / artifact id: 64 lowercase hex + `i0`. */
export const SIMPLELOG_PINID_RE = /^[0-9a-f]{64}i0$/;

/**
 * A complete chain URI — scheme + full pinid, plus an optional file suffix
 * (`metafile://<pinid>.zip`). Anything shorter is a citation fragment, not a
 * reference: the protocol forbids truncation outright.
 */
export const SIMPLELOG_CHAIN_URI_RE = /^(pin|metafile|metaapp):\/\/[0-9a-f]{64}i0(\.[A-Za-z0-9]{1,8})?$/;

const WEB2_URI_RE = /^https?:\/\//i;
const ELLIPSIS_RE = /…|\.{3,}/;
/** Placeholder/decorative brackets that can never be part of a URI. */
const PLACEHOLDER_RE = /[<>[\]]/;
/** Trailing prose punctuation that may follow a real URI in a sentence. */
const TRAILING_PUNCT_RE = /[，。；、！？!?,;:：)）]+$/;
/** Markdown link with the URI as target: `[label](target)`. */
const MARKDOWN_LINK_RE = /^\[[^\]]*\]\(([^)\s]+)\)$/;

export interface ChainUriToken {
  /** The bare chain URI, or null when the value is not one. */
  uri: string | null;
  /** Why the value was rejected (writer error text / extractor note). */
  reason: string | null;
}

/**
 * Unwrap ONE deliverables/refs item to its bare chain URI.
 *
 * Array items may arrive raw (`pin://<pinid>`) or dressed by a renderer:
 * `[pin://<pinid>](pin://<pinid>)` (the MetaWeb habit — label and target are
 * the same URI), `` `pin://<pinid>` `` (inline code) or `<pin://<pinid>>`
 * (angle brackets). The wrapper is NEVER the value: the URI is read from the
 * markdown link TARGET, so a truncated or placeholder label cannot smuggle a
 * dirty token through — and being dressed up is not validation, a truncated
 * target stays rejected.
 */
export function normalizeChainUriToken(raw: unknown): ChainUriToken {
  if (typeof raw !== 'string') return { uri: null, reason: 'not a string' };
  let token = raw.trim();
  const link = MARKDOWN_LINK_RE.exec(token);
  if (link) token = link[1].trim();
  // Strip code/emphasis/angle wrappers, repeatedly at both ends.
  for (let i = 0; i < 3; i += 1) {
    const next = token.replace(/^[`*_<\s]+/, '').replace(/[`*_>\s]+$/, '');
    if (next === token) break;
    token = next;
  }
  token = token.replace(TRAILING_PUNCT_RE, '');
  if (!token) return { uri: null, reason: 'empty URI' };
  if (WEB2_URI_RE.test(token)) {
    return { uri: null, reason: 'Web2 URL is not a chain URI (deliverables/refs accept pin://, metafile://, metaapp:// only)' };
  }
  if (ELLIPSIS_RE.test(token)) return { uri: null, reason: 'truncated URI (ellipsis in the pinid)' };
  if (PLACEHOLDER_RE.test(token)) return { uri: null, reason: 'placeholder token (`<…>`, brackets) in the URI' };
  // Canonical pinids are lowercase; normalize an uppercase spelling before the
  // shape check so `PIN://ABC…I0` is accepted as the same object (never as a
  // second identity).
  const normalized = token.replace(/[0-9a-fA-F]{64}i0/i, (match) => match.toLowerCase());
  if (!SIMPLELOG_CHAIN_URI_RE.test(normalized)) {
    return {
      uri: null,
      reason: 'not a complete chain URI (expected scheme://<64-hex+i0>, no truncation)',
    };
  }
  return { uri: normalized, reason: null };
}

/** Reader-side URI test — the same discipline the writer enforces. */
export function isChainUri(value: unknown): boolean {
  return normalizeChainUriToken(value).uri != null;
}

export interface SimpleLogInput {
  v?: unknown;
  kind?: unknown;
  summary?: unknown;
  taskid?: unknown;
  taskkey?: unknown;
  step?: unknown;
  status?: unknown;
  role?: unknown;
  toid?: unknown;
  deliverables?: unknown;
  refs?: unknown;
  content?: unknown;
  extra?: unknown;
}

export interface SimpleLogBuildOk {
  ok: true;
  /** Protocol-shaped payload, empty optional fields omitted. */
  payload: Record<string, unknown>;
  /** Non-blocking deviations (normalized input, free values outside the word tables). */
  warnings: string[];
}

export interface SimpleLogBuildFailure {
  ok: false;
  errors: string[];
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUriArray(
  value: unknown,
  field: 'deliverables' | 'refs',
  errors: string[],
): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of chain URIs`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    const { uri, reason } = normalizeChainUriToken(item);
    if (!uri) {
      errors.push(`${field}[${index}] is not a usable chain URI: ${reason}`);
      return;
    }
    out.push(uri);
  });
  return out;
}

/**
 * Build a protocol-legal simplelog payload from a tool/CLI call.
 *
 * Rejects (never publishes) a record that cannot be replayed: wrong version,
 * unknown kind, empty/oversized summary, no task anchor, a taskid carrying a
 * URI scheme instead of the bare pinid the protocol pins down, a deliverables/
 * refs item that is truncated / uses a placeholder / points at Web2, and a
 * content body over the 4 KiB budget (large material belongs in a metafile,
 * referenced from refs).
 */
export function buildSimpleLogPayload(input: SimpleLogInput): SimpleLogBuildOk | SimpleLogBuildFailure {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rawVersion = input.v;
  if (rawVersion != null && rawVersion !== '' && Number(rawVersion) !== SIMPLELOG_VERSION) {
    errors.push(`v must be ${SIMPLELOG_VERSION} (v1 is the only SimpleLog version)`);
  }

  const kind = asTrimmedString(input.kind);
  if (!kind) {
    errors.push(`kind is required (one of: ${SIMPLELOG_KINDS.join(', ')})`);
  } else if (!(SIMPLELOG_KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind "${kind}" is not a SimpleLog kind (one of: ${SIMPLELOG_KINDS.join(', ')})`);
  }

  // summary is ONE line ≤200 chars — collapse author-side wrapping instead of
  // rejecting it, but refuse anything that still exceeds the protocol budget.
  const summary = asTrimmedString(input.summary).replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ');
  if (!summary) {
    errors.push('summary is required (one line stating what happened)');
  } else if (summary.length > SIMPLELOG_SUMMARY_MAX) {
    errors.push(`summary is ${summary.length} characters — the protocol caps it at ${SIMPLELOG_SUMMARY_MAX}`);
  }
  if (/^更正[:：]/.test(summary) && input.refs == null) {
    errors.push('a correction (summary starting with 更正:) must carry refs pointing at the entry it corrects');
  }

  const taskid = asTrimmedString(input.taskid);
  const taskkey = asTrimmedString(input.taskkey);
  if (!taskid && !taskkey) {
    errors.push('taskid or taskkey is required — a record must be anchored to a task');
  }
  if (taskid) {
    if (taskid.includes('://')) {
      errors.push('taskid must be the BARE task pinid (64 lowercase hex + i0), without a pin:// scheme');
    } else if (!SIMPLELOG_PINID_RE.test(taskid)) {
      errors.push('taskid must be a complete bare pinid (64 lowercase hex + i0)');
    }
  }

  const role = asTrimmedString(input.role);
  if (role && !(SIMPLELOG_ROLES as readonly string[]).includes(role)) {
    warnings.push(`role "${role}" is outside the protocol word table (${SIMPLELOG_ROLES.join('|')})`);
  }
  const status = asTrimmedString(input.status);
  if (status && !(SIMPLELOG_STATUSES as readonly string[]).includes(status)) {
    warnings.push(`status "${status}" is outside the suggested table (${SIMPLELOG_STATUSES.join('|')}) — consumers must tolerate free values`);
  }
  const toid = asTrimmedString(input.toid);
  if (toid && !toid.startsWith('idq1')) {
    errors.push('toid must be the handoff target globalMetaId (idq1…)');
  }
  if (kind === 'handoff' && !toid) {
    warnings.push('kind handoff without toid — the handoff target is not recorded');
  }

  const deliverables = normalizeUriArray(input.deliverables, 'deliverables', errors);
  const refs = normalizeUriArray(input.refs, 'refs', errors);

  let content = '';
  if (typeof input.content === 'string' && input.content.trim()) {
    content = input.content;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > SIMPLELOG_CONTENT_MAX_BYTES) {
      errors.push(
        `content is ${bytes} bytes — over the ${SIMPLELOG_CONTENT_MAX_BYTES}-byte protocol budget; publish the material as a metafile and put its metafile:// URI in refs`,
      );
    }
  }

  let extra: Record<string, unknown> | null = null;
  if (input.extra != null) {
    if (typeof input.extra !== 'object' || Array.isArray(input.extra)) {
      errors.push('extra must be an object');
    } else {
      extra = input.extra as Record<string, unknown>;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Declarative minimalism: empty optional fields are omitted entirely, so a
  // record carries only the facts it actually asserts.
  const payload: Record<string, unknown> = { v: SIMPLELOG_VERSION, kind, summary };
  if (taskid) payload.taskid = taskid;
  if (taskkey) payload.taskkey = taskkey;
  const step = asTrimmedString(input.step);
  if (step) payload.step = step;
  if (status) payload.status = status;
  if (role) payload.role = role;
  if (toid) payload.toid = toid;
  if (deliverables.length) payload.deliverables = deliverables;
  if (refs.length) payload.refs = refs;
  if (content) payload.content = content;
  if (extra) payload.extra = extra;

  return { ok: true, payload, warnings };
}

export interface SimpleLogValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Reader-side validation of a RECEIVED record. Deliberately looser than the
 * builder (a consumer must tolerate unknown kinds and free status values) but
 * strict on the replay-load-bearing fields: the version, a kind, a summary and
 * at least one task anchor — a record without those cannot be attributed to a
 * task, which is exactly what the protocol forbids.
 */
export function validateSimpleLogPayload(value: unknown): SimpleLogValidation {
  const errors: string[] = [];
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['record is not an object'] };
  }
  const record = value as Record<string, unknown>;
  if (Number(record.v) !== SIMPLELOG_VERSION) {
    errors.push(`v is missing or not ${SIMPLELOG_VERSION}`);
  }
  if (!asTrimmedString(record.kind)) errors.push('kind is missing');
  if (!asTrimmedString(record.summary)) errors.push('summary is missing');
  if (!asTrimmedString(record.taskid) && !asTrimmedString(record.taskkey)) {
    errors.push('neither taskid nor taskkey is present — the record is not anchored to a task');
  }
  return { ok: errors.length === 0, errors };
}

/** True when `value` carries the load-bearing SimpleLog record fields. */
export function isSimpleLogRecord(value: unknown): boolean {
  return validateSimpleLogPayload(value).ok;
}

const FENCED_BLOCK_RE = /```[\s\S]*?(?:```|$)/g;

/**
 * Extract a SimpleLog record object from a message/tool payload body.
 *
 * The body may be the record JSON itself, or prose that embeds it. Two guards
 * come straight from the ledger's citation discipline: FENCED code blocks are
 * documentation (a quoted record example is never a record) and only the FIRST
 * balanced JSON object that validates as a record is returned — a nested or
 * echoed fragment is ignored.
 */
export function parseSimpleLogPayloadText(content: unknown): Record<string, unknown> | null {
  const text = typeof content === 'string' ? content.replace(FENCED_BLOCK_RE, '') : '';
  if (!text.includes('{')) return null;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findBalancedJsonEnd(text, start);
    if (end === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (isSimpleLogRecord(parsed)) return parsed as Record<string, unknown>;
  }
  return null;
}

/**
 * Index of the `}` closing the object that starts at `start`, or -1. String
 * contents (with escapes) are skipped so a `}` inside a summary does not end
 * the object early.
 */
function findBalancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The record's task anchor: the on-chain pinid when given, else the free key. */
export function simpleLogTaskAnchor(record: Record<string, unknown>): string {
  const taskid = asTrimmedString(record.taskid);
  if (taskid) return taskid;
  return asTrimmedString(record.taskkey);
}
