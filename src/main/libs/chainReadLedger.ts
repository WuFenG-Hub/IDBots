/**
 * Chain read ledger gate ("MetaBot 阅读账本").
 *
 * Records every chain pin a MetaBot fully opened through the read tools into
 * the `metabot_chain_reads` table (see chainContentHistoryStore.ts), and
 * back-fills the `saved_to_kb` flag when a read pin is later saved into a
 * knowledge base. Searches and list browsing are intentionally NOT recorded —
 * only full-content reads:
 *  - read_metaweb_pin           (metawebLearningAgentTools)
 *  - social_post_detail         (socialRecallAgentTools; comments/search excluded)
 *  - omni_read pin-class actions (pin / pin_content / buzz_info)
 *
 * The mapping from each tool's payload shape to RecordChainReadInput lives in
 * exported pure functions so it stays unit-testable; recordChainReadSafe /
 * markChainReadSavedToKbSafe are the side-effecting entry points. Recording is
 * fire-and-forget: a missing store (unit tests, early startup), an
 * unattributed session (metabotId null), or any store failure degrades to a
 * console.warn and never changes the tool's return value.
 */

import { getChainContentHistoryStore } from '../chainContentHistoryRuntime';
import type { RecordChainReadInput } from '../chainContentHistoryStore';
import type { MetawebPin } from '../services/metawebPinService';
import type { SocialPostItem } from '../services/socialRecallService';

type MetabotIdLike = number | null | undefined;

const isValidMetabotId = (value: MetabotIdLike): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Trimmed non-empty string for metadata fields; null otherwise. */
function metaOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Content text is kept verbatim but treated as absent when effectively empty. */
function contentOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** read_metaweb_pin — the pin is fully normalized host-side (MetawebPin). */
export function readInputFromMetawebPin(
  pin: MetawebPin,
  metabotId: MetabotIdLike,
  source: string,
): RecordChainReadInput | null {
  if (!isValidMetabotId(metabotId)) return null;
  const pinId = metaOrNull(pin?.pinId);
  if (!pinId) return null;
  return {
    metabotId,
    pinId,
    path: metaOrNull(pin?.path),
    protocol: metaOrNull(pin?.protocol),
    title: metaOrNull(pin?.meta?.title),
    authorGlobalMetaId: metaOrNull(pin?.creator?.globalMetaId),
    contentText: contentOrNull(pin?.text),
    contentBytes: null,
    source,
    readAtMs: Date.now(),
  };
}

/** social_post_detail — simplebuzz posts carry no title/protocol fields. */
export function readInputFromSocialPost(
  post: SocialPostItem,
  metabotId: MetabotIdLike,
): RecordChainReadInput | null {
  if (!isValidMetabotId(metabotId)) return null;
  const pinId = metaOrNull(post?.pinId);
  if (!pinId) return null;
  return {
    metabotId,
    pinId,
    path: metaOrNull(post?.protocolPath),
    protocol: null,
    title: null,
    authorGlobalMetaId: metaOrNull(post?.author?.globalMetaId),
    contentText: contentOrNull(post?.payload?.content),
    contentBytes: null,
    source: 'social_post_detail',
    readAtMs: Date.now(),
  };
}

// Best-effort key tables for the raw indexer JSON returned by omni_read —
// the responses are not normalized host-side, so every lookup tolerates the
// common spellings seen across manapi / shownow / metafile-indexer payloads.
const OMNI_PIN_ID_KEYS = ['pinId', 'pinid', 'pin_id', 'id'] as const;
const OMNI_CONTENT_KEYS = ['contentBody', 'content', 'text', 'body'] as const;
const OMNI_AUTHOR_KEYS = ['creator', 'author'] as const;
const OMNI_GLOBAL_METAID_KEYS = ['globalMetaId', 'globalmetaid', 'globalMetaID'] as const;

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = metaOrNull(record[key]);
    if (value) return value;
  }
  return null;
}

/**
 * Unwrap common `{code, data}` / `{code, result}` envelopes (up to 3 levels),
 * stopping early at the first level that already carries a pin id. Returns
 * null for non-object input and for business-error envelopes (code !== 0) —
 * an error page is not a completed read.
 */
function unwrapOmniPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let node = raw as Record<string, unknown>;
  for (let depth = 0; depth < 3; depth += 1) {
    const code = node.code;
    if (typeof code === 'number' && code !== 0) return null;
    if (firstString(node, OMNI_PIN_ID_KEYS)) return node;
    const inner = node.data ?? node.result;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      node = inner as Record<string, unknown>;
      continue;
    }
    return node;
  }
  return node;
}

function omniAuthorGlobalMetaId(node: Record<string, unknown>): string | null {
  for (const key of OMNI_AUTHOR_KEYS) {
    const holder = node[key];
    if (holder && typeof holder === 'object' && !Array.isArray(holder)) {
      const value = firstString(holder as Record<string, unknown>, OMNI_GLOBAL_METAID_KEYS);
      if (value) return value;
    }
  }
  return firstString(node, OMNI_GLOBAL_METAID_KEYS);
}

/**
 * omni_read pin-class actions (pin / pin_content / buzz_info). `json` is the
 * raw indexer payload — a decoded object for pin/buzz_info, or the raw body
 * string for pin_content. `fallbackPinId` is the requested pin id, used when
 * the payload itself does not echo one. Returns null (skip recording) when no
 * pin id can be resolved at all.
 */
export function readInputFromOmniJson(
  action: string,
  json: unknown,
  fallbackPinId: string,
  metabotId: MetabotIdLike,
): RecordChainReadInput | null {
  if (!isValidMetabotId(metabotId)) return null;
  const source = `omni_read:${metaOrNull(action) ?? 'unknown'}`;
  const fallback = metaOrNull(fallbackPinId);

  // pin_content returns the raw body string, not a JSON document.
  if (typeof json === 'string') {
    if (!fallback) return null;
    return {
      metabotId,
      pinId: fallback,
      path: null,
      protocol: null,
      title: null,
      authorGlobalMetaId: null,
      contentText: contentOrNull(json),
      contentBytes: null,
      source,
      readAtMs: Date.now(),
    };
  }

  const node = unwrapOmniPayload(json);
  if (!node) return null;
  const pinId = firstString(node, OMNI_PIN_ID_KEYS) ?? fallback;
  if (!pinId) return null;
  const meta = node.meta && typeof node.meta === 'object' && !Array.isArray(node.meta)
    ? node.meta as Record<string, unknown>
    : null;
  return {
    metabotId,
    pinId,
    path: metaOrNull(node.path),
    protocol: metaOrNull(node.protocol),
    title: metaOrNull(node.title) ?? (meta ? metaOrNull(meta.title) : null),
    authorGlobalMetaId: omniAuthorGlobalMetaId(node),
    contentText: contentOrNull(firstString(node, OMNI_CONTENT_KEYS)),
    contentBytes: null,
    source,
    readAtMs: Date.now(),
  };
}

/**
 * Record one completed chain read. Never throws; a null input (unattributed
 * session / unmappable payload), a missing store, or any store failure is a
 * silent skip or a console.warn, and the tool's return value is untouched.
 */
export function recordChainReadSafe(input: RecordChainReadInput | null | undefined): void {
  try {
    if (!input || !isValidMetabotId(input.metabotId)) return;
    const store = getChainContentHistoryStore();
    if (!store) return;
    store.recordRead({
      ...input,
      readAtMs: Number.isFinite(input.readAtMs) ? input.readAtMs : Date.now(),
    });
  } catch (error) {
    console.warn('[ChainReadLedger] Failed to record chain read:', error);
  }
}

/**
 * Back-fill `saved_to_kb` when a previously read pin is saved into a
 * knowledge base. Same never-throw posture as recordChainReadSafe.
 */
export function markChainReadSavedToKbSafe(
  metabotId: MetabotIdLike,
  pinId: unknown,
  kbId: string | null,
): void {
  try {
    if (!isValidMetabotId(metabotId)) return;
    const id = metaOrNull(pinId);
    if (!id) return;
    const store = getChainContentHistoryStore();
    if (!store) return;
    store.markReadSavedToKb(metabotId, id, kbId);
  } catch (error) {
    console.warn('[ChainReadLedger] Failed to mark chain read as saved to KB:', error);
  }
}
