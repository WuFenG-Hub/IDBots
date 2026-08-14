/**
 * Chat gateway route logic — pure functions, no Electron, no direct I/O.
 *
 * Backs the two HTTP routes registered in metaidRpcServer.ts:
 *   POST /api/idbots/chat/private-send     (Mega-Phase M4 R-M4.1 — send an
 *                                           encrypted simplemsg to a peer)
 *   POST /api/idbots/chat/private-history  (Mega-Phase M4 R-M4.1 — recent
 *                                           messages with a peer, read-only)
 *
 * The handlers validate + map; all I/O (wallet, chain API, db, create-pin)
 * arrives through injected deps so the logic is unit-testable under plain
 * `node` without Electron or a port.
 */
import {
  sendEncryptedSimplemsg,
  type SendEncryptedSimplemsgResult,
} from './encryptedSimplemsg';
import type { MetaidDataPayload } from './metaidCore';

export type ChatGatewayRouteResult = {
  status: number;
  body: Record<string, unknown>;
};

export interface ChatHistoryRow {
  id: number;
  direction: 'in' | 'out';
  content: string;
  timestamp: number;
}

/** Dependencies injected by the route chain (metaidRpcServer.ts). */
export interface ChatGatewayDeps {
  /** Internal: the bot's mnemonic (never exposed in any response). */
  getWalletMnemonic: (metabotId: number) => string;
  /** Resolve a peer's ECDH chat pubkey: local history first, chain API fallback. */
  resolvePeerChatPubkey: (peerGlobalMetaId: string) => Promise<string>;
  /** Broadcast a `/protocols/simplemsg` pin (create-pin with the bot's wallet). */
  createSimplemsgPin: (
    metabotId: number,
    payload: MetaidDataPayload
  ) => Promise<SendEncryptedSimplemsgResult>;
  /** Read recent messages between the bot and a peer (newest last). */
  readHistory: (
    metabotId: number,
    peerGlobalMetaId: string,
    limit: number
  ) => Promise<ChatHistoryRow[]>;
}

const MAX_HISTORY_LIMIT = 200;
const MAX_CONTENT_BYTES = 64 * 1024;

function jsonError(status: number, error: string): ChatGatewayRouteResult {
  return { status, body: { success: false, error } };
}

function jsonOk(body: Record<string, unknown>): ChatGatewayRouteResult {
  return { status: 200, body: { success: true, ...body } };
}

function parseJsonBody(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function requirePositiveInt(value: unknown, field: string): number | null {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

function requireNonEmptyString(value: unknown, field: string): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text;
}

/**
 * POST /api/idbots/chat/private-send — encrypt + broadcast a private message
 * to a peer MetaBot (simplemsg protocol, ECDH). Read the deps carefully: the
 * mnemonic is fetched internally and never appears in any response.
 */
export async function handlePrivateSendRoute(
  deps: ChatGatewayDeps,
  rawBody: string
): Promise<ChatGatewayRouteResult> {
  const parsed = parseJsonBody(rawBody);
  if (!parsed) return jsonError(400, 'Invalid JSON body');

  const metabotId = requirePositiveInt(parsed.metabot_id, 'metabot_id');
  const to = requireNonEmptyString(parsed.to_global_meta_id, 'to_global_meta_id');
  const content = requireNonEmptyString(parsed.content, 'content');
  if (metabotId === null) return jsonError(400, 'metabot_id is required (positive integer)');
  if (!to) return jsonError(400, 'to_global_meta_id is required');
  if (!content) return jsonError(400, 'content is required');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return jsonError(400, `content exceeds ${MAX_CONTENT_BYTES} bytes`);
  }
  const replyPin = typeof parsed.reply_pin === 'string' && parsed.reply_pin.trim()
    ? parsed.reply_pin.trim()
    : null;

  const mnemonic = deps.getWalletMnemonic(metabotId);
  if (!mnemonic.trim()) {
    return jsonError(400, `no wallet for metabot ${metabotId}`);
  }

  let peerChatPubkey = '';
  try {
    peerChatPubkey = await deps.resolvePeerChatPubkey(to);
  } catch {
    return jsonError(502, `failed to resolve peer chat pubkey for ${to}`);
  }
  if (!peerChatPubkey.trim()) {
    return jsonError(400, `peer chat pubkey unavailable for ${to}`);
  }

  try {
    const sent = await sendEncryptedSimplemsg({
      metabotId,
      wallet: { mnemonic },
      peerGlobalMetaId: to,
      peerChatPubkey,
      plaintext: content,
      replyPin,
      createPin: deps.createSimplemsgPin,
    });
    return jsonOk({ pinId: sent.pinId, txids: sent.txids, to });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /api/idbots/chat/private-history — recent messages with a peer
 * (read-only; no wallet, no chain write).
 */
export async function handlePrivateHistoryRoute(
  deps: Pick<ChatGatewayDeps, 'readHistory'>,
  rawBody: string
): Promise<ChatGatewayRouteResult> {
  const parsed = parseJsonBody(rawBody);
  if (!parsed) return jsonError(400, 'Invalid JSON body');

  const metabotId = requirePositiveInt(parsed.metabot_id, 'metabot_id');
  const peer = requireNonEmptyString(parsed.peer_global_meta_id, 'peer_global_meta_id');
  if (metabotId === null) return jsonError(400, 'metabot_id is required (positive integer)');
  if (!peer) return jsonError(400, 'peer_global_meta_id is required');

  const limitRaw = Number(parsed.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MAX_HISTORY_LIMIT)
    : 50;

  try {
    const messages = await deps.readHistory(metabotId, peer, limit);
    return jsonOk({ peer, messages });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}
