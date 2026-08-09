/**
 * Group Task service: business layer over groupTaskStore + groupChatTransport.
 * One group = one task; the twin bot chairs every task group. Shared by the RPC
 * endpoints (metaidRpcServer) and the future UI (M3).
 *
 * DI via setter injection (same style as groupChatTransport): main.ts wires
 * MetabotStore / GroupTaskStore getters once during startup.
 */

import type { MetabotStore } from '../metabotStore';
import {
  GroupTaskStore,
  type GroupTask,
  type GroupTaskMember,
  type GroupTaskDeliverable,
  type GroupTaskStatus,
  type GroupChatTranscriptMessage,
} from '../groupTaskStore';
import {
  createGroupChat,
  joinGroupChat,
  joinGroupChatAsIdentity,
  removeGroupChatMember,
  sendGroupChatMessage,
  sendGroupChatMessageAsIdentity,
  waitForGroupIndexed,
  fetchGroupMembers,
} from './groupChatTransport';
import { getMetaIdDetail, type MetaIdDetail } from './metaIdSearchService';
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import { buildOpenTeamKickMessage } from './openTeamProtocols';
import type { OpenTeamGuestSendSimplemsgFn } from './openTeamGuestService';
import {
  recordTaskCloseImpressions,
  recordKickImpression,
} from './openTeamImpressionService';

export interface CreateGroupTaskOptions {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  /** Worker metabot ids; chair (the current twin) is added automatically. */
  memberMetabotIds?: number[];
  /** When true, make the entire small local Worker roster available to the Twin chair;
   * the chair's LLM selects the specialist and only its assignment is mentioned. */
  autoSelectWorkers?: boolean;
  createdBy: 'user' | 'twinbot';
}

export interface GroupTaskDetail extends GroupTask {
  members: GroupTaskMember[];
  deliverables: GroupTaskDeliverable[];
  /** Latest group transcript page (P2-6: chair can read the message flow). */
  messages: GroupChatTranscriptMessage[];
  /**
   * Round-4 stall signal: true when a NON-TERMINAL task has had no host drive
   * (lastDrivenAt, falling back to updatedAt) for longer than
   * stallAfterMinutes — the pipeline looks stuck.
   */
  stall: boolean;
  /** Round-4: the stall threshold in minutes (30 by default). */
  stallAfterMinutes: number;
}

/** Round-4: minutes of host inactivity before a non-terminal task reads as stalled. */
export const GROUP_TASK_STALL_AFTER_MINUTES = 30;

/** R2P1-2: post-kick on-chain removal re-check cadence (2s x 15 by default). */
export const KICK_CONFIRM_POLL_INTERVAL_MS = 2_000;
export const KICK_CONFIRM_MAX_ATTEMPTS = 15;

/** sqlite datetime('now') strings are UTC 'YYYY-MM-DD HH:MM:SS'. */
function parseSqliteUtc(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
}

/**
 * Round-4: lastProcessedMsgId semantics + stall. `stall` is true when the task
 * is not terminal and the host's last drive (lastDrivenAt, else updatedAt) is
 * older than GROUP_TASK_STALL_AFTER_MINUTES. Unknown activity (no timestamps)
 * never claims a stall.
 */
export function computeGroupTaskStall(
  task: GroupTask,
  nowMs: number = Date.now(),
): { stall: boolean; stallAfterMinutes: number } {
  if (TERMINAL_STATUSES.has(task.status)) {
    return { stall: false, stallAfterMinutes: GROUP_TASK_STALL_AFTER_MINUTES };
  }
  const drivenMs = task.lastDrivenAt != null ? task.lastDrivenAt * 1000 : null;
  const lastActivityMs = drivenMs ?? parseSqliteUtc(task.updatedAt);
  const stall = lastActivityMs != null
    && nowMs - lastActivityMs > GROUP_TASK_STALL_AFTER_MINUTES * 60_000;
  return { stall, stallAfterMinutes: GROUP_TASK_STALL_AFTER_MINUTES };
}

export interface PostGroupTaskMessageOptions {
  contentType?: string;
  replyPin?: string;
  mention?: string[];
}

const TERMINAL_STATUSES: ReadonlySet<GroupTaskStatus> = new Set(['done', 'cancelled']);

let metabotStoreGetter: (() => MetabotStore) | null = null;
let groupTaskStoreGetter: (() => GroupTaskStore) | null = null;
let orchestrationBridgeGetter: (() => GroupTaskOrchestrationBridge) | null = null;

export function setGroupTaskServiceMetabotStoreGetter(getter: () => MetabotStore): void {
  metabotStoreGetter = getter;
}

export function setGroupTaskServiceGroupTaskStoreGetter(getter: () => GroupTaskStore): void {
  groupTaskStoreGetter = getter;
}

export function setGroupTaskServiceOrchestrationBridgeGetter(
  getter: (() => GroupTaskOrchestrationBridge) | null,
): void {
  orchestrationBridgeGetter = getter;
}

/** Minimal kv surface used for the owner-join guard (satisfied by SqliteStore). */
export interface GroupTaskServiceKvStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

let kvStoreGetter: (() => GroupTaskServiceKvStore) | null = null;

export function setGroupTaskServiceKvStoreGetter(getter: () => GroupTaskServiceKvStore): void {
  kvStoreGetter = getter;
}

function getKvStore(): GroupTaskServiceKvStore {
  if (!kvStoreGetter) {
    throw new Error('groupTaskService not initialized: call setGroupTaskServiceKvStoreGetter first');
  }
  return kvStoreGetter();
}

// Transport function seams (same setter-injection style; defaults are the real
// implementations). Tests override these to avoid chain writes.
let createGroupChatFn = createGroupChat;
let joinGroupChatFn = joinGroupChat;
let joinGroupChatAsIdentityFn = joinGroupChatAsIdentity;
let removeGroupChatMemberFn = removeGroupChatMember;
let sendGroupChatMessageFn = sendGroupChatMessage;
let sendGroupChatMessageAsIdentityFn = sendGroupChatMessageAsIdentity;
let waitForGroupIndexedFn = waitForGroupIndexed;
// Indexer lookup seam (OpenTeam M3): resolves a remote member's legacy metaId.
let getMetaIdDetailFn = getMetaIdDetail;
// R2P1-2: member-list read seam for the post-kick on-chain removal re-check.
let fetchGroupMembersFn = fetchGroupMembers;
// P1-2: simplemsg seam for the kick notification. No safe default (createPin
// must be host-bound), so unwired = the notification is skipped with a warn.
let sendEncryptedSimplemsgFn: OpenTeamGuestSendSimplemsgFn | null = null;
let kickConfirmPollIntervalMs = KICK_CONFIRM_POLL_INTERVAL_MS;
let kickConfirmMaxAttempts = KICK_CONFIRM_MAX_ATTEMPTS;

export interface GroupTaskServiceTransportOverrides {
  createGroupChat?: typeof createGroupChat;
  joinGroupChat?: typeof joinGroupChat;
  joinGroupChatAsIdentity?: typeof joinGroupChatAsIdentity;
  removeGroupChatMember?: typeof removeGroupChatMember;
  sendGroupChatMessage?: typeof sendGroupChatMessage;
  sendGroupChatMessageAsIdentity?: typeof sendGroupChatMessageAsIdentity;
  waitForGroupIndexed?: typeof waitForGroupIndexed;
  getMetaIdDetail?: typeof getMetaIdDetail;
  fetchGroupMembers?: typeof fetchGroupMembers;
  sendEncryptedSimplemsg?: OpenTeamGuestSendSimplemsgFn;
  /** R2P1-2 poll tuning (tests inject tiny values). */
  kickConfirmPollIntervalMs?: number;
  kickConfirmMaxAttempts?: number;
}

export function setGroupTaskServiceTransport(overrides: GroupTaskServiceTransportOverrides): void {
  createGroupChatFn = overrides.createGroupChat ?? createGroupChat;
  joinGroupChatFn = overrides.joinGroupChat ?? joinGroupChat;
  joinGroupChatAsIdentityFn = overrides.joinGroupChatAsIdentity ?? joinGroupChatAsIdentity;
  removeGroupChatMemberFn = overrides.removeGroupChatMember ?? removeGroupChatMember;
  sendGroupChatMessageFn = overrides.sendGroupChatMessage ?? sendGroupChatMessage;
  sendGroupChatMessageAsIdentityFn = overrides.sendGroupChatMessageAsIdentity ?? sendGroupChatMessageAsIdentity;
  waitForGroupIndexedFn = overrides.waitForGroupIndexed ?? waitForGroupIndexed;
  getMetaIdDetailFn = overrides.getMetaIdDetail ?? getMetaIdDetail;
  fetchGroupMembersFn = overrides.fetchGroupMembers ?? fetchGroupMembers;
  sendEncryptedSimplemsgFn = overrides.sendEncryptedSimplemsg ?? null;
  kickConfirmPollIntervalMs = Math.max(
    1,
    Math.trunc(overrides.kickConfirmPollIntervalMs ?? KICK_CONFIRM_POLL_INTERVAL_MS),
  );
  kickConfirmMaxAttempts = Math.max(
    1,
    Math.trunc(overrides.kickConfirmMaxAttempts ?? KICK_CONFIRM_MAX_ATTEMPTS),
  );
}

export function resetGroupTaskServiceTransport(): void {
  createGroupChatFn = createGroupChat;
  joinGroupChatFn = joinGroupChat;
  joinGroupChatAsIdentityFn = joinGroupChatAsIdentity;
  removeGroupChatMemberFn = removeGroupChatMember;
  sendGroupChatMessageFn = sendGroupChatMessage;
  sendGroupChatMessageAsIdentityFn = sendGroupChatMessageAsIdentity;
  waitForGroupIndexedFn = waitForGroupIndexed;
  getMetaIdDetailFn = getMetaIdDetail;
  fetchGroupMembersFn = fetchGroupMembers;
  sendEncryptedSimplemsgFn = null;
  kickConfirmPollIntervalMs = KICK_CONFIRM_POLL_INTERVAL_MS;
  kickConfirmMaxAttempts = KICK_CONFIRM_MAX_ATTEMPTS;
}

const OWNER_JOINED_KV_PREFIX = 'group_task_owner_joined:';

/**
 * Re-join guard: joining costs gas, so the owner's on-chain join is recorded in kv
 * (`group_task_owner_joined:<groupId>` = '1'). Joins only when the flag is missing;
 * returns true when a join pin was actually sent. Throws when the join fails.
 */
export async function ensureOwnerJoinedGroup(groupId: string): Promise<boolean> {
  const kv = getKvStore();
  const key = `${OWNER_JOINED_KV_PREFIX}${groupId}`;
  if (kv.get<string>(key) === '1') return false;
  await joinGroupChatAsIdentityFn(groupId);
  kv.set(key, '1');
  return true;
}

function getMetabotStore(): MetabotStore {
  if (!metabotStoreGetter) {
    throw new Error('groupTaskService not initialized: call setGroupTaskServiceMetabotStoreGetter first');
  }
  return metabotStoreGetter();
}

function getGroupTaskStore(): GroupTaskStore {
  if (!groupTaskStoreGetter) {
    throw new Error('groupTaskService not initialized: call setGroupTaskServiceGroupTaskStoreGetter first');
  }
  return groupTaskStoreGetter();
}

/** The twin bot chairs every group task (machine-wide unique-Twin invariant). */
function resolveTwinMetabotId(): number {
  const twin = getMetabotStore().listMetabots().find((m) => m.metabot_type === 'twin');
  if (!twin) {
    throw new Error('No twin MetaBot found: create or designate a twin bot before creating a group task');
  }
  return twin.id;
}

function requireTask(taskId: number): GroupTask {
  const task = getGroupTaskStore().getTaskById(taskId);
  if (!task) throw new Error(`Group task ${taskId} not found`);
  return task;
}

/**
 * Shared runnable guard (also used by the OpenTeam inviter service): the task
 * exists, is not terminal, and has its on-chain group id.
 */
export function requireRunnableTask(taskId: number): GroupTask {
  const task = requireTask(taskId);
  if (TERMINAL_STATUSES.has(task.status)) {
    throw new Error(`Group task ${taskId} is ${task.status}; no further messages or members allowed`);
  }
  if (!task.groupId) {
    throw new Error(`Group task ${taskId} has no on-chain group id`);
  }
  return task;
}

/**
 * Kickoff message posted by the chair right after group creation.
 * IMPORTANT (P0-3): the member roster line must NOT carry `@` prefixes — the
 * daemon treats an explicit `@Name` as a work assignment. A roster line with
 * every member @-mentioned used to trigger every member to respond.
 */
function buildKickoffMessage(input: {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  chairName: string;
  memberNames: string[];
}): string {
  const lines = [
    `[GROUP TASK] ${input.title}`,
    `Goal: ${input.goal}`,
    `Acceptance: ${input.acceptanceCriteria?.trim() || '(none specified)'}`,
    `Chair: ${input.chairName}`,
    input.memberNames.length > 0
      ? `Members: ${input.memberNames.join(', ')}`
      : 'Members: (chair only)',
  ];
  return lines.join('\n');
}

/**
 * Create a group task end to end: resolve twin (chair) -> create the on-chain
 * group -> wait for the indexer -> persist task + member rows -> join each local
 * member -> chair posts the kickoff message.
 *
 * If waitForGroupIndexed times out the task is STILL persisted (a warning is
 * logged) and joins/kickoff are attempted anyway: the group pin is already
 * on-chain, so the indexer will catch up and the backfill daemon reconciles.
 */
export async function createGroupTask(opts: CreateGroupTaskOptions): Promise<GroupTaskDetail> {
  const title = opts.title?.trim();
  const goal = opts.goal?.trim();
  if (!title) throw new Error('title is required');
  if (!goal) throw new Error('goal is required');

  const metabotStore = getMetabotStore();
  const store = getGroupTaskStore();

  const chairMetabotId = resolveTwinMetabotId();
  const chair = metabotStore.getMetabotById(chairMetabotId);
  const chairName = chair?.name?.trim() || `bot-${chairMetabotId}`;

  const requestedWorkerIds = opts.autoSelectWorkers
    ? metabotStore.listMetabots().filter((metabot) => metabot.metabot_type === 'worker' && metabot.enabled).map((metabot) => metabot.id)
    : (opts.memberMetabotIds ?? []);
  const workerIds = [...new Set(requestedWorkerIds
    .map((id) => Math.trunc(Number(id)))
    .filter((id) => Number.isFinite(id) && id > 0 && id !== chairMetabotId))];

  const { groupId, pinId } = await createGroupChatFn(chairMetabotId, {
    groupName: title,
    groupNote: goal,
  });

  const indexed = await waitForGroupIndexedFn(groupId);
  if (!indexed) {
    console.warn(
      `[GroupTask] Group ${groupId.slice(0, 12)}… not indexed within timeout; ` +
      'persisting task anyway (group pin is on-chain, backfill will reconcile)',
    );
  }

  const task = store.createTask({
    groupId,
    title,
    goal,
    acceptanceCriteria: opts.acceptanceCriteria?.trim() || null,
    chairMetabotId,
    createdBy: opts.createdBy,
    createPinId: pinId,
  });

  try {
    orchestrationBridgeGetter?.().ensureCanonicalTask(task);
  } catch (error) {
    // The on-chain group already exists, so preserve the Group Task and let the
    // daemon retry canonical reconciliation instead of duplicating chain writes.
    console.warn(
      `[GroupTask] Canonical task link failed for task ${task.id}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Chair is implicitly a member via the create pin.
  store.addMember({
    taskId: task.id,
    metabotId: chairMetabotId,
    globalmetaid: chair?.globalmetaid ?? null,
    role: 'chair',
    joinedPinId: pinId,
  });

  const memberNames: string[] = [];
  for (const workerId of workerIds) {
    const worker = metabotStore.getMetabotById(workerId);
    if (!worker) {
      console.warn(`[GroupTask] Member metabot ${workerId} not found; skipped`);
      continue;
    }
    store.addMember({
      taskId: task.id,
      metabotId: workerId,
      globalmetaid: worker.globalmetaid ?? null,
      role: 'worker',
    });
    memberNames.push(worker.name?.trim() || `bot-${workerId}`);
    try {
      const { pinId: joinPinId } = await joinGroupChatFn(workerId, groupId);
      store.updateMemberJoinedPinId(task.id, workerId, joinPinId);
    } catch (error) {
      // A member join failure must not fail the whole creation; joined_pin_id stays NULL.
      console.warn(
        `[GroupTask] joinGroupChat failed for member ${workerId} in task ${task.id}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // The indexer diverts messages from non-members, so the human owner joins every
  // task group to observe/post. Degradation-tolerant like member joins.
  try {
    await ensureOwnerJoinedGroup(groupId);
  } catch (error) {
    console.warn(
      `[GroupTask] Owner identity join failed for task ${task.id}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await sendGroupChatMessageFn(chairMetabotId, groupId, {
      content: buildKickoffMessage({
        title,
        goal,
        acceptanceCriteria: opts.acceptanceCriteria,
        chairName,
        memberNames,
      }),
      nickName: chairName,
    });
  } catch (error) {
    console.warn(
      `[GroupTask] Kickoff message failed for task ${task.id}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return getGroupTask(task.id);
}

export async function listGroupTasks(filter?: { status?: GroupTaskStatus }): Promise<GroupTask[]> {
  return getGroupTaskStore().listTasks(filter);
}

export interface GroupTaskSummary extends GroupTask {
  memberCount: number;
  chairName: string | null;
  memberNames: string[];
}

/** listGroupTasks enriched with member count + chair/member names (IPC list surface). */
export async function listGroupTaskSummaries(
  filter?: { status?: GroupTaskStatus },
): Promise<GroupTaskSummary[]> {
  const store = getGroupTaskStore();
  return store.listTasks(filter).map((task) => {
    const members = store.listMembers(task.id);
    return {
      ...task,
      memberCount: members.length,
      chairName: members.find((member) => member.role === 'chair')?.name ?? null,
      memberNames: members.map((member) => member.name).filter((name): name is string => Boolean(name)),
    };
  });
}

export interface GroupTaskMemberSummary extends GroupTaskMember {
  /** Round-4 (show summary): epoch seconds of the member's last chain speech. */
  lastSpeakAt: number | null;
}

export interface GetGroupTaskOptions {
  /**
   * Round-4: 'summary' (default) returns status, members (with last speak
   * time), deliverables and the last 5 messages — readable without a huge
   * blob; 'full' returns everything (50 messages).
   */
  view?: 'summary' | 'full';
}

export async function getGroupTask(
  id: number,
  opts?: GetGroupTaskOptions,
): Promise<GroupTaskDetail> {
  const store = getGroupTaskStore();
  const task = requireTask(id);
  const stall = computeGroupTaskStall(task);
  // The IPC detail view keeps the full page (50 messages); the RPC show
  // endpoint explicitly requests view='summary' by default.
  const view = opts?.view ?? 'full';
  const members = store.listMembers(id);
  const speakMap = view === 'summary' && task.groupId
    ? store.getMembersLastSpeakAt(task.groupId!, members.map((m) => m.globalmetaid))
    : new Map<string, number>();
  const membersWithSpeakAt: GroupTaskMemberSummary[] = members.map((member) => {
    const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
    return { ...member, lastSpeakAt: gmid ? (speakMap.get(gmid) ?? null) : null };
  });
  return {
    ...task,
    members: membersWithSpeakAt,
    deliverables: store.listDeliverables(id),
    messages: task.groupId
      ? store.listGroupChatMessages(task.groupId, { limit: view === 'full' ? 50 : 5 })
      : [],
    stall: stall.stall,
    stallAfterMinutes: stall.stallAfterMinutes,
  };
}

/**
 * Post a message to the task group as one of its member bots.
 * Validates membership and that the task is not terminal.
 */
export async function postGroupTaskMessage(
  taskId: number,
  metabotId: number,
  content: string,
  opts?: PostGroupTaskMessageOptions,
): Promise<{ pinId: string }> {
  const task = requireRunnableTask(taskId);
  const store = getGroupTaskStore();
  if (!store.isMember(taskId, metabotId)) {
    throw new Error(`MetaBot ${metabotId} is not a member of group task ${taskId}`);
  }
  const text = content?.trim();
  if (!text) throw new Error('content is required');
  const metabot = getMetabotStore().getMetabotById(metabotId);
  const nickName = metabot?.name?.trim() || `bot-${metabotId}`;
  return sendGroupChatMessageFn(metabotId, task.groupId!, {
    content: text,
    nickName,
    contentType: opts?.contentType,
    replyPin: opts?.replyPin,
    mention: opts?.mention,
  });
}

/**
 * Post a message to the task group as the human owner (user identity).
 * Applies the kv re-join guard first so the owner is an on-chain member
 * (covers tasks created before owner-join existed).
 */
export async function postGroupTaskMessageAsOwner(
  taskId: number,
  content: string,
  opts?: { replyPin?: string; mention?: string[] },
): Promise<{ pinId: string }> {
  const task = requireRunnableTask(taskId);
  const text = content?.trim();
  if (!text) throw new Error('content is required');
  await ensureOwnerJoinedGroup(task.groupId!);
  return sendGroupChatMessageAsIdentityFn(task.groupId!, {
    content: text,
    replyPin: opts?.replyPin,
    mention: opts?.mention,
  });
}

/** Add a local bot to an existing task: on-chain join first, then the member row. */
export async function joinGroupTaskMember(
  taskId: number,
  metabotId: number,
): Promise<GroupTaskMember> {
  const task = requireRunnableTask(taskId);
  const store = getGroupTaskStore();
  const existing = store.listMembers(taskId).find((m) => m.metabotId === metabotId);
  if (existing) return existing;

  const metabot = getMetabotStore().getMetabotById(metabotId);
  if (!metabot) throw new Error(`MetaBot ${metabotId} not found`);

  const { pinId } = await joinGroupChatFn(metabotId, task.groupId!, {
    referrer: task.chairMetabotId
      ? getMetabotStore().getMetabotById(task.chairMetabotId)?.metaid ?? ''
      : '',
  });
  return store.addMember({
    taskId,
    metabotId,
    globalmetaid: metabot.globalmetaid ?? null,
    role: 'worker',
    joinedPinId: pinId,
  });
}

export interface KickGroupTaskMemberInput {
  taskId: number;
  /** Local member path (metabots row id). */
  metabotId?: number;
  /** Remote member path (OpenTeam member rows have metabot_id IS NULL). */
  globalmetaid?: string;
  reason?: string;
}

/**
 * Fetch a remote member's indexer detail once per kick: its legacy metaId feeds
 * the /protocols/simplegroupremoveuser body and its chatPubkey the kick
 * notification. Lookup failures degrade both paths (GlobalMetaID fallback, no
 * notification) without affecting the kick itself. Never throws.
 */
async function fetchRemoteMemberDetail(gmid: string): Promise<MetaIdDetail | null> {
  try {
    return await getMetaIdDetailFn(gmid);
  } catch (error) {
    console.warn(
      `[GroupTask] MetaID detail lookup for ${gmid} failed (remove pin falls back to the ` +
      `GlobalMetaID, kick notification skipped): ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Resolve the legacy MetaID the /protocols/simplegroupremoveuser body expects
 * (idchat's removeMember writes the legacy metaId, not the GlobalMetaID).
 * Local members read it from the metabots row; remote OpenTeam members only
 * carry a GlobalMetaID locally, so it comes from the prefetched MetaID search
 * indexer detail — falling back to the GlobalMetaID itself when the lookup
 * failed or returned no metaId (the indexer tolerates the GlobalMetaID form
 * for member matching; a wrong value only means the on-chain removal is a
 * no-op while the local kick still holds).
 */
async function resolveRemoveMetaid(
  member: GroupTaskMember,
  remoteDetail?: MetaIdDetail | null,
): Promise<string> {
  if (member.metabotId != null) {
    const metaid = getMetabotStore().getMetabotById(member.metabotId)?.metaid?.trim() ?? '';
    if (!metaid) {
      throw new Error(`MetaBot ${member.metabotId} has no on-chain MetaID; sync its identity first`);
    }
    return metaid;
  }
  const gmid = (member.globalmetaid ?? '').trim();
  if (!gmid) throw new Error(`Member ${member.id} has neither metabotId nor globalmetaid`);
  const metaid = remoteDetail?.metaId?.trim() ?? '';
  if (metaid) return metaid;
  if (remoteDetail) {
    console.warn(`[GroupTask] MetaID detail for ${gmid} has no metaId; falling back to the GlobalMetaID`);
  }
  return gmid;
}

/**
 * P1-2: tell a kicked REMOTE guest about its removal via a deterministic
 * [OPENTEAM_KICK] simplemsg from the chair, so its guest side marks the
 * membership left immediately (the guest daemon's periodic on-chain membership
 * self-check is the fallback when this never arrives). Local members need no
 * notification — the kick lands in their own machine's DB. Best-effort: every
 * failure mode is logged and never changes the kick result.
 */
async function notifyKickedRemoteMember(input: {
  chairMetabotId: number;
  task: GroupTask;
  member: GroupTaskMember;
  remoteDetail: MetaIdDetail | null;
  reason?: string;
}): Promise<void> {
  const gmid = (input.member.globalmetaid ?? '').trim();
  if (!gmid) return;
  if (!sendEncryptedSimplemsgFn) {
    console.warn(`[GroupTask] Kick notification for ${gmid} skipped: simplemsg sender not wired`);
    return;
  }
  const chatPubkey = input.remoteDetail?.chatPubkey?.trim() ?? '';
  if (!chatPubkey) {
    console.warn(`[GroupTask] Kick notification for ${gmid} skipped: no on-chain chat pubkey`);
    return;
  }
  const wallet = getMetabotStore().getMetabotWalletByMetabotId(input.chairMetabotId);
  if (!wallet?.mnemonic?.trim()) {
    console.warn(`[GroupTask] Kick notification for ${gmid} skipped: chair wallet unavailable`);
    return;
  }
  try {
    await sendEncryptedSimplemsgFn({
      metabotId: input.chairMetabotId,
      wallet,
      peerGlobalMetaId: gmid,
      peerChatPubkey: chatPubkey,
      plaintext: buildOpenTeamKickMessage({
        v: 1,
        groupId: input.task.groupId!,
        taskTitle: input.task.title,
        reason: input.reason ?? '',
      }),
    });
  } catch (error) {
    console.warn(
      `[GroupTask] Kick notification to ${gmid} failed (the kick still holds; the guest ` +
      `self-check is the fallback): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * R2P1-2: after the removeuser pin, poll the indexer member list until none of
 * the kicked identities (legacy metaId + GlobalMetaID forms) appear anymore.
 * An unreachable indexer simply costs one attempt; "unconfirmed" is NOT an
 * error — the local removal and SUSPECT gating hold regardless. Never throws.
 */
async function confirmChainRemoval(
  groupId: string,
  identities: Array<string | null | undefined>,
): Promise<boolean> {
  const candidates = new Set(
    identities.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean),
  );
  if (candidates.size === 0) return false;
  for (let attempt = 1; attempt <= kickConfirmMaxAttempts; attempt += 1) {
    let members: string[] | null = null;
    try {
      members = await fetchGroupMembersFn(groupId);
    } catch {
      members = null; // injected fakes may throw; the real client never does
    }
    if (members && !members.some((member) => candidates.has(member.trim().toLowerCase()))) {
      return true;
    }
    if (attempt < kickConfirmMaxAttempts) {
      await sleepMs(kickConfirmPollIntervalMs);
    }
  }
  return false;
}

export interface KickGroupTaskMemberResult extends GroupTaskMember {
  /**
   * R2P1-2: true once the indexer member list no longer contains the kicked
   * identity. False means the local removal + SUSPECT gating hold but the
   * on-chain removal could not be confirmed within the poll budget (a warning
   * is logged; the kick is NOT considered failed). The idempotent no-op path
   * (member already removed by an earlier kick) sends no new pin but still
   * re-checks the member list read-only, so a removal that never landed
   * on-chain surfaces here too.
   */
  chainRemovalConfirmed: boolean;
}

/**
 * Kick a member out of a group task (OpenTeam M3): the chair (twin, the group's
 * on-chain creator) signs a /protocols/simplegroupremoveuser pin, then the
 * member row is marked removed and the chair posts a deterministic moderation
 * notice in the group (no LLM). On-chain failure aborts before any DB write.
 * A kicked REMOTE member also gets a one-way [OPENTEAM_KICK] simplemsg so its
 * guest side marks the membership left (P1-2), and the removal is re-checked
 * against the indexer member list (R2P1-2, chainRemovalConfirmed on the
 * result). Idempotent: an already-removed member is returned without a new pin.
 */
export async function kickGroupTaskMember(input: KickGroupTaskMemberInput): Promise<KickGroupTaskMemberResult> {
  const taskId = Math.trunc(Number(input.taskId));
  if (!Number.isInteger(taskId) || taskId <= 0) throw new Error('taskId is required');
  const task = requireRunnableTask(taskId);
  const store = getGroupTaskStore();
  const metabotStore = getMetabotStore();

  const metabotId = input.metabotId != null ? Math.trunc(Number(input.metabotId)) : null;
  // Normalize the remote identity at the entry point, same as the invite path.
  const rawGlobalMetaId = input.globalmetaid?.trim() ?? '';
  const globalmetaid = rawGlobalMetaId ? normalizeRawGlobalMetaId(rawGlobalMetaId) : null;
  if (metabotId != null && (!Number.isInteger(metabotId) || metabotId <= 0)) {
    throw new Error('metabotId must be a positive integer');
  }
  if (rawGlobalMetaId && !globalmetaid) {
    throw new Error('globalmetaid must be a valid GlobalMetaID');
  }
  if (metabotId == null && !globalmetaid) {
    throw new Error('metabotId or globalmetaid is required');
  }

  // Look the member up INCLUDING removed rows so a repeated kick is a no-op.
  const all = store.listMembers(taskId, { includeRemoved: true });
  const member = metabotId != null
    ? all.find((candidate) => candidate.metabotId === metabotId)
    // Remote re-joins create fresh rows; the latest row is the live one.
    : [...all].reverse().find(
        (candidate) => candidate.metabotId == null && candidate.globalmetaid === globalmetaid,
      );
  if (!member) {
    const who = metabotId != null ? `MetaBot ${metabotId}` : `globalmetaid ${globalmetaid}`;
    throw new Error(`${who} is not a member of group task ${taskId}`);
  }
  if (member.role === 'chair') {
    throw new Error('The chair (twin bot) cannot be removed from its own group task');
  }
  if (member.removedAt) {
    // Idempotent: no new pin — but still re-check the chain state (read-only)
    // so a repeat kick surfaces a removal that never landed on-chain instead
    // of blindly reporting success.
    const chainRemovalConfirmed = await confirmChainRemoval(task.groupId!, [
      member.globalmetaid,
      member.metabotId != null
        ? metabotStore.getMetabotById(member.metabotId)?.metaid
        : null,
    ]);
    return { ...member, chainRemovalConfirmed };
  }

  const chair = metabotStore.getMetabotById(task.chairMetabotId);
  if (!chair) {
    throw new Error(`Chair MetaBot ${task.chairMetabotId} not found; cannot sign the removal pin`);
  }

  const reason = input.reason?.trim() || undefined;
  // One indexer lookup serves both the legacy-metaId resolution (removeuser
  // body) and the chat pubkey (kick notification) for remote members.
  const remoteDetail = member.metabotId == null
    ? await fetchRemoteMemberDetail((member.globalmetaid ?? '').trim())
    : null;
  const removeMetaid = await resolveRemoveMetaid(member, remoteDetail);
  const { pinId } = await removeGroupChatMemberFn(task.chairMetabotId, task.groupId!, {
    removeMetaid,
    reason,
  });
  const removed = store.markMemberRemoved({
    taskId,
    metabotId: member.metabotId,
    globalmetaid: member.metabotId == null ? member.globalmetaid : undefined,
    removePinId: pinId,
  });

  // Deterministic moderation notice from the chair (English, fixed format).
  // A failed announcement must not roll back the removal — the pin and the
  // member row already hold.
  try {
    const displayName = member.name?.trim() || removeMetaid;
    await sendGroupChatMessageFn(task.chairMetabotId, task.groupId!, {
      content:
        `Moderation: ${displayName} has been removed from this group task by the owner.` +
        (reason ? ` Reason: ${reason}` : ''),
      nickName: chair.name?.trim() || `bot-${task.chairMetabotId}`,
    });
  } catch (error) {
    console.warn(
      `[GroupTask] Moderation announcement failed for task ${taskId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // P1-2: proactively notify a kicked REMOTE guest (a local member's own
  // machine records the removal directly). Best-effort, never throws.
  if (member.metabotId == null) {
    await notifyKickedRemoteMember({
      chairMetabotId: task.chairMetabotId,
      task,
      member,
      remoteDetail,
      reason,
    });
  }

  // OpenTeam M3: the chair sediments a collaboration impression about a kicked
  // REMOTE member. Best-effort — the removal above already holds; the recorder
  // no-ops for local members and never throws.
  recordKickImpression(taskId, member.globalmetaid ?? '', reason);

  // R2P1-2: re-check the on-chain removal against the indexer member list.
  const chainRemovalConfirmed = await confirmChainRemoval(task.groupId!, [
    removeMetaid,
    member.globalmetaid,
  ]);
  if (!chainRemovalConfirmed) {
    console.warn(
      `[GroupTask] Kick of member ${member.id} in task ${taskId} not confirmed on-chain within ` +
      `${kickConfirmMaxAttempts} member-list poll(s); the local removal holds and the indexer may just be lagging`,
    );
  }
  return { ...removed, chainRemovalConfirmed };
}

/**
 * Remove a mistakenly recorded deliverable (P1-4 cleanup hatch: chair can delete
 * placeholder/junk deliverables that were ingested before the parser hardening).
 */
export async function deleteGroupTaskDeliverable(taskId: number, deliverableId: number): Promise<boolean> {
  const task = requireTask(taskId);
  const store = getGroupTaskStore();
  const deliverable = store.listDeliverables(taskId).find((item) => item.id === deliverableId);
  if (!deliverable) {
    throw new Error(`Deliverable ${deliverableId} not found in group task ${taskId}`);
  }
  return store.deleteDeliverable(deliverableId);
}

/**
 * Close a task via the store state machine (sets closed_at for terminal states).
 * `reason` is accepted for API completeness but not persisted (no column in M1).
 */
export async function closeGroupTask(
  taskId: number,
  opts: { status: 'done' | 'cancelled'; reason?: string },
): Promise<GroupTask> {
  if (opts.status !== 'done' && opts.status !== 'cancelled') {
    throw new Error(`closeGroupTask status must be 'done' or 'cancelled'`);
  }
  if (opts.reason?.trim()) {
    console.log(`[GroupTask] Closing task ${taskId} as ${opts.status}: ${opts.reason.trim()}`);
  }
  let closed: GroupTask;
  if (orchestrationBridgeGetter) {
    const bridge = orchestrationBridgeGetter();
    closed = opts.status === 'done'
      ? bridge.acceptGroupTask(taskId).groupTask
      : bridge.cancelGroupTask(taskId).groupTask;
  } else {
    closed = getGroupTaskStore().updateTaskStatus(taskId, opts.status);
  }
  // OpenTeam M3: the chair sediments one participation impression per REMOTE
  // teammate (recorded for cancelled tasks too). Best-effort: the task is
  // already closed; the recorder never throws into this flow.
  recordTaskCloseImpressions(taskId, opts.status, opts.reason);
  return closed;
}
