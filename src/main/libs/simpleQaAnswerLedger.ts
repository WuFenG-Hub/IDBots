/**
 * Local posting ledger for on-chain Q&A answers (simpleanswer protocol).
 *
 * Purpose: the post_simpleanswer tool surfaces "you already answered this
 * question from this host, here is what you posted" so the acting bot can
 * decide whether a repeat answer adds value BEFORE spending sats. This is
 * host-side fact bookkeeping only (what this host published, keyed by the
 * acting MetaBot); it is not a protocol constraint — the protocol allows any
 * number of answers per bot and must not be de-duplicated. Cross-machine
 * history arrives with the Q&A indexer APIs (docs/metaweb-qa-backend-
 * requirements.md) in a later phase; until then the ledger only knows this
 * host's own posts.
 *
 * Storage: the shared SQLite-backed kv store (same injection shape as
 * feeRateStore); entries are a JSON array under
 * `simpleqa:answers:v1:<metabotId>:<questionPinId>`. `postedAt` is local
 * bookkeeping for display ordering only and never appears in protocol
 * payloads (block time is authoritative there).
 */

export interface SimpleQaAnswerLedgerEntry {
  answerPinId: string;
  content: string;
  postedAt: number;
  network: string;
}

export type SimpleQaLedgerStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
};

let store: SimpleQaLedgerStore | null = null;

const KEY_PREFIX = 'simpleqa:answers:v1:';
const MAX_ENTRIES_PER_QUESTION = 50;
const MAX_CONTENT_CHARS = 8000;

export function setSimpleQaAnswerLedgerStore(kvStore: SimpleQaLedgerStore | null): void {
  store = kvStore;
}

function ledgerKey(metabotId: number, questionPinId: string): string {
  return `${KEY_PREFIX}${metabotId}:${questionPinId}`;
}

function parseEntries(raw: unknown): SimpleQaAnswerLedgerEntry[] {
  // The kv store may hand back the stored JSON string or an already-parsed
  // array depending on the backend; accept both.
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const entries: SimpleQaAnswerLedgerEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<SimpleQaAnswerLedgerEntry>;
    if (typeof candidate.answerPinId !== 'string' || !candidate.answerPinId) continue;
    if (typeof candidate.content !== 'string') continue;
    entries.push({
      answerPinId: candidate.answerPinId,
      content: candidate.content,
      postedAt: typeof candidate.postedAt === 'number' ? candidate.postedAt : 0,
      network: typeof candidate.network === 'string' ? candidate.network : '',
    });
  }
  return entries;
}

/** List this host's recorded answers by the bot for one question (newest last). */
export function listSimpleQaAnswers(metabotId: number, questionPinId: string): SimpleQaAnswerLedgerEntry[] {
  if (!store || !questionPinId) return [];
  try {
    return parseEntries(store.get(ledgerKey(metabotId, questionPinId)));
  } catch {
    return [];
  }
}

/** Record one successfully published answer. Best-effort; ledger failures never break posting. */
export function recordSimpleQaAnswer(
  metabotId: number,
  questionPinId: string,
  entry: SimpleQaAnswerLedgerEntry,
): void {
  if (!store || !questionPinId || !entry.answerPinId) return;
  const entries = [
    ...listSimpleQaAnswers(metabotId, questionPinId),
    { ...entry, content: entry.content.slice(0, MAX_CONTENT_CHARS) },
  ];
  try {
    store.set(
      ledgerKey(metabotId, questionPinId),
      JSON.stringify(entries.slice(-MAX_ENTRIES_PER_QUESTION)),
    );
  } catch (error) {
    console.warn(
      '[simpleQaAnswerLedger] failed to record answer (posting itself succeeded):',
      error instanceof Error ? error.message : String(error),
    );
  }
}
