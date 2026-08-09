/**
 * OpenTeam inviter service (M1): the Twin/chair side of remote collaboration.
 *
 * - searchRemoteCandidates finds on-chain bots via the MetaID search API and
 *   filters them down to online, non-local candidates through idchat presence.
 * - inviteRemoteBot validates the target (runnable task, not local, not already
 *   a member, no pending duplicate, online, has a chat pubkey), sends an
 *   [OPENTEAM_INVITE] encrypted simplemsg from the twin wallet, records the
 *   pending invite in openteam_invites and starts a join-confirmation watcher.
 * - The watcher polls the invite row: once the guest's ACCEPT has landed
 *   (written by handleIncomingOpenTeamResponse in openTeamGuestService), it
 *   confirms the on-chain join via waitForMemberJoined and records the remote
 *   member (metabot_id NULL, deduped by globalmetaid). On timeout the invite
 *   is marked expired and the owner gets a heads-up through the group-task
 *   owner-report channel.
 *
 * inviteId note: the plan's "inviteId = the invite pin's pinId" is physically
 * impossible — a pinId derives from the pin content, so the content cannot
 * embed its own id. The inviteId is instead a random pinId-shaped string
 * (64 hex + 'i0') generated before sending; it is stored as
 * openteam_invites.invite_pin_id and echoed back by the guest in the
 * ACCEPT/DECLINE tag, which is all the matching needs.
 *
 * DI follows the module-level setter style of openTeamGuestService: main.ts
 * wires everything once via setOpenTeamServiceDeps; tests inject mocks the
 * same way. Watchers are module state — stopOpenTeamInviteWatchers cleans up
 * on shutdown/recovery, resumeOpenTeamInviteWatchers re-arms them after a
 * restart from the pending invite rows plus accepted-but-unconfirmed rows
 * (crash between the ACCEPT landing and the join confirmation) whose remote
 * member row is still missing.
 */

import { randomBytes } from 'crypto';
import type { MetabotStore } from '../metabotStore';
import type { GroupTaskStore } from '../groupTaskStore';
import type {
  OpenTeamInvite,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import { requireRunnableTask } from './groupTaskService';
import {
  getMetaIdDetail,
  searchMetaIds,
} from './metaIdSearchService';
import type { IdchatOnlineStatusResult } from './idchatPresenceService';
import type { OpenTeamGuestSendSimplemsgFn } from './openTeamGuestService';
import { buildOpenTeamInviteMessage } from './openTeamProtocols';

const DEFAULT_CANDIDATE_LIMIT = 10;
const MAX_CANDIDATE_LIMIT = 50;
const GOAL_SUMMARY_MAX_CHARS = 200;
const DEFAULT_INVITE_TTL_SECONDS = 600; // envelope expiresAt = now + 10 min
const DEFAULT_JOIN_CONFIRM_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WATCHER_POLL_MS = 2_000;

/** Owner heads-up on expired invites (main.ts wires the group-task report channel). */
export type OpenTeamOwnerReportFn = (params: {
  taskId: number;
  metabotId: number;
  ownerGlobalMetaId: string;
  text: string;
}) => Promise<unknown>;

export type OpenTeamWaitForMemberJoinedFn = (
  groupId: string,
  identities: string | string[],
  opts?: { timeoutMs?: number; intervalMs?: number },
) => Promise<boolean>;

export interface OpenTeamServiceDeps {
  getMetabotStore: () => MetabotStore;
  getGroupTaskStore: () => GroupTaskStore;
  getMembershipStore: () => OpenTeamMembershipStore;
  searchMetaIds: typeof searchMetaIds;
  getMetaIdDetail: typeof getMetaIdDetail;
  fetchOnlineStatus: (globalMetaIds: string[]) => Promise<IdchatOnlineStatusResult>;
  waitForMemberJoined: OpenTeamWaitForMemberJoinedFn;
  /** Already has createPin bound by the host (same shape as the guest side). */
  sendEncryptedSimplemsg: OpenTeamGuestSendSimplemsgFn;
  sendOwnerPrivateReport?: OpenTeamOwnerReportFn;
  emitLog?: (message: string) => void;
  now?: () => number;
  inviteTtlSeconds?: number;
  joinConfirmTimeoutMs?: number;
  watcherPollMs?: number;
}

let deps: OpenTeamServiceDeps | null = null;

export function setOpenTeamServiceDeps(next: OpenTeamServiceDeps): void {
  deps = next;
}

export function resetOpenTeamServiceDeps(): void {
  stopOpenTeamInviteWatchers();
  deps = null;
}

function getOpenTeamServiceDeps(): OpenTeamServiceDeps {
  if (!deps) {
    throw new Error('openTeamService not initialized: call setOpenTeamServiceDeps first');
  }
  return deps;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Math.trunc(Number(value));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(min, Math.min(max, num));
}

/** Normalized GlobalMetaIDs of every local MetaBot (excluded from remote flows). */
function listOwnGlobalMetaIds(metabotStore: MetabotStore): Set<string> {
  const own = new Set<string>();
  for (const bot of metabotStore.listMetabots()) {
    const normalized = normalizeRawGlobalMetaId(bot.globalmetaid);
    if (normalized) own.add(normalized);
  }
  return own;
}

// ---------------------------------------------------------------------------
// Remote candidate search
// ---------------------------------------------------------------------------

export interface OpenTeamRemoteCandidate {
  globalMetaId: string;
  name: string;
  bio: string;
  chatSkills: string[];
  chainName: string;
  isOnline: boolean;
  lastSeenAgoSeconds: number;
}

export interface SearchRemoteCandidatesInput {
  keyword?: string;
  skill?: string;
  limit?: number;
}

/**
 * Search on-chain identities and keep only online, invitable candidates:
 * has a chat pubkey (server-side filter), not one of this machine's own bots,
 * currently online per idchat presence. Presence failures propagate — an
 * unverifiable candidate list is worse than none.
 */
export async function searchRemoteCandidates(
  input: SearchRemoteCandidatesInput = {},
): Promise<OpenTeamRemoteCandidate[]> {
  const resolved = getOpenTeamServiceDeps();
  const limit = clampInt(input.limit, DEFAULT_CANDIDATE_LIMIT, 1, MAX_CANDIDATE_LIMIT);
  const keyword = input.keyword?.trim() || undefined;
  const skill = input.skill?.trim() || undefined;
  // Extra headroom: own-bot + offline filtering shrink the page.
  const page = await resolved.searchMetaIds({
    keyword,
    skill,
    hasChatPubkey: true,
    size: Math.min(100, limit * 3),
  });
  const ownGmids = listOwnGlobalMetaIds(resolved.getMetabotStore());
  const items = page.items.filter((item) => {
    const gmid = item.globalMetaId?.trim();
    return Boolean(gmid) && !ownGmids.has(gmid.toLowerCase());
  });
  if (items.length === 0) return [];
  const presence = await resolved.fetchOnlineStatus(items.map((item) => item.globalMetaId.trim()));
  const onlineByGmid = new Map(
    presence.list.map((entry) => [entry.globalMetaId.trim().toLowerCase(), entry]),
  );
  const candidates: OpenTeamRemoteCandidate[] = [];
  for (const item of items) {
    const gmid = item.globalMetaId.trim();
    const entry = onlineByGmid.get(gmid.toLowerCase());
    if (!entry?.isOnline) continue;
    candidates.push({
      globalMetaId: gmid,
      name: item.name,
      bio: item.bio,
      chatSkills: item.chatSkills,
      chainName: item.chainName,
      isOnline: true,
      lastSeenAgoSeconds: entry.lastSeenAgoSeconds,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Invite flow
// ---------------------------------------------------------------------------

export interface InviteRemoteBotInput {
  taskId: number;
  inviteeGlobalMetaId: string;
  inviteeName?: string;
  requiredSkills?: string[];
  /**
   * Explicit owner-requested override (M3): re-inviting an invitee who was
   * previously kicked from this task or declined a previous invite is rejected
   * by default; pass true only when the owner explicitly asked for the
   * re-invite. Expired invites are not negative history and never block.
   */
  allowReinvite?: boolean;
}

export interface InviteRemoteBotResult {
  /** The inviteId embedded in the envelope (random pinId-shaped; see header). */
  invitePinId: string;
  status: 'pending';
}

/** Random pinId-shaped invite identifier (64 hex + literal 'i0'). */
function generateOpenTeamInviteId(): string {
  return `${randomBytes(32).toString('hex')}i0`;
}

/**
 * Send an [OPENTEAM_INVITE] to a remote online bot and track it as pending.
 * Validation order: runnable task -> valid/non-local invitee -> not a member
 * -> no pending duplicate -> no blocked re-invite (kicked/declined history,
 * unless allowReinvite) -> online -> chat pubkey available. Throws with a
 * user-readable message on the first failing check.
 */
export async function inviteRemoteBot(input: InviteRemoteBotInput): Promise<InviteRemoteBotResult> {
  const resolved = getOpenTeamServiceDeps();
  const emitLog = resolved.emitLog ?? (() => undefined);
  const now = resolved.now ?? (() => Date.now());
  const taskId = Math.trunc(Number(input.taskId));
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error('taskId is required');
  }
  const task = requireRunnableTask(taskId);
  const invitee = normalizeRawGlobalMetaId(input.inviteeGlobalMetaId);
  if (!invitee) {
    throw new Error('inviteeGlobalMetaId must be a valid GlobalMetaID');
  }

  const metabotStore = resolved.getMetabotStore();
  const store = resolved.getGroupTaskStore();
  const membershipStore = resolved.getMembershipStore();

  if (listOwnGlobalMetaIds(metabotStore).has(invitee)) {
    throw new Error('invitee is a local MetaBot; use the local group-task invite action instead');
  }
  if (store.isMember(taskId, null, invitee)) {
    throw new Error(`invitee ${invitee} is already a member of group task ${taskId}`);
  }
  if (membershipStore.hasPendingInvite(taskId, invitee)) {
    throw new Error(`a pending invite for ${invitee} already exists on group task ${taskId}`);
  }
  if (!input.allowReinvite) {
    // Re-invite policy (M3): kicked members and declined invitees are not
    // re-invited unless the owner explicitly asks (allowReinvite). Expired
    // invites are not negative history and never block.
    const wasRemoved = store
      .listMembers(taskId, { includeRemoved: true })
      .some((m) => m.metabotId == null && m.removedAt && m.globalmetaid === invitee);
    if (wasRemoved) {
      throw new Error(
        `invitee ${invitee} was previously removed from group task ${taskId}; ` +
        're-invite only when the owner explicitly asks (allowReinvite)',
      );
    }
    if (membershipStore.hasDeclinedInvite(taskId, invitee)) {
      throw new Error(
        `invitee ${invitee} previously declined an invite to group task ${taskId}; ` +
        're-invite only when the owner explicitly asks (allowReinvite)',
      );
    }
  }

  const presence = await resolved.fetchOnlineStatus([invitee]);
  const online = presence.list.some(
    (entry) => entry.globalMetaId.trim().toLowerCase() === invitee && entry.isOnline,
  );
  if (!online) {
    throw new Error(`invitee ${invitee} is offline`);
  }

  const detail = await resolved.getMetaIdDetail(invitee);
  const chatPubkey = detail.chatPubkey?.trim();
  if (!chatPubkey) {
    throw new Error(`invitee ${invitee} does not accept private messages (no on-chain chat pubkey)`);
  }

  // The twin bot is the inviter and chairs every group task.
  const twin = metabotStore.listMetabots().find((m) => m.metabot_type === 'twin');
  if (!twin) {
    throw new Error('No twin MetaBot found: create or designate a twin bot before inviting remote bots');
  }
  const inviterGmid = normalizeRawGlobalMetaId(twin.globalmetaid);
  if (!inviterGmid) {
    throw new Error('The twin MetaBot has no GlobalMetaID; sync its on-chain identity first');
  }
  const wallet = metabotStore.getMetabotWalletByMetabotId(twin.id);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error('twin MetaBot wallet unavailable');
  }

  const inviteId = generateOpenTeamInviteId();
  const inviteTtlSeconds = Math.max(60, Math.trunc(resolved.inviteTtlSeconds ?? DEFAULT_INVITE_TTL_SECONDS));
  const requiredSkills = (input.requiredSkills ?? [])
    .map((skill) => String(skill ?? '').trim())
    .filter((skill) => skill.length > 0);
  const goalSummary = task.goal.length > GOAL_SUMMARY_MAX_CHARS
    ? `${task.goal.slice(0, GOAL_SUMMARY_MAX_CHARS)}…`
    : task.goal;
  const inviteeName = input.inviteeName?.trim() || detail.name || '';
  const plaintext = buildOpenTeamInviteMessage({
    v: 1,
    inviteId,
    groupId: task.groupId!,
    taskTitle: task.title,
    goalSummary,
    requiredSkills,
    inviterGlobalMetaId: inviterGmid,
    inviterName: twin.name?.trim() || `bot-${twin.id}`,
    chairGlobalMetaId: inviterGmid,
    targetGlobalMetaId: invitee,
    expiresAt: Math.floor(now() / 1000) + inviteTtlSeconds,
  });
  // Persist the pending invite BEFORE sending the envelope: a crash between
  // send and record would otherwise leave a ghost invite the guest may accept
  // while no local row tracks it. invite_pin_id stores the generated inviteId
  // from the start (it is the envelope identifier, not the simplemsg pinId).
  membershipStore.createInvite({
    taskId,
    groupId: task.groupId!,
    inviteeGlobalmetaid: invitee,
    inviteeName: inviteeName || null,
    invitePinId: inviteId,
  });
  let sent: Awaited<ReturnType<typeof resolved.sendEncryptedSimplemsg>>;
  try {
    sent = await resolved.sendEncryptedSimplemsg({
      metabotId: twin.id,
      wallet,
      peerGlobalMetaId: invitee,
      peerChatPubkey: chatPubkey,
      plaintext,
    });
  } catch (error) {
    // Send failed after the row landed: finalize it as expired (send_failed)
    // so it never blocks a later re-invite as a phantom pending row.
    membershipStore.updateInviteStatus({ invitePinId: inviteId }, 'expired', 'send_failed');
    emitLog(
      `[OpenTeam] Invite ${inviteId} to ${inviteeName || invitee} failed to send; marked expired (send_failed): ${errorMessage(error)}`,
    );
    throw error;
  }
  emitLog(
    `[OpenTeam] Invite ${inviteId} sent to ${inviteeName || invitee} for task ${taskId} ` +
    `(simplemsg pin ${sent.pinId}); join-confirmation watcher started`,
  );
  // Both identity forms: the indexer member list may expose either.
  startInviteWatcher(inviteId, { identities: [invitee, detail.metaId] });
  return { invitePinId: inviteId, status: 'pending' };
}

// ---------------------------------------------------------------------------
// Join-confirmation watchers
// ---------------------------------------------------------------------------

interface InviteWatcherState {
  invitePinId: string;
  /** Extra acceptable identity forms (e.g. the legacy metaId from the detail lookup). */
  identities: string[];
  /** Counts from the invite row's created_at so a restart keeps the original window. */
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

const inviteWatchers = new Map<string, InviteWatcherState>();

/** sqlite datetime('now') is UTC 'YYYY-MM-DD HH:MM:SS'. */
function parseSqliteUtcMs(value: string | null): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(`${value.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function stopInviteWatcher(watcher: InviteWatcherState): void {
  watcher.stopped = true;
  if (watcher.timer) {
    clearTimeout(watcher.timer);
    watcher.timer = null;
  }
  inviteWatchers.delete(watcher.invitePinId);
}

function scheduleWatcherStep(watcher: InviteWatcherState, delayMs: number): void {
  if (watcher.stopped) return;
  watcher.timer = setTimeout(() => {
    void runWatcherStep(watcher);
  }, Math.max(0, delayMs));
}

function startInviteWatcher(invitePinId: string, opts?: { identities?: string[] }): void {
  const resolved = getOpenTeamServiceDeps();
  if (inviteWatchers.has(invitePinId)) return;
  const invite = resolved.getMembershipStore().getInviteByPinId(invitePinId);
  // Pending waits for the guest's answer; accepted (restart recovery of a
  // crash mid-handshake) resumes straight into join confirmation.
  if (!invite || (invite.status !== 'pending' && invite.status !== 'accepted')) return;
  const now = resolved.now ?? (() => Date.now());
  const timeoutMs = Math.max(1_000, Math.trunc(resolved.joinConfirmTimeoutMs ?? DEFAULT_JOIN_CONFIRM_TIMEOUT_MS));
  const createdMs = parseSqliteUtcMs(invite.createdAt);
  const deadline = Number.isFinite(createdMs) ? createdMs + timeoutMs : now() + timeoutMs;
  const watcher: InviteWatcherState = {
    invitePinId,
    identities: (opts?.identities ?? [])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0),
    deadline,
    timer: null,
    stopped: false,
  };
  inviteWatchers.set(invitePinId, watcher);
  // First step runs immediately: the ACCEPT may already have landed.
  scheduleWatcherStep(watcher, 0);
}

async function runWatcherStep(watcher: InviteWatcherState): Promise<void> {
  let resolved: OpenTeamServiceDeps;
  try {
    resolved = getOpenTeamServiceDeps();
  } catch {
    stopInviteWatcher(watcher);
    return;
  }
  const emitLog = resolved.emitLog ?? (() => undefined);
  const now = resolved.now ?? (() => Date.now());
  const pollMs = Math.max(100, Math.trunc(resolved.watcherPollMs ?? DEFAULT_WATCHER_POLL_MS));
  try {
    const membershipStore = resolved.getMembershipStore();
    const invite = membershipStore.getInviteByPinId(watcher.invitePinId);
    // Declined/expired rows are final; missing rows mean local state was reset.
    if (!invite || invite.status === 'declined' || invite.status === 'expired') {
      stopInviteWatcher(watcher);
      return;
    }
    const remaining = watcher.deadline - now();
    if (invite.status === 'accepted') {
      const joined = await resolved.waitForMemberJoined(
        invite.groupId,
        [invite.inviteeGlobalmetaid, ...watcher.identities],
        { timeoutMs: Math.max(remaining, pollMs), intervalMs: pollMs },
      );
      if (watcher.stopped) return;
      if (joined) {
        // Idempotent on (task_id, globalmetaid); invite stays 'accepted' = the
        // whole handshake completed (no extra status; CHECK constraint).
        resolved.getGroupTaskStore().addMember({
          taskId: invite.taskId,
          metabotId: null,
          globalmetaid: invite.inviteeGlobalmetaid,
          displayName: invite.inviteeName,
          role: 'worker',
          joinedPinId: null,
        });
        emitLog(
          `[OpenTeam] Invite ${watcher.invitePinId}: ${invite.inviteeName || invite.inviteeGlobalmetaid} ` +
          `joined group ${invite.groupId}; recorded as remote member of task ${invite.taskId}`,
        );
        stopInviteWatcher(watcher);
        return;
      }
      expireWatchedInvite(watcher, invite, 'join_confirm_timeout');
      return;
    }
    // Still pending: the guest never answered before the invite window closed.
    if (remaining <= 0) {
      expireWatchedInvite(watcher, invite, 'invite_response_timeout');
      return;
    }
    scheduleWatcherStep(watcher, Math.min(pollMs, remaining));
  } catch (error) {
    emitLog(
      `[OpenTeam] Invite watcher ${watcher.invitePinId} tick failed (retrying): ${errorMessage(error)}`,
    );
    scheduleWatcherStep(watcher, pollMs);
  }
}

function expireWatchedInvite(
  watcher: InviteWatcherState,
  invite: OpenTeamInvite,
  reason: 'join_confirm_timeout' | 'invite_response_timeout',
): void {
  const resolved = getOpenTeamServiceDeps();
  const emitLog = resolved.emitLog ?? (() => undefined);
  resolved.getMembershipStore().updateInviteStatus({ invitePinId: watcher.invitePinId }, 'expired', reason);
  emitLog(`[OpenTeam] Invite ${watcher.invitePinId} marked expired (${reason})`);
  stopInviteWatcher(watcher);
  void notifyOwnerOfExpiredInvite(resolved, invite, reason);
}

/** Best-effort owner heads-up through the group-task private-report channel. */
async function notifyOwnerOfExpiredInvite(
  resolved: OpenTeamServiceDeps,
  invite: OpenTeamInvite,
  reason: 'join_confirm_timeout' | 'invite_response_timeout',
): Promise<void> {
  const emitLog = resolved.emitLog ?? (() => undefined);
  if (!resolved.sendOwnerPrivateReport) return;
  try {
    const task = resolved.getGroupTaskStore().getTaskById(invite.taskId);
    const chairId = task?.chairMetabotId ?? null;
    const chair = chairId != null ? resolved.getMetabotStore().getMetabotById(chairId) : null;
    const ownerGlobalMetaId = (chair?.boss_global_metaid ?? '').trim();
    if (!task || chairId == null || !chair || !ownerGlobalMetaId) {
      emitLog(
        `[OpenTeam] Invite ${invite.invitePinId}: owner notification skipped ` +
        '(chair bot or owner GlobalMetaID unavailable)',
      );
      return;
    }
    const inviteeLabel = invite.inviteeName?.trim() || invite.inviteeGlobalmetaid;
    const reasonText = reason === 'join_confirm_timeout'
      ? 'accepted the invite but never appeared in the on-chain group member list'
      : 'did not respond before the invite expired';
    await resolved.sendOwnerPrivateReport({
      taskId: invite.taskId,
      metabotId: chairId,
      ownerGlobalMetaId,
      text:
        `[OpenTeam] Remote invite for task #${invite.taskId} "${task.title}" did not complete: ` +
        `${inviteeLabel} ${reasonText}. The invite was marked expired and no remote member ` +
        'was added; the task continues with the current roster.',
    });
  } catch (error) {
    emitLog(`[OpenTeam] Invite ${invite.invitePinId}: owner notification failed: ${errorMessage(error)}`);
  }
}

/**
 * Restart recovery: re-arm watchers for every still-pending invite row, plus
 * accepted-but-unconfirmed invites (app quit after the ACCEPT landed but
 * before the join was confirmed). An accepted invite whose remote member row
 * already exists is complete — no watcher, no duplicate addMember. Accepted
 * invites past their original window finalize as expired on the first tick
 * through the same join_confirm_timeout path as a live watcher.
 * Returns the number of watchers started.
 */
export function resumeOpenTeamInviteWatchers(): number {
  const resolved = getOpenTeamServiceDeps();
  const membershipStore = resolved.getMembershipStore();
  const groupTaskStore = resolved.getGroupTaskStore();
  const resumable = [
    ...membershipStore.listPendingInvites(),
    ...membershipStore
      .listAcceptedInvites()
      .filter((invite) => !groupTaskStore.isMember(invite.taskId, null, invite.inviteeGlobalmetaid)),
  ];
  let started = 0;
  for (const invite of resumable) {
    if (!invite.invitePinId || inviteWatchers.has(invite.invitePinId)) continue;
    startInviteWatcher(invite.invitePinId, { identities: [invite.inviteeGlobalmetaid] });
    if (inviteWatchers.has(invite.invitePinId)) started += 1;
  }
  return started;
}

/** Stop every watcher (app shutdown / sqlite recovery restart / test cleanup). */
export function stopOpenTeamInviteWatchers(): void {
  for (const watcher of [...inviteWatchers.values()]) {
    stopInviteWatcher(watcher);
  }
}
