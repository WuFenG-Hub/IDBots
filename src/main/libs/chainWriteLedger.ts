/**
 * Chain write ledger gate ("MetaBot 发布账本").
 *
 * Decides which successful createPin broadcasts land in the
 * `metabot_chain_writes` table (see chainContentHistoryStore.ts) and performs
 * the actual recording. Pure/decision logic lives in shouldRecordChainWrite so
 * it stays unit-testable; recordChainWriteFromCreatePin is the side-effecting
 * entry point called from services/metaidCore.ts createPin.
 *
 * Excluded from the ledger (already persisted elsewhere — recording them here
 * would create a second source of truth):
 *  - chat/group-management protocol paths: the MetaWeb listener already lands
 *    those pins in private_chat_messages / group_chat_messages (including the
 *    bot's own sends);
 *  - `/info/*` identity sync pins: the metabots table has a dedicated column
 *    per synced field;
 *  - internal services with their own dedicated tables (group-task
 *    deliverables, service orders, MetaApp publishes, gig-square services,
 *    private/group chat daemons, identity sync) — tagged via CreatePinOptions
 *    .origin at the call site.
 * Everything else (simplebuzz, simplenote, /file binary uploads, omni_cast
 * protocol writes, RPC-gateway publishes, …) IS recorded.
 */

import { getChainContentHistoryStore } from '../chainContentHistoryRuntime';
import type { MetaidDataPayload, CreatePinResult } from '../services/metaidCore';

/** Protocol paths the MetaWeb listener already persists into chat tables. */
const EXCLUDED_EXACT_PATHS: ReadonlySet<string> = new Set([
  '/protocols/simplemsg',
  '/protocols/simplegroupcreate',
  '/protocols/simplegroupjoin',
  '/protocols/simplegroupremoveuser',
  '/protocols/simplegroupchat',
]);

/** Identity sync pins (name/avatar/bio/persona/llm/chatSkills/homepage/owner). */
const EXCLUDED_PATH_PREFIX = '/info/';

/** Origins whose writes are already tracked by a dedicated internal table. */
const EXCLUDED_ORIGINS: ReadonlySet<string> = new Set([
  'internal:group-task-deliverable',
  'internal:service-order',
  'internal:metaapp',
  'internal:gig-square',
  'internal:private-chat',
  'internal:group-chat',
  'internal:identity-sync',
]);

/** True when one broadcast pin should be recorded in metabot_chain_writes. */
export function shouldRecordChainWrite(input: { path?: string | null; origin?: string | null }): boolean {
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (path) {
    if (EXCLUDED_EXACT_PATHS.has(path)) return false;
    if (path.startsWith(EXCLUDED_PATH_PREFIX)) return false;
  }
  const origin = typeof input.origin === 'string' ? input.origin.trim() : '';
  if (origin && EXCLUDED_ORIGINS.has(origin)) return false;
  return true;
}

/**
 * Record one successful createPin broadcast into the chain content ledger.
 * Never throws and never touches the createPin return value: a missing store
 * (tests, early startup) or any store failure degrades to a console.warn.
 *
 * Skipped results: sponsor-flow draft-phase successes carry no real pin
 * (`result.draft` set / empty pinId) — nothing was broadcast yet.
 *
 * Payload handling mirrors spawnCreatePinWorker: a string payload without
 * `encoding: 'base64'` is text and is stored in full (the store caps it);
 * Buffer payloads and base64 strings are binary — only their metadata
 * (byte size + content type) is recorded, never the content.
 */
export function recordChainWriteFromCreatePin(
  metabotId: number,
  metaidData: MetaidDataPayload,
  result: CreatePinResult,
  origin?: string | null,
): void {
  try {
    const store = getChainContentHistoryStore();
    if (!store) return;
    const pinId = String(result?.pinId ?? '').trim();
    if (!pinId || result?.draft) return;
    const path = metaidData?.path ?? null;
    if (!shouldRecordChainWrite({ path, origin })) return;

    const payload = metaidData?.payload;
    const isText = typeof payload === 'string' && metaidData?.encoding !== 'base64';
    let contentBytes: number | null = null;
    if (!isText) {
      if (Buffer.isBuffer(payload)) {
        contentBytes = payload.length;
      } else if (typeof payload === 'string') {
        // base64 string payload: record the decoded byte size.
        contentBytes = Buffer.byteLength(payload, 'base64');
      }
    }

    store.recordWrite({
      metabotId,
      pinId,
      txId: Array.isArray(result.txids) ? (result.txids[0] ?? null) : null,
      path,
      operation: metaidData?.operation ?? null,
      contentText: isText ? (payload as string) : null,
      contentBytes,
      contentType: metaidData?.contentType ?? null,
      origin: origin ?? null,
      occurredAtMs: Date.now(),
    });
  } catch (error) {
    console.warn('[ChainWriteLedger] Failed to record chain write:', error);
  }
}
