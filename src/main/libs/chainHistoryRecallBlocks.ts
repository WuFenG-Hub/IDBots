import type {
  MetabotChainReadRecord,
  MetabotChainWriteRecord,
} from '../chainContentHistoryStore';
import { getDayBoundsMs } from './dreamPrompt';

/**
 * Pure helpers behind the `chain_history_recall` tool — argument resolution
 * and result formatting for the chain content history ledger (pins the bot
 * published + chain pins it fully read). No I/O here; coworkRunner wires the
 * store queries around these.
 */

export type ChainHistoryRecallKind = 'write' | 'read';

export interface ChainHistoryRecallArgs {
  query?: string;
  date_from?: string;
  date_to?: string;
  kind?: string;
  limit?: number;
}

export interface ResolvedChainHistoryRecallQuery {
  query: string | null;
  kind: 'both' | ChainHistoryRecallKind;
  /** Local-midnight start of date_from (inclusive), or null. */
  fromMs: number | null;
  /** Local-midnight end of date_to (exclusive), or null. */
  toMs: number | null;
  limit: number;
}

export const DEFAULT_CHAIN_HISTORY_RECALL_LIMIT = 20;
export const MAX_CHAIN_HISTORY_RECALL_LIMIT = 50;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function resolveChainHistoryRecallQuery(args: ChainHistoryRecallArgs): ResolvedChainHistoryRecallQuery {
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : null;
  const kind: ResolvedChainHistoryRecallQuery['kind'] = args.kind === 'write' || args.kind === 'read'
    ? args.kind
    : 'both';
  let fromMs: number | null = null;
  let toMs: number | null = null;
  const from = typeof args.date_from === 'string' && DATE_PATTERN.test(args.date_from.trim())
    ? args.date_from.trim()
    : null;
  const to = typeof args.date_to === 'string' && DATE_PATTERN.test(args.date_to.trim())
    ? args.date_to.trim()
    : null;
  if (from) fromMs = getDayBoundsMs(from).startMs;
  if (to) toMs = getDayBoundsMs(to).endMs;
  const limit = Math.max(
    1,
    Math.min(MAX_CHAIN_HISTORY_RECALL_LIMIT, Math.floor(args.limit ?? DEFAULT_CHAIN_HISTORY_RECALL_LIMIT)),
  );
  return { query, kind, fromMs, toMs, limit };
}

/** Gist cap per result line — the full text stays in the ledger, not in the reply. */
const RECALL_GIST_CHARS = 240;

const truncateGist = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= RECALL_GIST_CHARS) return normalized;
  return `${normalized.slice(0, RECALL_GIST_CHARS)}…`;
};

const formatWhen = (ms: number): string => new Date(ms).toISOString();

/**
 * Render recall results for the tool output. Writes first, then reads, each
 * newest-first; every line carries the pinId so the bot can re-open the pin
 * (read_metaweb_pin) or cite it.
 */
export function formatChainHistoryRecallResults(
  writes: MetabotChainWriteRecord[],
  reads: MetabotChainReadRecord[],
): string {
  if (writes.length === 0 && reads.length === 0) {
    return 'No matching records in your chain content history — nothing you published or fully read matches this query/range.';
  }
  const lines: string[] = [];
  for (const write of writes) {
    const gist = write.summary?.trim() || write.contentText?.trim() || '(binary content)';
    const where = write.path?.trim() || '(unknown path)';
    const operation = write.operation ? `, ${write.operation}` : '';
    const origin = write.origin ? ` via ${write.origin}` : '';
    lines.push(
      `- [write] pinId=${write.pinId} (${where}${operation}) at ${formatWhen(write.occurredAtMs)}${origin}: ${truncateGist(gist)}`,
    );
  }
  for (const read of reads) {
    const gist = read.summary?.trim() || read.contentExcerpt?.trim() || '(no excerpt)';
    const label = read.title?.trim() || read.path?.trim() || read.protocol?.trim() || '(unknown)';
    const extras = [
      read.authorGlobalMetaId ? `author=${read.authorGlobalMetaId}` : null,
      read.savedToKb ? 'saved to knowledge base' : null,
      read.readCount > 1 ? `read ${read.readCount} times` : null,
    ].filter(Boolean).join(', ');
    lines.push(
      `- [read] pinId=${read.pinId} 「${label}」${extras ? ` (${extras})` : ''} at ${formatWhen(read.lastReadAtMs)}: ${truncateGist(gist)}`,
    );
  }
  return [
    'Your chain content history (pins you published + chain pins you fully read), newest first:',
    ...lines,
    '',
    'To fetch a pin\'s full content again, pass its pinId to read_metaweb_pin.',
  ].join('\n');
}
