/**
 * OpenTeam simplemsg envelope protocol (M1): the private-chat handshake used to
 * invite a remote bot into an on-chain group task. Three plaintext envelopes,
 * tag-prefixed like serviceOrderProtocols.js:
 *
 *   [OPENTEAM_INVITE] {JSON}
 *     { v:1, inviteId, groupId, taskTitle, goalSummary, requiredSkills[],
 *       inviterGlobalMetaId, inviterName, chairGlobalMetaId, targetGlobalMetaId,
 *       expiresAt }
 *   [OPENTEAM_ACCEPT:inviteId] {JSON}   // { joinedPinId }
 *   [OPENTEAM_DECLINE:inviteId] reason  // plain-text reason
 *   [OPENTEAM_KICK] {JSON}              // { v:1, groupId, taskTitle, reason }
 *
 * The KICK envelope is the chair's one-way kick notification (M3): the kicked
 * guest marks its membership left so it stops consuming the group without
 * waiting for the periodic on-chain membership self-check. It carries no
 * inviteId and expects no reply.
 *
 * inviteId is the pinId of the invite pin (`<txid>i0`, hex + literal `i0`), so
 * it is always safe to embed in the bracket-tag `:param` position. All parsers
 * are total: malformed input returns null, never throws.
 */

export const OPENTEAM_INVITE_TAG = 'OPENTEAM_INVITE';
export const OPENTEAM_ACCEPT_TAG = 'OPENTEAM_ACCEPT';
export const OPENTEAM_DECLINE_TAG = 'OPENTEAM_DECLINE';
export const OPENTEAM_KICK_TAG = 'OPENTEAM_KICK';

/** pinId shape: 64 hex chars + literal `i0` (case-insensitive on parse). */
const OPENTEAM_PINID_RE = /^[0-9a-f]{64}i0$/i;
/** `[TAG]` or `[TAG:<pinId>]` at the very start of the plaintext. */
const OPENTEAM_TAG_RE = /^\[([A-Za-z_]+)(?::([0-9a-fA-F]{64}i0))?\]/;

export interface OpenTeamInvitePayload {
  v: 1;
  /** pinId of the invite pin; doubles as the invite identifier. */
  inviteId: string;
  groupId: string;
  taskTitle: string;
  goalSummary: string;
  requiredSkills: string[];
  inviterGlobalMetaId: string;
  inviterName: string;
  chairGlobalMetaId: string;
  /** The bot this invite is addressed to; mismatching recipients must decline. */
  targetGlobalMetaId: string;
  /** Unix seconds after which the invite is no longer acceptable. */
  expiresAt: number;
}

export interface OpenTeamAcceptEnvelope {
  kind: 'accept';
  inviteId: string;
  joinedPinId: string;
}

export interface OpenTeamDeclineEnvelope {
  kind: 'decline';
  inviteId: string;
  reason: string;
}

export interface OpenTeamInviteEnvelope {
  kind: 'invite';
  invite: OpenTeamInvitePayload;
}

export interface OpenTeamKickPayload {
  v: 1;
  groupId: string;
  taskTitle: string;
  reason: string;
}

export interface OpenTeamKickEnvelope {
  kind: 'kick';
  kick: OpenTeamKickPayload;
}

export type OpenTeamEnvelope =
  | OpenTeamInviteEnvelope
  | OpenTeamAcceptEnvelope
  | OpenTeamDeclineEnvelope
  | OpenTeamKickEnvelope;

/** Lowercase-normalized pinId, or '' when the value is not a valid pinId. */
function normalizeOpenTeamPinId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return OPENTEAM_PINID_RE.test(normalized) ? normalized : '';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asTrimmedString(entry))
    .filter((entry) => entry.length > 0);
}

function asPositiveFiniteNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(num) && num > 0 ? num : Number.NaN;
}

export function buildOpenTeamInviteMessage(payload: OpenTeamInvitePayload): string {
  return `[${OPENTEAM_INVITE_TAG}] ${JSON.stringify(payload ?? {})}`;
}

export function buildOpenTeamAcceptMessage(inviteId: string, joinedPinId: string): string {
  return `[${OPENTEAM_ACCEPT_TAG}:${normalizeOpenTeamPinId(inviteId)}] ${JSON.stringify({ joinedPinId: asTrimmedString(joinedPinId) })}`;
}

export function buildOpenTeamDeclineMessage(inviteId: string, reason: string): string {
  const text = asTrimmedString(reason);
  return `[${OPENTEAM_DECLINE_TAG}:${normalizeOpenTeamPinId(inviteId)}]${text ? ` ${text}` : ''}`;
}

export function buildOpenTeamKickMessage(payload: OpenTeamKickPayload): string {
  return `[${OPENTEAM_KICK_TAG}] ${JSON.stringify(payload ?? {})}`;
}

/** Parse and validate the kick JSON body; null on any malformed field. */
function parseOpenTeamKickPayload(jsonText: string): OpenTeamKickPayload | null {
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  const groupId = asTrimmedString(record.groupId);
  if (!groupId) return null;
  return {
    v: 1,
    groupId,
    taskTitle: asTrimmedString(record.taskTitle),
    reason: asTrimmedString(record.reason),
  };
}

/** Parse and validate the invite JSON body; null on any malformed field. */
function parseOpenTeamInvitePayload(jsonText: string): OpenTeamInvitePayload | null {
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  const inviteId = normalizeOpenTeamPinId(record.inviteId);
  const groupId = asTrimmedString(record.groupId);
  const inviterGlobalMetaId = asTrimmedString(record.inviterGlobalMetaId);
  const targetGlobalMetaId = asTrimmedString(record.targetGlobalMetaId);
  const expiresAt = asPositiveFiniteNumber(record.expiresAt);
  if (!inviteId || !groupId || !inviterGlobalMetaId || !targetGlobalMetaId) return null;
  if (!Number.isFinite(expiresAt)) return null;
  return {
    v: 1,
    inviteId,
    groupId,
    taskTitle: asTrimmedString(record.taskTitle),
    goalSummary: asTrimmedString(record.goalSummary),
    requiredSkills: asStringArray(record.requiredSkills),
    inviterGlobalMetaId,
    inviterName: asTrimmedString(record.inviterName),
    chairGlobalMetaId: asTrimmedString(record.chairGlobalMetaId),
    targetGlobalMetaId,
    expiresAt,
  };
}

/**
 * Parse any of the four OpenTeam envelopes. Returns a discriminated union on
 * success, null for non-OpenTeam or malformed input. Never throws.
 */
export function parseOpenTeamEnvelope(plaintext: string): OpenTeamEnvelope | null {
  const trimmed = String(plaintext || '').trim();
  const match = trimmed.match(OPENTEAM_TAG_RE);
  if (!match) return null;
  const tag = String(match[1] || '').toUpperCase();
  const tagInviteId = normalizeOpenTeamPinId(match[2]);
  const rest = trimmed.slice(match[0].length).trim();

  if (tag === OPENTEAM_INVITE_TAG) {
    const invite = parseOpenTeamInvitePayload(rest);
    return invite ? { kind: 'invite', invite } : null;
  }
  if (tag === OPENTEAM_ACCEPT_TAG) {
    if (!tagInviteId || !rest) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rest);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const joinedPinId = asTrimmedString((parsed as Record<string, unknown>).joinedPinId);
    if (!joinedPinId) return null;
    return { kind: 'accept', inviteId: tagInviteId, joinedPinId };
  }
  if (tag === OPENTEAM_DECLINE_TAG) {
    if (!tagInviteId) return null;
    return { kind: 'decline', inviteId: tagInviteId, reason: rest };
  }
  if (tag === OPENTEAM_KICK_TAG) {
    const kick = parseOpenTeamKickPayload(rest);
    return kick ? { kind: 'kick', kick } : null;
  }
  return null;
}
