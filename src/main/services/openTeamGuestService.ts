/**
 * OpenTeam guest service (M1): the invitee side of the OpenTeam handshake plus
 * the inviter-side ACCEPT/DECLINE bookkeeping.
 *
 * Guest flow: validate an incoming [OPENTEAM_INVITE] envelope against local
 * policy (bot enabled -> allowRemoteCollab switch -> target match -> duplicate
 * -> expiry), join the group on-chain, record the membership (which instantly
 * adds the group to the chat backfill union) and reply ACCEPT/DECLINE via
 * encrypted simplemsg. Any validation failure still gets a DECLINE reply so
 * the inviter learns why.
 *
 * Dependencies are injectable two ways: handleOpenTeamInvite takes an explicit
 * deps object (tests), while the privateChatDaemon interception path calls the
 * module-level handleIncomingOpenTeamInvite / handleIncomingOpenTeamResponse,
 * which resolve the deps wired once by main.ts (setOpenTeamGuestServiceDeps,
 * same setter-injection style as groupChatTransport).
 */

import type { CoworkStore } from '../coworkStore';
import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import type {
  OpenTeamInvite,
  OpenTeamInviteStatus,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import type {
  SendEncryptedSimplemsgResult,
  SimplemsgWalletInput,
} from './encryptedSimplemsg';
import {
  buildOpenTeamAcceptMessage,
  buildOpenTeamDeclineMessage,
  type OpenTeamAcceptEnvelope,
  type OpenTeamDeclineEnvelope,
  type OpenTeamInvitePayload,
} from './openTeamProtocols';
import {
  ensureOpenTeamGuestSession,
  injectOpenTeamGuestContext,
} from './groupTaskSession';

/** Per-metabot kill switch (metabot_settings kv): missing = allowed, '0' = off. */
export const OPENTEAM_ALLOW_REMOTE_COLLAB_KEY = 'openteam.allowRemoteCollab';

/** deps.sendEncryptedSimplemsg already has createPin bound by the host. */
export type OpenTeamGuestSendSimplemsgFn = (input: {
  metabotId: number;
  wallet: SimplemsgWalletInput;
  peerGlobalMetaId: string;
  peerChatPubkey: string;
  plaintext: string;
  replyPin?: string | null;
}) => Promise<SendEncryptedSimplemsgResult>;

export interface OpenTeamGuestServiceDeps {
  getMetabotStore: () => MetabotStore;
  getMembershipStore: () => OpenTeamMembershipStore;
  joinGroupChat: (metabotId: number, groupId: string) => Promise<{ pinId: string }>;
  sendEncryptedSimplemsg: OpenTeamGuestSendSimplemsgFn;
  emitLog?: (message: string) => void;
  now?: () => number;
  /**
   * P1-3 (invitee-side immediate wake-up): when wired, the ACCEPT flow
   * eagerly creates the invited bot's cowork session and injects the group
   * context (task title + recent transcript) — the worker session exists
   * within seconds of the invite instead of waiting ~20 min for a lazy
   * daemon-created session.
   */
  getCoworkStore?: () => CoworkStore;
  listRecentGroupMessages?: (
    groupId: string,
    limit: number,
  ) => Array<{ senderName: string | null; content: string | null }>;
}

export interface OpenTeamInviteReplyContext {
  /** Inviter's globalMetaId (sender of the invite simplemsg). */
  peerGlobalMetaId: string;
  /** Inviter's chat pubkey (from_chat_pubkey of the invite row). */
  peerChatPubkey: string;
  /** Invite pin id; used as replyPin on the ACCEPT/DECLINE reply. */
  invitePinId: string;
}

export interface OpenTeamGuestResult {
  action: 'accepted' | 'declined';
  /** Short machine-ish decline reason tag (empty when accepted). */
  reason: string;
  joinedPinId: string | null;
  /** pinId of the ACCEPT/DECLINE simplemsg we sent back (null when unsent). */
  replyPinId: string | null;
}

let deps: OpenTeamGuestServiceDeps | null = null;

export function setOpenTeamGuestServiceDeps(next: OpenTeamGuestServiceDeps): void {
  deps = next;
}

export function resetOpenTeamGuestServiceDeps(): void {
  deps = null;
}

function getOpenTeamGuestServiceDeps(): OpenTeamGuestServiceDeps {
  if (!deps) {
    throw new Error('openTeamGuestService not initialized: call setOpenTeamGuestServiceDeps first');
  }
  return deps;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Core guest accept flow with explicit deps (unit-testable). Validation order:
 * bot enabled -> allowRemoteCollab switch -> target match -> duplicate -> expiry.
 * Every failure path replies DECLINE with a reason; a join failure also
 * declines (reason carries the underlying error, e.g. insufficient balance).
 */
export async function handleOpenTeamInvite(
  deps: OpenTeamGuestServiceDeps,
  input: {
    metabot: Metabot;
    invite: OpenTeamInvitePayload;
    replyContext: OpenTeamInviteReplyContext;
  },
): Promise<OpenTeamGuestResult> {
  const { metabot, invite, replyContext } = input;
  const emitLog = deps.emitLog ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());
  const metabotStore = deps.getMetabotStore();
  const membershipStore = deps.getMembershipStore();

  const sendReply = async (plaintext: string): Promise<string | null> => {
    const wallet = metabotStore.getMetabotWalletByMetabotId(metabot.id);
    if (!wallet?.mnemonic?.trim()) {
      emitLog(`[OpenTeam] MetaBot ${metabot.id}: cannot reply to invite (no wallet)`);
      return null;
    }
    try {
      const sent = await deps.sendEncryptedSimplemsg({
        metabotId: metabot.id,
        wallet,
        peerGlobalMetaId: replyContext.peerGlobalMetaId,
        peerChatPubkey: replyContext.peerChatPubkey,
        plaintext,
        replyPin: replyContext.invitePinId,
      });
      return sent.pinId ?? null;
    } catch (error) {
      emitLog(
        `[OpenTeam] MetaBot ${metabot.id}: invite reply send failed: ${errorMessage(error)}`,
      );
      return null;
    }
  };

  const decline = async (reason: string, detail?: string): Promise<OpenTeamGuestResult> => {
    const text = detail ? `${reason}: ${detail}` : reason;
    emitLog(`[OpenTeam] MetaBot ${metabot.id}: declining invite ${invite.inviteId} (${text})`);
    const replyPinId = await sendReply(buildOpenTeamDeclineMessage(invite.inviteId, text));
    return { action: 'declined', reason, joinedPinId: null, replyPinId };
  };

  if (metabot.enabled === false) {
    return decline('bot_disabled', 'the invited MetaBot is disabled');
  }
  const allowRemoteCollab = metabotStore.getMetabotSetting(metabot.id, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY);
  if (allowRemoteCollab === '0') {
    return decline('remote_collab_disabled', 'remote collaboration is disabled by the bot owner');
  }
  const localGlobalMetaId = (metabot.globalmetaid ?? '').trim();
  if (!localGlobalMetaId || localGlobalMetaId !== invite.targetGlobalMetaId.trim()) {
    return decline('target_mismatch', 'invite target does not match this bot');
  }
  const existing = membershipStore.getMembership(invite.groupId, metabot.id);
  if (existing?.status === 'active') {
    return decline('already_member', 'bot is already an active member of this group');
  }
  if (invite.expiresAt * 1000 <= now()) {
    return decline('invite_expired', 'the invite has expired');
  }

  let joinedPinId: string;
  try {
    const joined = await deps.joinGroupChat(metabot.id, invite.groupId);
    joinedPinId = joined.pinId;
  } catch (error) {
    return decline('join_failed', errorMessage(error));
  }

  try {
    membershipStore.upsertActiveMembership({
      groupId: invite.groupId,
      metabotId: metabot.id,
      globalmetaid: localGlobalMetaId,
      inviterGlobalmetaid: invite.inviterGlobalMetaId,
      taskTitle: invite.taskTitle,
      invitePinId: invite.inviteId,
      joinedPinId,
    });
    // The guest daemon answers only messages arriving after the join.
    membershipStore.catchUpCursorToLatest(invite.groupId, metabot.id);
  } catch (error) {
    // Joined on-chain but the local record failed: decline so the inviter does
    // not wait on a member we cannot track. The membership UNIQUE upsert makes
    // a later re-invite converge back to active.
    return decline('membership_record_failed', errorMessage(error));
  }

  // P1-3 (invitee-side immediate wake-up): eagerly create the invited bot's
  // cowork session and inject the group context. Best-effort — a session
  // failure must never flip a successful join into a decline.
  try {
    if (deps.getCoworkStore && deps.listRecentGroupMessages) {
      const coworkStore = deps.getCoworkStore();
      const { session } = ensureOpenTeamGuestSession(
        coworkStore,
        metabot.id,
        metabot.name?.trim() || `bot-${metabot.id}`,
        { groupId: invite.groupId, taskTitle: invite.taskTitle },
      );
      injectOpenTeamGuestContext({
        coworkStore,
        sessionId: session.id,
        taskTitle: invite.taskTitle,
        inviterGlobalmetaid: invite.inviterGlobalMetaId,
        recentMessages: deps.listRecentGroupMessages(invite.groupId, 20),
      });
      emitLog(
        `[OpenTeam] MetaBot ${metabot.id}: guest session ready for group ${invite.groupId} (${session.id})`,
      );
    }
  } catch (error) {
    emitLog(
      `[OpenTeam] MetaBot ${metabot.id}: guest session pre-creation failed (continuing without it): ${errorMessage(error)}`,
    );
  }

  emitLog(
    `[OpenTeam] MetaBot ${metabot.id}: accepted invite ${invite.inviteId}, joined group ${invite.groupId} (pin ${joinedPinId})`,
  );
  const replyPinId = await sendReply(buildOpenTeamAcceptMessage(invite.inviteId, joinedPinId));
  return { action: 'accepted', reason: '', joinedPinId, replyPinId };
}

/** Daemon entry point: resolves the module deps wired by main.ts. */
export async function handleIncomingOpenTeamInvite(input: {
  metabot: Metabot;
  invite: OpenTeamInvitePayload;
  replyContext: OpenTeamInviteReplyContext;
}): Promise<OpenTeamGuestResult> {
  return handleOpenTeamInvite(getOpenTeamGuestServiceDeps(), input);
}

export interface OpenTeamResponseResult {
  /** True when a local invite row matched the envelope inviteId. */
  matched: boolean;
  invite: OpenTeamInvite | null;
}

/**
 * Inviter-side bookkeeping for ACCEPT/DECLINE envelopes: transition the
 * matching pending invite row. The join-confirmation watcher that turns an
 * accepted invite into a task member is a later milestone; here we only
 * persist the state change.
 */
export function handleOpenTeamResponse(
  deps: OpenTeamGuestServiceDeps,
  envelope: OpenTeamAcceptEnvelope | OpenTeamDeclineEnvelope,
): OpenTeamResponseResult {
  const emitLog = deps.emitLog ?? (() => undefined);
  const membershipStore = deps.getMembershipStore();
  const invite = membershipStore.getInviteByPinId(envelope.inviteId);
  if (!invite) {
    emitLog(`[OpenTeam] ${envelope.kind} for unknown invite ${envelope.inviteId}; ignored`);
    return { matched: false, invite: null };
  }
  if (invite.status !== 'pending') {
    emitLog(
      `[OpenTeam] ${envelope.kind} for invite ${envelope.inviteId} already ${invite.status}; ignored`,
    );
    return { matched: true, invite };
  }
  const status: OpenTeamInviteStatus = envelope.kind === 'accept' ? 'accepted' : 'declined';
  const declineReason = envelope.kind === 'decline' ? envelope.reason || null : null;
  const updated = membershipStore.updateInviteStatus(
    { invitePinId: envelope.inviteId },
    status,
    declineReason,
  );
  emitLog(
    `[OpenTeam] Invite ${envelope.inviteId} marked ${status}` +
    (declineReason ? ` (${declineReason})` : ''),
  );
  return { matched: true, invite: updated };
}

/** Daemon entry point: resolves the module deps wired by main.ts. */
export function handleIncomingOpenTeamResponse(
  envelope: OpenTeamAcceptEnvelope | OpenTeamDeclineEnvelope,
): OpenTeamResponseResult {
  return handleOpenTeamResponse(getOpenTeamGuestServiceDeps(), envelope);
}
