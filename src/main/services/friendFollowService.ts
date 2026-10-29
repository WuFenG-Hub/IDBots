import type { MetaidDataPayload } from './metaidCore';
import { normalizeGlobalMetaID } from '../shared/globalMetaId';

/**
 * Friend follow/unfollow write side for A2A private chats (S5 of the
 * MetaBot friend/block task, spec docs/specs/2026-10-29-social-friend-block-api.md
 * §2.4/§3.1): every NEW follow pin writes the peer's GlobalMetaID as a plain
 * string contentBody, and unfollow revokes the original follow pin through
 * `/follow@<originalFollowPinId>`.
 *
 * The LLM signals intent with an inline tag in its reply (the one-shot A2A
 * reply chain has no tool surface); the daemon strips the tag before
 * delivery and drives the owner-authorized chain write separately.
 */

/** Reply tag the A2A system prompt instructs the LLM to emit to propose a mutual friend invite. */
export const FRIEND_INVITE_TAG = '[FRIEND_INVITE]';
/** Reply tag to end a friendship this bot established (revoke the /follow pin). */
export const FRIEND_REMOVE_TAG = '[FRIEND_REMOVE]';

export type FriendActionKind = 'invite' | 'remove';

// Cosmetic wrapping tolerated AROUND the tag (quotes, CJK/Latin parentheses,
// CJK brackets, spaces) — deliberately excluding [ and ] so the tag's own
// brackets always survive normalization.
const TAG_LEADING_WRAP_RE = /^[\s"'`“”‘’（(【]+/;
const TAG_TRAILING_WRAP_RE = /[\s"'`“”‘’）)】.,;。！!？?]+$/;

const normalizeTagToken = (token: string): string => token
  .replace(TAG_LEADING_WRAP_RE, '')
  .replace(TAG_TRAILING_WRAP_RE, '')
  .trim()
  .toUpperCase();

/**
 * Extract friend-action tags from an A2A reply. Tags stand on their own line
 * (cosmetic wrapping tolerated, mirroring the [NO_REPLY] sentinel's leniency)
 * and are removed from the delivered text. Invite wins when both tags appear.
 */
export function extractFriendActionTags(reply: string): {
  text: string;
  action: FriendActionKind | null;
} {
  const raw = typeof reply === 'string' ? reply : '';
  const keptLines: string[] = [];
  let invite = false;
  let remove = false;
  for (const line of raw.split('\n')) {
    const token = normalizeTagToken(line);
    if (token === FRIEND_INVITE_TAG) {
      invite = true;
      continue;
    }
    if (token === FRIEND_REMOVE_TAG) {
      remove = true;
      continue;
    }
    keptLines.push(line);
  }
  const action: FriendActionKind | null = invite ? 'invite' : remove ? 'remove' : null;
  // Trim the trailing blank lines the stripped tags may leave behind, but
  // keep interior formatting untouched.
  const text = keptLines.join('\n').replace(/[\s\n]+$/, '').trim();
  return { text, action };
}

/** Canonical GlobalMetaID validation (shared normalizer) — the write side never falls back to legacy hex. */
export function isValidGlobalMetaIdRef(value: unknown): value is string {
  return normalizeGlobalMetaID(value) !== null;
}

const normalizeFollowPinId = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^([0-9a-f]{64})i\d+$/.test(normalized) ? normalized : '';
};

/** create /follow payload per spec §3.1: contentBody = target GlobalMetaID plain string. */
export function buildFollowCreatePayload(peerGlobalMetaId: string): MetaidDataPayload {
  const peer = normalizeGlobalMetaID(peerGlobalMetaId);
  if (!peer) {
    throw new Error(`Invalid peer GlobalMetaID for /follow write: ${String(peerGlobalMetaId)}`);
  }
  return {
    operation: 'create',
    path: '/follow',
    encryption: '0',
    version: '1.0.0',
    contentType: 'text/plain',
    payload: peer,
    encoding: 'utf-8',
  };
}

/** revoke payload per the shipped contract: `/follow@<originalFollowPinId>` + operation revoke. */
export function buildFollowRevokePayload(followPinId: string): MetaidDataPayload {
  const pinId = normalizeFollowPinId(followPinId);
  if (!pinId) {
    throw new Error(`Invalid original /follow pinId to revoke: ${String(followPinId)}`);
  }
  return {
    operation: 'revoke',
    path: `/follow@${pinId}`,
    encryption: '0',
    version: '1.0.0',
    contentType: 'text/plain',
    payload: '',
    encoding: 'utf-8',
  };
}

/** Conversation-mapping metadata key holding this bot's active /follow pin toward the peer. */
export const FRIEND_FOLLOW_PIN_METADATA_KEY = 'friendFollowPin';

export interface FriendFollowRecord {
  pinId: string;
  txid?: string;
  followedAt?: number;
}

export function readFriendFollowRecord(metadata: Record<string, unknown> | null | undefined): FriendFollowRecord | null {
  const raw = metadata?.[FRIEND_FOLLOW_PIN_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const pinId = normalizeFollowPinId(record.pinId);
  if (!pinId) return null;
  return {
    pinId,
    txid: typeof record.txid === 'string' && record.txid.trim() ? record.txid.trim() : undefined,
    followedAt: Number.isFinite(Number(record.followedAt)) ? Number(record.followedAt) : undefined,
  };
}

export function buildFriendFollowRecord(pinId: string, txid?: string): FriendFollowRecord {
  return {
    pinId,
    txid: txid && txid.trim() ? txid.trim() : undefined,
    followedAt: Date.now(),
  };
}

/** createPin signature the private-chat daemon already carries (metabot wallet publisher). */
export type FriendCreatePinFn = (
  metabotStore: unknown,
  metabotId: number,
  payload: MetaidDataPayload,
  options?: { origin?: string }
) => Promise<{ txids: string[]; pinId?: string }>;

/** Chain-write origin tag for ledger attribution (internal infrastructure write). */
export const FRIEND_FOLLOW_ORIGIN = 'internal:friend-follow';

async function publishFriendPin(
  createPin: FriendCreatePinFn,
  metabotStore: unknown,
  metabotId: number,
  payload: MetaidDataPayload
): Promise<{ pinId: string; txid: string }> {
  const result = await createPin(metabotStore, metabotId, payload, { origin: FRIEND_FOLLOW_ORIGIN });
  const pinId = typeof result?.pinId === 'string' ? result.pinId.trim() : '';
  const txid = Array.isArray(result?.txids) && typeof result.txids[0] === 'string' ? result.txids[0] : '';
  if (!pinId) {
    throw new Error(txid
      ? `/follow pin published without pinId (txid ${txid})`
      : '/follow pin publish returned no pinId');
  }
  return { pinId, txid };
}

/** Write the /follow create pin (owner already approved). Returns the new pin identity. */
export async function executeFriendFollowWrite(params: {
  createPin: FriendCreatePinFn;
  metabotStore: unknown;
  metabotId: number;
  peerGlobalMetaId: string;
}): Promise<{ pinId: string; txid: string }> {
  return publishFriendPin(
    params.createPin,
    params.metabotStore,
    params.metabotId,
    buildFollowCreatePayload(params.peerGlobalMetaId)
  );
}

/** Revoke the original /follow pin (owner already approved). */
export async function executeFriendUnfollowWrite(params: {
  createPin: FriendCreatePinFn;
  metabotStore: unknown;
  metabotId: number;
  followPinId: string;
}): Promise<{ pinId: string; txid: string }> {
  return publishFriendPin(
    params.createPin,
    params.metabotStore,
    params.metabotId,
    buildFollowRevokePayload(params.followPinId)
  );
}
