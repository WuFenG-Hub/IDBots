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
 * member row is still missing and whose invitee was not kicked afterwards.
 *
 * Watcher windows are two independent budgets, both derived from the persisted
 * row so a restart keeps them: pending waits created_at + envelope TTL +
 * propagation margin (a legitimate ACCEPT sent near the envelope expiry still
 * lands on a pending row); the join confirmation after an ACCEPT gets a full
 * fresh budget from responded_at instead of the invite window's leftover.
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
  type MetaIdSearchItem,
} from './metaIdSearchService';
import type { IdchatOnlineStatusResult } from './idchatPresenceService';
import type { OpenTeamGuestSendSimplemsgFn } from './openTeamGuestService';
import { buildOpenTeamInviteMessage } from './openTeamProtocols';

const DEFAULT_CANDIDATE_LIMIT = 10;
const MAX_CANDIDATE_LIMIT = 50;
const GOAL_SUMMARY_MAX_CHARS = 200;
/**
 * #16: per-token fuzzy recall cap. Multi-keyword queries are recalled as ONE
 * server search per token (OR semantics); a long CJK run expands into many
 * bigram tokens, so cap the per-token searches (the broad feed fallback still
 * runs for the remainder).
 */
const MAX_RECALL_TOKENS = 6;
const DEFAULT_INVITE_TTL_SECONDS = 600; // envelope expiresAt = now + 10 min
// The guest may legally accept until expiresAt (+60s clock-skew tolerance on
// its side) and the ACCEPT then crosses the indexer + private-message layers,
// so the pending window outlives the envelope TTL by this margin.
const DEFAULT_INVITE_PROPAGATION_MARGIN_MS = 5 * 60_000;
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
  /** Grace past the envelope TTL during which a legitimate ACCEPT still lands (default 5 min). */
  invitePropagationMarginMs?: number;
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

/** Envelope TTL in seconds (floor 60 so a misconfigured TTL cannot dead-letter invites). */
function resolveInviteTtlSeconds(resolved: OpenTeamServiceDeps): number {
  return Math.max(60, Math.trunc(resolved.inviteTtlSeconds ?? DEFAULT_INVITE_TTL_SECONDS));
}

/**
 * Pending window = envelope TTL + propagation margin: an ACCEPT sent just
 * before the envelope expired is still legitimate and must find the invite
 * row pending when it lands, not expired.
 */
function resolvePendingWindowMs(resolved: OpenTeamServiceDeps): number {
  const marginMs = Math.max(
    0,
    Math.trunc(resolved.invitePropagationMarginMs ?? DEFAULT_INVITE_PROPAGATION_MARGIN_MS),
  );
  return resolveInviteTtlSeconds(resolved) * 1000 + marginMs;
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
 *
 * P1-5 fuzzy recall: the remote search API matches `keyword` exactly (full-name
 * lookups and bio-described skills return nothing). When the caller supplies a
 * keyword/skill, a second, looser recall runs WITHOUT the keyword against the
 * same skill filter and matches locally: query tokens (whitespace/separator
 * split, plus 2-grams for CJK runs) are matched against name/bio/chatSkills,
 * each candidate gets a relevance score, and results are returned best-match
 * first. The loose recall never drops the exact-path results — it only adds
 * candidates the exact path missed.
 */

/** Split a query into match tokens: separator-split words plus 2-grams of CJK runs. */
export function tokenizeOpenTeamQuery(text: string): string[] {
  const tokens = new Set<string>();
  const parts = String(text ?? '')
    .toLowerCase()
    .split(/[\s,，。;；:：/|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const part of parts) {
    tokens.add(part);
    // CJK runs (no ASCII letters): add 2-grams so "占卜塔罗" matches a bio
    // containing "占卜塔罗牌" without needing a manual space.
    if (/[一-鿿]/.test(part) && !/[a-z0-9]/.test(part) && part.length > 2) {
      for (let index = 0; index < part.length - 1; index += 1) {
        tokens.add(part.slice(index, index + 2));
      }
    }
  }
  return [...tokens];
}

/**
 * Local fuzzy relevance: how well one candidate matches the query tokens.
 * Name hits weigh most, then chatSkills, then bio. Long exact tokens beat
 * short substrings. Returns 0 when nothing matched (candidate excluded).
 */
export function scoreOpenTeamCandidate(
  item: Pick<MetaIdSearchItem, 'name' | 'bio' | 'chatSkills'>,
  tokens: string[],
): number {
  if (tokens.length === 0) return 0;
  const name = (item.name ?? '').toLowerCase();
  const bio = (item.bio ?? '').toLowerCase();
  const skills = (item.chatSkills ?? []).map((skill) => String(skill ?? '').toLowerCase());
  let score = 0;
  for (const token of tokens) {
    const weight = Math.min(4, Math.max(1, token.length));
    if (name.includes(token)) score += 4 * weight;
    if (skills.some((skill) => skill.includes(token))) score += 2 * weight;
    if (bio.includes(token)) score += weight;
  }
  return score;
}

export async function searchRemoteCandidates(
  input: SearchRemoteCandidatesInput = {},
): Promise<OpenTeamRemoteCandidate[]> {
  const resolved = getOpenTeamServiceDeps();
  const limit = clampInt(input.limit, DEFAULT_CANDIDATE_LIMIT, 1, MAX_CANDIDATE_LIMIT);
  const keyword = input.keyword?.trim() || undefined;
  const skill = input.skill?.trim() || undefined;
  const ownGmids = listOwnGlobalMetaIds(resolved.getMetabotStore());
  const seen = new Set<string>();
  const byScore = new Map<string, number>();
  // P1-5: item-by-gmid for the merged candidate list (exact hits first, then
  // fuzzy-only recalls) — the final filter must run over BOTH paths, not just
  // the exact page, or fuzzy-only recalls would be scored and then dropped.
  const byGmid = new Map<string, MetaIdSearchItem>();

  // Exact path: pass keyword/skill to the server-side matcher as-is.
  const page = await resolved.searchMetaIds({
    keyword,
    skill,
    hasChatPubkey: true,
    size: Math.min(100, limit * 3),
  });
  for (const item of page.items) {
    const gmid = item.globalMetaId?.trim();
    if (!gmid || ownGmids.has(gmid.toLowerCase()) || seen.has(gmid.toLowerCase())) continue;
    seen.add(gmid.toLowerCase());
    // Exact-path hits that ALSO match the tokens get ranked by score; hits the
    // exact path returned but the local matcher misses keep a base score of 1
    // so they are never dropped below the fuzzy-only candidates.
    byScore.set(gmid, Math.max(1, scoreOpenTeamCandidate(item, tokenizeOpenTeamQuery([keyword, skill].filter(Boolean).join(' ')))));
    byGmid.set(gmid.toLowerCase(), item);
  }

  // P1-5 fuzzy path: only when the caller asked for keyword/skill matching.
  // #16 (2026-08-11 verification): the multi-token semantics were already a
  // weighted PARTIAL match in scoreOpenTeamCandidate (a candidate matching ANY
  // token scores > 0), NOT a hard AND — but the recall source was a single
  // no-keyword feed page, which can miss niche candidates entirely (FTM was
  // not in the top-50 feed, so "占卜 塔罗 命运" recalled nothing to score).
  // Fixed: recall runs ONE server keyword search PER TOKEN (server-side OR
  // semantics), merged and ranked locally by partial-match score; a broad
  // no-keyword feed stays as the final safety net.
  if (keyword || skill) {
    try {
      const tokens = tokenizeOpenTeamQuery([keyword, skill].filter(Boolean).join(' '));
      const recallPages = [];
      for (const token of tokens.slice(0, MAX_RECALL_TOKENS)) {
        recallPages.push(
          await resolved.searchMetaIds({
            keyword: token,
            skill,
            hasChatPubkey: true,
            size: Math.min(100, limit * 3),
          }),
        );
      }
      // Broad no-keyword feed fallback: candidates the per-token server
      // searches missed but the local scorer still matches.
      recallPages.push(
        await resolved.searchMetaIds({
          skill,
          hasChatPubkey: true,
          size: Math.min(100, limit * 10),
        }),
      );
      for (const page of recallPages) {
        for (const item of page.items) {
          const gmid = item.globalMetaId?.trim();
          if (!gmid || ownGmids.has(gmid.toLowerCase()) || seen.has(gmid.toLowerCase())) continue;
          const score = scoreOpenTeamCandidate(item, tokens);
          if (score <= 0) continue;
          seen.add(gmid.toLowerCase());
          byScore.set(gmid, score);
          byGmid.set(gmid.toLowerCase(), item);
        }
      }
    } catch (error) {
      // The fuzzy path is a recall enhancement: an API failure here must never
      // fail the whole search when the exact path already produced candidates.
      resolved.emitLog?.(
        `[OpenTeam] fuzzy candidate recall failed (exact results kept): ${errorMessage(error)}`,
      );
    }
  }

  const items = [...byGmid.values()].filter((item) => {
    const gmid = item.globalMetaId?.trim();
    return Boolean(gmid) && byScore.has(gmid.toLowerCase());
  });
  if (items.length === 0) return [];
  const presence = await resolved.fetchOnlineStatus(items.map((item) => item.globalMetaId.trim()));
  const onlineByGmid = new Map(
    presence.list.map((entry) => [entry.globalMetaId.trim().toLowerCase(), entry]),
  );
  const ranked = items
    .map((item) => ({
      item,
      score: byScore.get(item.globalMetaId.trim().toLowerCase()) ?? 0,
    }))
    .sort((left, right) => right.score - left.score);
  const candidates: OpenTeamRemoteCandidate[] = [];
  for (const { item } of ranked) {
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
   * previously kicked from this task or declined a previous invite out of
   * owner intent (bot/remote-collab switched off — transient/technical
   * declines like rate_limited or group_verify_failed never block) is rejected
   * by default; pass true only when the owner explicitly asked for the
   * re-invite. Expired invites are not negative history and never block.
   */
  allowReinvite?: boolean;
}

export interface InviteRemoteBotResult {
  /** The inviteId embedded in the envelope (random pinId-shaped; see header). */
  invitePinId: string;
  status: 'pending';
  /**
   * P1-3: worker-session creation status as seen from the INVITER host. Local
   * invites report created/ready/failed; remote invites are always 'pending' —
   * the guest's session is created on the INVITEE's host when its ACCEPT
   * lands (host cooperation; unverifiable from the inviter side).
   */
  sessionStatus: 'pending';
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
  // P1-1: only a CONFIRMED member blocks a re-invite. A remote placeholder row
  // (joined_pin_id NULL — created by the join watcher without the join pin,
  // or by the indexer lag) means "invite sent, join not confirmed yet"; when
  // its invite has expired it must not keep blocking the retry forever.
  // The pending-invite check right below still stops a duplicate WHILE an
  // invite is live.
  const activeRemote = store.getActiveRemoteMember(taskId, invitee);
  if (activeRemote && activeRemote.joinedPinId) {
    throw new Error(`invitee ${invitee} is already a member of group task ${taskId}`);
  }
  if (membershipStore.hasPendingInvite(taskId, invitee)) {
    throw new Error(`a pending invite for ${invitee} already exists on group task ${taskId}`);
  }
  if (activeRemote && !activeRemote.joinedPinId) {
    // The placeholder exists but no invite is pending: the previous invite
    // expired (or its join never confirmed). The retry is allowed; log it so
    // the operator can see the release happened.
    emitLog(
      `[OpenTeam] Re-inviting ${input.inviteeName?.trim() || invitee} to task ${taskId}: previous remote ` +
      'placeholder member never confirmed a join (joined_pin_id NULL) and no invite is pending; retry released',
    );
  }
  if (!input.allowReinvite) {
    // Re-invite policy (M3): kicked members and invitees who declined out of
    // owner intent are not re-invited unless the owner explicitly asks
    // (allowReinvite). Expired invites and transient/technical declines are
    // not negative history and never block.
    if (store.hasRemovedMember(taskId, invitee)) {
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
  const inviteTtlSeconds = resolveInviteTtlSeconds(resolved);
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
    // Persist the legacy metaId form too: a watcher re-armed after a restart
    // polls the indexer with both identity forms.
    inviteeMetaid: detail.metaId?.trim() || null,
    inviteeName: inviteeName || null,
    invitePinId: inviteId,
    // #13: why the invitee is invited — the join-welcome handshake reads this
    // to state the reason in the welcome broadcast.
    requiredSkills,
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
  return { invitePinId: inviteId, status: 'pending', sessionStatus: 'pending' };
}

// ---------------------------------------------------------------------------
// Join-confirmation watchers
// ---------------------------------------------------------------------------

interface InviteWatcherState {
  invitePinId: string;
  /** Extra acceptable identity forms (e.g. the legacy metaId from the detail lookup). */
  identities: string[];
  /**
   * Cached deadline of the current phase, recomputed from the invite row on
   * every successful step (pending: created_at + TTL + propagation margin;
   * accepted: responded_at + join-confirm budget). The catch branch uses the
   * cached value to finalize a watcher whose step keeps failing instead of
   * retrying forever.
   */
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

const inviteWatchers = new Map<string, InviteWatcherState>();

/** sqlite UTC text: 'YYYY-MM-DD HH:MM:SS' (datetime('now')) or with '.SSS' (strftime %f). */
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
  const createdMs = parseSqliteUtcMs(invite.createdAt);
  const deadline = (Number.isFinite(createdMs) ? createdMs : now()) + resolvePendingWindowMs(resolved);
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
    const createdMs = parseSqliteUtcMs(invite.createdAt);
    if (invite.status === 'accepted') {
      // A kick AFTER this invite was issued removed the membership the invite
      // created (R2): the invite freezes as accepted history — never re-add a
      // self-rejoining kicked bot, never expire with a misleading owner alert.
      // A removed row PREDATING the invite belongs to an earlier membership
      // and does not block an explicit re-invite from confirming.
      if (resolved.getGroupTaskStore().hasRemovedMember(invite.taskId, invite.inviteeGlobalmetaid, createdMs)) {
        emitLog(
          `[OpenTeam] Invite ${watcher.invitePinId}: ${invite.inviteeName || invite.inviteeGlobalmetaid} ` +
          `was removed from task ${invite.taskId} after accepting; watcher stopped, invite left accepted`,
        );
        stopInviteWatcher(watcher);
        return;
      }
      // The join-confirmation budget is independent of the invite window: it
      // starts when the ACCEPT landed (responded_at), so a late-but-legitimate
      // answer still gets the full confirmation window instead of the leftover.
      const respondedMs = parseSqliteUtcMs(invite.respondedAt);
      const anchorMs = Number.isFinite(respondedMs)
        ? respondedMs
        : Number.isFinite(createdMs) ? createdMs : now();
      const deadline = anchorMs + Math.max(
        1_000,
        Math.trunc(resolved.joinConfirmTimeoutMs ?? DEFAULT_JOIN_CONFIRM_TIMEOUT_MS),
      );
      watcher.deadline = deadline;
      const remaining = deadline - now();
      // Both identity forms: the indexer member list may expose either (the
      // persisted invitee_metaid covers watchers re-armed after a restart).
      const identities = [...new Set(
        [invite.inviteeGlobalmetaid, invite.inviteeMetaid, ...watcher.identities]
          .map((value) => (value ?? '').trim())
          .filter((value) => value.length > 0),
      )];
      const joined = await resolved.waitForMemberJoined(
        invite.groupId,
        identities,
        { timeoutMs: Math.max(remaining, pollMs), intervalMs: pollMs },
      );
      if (watcher.stopped) return;
      if (joined) {
        // Idempotent on (task_id, globalmetaid); invite stays 'accepted' = the
        // whole handshake completed (no extra status; CHECK constraint).
        // P1-2: the ACCEPT envelope's joinedPinId (persisted on the invite row
        // by handleOpenTeamResponse) now lands on the member row, so "already
        // joined" is readable from the member itself.
        resolved.getGroupTaskStore().addMember({
          taskId: invite.taskId,
          metabotId: null,
          globalmetaid: invite.inviteeGlobalmetaid,
          displayName: invite.inviteeName,
          role: 'worker',
          joinedPinId: invite.joinedPinId,
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
    // Still pending: the window is created_at + envelope TTL + propagation
    // margin, so a legitimate ACCEPT sent just before the envelope expired
    // still finds the row pending when it lands.
    const deadline = (Number.isFinite(createdMs) ? createdMs : now()) + resolvePendingWindowMs(resolved);
    watcher.deadline = deadline;
    const remaining = deadline - now();
    if (remaining <= 0) {
      expireWatchedInvite(watcher, invite, 'invite_response_timeout');
      return;
    }
    scheduleWatcherStep(watcher, Math.min(pollMs, remaining));
  } catch (error) {
    // Past the cached deadline a failing step finalizes the invite instead of
    // retrying forever (a persistently broken DB must not spin the watcher).
    if (now() >= watcher.deadline) {
      finalizeExpiredWatcher(resolved, watcher);
      return;
    }
    emitLog(
      `[OpenTeam] Invite watcher ${watcher.invitePinId} tick failed (retrying): ${errorMessage(error)}`,
    );
    scheduleWatcherStep(watcher, pollMs);
  }
}

/**
 * Error-branch finalization: the watcher is past its cached deadline and the
 * step keeps throwing. Re-read the row best-effort (the failure may have been
 * transient) and run the normal expire path; when the row is unreadable or
 * already final, just stop the watcher — a leftover pending/accepted row is
 * re-armed and finalized by resumeOpenTeamInviteWatchers on the next start.
 */
function finalizeExpiredWatcher(resolved: OpenTeamServiceDeps, watcher: InviteWatcherState): void {
  const emitLog = resolved.emitLog ?? (() => undefined);
  try {
    const invite = resolved.getMembershipStore().getInviteByPinId(watcher.invitePinId);
    if (invite && invite.status !== 'declined' && invite.status !== 'expired') {
      expireWatchedInvite(
        watcher,
        invite,
        invite.status === 'accepted' ? 'join_confirm_timeout' : 'invite_response_timeout',
      );
      return;
    }
  } catch (error) {
    emitLog(
      `[OpenTeam] Invite watcher ${watcher.invitePinId} is past its deadline but the invite row ` +
      `is unreadable; watcher stopped, finalization deferred to the next resume: ${errorMessage(error)}`,
    );
  }
  stopInviteWatcher(watcher);
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
 * already exists is complete — no watcher, no duplicate addMember. An accepted
 * invite whose invitee was KICKED after the invite was issued stays frozen as
 * accepted history — re-arming would either silently un-kick a self-rejoining
 * bot or expire the invite with a misleading owner alert. Accepted invites
 * past their join-confirmation budget finalize as expired on the first tick
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
      .filter((invite) => !groupTaskStore.isMember(invite.taskId, null, invite.inviteeGlobalmetaid))
      .filter((invite) => !groupTaskStore.hasRemovedMember(
        invite.taskId,
        invite.inviteeGlobalmetaid,
        parseSqliteUtcMs(invite.createdAt),
      )),
  ];
  let started = 0;
  for (const invite of resumable) {
    if (!invite.invitePinId || inviteWatchers.has(invite.invitePinId)) continue;
    // Identity forms come from the persisted row (invitee_globalmetaid plus
    // the invitee_metaid column), so a restarted watcher polls both.
    startInviteWatcher(invite.invitePinId);
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
