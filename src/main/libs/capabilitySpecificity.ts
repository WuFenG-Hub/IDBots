/**
 * RRSI P5 specificity critic (design 2026-10-14 §6.5 P5.1): pure detection of
 * instance markers — pin ids, txids, GlobalMetaIDs, UUIDs, ISO dates — in
 * capability-draft text. A lesson that only names one specific person, order,
 * pin, or date must not harden into an always-on technique; the markers are
 * shown to the reconciliation panel as mechanical evidence and a marker in the
 * TITLE makes the draft situational by host rule. Pure module: no clock, no
 * randomness, no I/O.
 */

/** Scope verdict of the reconciliation panel (design §6.5 P5.2). NULL in the
 * store means "not assessed" and reads as general everywhere. */
export type CapabilityScope = 'general' | 'situational' | 'scorer_fitted';

export function normalizeCapabilityScope(value: unknown): CapabilityScope | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  return normalized === 'general' || normalized === 'situational' || normalized === 'scorer_fitted'
    ? normalized
    : null;
}

export type InstanceMarkerKind = 'pin' | 'txid' | 'globalmetaid' | 'uuid' | 'date';

export interface InstanceMarker {
  kind: InstanceMarkerKind;
  value: string;
}

const PIN_RE = /\b[0-9a-f]{64}i\d+\b/gi;
const TXID_RE = /\b[0-9a-f]{64}\b/gi;
const GLOBALMETAID_RE = /\bidq1[0-9a-z]{20,}\b/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;

const MARKER_KINDS: ReadonlyArray<{ kind: InstanceMarkerKind; re: RegExp }> = [
  { kind: 'pin', re: PIN_RE },
  { kind: 'txid', re: TXID_RE },
  { kind: 'globalmetaid', re: GLOBALMETAID_RE },
  { kind: 'uuid', re: UUID_RE },
  { kind: 'date', re: DATE_RE },
];

/**
 * All markers in `text`, ordered by first occurrence, duplicates (same kind +
 * value) removed, values lowercased except dates. A pin's 64-hex head also
 * satisfies the txid pattern; the `\b` after the hex run fails on the `i`, and
 * any survivor at the same start index is skipped defensively (plan P5 Task 1).
 */
export function detectInstanceMarkers(text: string): InstanceMarker[] {
  const source = String(text ?? '');
  const collected: Array<{ marker: InstanceMarker; index: number }> = [];
  for (const { kind, re } of MARKER_KINDS) {
    // /g regexes carry lastIndex state; always match with a fresh copy.
    const pattern = new RegExp(re.source, re.flags);
    for (const match of source.matchAll(pattern)) {
      collected.push({
        marker: { kind, value: kind === 'date' ? match[0] : match[0].toLowerCase() },
        index: match.index ?? 0,
      });
    }
  }
  const pinStarts = new Set(collected.filter((entry) => entry.marker.kind === 'pin').map((entry) => entry.index));
  const seen = new Set<string>();
  const markers: InstanceMarker[] = [];
  for (const entry of collected.sort((left, right) => left.index - right.index)) {
    if (entry.marker.kind === 'txid' && pinStarts.has(entry.index)) continue;
    const key = `${entry.marker.kind}\u0000${entry.marker.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push(entry.marker);
  }
  return markers;
}

/** Host rule (design §6.5 P5.1): a title carrying any marker is situational. */
export function titleHasHardInstanceMarker(title: string): boolean {
  return detectInstanceMarkers(title).length > 0;
}

const MARKER_LABELS: Record<InstanceMarkerKind, string> = {
  pin: 'pin',
  txid: 'txid',
  globalmetaid: 'GlobalMetaID',
  uuid: 'uuid',
  date: '日期',
};

const shortMarkerValue = (kind: InstanceMarkerKind, value: string): string => {
  if (kind === 'pin') {
    const suffix = /i\d+$/.exec(value);
    return `${value.slice(0, 8)}…${suffix ? suffix[0] : ''}`;
  }
  if (kind === 'date') return value;
  return `${value.slice(0, kind === 'globalmetaid' ? 10 : 8)}…`;
};

/**
 * Compact one-line rendering of the marker list for the reconciliation prompt:
 * `无` when empty, `<label> <short>` items joined with `;`, and `;等 <N> 个`
 * appended when more than `maxShown` markers exist (N = the total count).
 */
export function formatInstanceMarkers(markers: readonly InstanceMarker[], maxShown = 6): string {
  const list = Array.isArray(markers) ? markers : [];
  if (list.length === 0) return '无';
  const shown = list.slice(0, Math.max(1, Math.floor(maxShown)));
  const text = shown
    .map((marker) => `${MARKER_LABELS[marker.kind]} ${shortMarkerValue(marker.kind, marker.value)}`)
    .join(';');
  return list.length > shown.length ? `${text};等 ${list.length} 个` : text;
}
