/**
 * Group Task service: business layer over groupTaskStore + groupChatTransport.
 * One group = one task; the twin bot chairs every task group. Shared by the RPC
 * endpoints (metaidRpcServer) and the future UI (M3).
 *
 * DI via setter injection (same style as groupChatTransport): main.ts wires
 * MetabotStore / GroupTaskStore getters once during startup.
 */

import type { CoworkStore } from '../coworkStore';
import type { MetabotStore } from '../metabotStore';
import {
  GroupTaskStore,
  type GroupTask,
  type GroupTaskMember,
  type GroupTaskMemberStatus,
  type GroupTaskTransition,
  type GroupTaskIntegrityEvent,
  type GroupTaskDeliverable,
  type GroupTaskStatus,
  type GroupTaskStatusEvent,
  type GroupTaskStatusEventActor,
  type GroupTaskCheckpoint,
  type GroupChatTranscriptMessage,
  type GroupTaskAcceptanceSummary,
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
import {
  validateDeliverableLines,
  type DeliverableValidation,
} from './groupTaskDeliverableParser';
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import { buildOpenTeamKickMessage } from './openTeamProtocols';
import type { OpenTeamGuestSendSimplemsgFn } from './openTeamGuestService';
import type {
  OpenTeamInviteStatus,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import {
  ensureGroupTaskMemberReady,
  GROUP_TASK_CONVERSATION_CHANNEL,
} from './groupTaskSession';
import {
  clearGroupTaskReviewDeliveryGuards,
  extractCheckpointDecisionSummary,
  GROUP_TASK_DRIVER_KV_PREFIX,
  GROUP_TASK_REVIEW_NOTIFIED_KV_PREFIX,
  GROUP_TASK_REWORK_AT_KV_PREFIX,
} from './groupTaskDaemon';
import { getMetaIdDetail, type MetaIdDetail } from './metaIdSearchService';
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
  /**
   * P0-6: per-member observer expectation (name → e.g. "静默观察 / 待命接手 / 可退出").
   * Injected into the kickoff message so listed-but-unassigned members know
   * their expected role instead of "在列猜谜".
   */
  observerRoles?: Record<string, string>;
  /**
   * P0-6: names of members who already have assigned work at kickoff. When
   * provided and smaller than the roster, the remaining members get an
   * auto-generated observer note (default standby text).
   */
  activeMemberNames?: string[];

  /** When true, make the entire small local Worker roster available to the Twin chair;
   * the chair's LLM selects the specialist and only its assignment is mentioned. */
  autoSelectWorkers?: boolean;
  createdBy: 'user' | 'twinbot';
  /**
   * R2: the originating CoWork session creating this task, so the host can
   * relay the acceptance result back on close ("哪里发起哪里结束"). Omitted by
   * the panel IPC (panel-created tasks have no originating session).
   */
  sourceSessionId?: string;
}

export interface GroupTaskDetail extends GroupTask {
  members: GroupTaskMemberSummary[];
  deliverables: GroupTaskDeliverable[];
  /** P0-5: state-transition audit log (who/from/to/reason). */
  transitions: GroupTaskTransition[];
  /** P0-8: public integrity declarations (honest corrections/reports). */
  integrityEvents: GroupTaskIntegrityEvent[];
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
  /** P1-5: status transition history (newest first). */
  statusEvents: GroupTaskStatusEvent[];
  /** P2-8: the daemon instance currently driving this task (kv heartbeat claim). */
  driver: GroupTaskDriverInfo | null;
  /** HITL: all human checkpoints of the task, oldest first (open one included). */
  checkpoints: GroupTaskCheckpoint[];
  /**
   * R1: the host-generated acceptance summary ("把菜端上桌"), the single source
   * of truth rendered by the group's last review message, the owner private
   * report, and the R2 source-session notification. Null before the task has
   * entered review (no summary generated yet).
   */
  acceptanceSummary: GroupTaskAcceptanceSummary | null;
  /**
   * HITL: what the owner must decide right now — the tag-free body of the
   * chair's [CHECKPOINT] message that opened the currently open checkpoint
   * (null when no open checkpoint, the message is unavailable, or it held
   * nothing but the tag). Document links inside it survive untouched.
   */
  openCheckpointSummary: string | null;
}

/** P2-8: who drives a task right now (multi-window/multi-session annotation). */
export interface GroupTaskDriverInfo {
  instanceId: string;
  atMs: number;
}

/** P1-4/R6: host-computed member work state. 'timeout' (R6) = a self-reported
 * working/assigned member whose [WORKING] signal has gone stale — the
 * authoritative "went silent" read, distinct from 'idle' (spoke, not currently
 * working). */
export type GroupTaskMemberWorkStatus = 'working' | 'error' | 'timeout' | 'idle' | 'unknown';

/** Minutes a [WORKING] tag stays "working" after its last occurrence. */
export const GROUP_TASK_WORKING_WINDOW_MINUTES = 20;
/** R6: minutes a working/assigned member's [WORKING] signal may be stale before
 * the authoritative state reads 'timeout' (distinct from 'error' = failed attempt). */
export const GROUP_TASK_TIMEOUT_WINDOW_MINUTES = 20;
/** Minutes a failed canonical attempt stays "error" after it finished. */
export const GROUP_TASK_ERROR_WINDOW_MINUTES = 60;

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
/**
 * P1-1: optional OpenTeamMembershipStore getter (wired by main.ts; null in
 * contexts without OpenTeam). When unset, member summaries report
 * inviteStatus 'none' and remote placeholder reads are skipped.
 */
let openTeamMembershipStoreGetter: (() => OpenTeamMembershipStore) | null = null;

export function setGroupTaskServiceMetabotStoreGetter(getter: () => MetabotStore): void {
  metabotStoreGetter = getter;
}

export function setGroupTaskServiceGroupTaskStoreGetter(getter: () => GroupTaskStore): void {
  groupTaskStoreGetter = getter;
}

export function setGroupTaskServiceOpenTeamMembershipStoreGetter(
  getter: (() => OpenTeamMembershipStore) | null,
): void {
  openTeamMembershipStoreGetter = getter;
}

export function setGroupTaskServiceOrchestrationBridgeGetter(
  getter: (() => GroupTaskOrchestrationBridge) | null,
): void {
  orchestrationBridgeGetter = getter;
}

/** Minimal kv surface used by the owner-join guard and the reopen/ack guards
 * (satisfied by SqliteStore). `delete` is needed to clear the owner-report
 * guard on the review -> executing rework hatch. */
export interface GroupTaskServiceKvStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

let kvStoreGetter: (() => GroupTaskServiceKvStore) | null = null;
let coworkStoreGetter: (() => CoworkStore) | null = null;

export function setGroupTaskServiceKvStoreGetter(getter: () => GroupTaskServiceKvStore): void {
  kvStoreGetter = getter;
}

export function setGroupTaskServiceCoworkStoreGetter(getter: () => CoworkStore): void {
  coworkStoreGetter = getter;
}

function getCoworkStore(): CoworkStore {
  if (!coworkStoreGetter) {
    throw new Error('groupTaskService not initialized: call setGroupTaskServiceCoworkStoreGetter first');
  }
  return coworkStoreGetter();
}

/**
 * R2 cross-session relay seam. main.ts wires this to the CoworkRunner's
 * insertCrossSessionMessageAndQueue (the same ORCH-NOTIFY pipe) so the service
 * stays decoupled from the runner type. Returns ok:false when the target
 * session is missing/A2A (the caller degrades to owner-private-only, never
 * rolls back the task close). null seam = R2 disabled (tests / pre-wire).
 */
export type GroupTaskAcceptanceNotifier = (input: {
  taskId: number;
  targetSessionId: string;
  message: string;
}) => { ok: boolean; warning?: string };

let acceptanceNotifier: GroupTaskAcceptanceNotifier | null = null;

export function setGroupTaskAcceptanceNotifier(notifier: GroupTaskAcceptanceNotifier | null): void {
  acceptanceNotifier = notifier;
}

/** R2 kv guard: one acceptance notification per task per terminal outcome. */
const GROUP_TASK_ACCEPTANCE_NOTIFIED_KV_PREFIX = 'group_task_acceptance_notified:';

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
  observerRoles?: Record<string, string>;
  activeMemberNames?: string[];
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
  // P0-6: observer expectations for listed-but-unassigned members. Only active
  // when the caller supplied assignment info (activeMemberNames) or explicit
  // observerRoles — otherwise the kickoff stays unchanged (no regression).
  const hasActiveList = Array.isArray(input.activeMemberNames) && input.activeMemberNames.length > 0;
  const hasObserverRoles = Boolean(input.observerRoles && Object.keys(input.observerRoles).length > 0);
  if (hasActiveList || hasObserverRoles) {
    const assigned = new Set((input.activeMemberNames ?? []).map((name) => name.trim()).filter(Boolean));
    const observerLines: string[] = [];
    for (const name of input.memberNames) {
      if (assigned.has(name)) continue;
      if (!hasActiveList && !input.observerRoles?.[name]) continue;
      const expectation = input.observerRoles?.[name]?.trim() || '静默观察 / 待命接手 / 可退出';
      observerLines.push(`- ${name}：${expectation}`);
    }
    if (observerLines.length > 0) {
      lines.push('', '未派活成员预期（observer/standby）：', ...observerLines);
    }
  }
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
    sourceSessionId: opts.sourceSessionId?.trim() || null,
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
    // P1-3: eager worker-session pre-creation with the group context injected
    // (invite immediate wake-up) — best-effort, never fails the creation.
    try {
      ensureGroupTaskMemberReady({
        coworkStore: getCoworkStore(),
        groupTaskStore: store,
        task: store.getTaskById(task.id)!,
        botId: workerId,
        botName: worker.name?.trim() || `bot-${workerId}`,
      });
    } catch (error) {
      console.warn(
        `[GroupTask] Worker session pre-creation failed for member ${workerId} in task ${task.id}: ` +
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
        observerRoles: opts.observerRoles,
        activeMemberNames: opts.activeMemberNames,
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
  // The UI list hides archived tasks and sorts pinned ones first; internal
  // callers (listGroupTasks) still see the full set.
  return store.listTasks({ ...filter, includeArchived: false }).map((task) => {
    const members = store.listMembers(task.id);
    return {
      ...task,
      memberCount: members.length,
      chairName: members.find((member) => member.role === 'chair')?.name ?? null,
      memberNames: members.map((member) => member.name).filter((name): name is string => Boolean(name)),
    };
  });
}

/** Archived tasks (Settings restore panel), newest archive first. */
export async function listArchivedGroupTasks(
  options?: { offset?: number; limit?: number },
): Promise<GroupTaskSummary[]> {
  const store = getGroupTaskStore();
  return store.listArchivedTasks(options).map((task) => {
    const members = store.listMembers(task.id);
    return {
      ...task,
      memberCount: members.length,
      chairName: members.find((member) => member.role === 'chair')?.name ?? null,
      memberNames: members.map((member) => member.name).filter((name): name is string => Boolean(name)),
    };
  });
}

export async function countArchivedGroupTasks(): Promise<number> {
  return getGroupTaskStore().countArchivedTasks();
}

/** Set the local pinned flag; resolves with the updated task. */
export async function setGroupTaskPinned(taskId: number, pinned: boolean): Promise<GroupTask> {
  const store = getGroupTaskStore();
  store.setTaskPinned(taskId, pinned);
  const task = store.getTaskById(taskId);
  if (!task) throw new Error(`Group task ${taskId} not found`);
  return task;
}

/** Set the local display name (empty clears it back to the chain title). */
export async function renameGroupTask(taskId: number, displayName: string): Promise<GroupTask> {
  const store = getGroupTaskStore();
  store.renameTask(taskId, displayName);
  const task = store.getTaskById(taskId);
  if (!task) throw new Error(`Group task ${taskId} not found`);
  return task;
}

/** Archive (hide from the UI list; records and daemon driving are preserved). */
export async function archiveGroupTask(taskId: number): Promise<GroupTask> {
  const store = getGroupTaskStore();
  store.archiveTask(taskId);
  const task = store.getTaskById(taskId);
  if (!task) throw new Error(`Group task ${taskId} not found`);
  return task;
}

/** Restore an archived task back into the UI list. */
export async function unarchiveGroupTask(taskId: number): Promise<GroupTask> {
  const store = getGroupTaskStore();
  store.unarchiveTask(taskId);
  const task = store.getTaskById(taskId);
  if (!task) throw new Error(`Group task ${taskId} not found`);
  return task;
}

export interface GroupTaskMemberSummary extends GroupTaskMember {
  /** Round-4 (show summary): epoch seconds of the member's last chain speech. */
  lastSpeakAt: number | null;
  /** P1-4: epoch seconds of the member's last `[WORKING]` tag message. */
  lastWorkingAt: number | null;
  /** P1-4: host-computed work state — the chair can query instead of guessing. */
  workStatus: GroupTaskMemberWorkStatus;
  /**
   * P1-1: OpenTeam invite state for remote members ('invited' while an invite
   * is live, 'accepted' after the ACCEPT, 'declined', 'expired' after the
   * pending window, 'joined' when the member row itself confirms a join via
   * joined_pin_id). Local members and remote members without any invite row
   * report 'none'. Derived from the newest openteam_invites row for the
   * (task, invitee); when the OpenTeam store is not wired, always 'none'.
   */
  inviteStatus: GroupTaskMemberInviteStatus;
}

export type GroupTaskMemberInviteStatus =
  | 'none'
  | 'invite_pending'
  | 'invite_accepted'
  | 'invite_declined'
  | 'invite_expired'
  | 'joined';

/**
 * P1-1: pure invite-status derivation for one member summary. Rules:
 * - local members (metabotId != null): 'none';
 * - 'joined' wins once the MEMBER row itself carries a join pin (P1-2:
 *   joined_pin_id on the member row is the source of truth for "already
 *   joined"), even when no invite row exists on record (e.g. legacy rows) —
 *   the invite row's own joined pin is the fallback;
 * - otherwise the invite row's status maps 1:1, 'pending' -> 'invite_pending',
 *   and members without an invite row: 'none'.
 */
export function deriveGroupTaskMemberInviteStatus(input: {
  metabotId: number | null;
  memberJoinedPinId: string | null;
  inviteStatus: OpenTeamInviteStatus | null;
  inviteJoinedPinId: string | null;
}): GroupTaskMemberInviteStatus {
  if (input.metabotId != null) return 'none';
  if (input.memberJoinedPinId || input.inviteJoinedPinId) return 'joined';
  if (!input.inviteStatus) return 'none';
  if (input.inviteStatus === 'pending') return 'invite_pending';
  if (input.inviteStatus === 'accepted') return 'invite_accepted';
  if (input.inviteStatus === 'declined') return 'invite_declined';
  if (input.inviteStatus === 'expired') return 'invite_expired';
  return 'none';
}

/**
 * P1-4: pure workStatus derivation. Priority:
 *  1. a RUNNING canonical attempt => working;
 *  2. a fresh `[WORKING]` tag (working window) => working;
 *  3. a recent FAILED attempt (error window) with a NEWER success record
 *     (lastSpeakAt / lastWorkingAt strictly AFTER attemptAtMs) => degraded off
 *     'error': working when lastWorkingAt is inside the working window,
 *     otherwise idle — the member has visibly recovered since the failure;
 *  4. a recent FAILED attempt without newer records => error;
 *  5. any speech => idle;
 *  6. otherwise => unknown.
 */
export function computeGroupTaskMemberWorkStatus(input: {
  metabotId: number | null;
  lastSpeakAt: number | null;
  lastWorkingAt: number | null;
  attemptStatus: 'running' | 'failed' | null;
  attemptAtMs: number | null;
  nowMs?: number;
  /** R6: the member's self-reported status — lets the host distinguish 'timeout'
   * (a working/assigned member who went silent) from 'idle' (never expected to
   * be working). Optional so existing callers/tests keep their behavior. */
  memberStatus?: GroupTaskMemberStatus;
}): GroupTaskMemberWorkStatus {
  const nowMs = input.nowMs ?? Date.now();
  if (input.attemptStatus === 'running') return 'working';
  if (
    input.lastWorkingAt != null
    && Number.isFinite(input.lastWorkingAt)
    && nowMs - input.lastWorkingAt <= GROUP_TASK_WORKING_WINDOW_MINUTES * 60_000
  ) {
    return 'working';
  }
  if (
    input.attemptStatus === 'failed'
    && input.attemptAtMs != null
    && Number.isFinite(input.attemptAtMs)
    && nowMs - input.attemptAtMs <= GROUP_TASK_ERROR_WINDOW_MINUTES * 60_000
  ) {
    // Error-degrade: a failed attempt is only a stale residual marker when no
    // NEWER success record exists. Any speech/working record strictly AFTER
    // the failed attempt (attemptAtMs = the attempt's finishedAt) downgrades
    // the panel off 'error'. A record at exactly attemptAtMs is NOT treated as
    // post-failure recovery evidence — it coincides with the failure itself.
    const hasNewerSuccessRecord =
      (input.lastSpeakAt != null && Number.isFinite(input.lastSpeakAt) && input.lastSpeakAt > input.attemptAtMs)
      || (input.lastWorkingAt != null && Number.isFinite(input.lastWorkingAt) && input.lastWorkingAt > input.attemptAtMs);
    if (hasNewerSuccessRecord) {
      // lastWorkingAt inside the working window => working, otherwise idle.
      if (
        input.lastWorkingAt != null
        && Number.isFinite(input.lastWorkingAt)
        && nowMs - input.lastWorkingAt <= GROUP_TASK_WORKING_WINDOW_MINUTES * 60_000
      ) {
        return 'working';
      }
      return 'idle';
    }
    return 'error';
  }
  // R6: a working/assigned member whose [WORKING] signal is stale (older than
  // the timeout window) and who is not mid-attempt or in the error window reads
  // 'timeout' — the authoritative "went silent" state. This is what replaces the
  // old "出错" misread: a silently-working member is no longer shown as idle.
  if (
    (input.memberStatus === 'working' || input.memberStatus === 'assigned')
    && input.lastWorkingAt != null
    && Number.isFinite(input.lastWorkingAt)
    && nowMs - input.lastWorkingAt > GROUP_TASK_TIMEOUT_WINDOW_MINUTES * 60_000
  ) {
    return 'timeout';
  }
  if (input.lastSpeakAt != null) return 'idle';
  return 'unknown';
}

/** P2-8: read the current driver claim for a task from kv (null when unclaimed). */
export function readGroupTaskDriver(
  kv: GroupTaskServiceKvStore,
  taskId: number,
): GroupTaskDriverInfo | null {
  const raw = kv.get<string>(`${GROUP_TASK_DRIVER_KV_PREFIX}${taskId}`);
  if (!raw) return null;
  const [instanceId, atText] = raw.split('|');
  const atMs = Number(atText);
  if (!instanceId || !Number.isFinite(atMs)) return null;
  return { instanceId, atMs };
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
  // P0-2: lastSpeakAt is computed for BOTH views — the detail/UI member list
  // shows the member state badge plus when each member last spoke.
  const speakMap = task.groupId
    ? store.getMembersLastSpeakAt(task.groupId!, members.map((m) => m.globalmetaid))
    : new Map<string, number>();
  const workingMap = view === 'summary' && task.groupId
    ? store.getMembersWorkingAt(task.groupId!, members.map((m) => m.globalmetaid))
    : new Map<string, number>();
  const bridge = orchestrationBridgeGetter?.();
  // P1-1: newest invite row per remote member (one store query per remote
  // member; local members have no invites and skip the lookup).
  const inviteByGmid = new Map<string, { status: OpenTeamInviteStatus | null; joinedPinId: string | null }>();
  if (openTeamMembershipStoreGetter) {
    const membershipStore = openTeamMembershipStoreGetter();
    for (const member of members) {
      const gmid = (member.globalmetaid ?? '').trim();
      if (!gmid || member.metabotId != null) continue;
      const invite = membershipStore.getLatestInvite(id, gmid);
      inviteByGmid.set(gmid.toLowerCase(), {
        status: invite?.status ?? null,
        joinedPinId: invite?.joinedPinId ?? null,
      });
    }
  }
  // HITL: all human checkpoints (open + past), oldest first — loaded once and
  // reused for the detail payload and the open-checkpoint decision summary.
  const checkpoints = store.listCheckpoints(id);
  const membersWithStatus: GroupTaskMemberSummary[] = members.map((member) => {
    const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
    const lastSpeakAt = gmid ? (speakMap.get(gmid) ?? null) : null;
    const lastWorkingAt = gmid ? (workingMap.get(gmid) ?? null) : null;
    const attempt: { status: 'running' | 'failed' | null; atMs: number | null } =
      member.metabotId != null && bridge?.getWorkerAttemptStatus
        ? bridge.getWorkerAttemptStatus(id, member.metabotId)
        : { status: null, atMs: null };
    const invite = inviteByGmid.get(gmid);
    return {
      ...member,
      lastSpeakAt,
      lastWorkingAt: lastWorkingAt != null ? lastWorkingAt * 1000 : null,
      workStatus: computeGroupTaskMemberWorkStatus({
        metabotId: member.metabotId,
        lastSpeakAt,
        lastWorkingAt: lastWorkingAt != null ? lastWorkingAt * 1000 : null,
        attemptStatus: attempt.status,
        attemptAtMs: attempt.atMs,
        memberStatus: member.status,
      }),
      inviteStatus: deriveGroupTaskMemberInviteStatus({
        metabotId: member.metabotId,
        memberJoinedPinId: member.joinedPinId,
        inviteStatus: invite?.status ?? null,
        inviteJoinedPinId: invite?.joinedPinId ?? null,
      }),
    };
  });
  return {
    ...task,
    members: membersWithStatus,
    deliverables: store.listDeliverables(id),
    transitions: store.listTaskTransitions(id),
    integrityEvents: store.listIntegrityEvents(id),
    messages: task.groupId
      ? store.listGroupChatMessages(task.groupId, { limit: view === 'full' ? 50 : 5 })
      : [],
    stall: stall.stall,
    stallAfterMinutes: stall.stallAfterMinutes,
    // P1-5: status transition history (who/when/from->to).
    statusEvents: store.listStatusEvents(id),
    // P2-8: current driving daemon instance (kv heartbeat claim).
    driver: readGroupTaskDriver(getKvStore(), id),
    // HITL: human checkpoints (open + past), oldest first.
    checkpoints,
    // R1: latest host-generated acceptance summary (single source of truth).
    acceptanceSummary: store.getLatestAcceptanceSummary(id),
    // HITL: what the owner must decide — the tag-free body of the chair's
    // [CHECKPOINT] message that opened the open checkpoint (by pin id), so the
    // detail banner can show it without the owner paging the transcript.
    openCheckpointSummary: resolveOpenCheckpointSummary(store, task, checkpoints),
  };
}

/**
 * HITL: resolve the decision summary for the task's open checkpoint (if any).
 * The summary is the chair's [CHECKPOINT] message body minus its tags — the
 * draft/decision content the owner must review. Returns null when there is no
 * open checkpoint, the opening message cannot be found, or it held nothing
 * but the tag (the UI then falls back to the checkpoint topic).
 */
function resolveOpenCheckpointSummary(
  store: GroupTaskStore,
  task: GroupTask,
  checkpoints: GroupTaskCheckpoint[],
): string | null {
  const openCheckpoint = checkpoints.find((checkpoint) => checkpoint.status === 'open') ?? null;
  if (!openCheckpoint?.openedMsgPinId || !task.groupId) return null;
  const openedMessage = store.getGroupChatMessageByPinId(openCheckpoint.openedMsgPinId);
  if (!openedMessage) return null;
  return extractCheckpointDecisionSummary(openedMessage.content);
}

/**
 * Post a message to the task group as one of its member bots.
 * Validates membership and that the task is not terminal.
 */
/**
 * Resolve the chair MetaBot id for a task (C-2: RPC `send` defaults to the
 * chair identity when the caller omits an explicit sender). Throws when the
 * task does not exist.
 */
export function getGroupTaskChairMetabotId(taskId: number): number {
  const task = requireTask(taskId);
  return task.chairMetabotId;
}

export async function postGroupTaskMessage(
  taskId: number,
  metabotId: number,
  content: string,
  opts?: PostGroupTaskMessageOptions,
): Promise<{ pinId: string; deliverableValidation: DeliverableValidation }> {
  const task = requireRunnableTask(taskId);
  const store = getGroupTaskStore();
  if (!store.isMember(taskId, metabotId)) {
    throw new Error(`MetaBot ${metabotId} is not a member of group task ${taskId}`);
  }
  const text = content?.trim();
  if (!text) throw new Error('content is required');
  const metabot = getMetabotStore().getMetabotById(metabotId);
  const nickName = metabot?.name?.trim() || `bot-${metabotId}`;
  // P0-1: field-level [DELIVERABLE] validation — surfaced to the caller but
  // never blocks the chain write (warn-and-deliver; the chair decides).
  const deliverableValidation = validateDeliverableLines(text);
  const sent = await sendGroupChatMessageFn(metabotId, task.groupId!, {
    content: text,
    nickName,
    contentType: opts?.contentType,
    replyPin: opts?.replyPin,
    mention: opts?.mention,
  });
  return { ...sent, deliverableValidation };
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
): Promise<{ pinId: string; deliverableValidation: DeliverableValidation }> {
  const task = requireRunnableTask(taskId);
  const text = content?.trim();
  if (!text) throw new Error('content is required');
  await ensureOwnerJoinedGroup(task.groupId!);
  const deliverableValidation = validateDeliverableLines(text);
  const sent = await sendGroupChatMessageAsIdentityFn(task.groupId!, {
    content: text,
    replyPin: opts?.replyPin,
    mention: opts?.mention,
  });
  return { ...sent, deliverableValidation };
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
  const member = store.addMember({
    taskId,
    metabotId,
    globalmetaid: metabot.globalmetaid ?? null,
    role: 'worker',
    joinedPinId: pinId,
  });
  // P1-3: eager worker-session pre-creation (invite immediate wake-up).
  try {
    ensureGroupTaskMemberReady({
      coworkStore: getCoworkStore(),
      groupTaskStore: store,
      task,
      botId: metabot.id,
      botName: metabot.name?.trim() || `bot-${metabot.id}`,
    });
  } catch (error) {
    console.warn(
      `[GroupTask] Worker session pre-creation failed for bot ${metabot.id} in task ${taskId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return member;
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

export const GROUP_TASK_MEMBER_STATUSES: GroupTaskMemberStatus[] = [
  'assigned',
  'working',
  'standby',
  'done',
  'unreachable',
];

/**
 * P0-2: set a member's state-machine status. A member may set its own status
 * (assigned/working/standby/done/unreachable); the chair may set any member's
 * status. Throws for unknown members or unauthorized actors.
 */
export async function setGroupTaskMemberStatus(
  taskId: number,
  targetMetabotId: number | null,
  status: GroupTaskMemberStatus,
  opts?: { actorMetabotId?: number | null; targetGlobalMetaId?: string | null },
): Promise<GroupTaskMember> {
  const task = requireTask(taskId);
  const store = getGroupTaskStore();
  if (!GROUP_TASK_MEMBER_STATUSES.includes(status)) {
    throw new Error(`member status must be one of: ${GROUP_TASK_MEMBER_STATUSES.join(', ')}`);
  }
  const members = store.listMembers(task.id);
  const target = targetMetabotId != null
    ? members.find((member) => member.metabotId === targetMetabotId)
    : members.find((member) =>
        (member.globalmetaid ?? '').trim().toLowerCase()
        === (opts?.targetGlobalMetaId ?? '').trim().toLowerCase(),
      );
  if (!target) throw new Error(`Member not found in group task ${task.id}`);

  const actorId = opts?.actorMetabotId ?? targetMetabotId;
  const chair = members.find((member) => member.role === 'chair');
  const isSelf = actorId != null && target.metabotId != null && actorId === target.metabotId;
  const isChair = actorId != null && chair?.metabotId != null && actorId === chair.metabotId;
  if (!isSelf && !isChair) {
    throw new Error('Only the member itself or the task chair can set member status');
  }

  const updated = store.setMemberStatus(task.id, target.metabotId, status, target.globalmetaid);
  if (!updated) throw new Error(`Member not found in group task ${task.id}`);
  return updated;
}

/**
 * P0-5: rework hatch — move a REVIEW task back to EXECUTING so the chair can
 * assign supplementary work before acceptance. Only the task chair may call it
 * (actorMetabotId matches the chair, or is omitted and defaults to the chair).
 * Every transition is recorded in the transition log (C-建议2).
 */
export async function reworkGroupTask(
  taskId: number,
  opts: { reason?: string; actorMetabotId?: number | null; actorName?: string | null },
): Promise<GroupTask> {
  const task = requireTask(taskId);
  const store = getGroupTaskStore();
  if (task.status !== 'review') {
    throw new Error(`Group task ${taskId} is ${task.status}; rework is only available from review`);
  }
  const actorId = opts.actorMetabotId ?? null;
  if (actorId != null && actorId !== task.chairMetabotId) {
    throw new Error('Only the task chair can rework a group task');
  }
  const actor = opts.actorName?.trim()
    || (actorId != null ? `metabot:${actorId}` : `metabot:${task.chairMetabotId}`);
  const updated = store.updateTaskStatusWithLog(taskId, 'executing', {
    actor,
    reason: opts.reason?.trim() || null,
  });
  // Improvement #2 (v1.3): rework-hatch parity with the on-chain
  // [STATUS:EXECUTING] path — reset EVERY review-delivery guard (owner A2A
  // report, origin-session review report, closing re-assert) so the next
  // review re-reports on all channels, and stamp the rework instant so a
  // stale in-flight [STATUS:REVIEW] verdict is debounced (task #24).
  try {
    const kv = getKvStore();
    clearGroupTaskReviewDeliveryGuards(kv, taskId);
    kv.set(`${GROUP_TASK_REWORK_AT_KV_PREFIX}${taskId}`, Date.now());
  } catch (error) {
    console.warn(
      `[GroupTask] Failed to reset review-delivery guards after rework of task ${taskId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (orchestrationBridgeGetter) {
    try {
      orchestrationBridgeGetter().syncStatus(taskId);
    } catch (error) {
      console.warn(
        `[GroupTask] Rework status projection failed for task ${taskId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return updated;
}

export interface GroupTaskExport extends GroupTaskDetail {
  /** Full transcript (up to exportMessageLimit, default 2000), oldest first. */
  fullMessages: GroupChatTranscriptMessage[];
  /** P0-7: per-day digest of the message flow (date → count + first/last). */
  dailySummaries: Array<{ date: string; count: number; firstAt: number | null; lastAt: number | null }>;
  exportedAt: string;
}

/**
 * P0-7: structured archive export — index + full message bodies + daily
 * summaries. Used for review/acceptance and episode preservation.
 */
export async function exportGroupTask(
  taskId: number,
  opts?: { messageLimit?: number },
): Promise<GroupTaskExport> {
  const store = getGroupTaskStore();
  const task = requireTask(taskId);
  const detail = await getGroupTask(taskId, { view: 'full' });
  const limit = Math.max(1, Math.min(5000, Math.trunc(opts?.messageLimit ?? 2000)));
  const messages = task.groupId
    ? store.listGroupChatMessages(task.groupId, { limit })
    : [];

  const byDay = new Map<string, { count: number; firstAt: number | null; lastAt: number | null }>();
  for (const message of messages) {
    if (message.chainTimestamp == null) continue;
    const date = new Date(message.chainTimestamp * 1000).toISOString().slice(0, 10);
    const entry = byDay.get(date) ?? { count: 0, firstAt: null, lastAt: null };
    entry.count += 1;
    entry.firstAt = entry.firstAt == null ? message.chainTimestamp : Math.min(entry.firstAt, message.chainTimestamp);
    entry.lastAt = entry.lastAt == null ? message.chainTimestamp : Math.max(entry.lastAt, message.chainTimestamp);
    byDay.set(date, entry);
  }
  const dailySummaries = [...byDay.entries()]
    .map(([date, entry]) => ({ date, ...entry }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    ...detail,
    fullMessages: messages,
    dailySummaries,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * P0-8: record a public integrity declaration (honest self-correction /
 * truthful report) into the acceptance record. Anyone in the task group may
 * record; dedupe is by message pin when provided.
 */
export async function recordGroupTaskIntegrityEvent(
  taskId: number,
  input: {
    msgPinId?: string | null;
    authorGlobalmetaid?: string | null;
    eventType?: 'correction' | 'honest_report';
    detail?: string | null;
  },
): Promise<GroupTaskIntegrityEvent> {
  const store = getGroupTaskStore();
  requireTask(taskId);
  const msgPinId = input.msgPinId?.trim() || null;
  if (msgPinId && store.hasIntegrityEventWithMsgPin(taskId, msgPinId)) {
    const existing = store.listIntegrityEvents(taskId).find((event) => event.msgPinId === msgPinId);
    if (existing) return existing;
  }
  return store.addIntegrityEvent({
    taskId,
    msgPinId,
    authorGlobalmetaid: input.authorGlobalmetaid?.trim() || null,
    eventType: input.eventType === 'honest_report' ? 'honest_report' : 'correction',
    detail: (input.detail ?? '').trim().slice(0, 500) || null,
  });
}

/**
 * R2: relay the deterministic acceptance notification to the CoWork session that
 * originated this group task ("哪里发起哪里结束"). The message is host-built (not
 * LLM) and kv-guarded per (task, outcome) so a close fires exactly once. The
 * latest acceptance summary (if any) is finalized with the outcome+rating so the
 * audit record is complete. Best-effort: any failure (missing/notifier unset,
 * target session gone) only logs — the task is already closed and never rolls
 * back; NULL sourceSessionId silently skips (degrades to owner-private-only).
 */
function notifySourceSession(
  task: GroupTask,
  outcome: 'done' | 'cancelled',
  rating?: number | null,
  ratingComment?: string | null,
): void {
  const targetSessionId = (task.sourceSessionId ?? '').trim();
  if (!targetSessionId) return; // panel-created / pre-R2 task — no originating session
  if (!acceptanceNotifier) return; // R2 not wired (tests / pre-init)
  const kv = getKvStore();
  const guardKey = `${GROUP_TASK_ACCEPTANCE_NOTIFIED_KV_PREFIX}${task.id}:${outcome}`;
  if (kv.get<string>(guardKey) === '1') return; // one notification per task per outcome

  // Finalize the acceptance summary's terminal snapshot (best-effort) so the
  // audit record carries the outcome+rating alongside the T1 review snapshot.
  try {
    getGroupTaskStore().finalizeAcceptanceSummary(task.id, { outcome, rating: rating ?? null, ratingComment: ratingComment ?? null });
  } catch (error) {
    console.warn(
      `[GroupTask] Failed to finalize acceptance summary on close of task ${task.id}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const ratingLine = outcome === 'done' && rating != null ? `｜评分 ${rating}/5` : '';
  const commentLine = ratingComment?.trim() ? `（${ratingComment.trim()}）` : '';
  const summary = getGroupTaskStore().getLatestAcceptanceSummary(task.id);
  const deliverableCount = summary?.deliverables.length ?? 0;
  const message = [
    `[GROUP_TASK_ACCEPTANCE] 任务「${task.title}」已完成验收：`,
    `结果：${outcome}${ratingLine}${commentLine}`,
    `成果：${deliverableCount} 项${summary ? `（详见验收总结 v${summary.version}）` : '，详见 Tasks 面板'}`,
  ].join('\n');

  try {
    const result = acceptanceNotifier({ taskId: task.id, targetSessionId, message });
    if (!result.ok) {
      console.warn(
        `[GroupTask] Acceptance notification to session ${targetSessionId} not delivered for task ${task.id}` +
        (result.warning ? ` (${result.warning})` : '') +
        '; degrading to owner-private-only',
      );
      return;
    }
    kv.set(guardKey, '1');
    try {
      getGroupTaskStore().updateAcceptanceSummaryNotifiedSession(task.id, targetSessionId);
    } catch (error) {
      console.warn(
        `[GroupTask] Failed to record notified session for task ${task.id}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log(`[GroupTask] Acceptance notification delivered to session ${targetSessionId} for task ${task.id} (${outcome})`);
  } catch (error) {
    console.warn(
      `[GroupTask] Acceptance notification failed for task ${task.id}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Cap for the review report body injected into the origin session (P4 v1.2):
 * concise summary + pointer per the owner's guidance — never a >2000-char dump. */
const REVIEW_REPORT_MAX_CHARS = 1500;

/**
 * P4 (v1.2): deliver the review-stage owner report (the same body the A2A
 * private chat receives) into the origin CoWork session under the
 * [GROUP_TASK_REVIEW] prefix, through the same R2 insertCrossSessionMessageAndQueue
 * seam as the close-time acceptance notice. kv-guarded per review-entry
 * (`group_task_review_notified:<taskId>`); the daemon's rework hatch clears the
 * guard so the next review re-reports. Best-effort only.
 *
 * Improvement #1 (single-card acceptance): when the daemon extracted the
 * chair's 【结论】 verdict, the notice collapses to verdict + pointer to the
 * Tasks acceptance card (the single place to read the checklist and act) —
 * no parallel full report. Without a conclusion the legacy capped-narrative
 * form is kept as the fallback.
 */
export function notifySourceSessionReview(
  task: GroupTask,
  input: { report: string; conclusion?: string | null },
): void {
  const targetSessionId = (task.sourceSessionId ?? '').trim();
  if (!targetSessionId) return; // no originating session (panel-created task)
  if (!acceptanceNotifier) return; // R2 seam not wired (tests / pre-init)
  const kv = getKvStore();
  const guardKey = `${GROUP_TASK_REVIEW_NOTIFIED_KV_PREFIX}${task.id}`;
  if (kv.get<string>(guardKey) === '1') return;

  const body = input.report.trim();
  if (!body) return;
  const conclusion = (input.conclusion ?? '').trim();
  let message: string;
  if (conclusion) {
    let versionTag = '';
    try {
      const summary = getGroupTaskStore().getLatestAcceptanceSummary(task.id);
      if (summary) versionTag = `（验收摘要 v${summary.version}）`;
    } catch {
      // Version tag is decorative — never blocks the notice.
    }
    message = [
      `[GROUP_TASK_REVIEW] 任务「${task.title}」已进入验收${versionTag}。`,
      `结论：${conclusion}`,
      `完整验收清单与 Accept & Close / Rework 操作见 Tasks 面板的验收卡。`,
    ].join('\n');
  } else {
    const capped = body.length > REVIEW_REPORT_MAX_CHARS
      ? `${body.slice(0, REVIEW_REPORT_MAX_CHARS).trimEnd()}…\n（报告过长已截断——完整验收摘要见 Tasks 面板与群内 chair 摘要消息）`
      : body;
    message = [
      // Improvement #5 (task #25): the body is an AI-drafted narration of the
      // host acceptance summary — it must never be labeled as the chair's ruling.
      `[GROUP_TASK_REVIEW] 任务「${task.title}」已进入验收（系统生成验收汇总，chair 一手核验结论见群内）：`,
      capped,
    ].join('\n');
  }

  try {
    const result = acceptanceNotifier({ taskId: task.id, targetSessionId, message });
    if (!result.ok) {
      console.warn(
        `[GroupTask] Review report to session ${targetSessionId} not delivered for task ${task.id}` +
        (result.warning ? ` (${result.warning})` : ''),
      );
      return;
    }
    kv.set(guardKey, '1');
    console.log(`[GroupTask] Review report delivered to session ${targetSessionId} for task ${task.id}`);
  } catch (error) {
    console.warn(
      `[GroupTask] Review report failed for task ${task.id}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Close a task via the store state machine (sets closed_at for terminal states).
 * `reason` is accepted for API completeness but not persisted (no column in M1).
 * When closing as 'done', the owner's acceptance rating (1-5 + optional
 * comment) is persisted alongside; automated callers (RPC) may omit it.
 * `actor` is recorded on the status-transition event (P1-5).
 */
export async function closeGroupTask(
  taskId: number,
  opts: { status: 'done' | 'cancelled'; reason?: string; rating?: number; ratingComment?: string; actor?: GroupTaskStatusEventActor },
): Promise<GroupTask> {
  if (opts.status !== 'done' && opts.status !== 'cancelled') {
    throw new Error(`closeGroupTask status must be 'done' or 'cancelled'`);
  }
  if (opts.reason?.trim()) {
    console.log(`[GroupTask] Closing task ${taskId} as ${opts.status}: ${opts.reason.trim()}`);
  }
  const closed = await (() => {
    if (orchestrationBridgeGetter) {
      const bridge = orchestrationBridgeGetter();
      return opts.status === 'done'
        ? bridge.acceptGroupTask(taskId, opts.actor).groupTask
        : bridge.cancelGroupTask(taskId, opts.actor).groupTask;
    }
    return getGroupTaskStore().updateTaskStatus(taskId, opts.status, { actor: opts.actor });
  })();
  // HITL: a task closing with a checkpoint still open cancels that checkpoint
  // (the wait is over either way). Best-effort: never block the close itself.
  try {
    getGroupTaskStore().closeOpenCheckpoints(taskId, 'cancelled', `task closed as ${opts.status}`);
  } catch (error) {
    console.warn(
      `[GroupTask] Failed to cancel open checkpoints on close of task ${taskId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (closed.status === 'done' && opts.rating != null) {
    const rated = getGroupTaskStore().updateTaskRating(taskId, opts.rating, opts.ratingComment);
    // R2: relay the acceptance result back to the originating CoWork session
    // (best-effort; never throws into the close flow). Done after the rating is
    // persisted so the notification carries the final rating.
    notifySourceSession(rated, opts.status, opts.rating, opts.ratingComment);
    return rated;
  }
  // OpenTeam M3: the chair sediments one participation impression per REMOTE
  // teammate (recorded for cancelled tasks too). Best-effort: the task is
  // already closed; the recorder never throws into this flow.
  recordTaskCloseImpressions(taskId, opts.status, opts.reason);
  // R2: relay the acceptance result back to the originating CoWork session
  // (covers cancelled and automated/RPC closes without a rating).
  notifySourceSession(closed, opts.status, opts.rating, opts.ratingComment);
  return closed;
}

/**
 * P0-1: pull a REVIEW task back to EXECUTING so the owner/chair can assign
 * supplementary subtasks (the "Back to work / 返回修改" action, mirroring the
 * on-chain rework hatch `[STATUS:EXECUTING]`). Legal only from review (the
 * store state machine enforces it). Also clears the owner-report kv guard so
 * the NEXT review re-reports to the owner, and syncs the canonical task.
 */
export async function reopenGroupTask(
  taskId: number,
  opts?: { actor?: GroupTaskStatusEventActor; reason?: string },
): Promise<GroupTaskDetail> {
  const store = getGroupTaskStore();
  const task = requireTask(taskId);
  if (task.status !== 'review') {
    throw new Error(
      `Group task ${taskId} is ${task.status}; only review tasks can be reopened to executing`,
    );
  }
  if (opts?.reason?.trim()) {
    console.log(`[GroupTask] Reopening task ${taskId} to executing: ${opts.reason.trim()}`);
  }
  const updated = store.updateTaskStatus(taskId, 'executing', {
    actor: opts?.actor ?? { kind: 'owner' },
  });
  try {
    orchestrationBridgeGetter?.().syncStatus(taskId);
  } catch (error) {
    console.warn(
      `[GroupTask] Canonical status projection failed after reopen of task ${taskId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Rework-hatch parity (Improvement #2 v1.3): reset EVERY review-delivery
  // guard (not just the owner-report one) and stamp the rework instant, so
  // the next review re-reports on all channels and a stale in-flight
  // [STATUS:REVIEW] verdict is debounced.
  try {
    const kv = getKvStore();
    clearGroupTaskReviewDeliveryGuards(kv, taskId);
    kv.set(`${GROUP_TASK_REWORK_AT_KV_PREFIX}${taskId}`, Date.now());
  } catch (error) {
    console.warn(
      `[GroupTask] Failed to reset review-delivery guards after reopen of task ${taskId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return getGroupTask(taskId);
}

/**
 * P1-4: host-computed member work status (idle/working/error) for the chair —
 * a dedicated lightweight query (RPC /group-task/member-status) so the chair
 * checks instead of guessing. Remote members carry only transcript signals.
 */
export async function getGroupTaskMemberStatus(
  taskId: number,
): Promise<GroupTaskMemberSummary[]> {
  const detail = await getGroupTask(taskId, { view: 'summary' });
  return detail.members;
}

/**
 * P1-3: join a local bot to the task AND eagerly create its worker session
 * with the group context injected (invite immediate wake-up — the session
 * exists within the join call instead of waiting for the first daemon reply).
 */
export type GroupTaskInviteSessionStatus = 'created' | 'ready' | 'failed';

/**
 * P1-3: join a local bot AND report the worker-session status. The eager
 * session creation itself happens inside joinGroupTaskMember (shared path);
 * here we diff the conversation mapping before/after the join so the response
 * can truthfully say created (fresh session) / ready (already existed) /
 * failed (no mapping after the join).
 */
export async function joinGroupTaskMemberWithSession(
  taskId: number,
  metabotId: number,
): Promise<{ member: GroupTaskMember; sessionStatus: GroupTaskInviteSessionStatus }> {
  const mappingExists = (): boolean => {
    try {
      return Boolean(
        getCoworkStore().getConversationMapping(
          GROUP_TASK_CONVERSATION_CHANNEL,
          `group-task:${taskId}`,
          metabotId,
        ),
      );
    } catch {
      return false;
    }
  };
  const hadSession = mappingExists();
  const member = await joinGroupTaskMember(taskId, metabotId);
  const hasSession = mappingExists();
  return {
    member,
    sessionStatus: hasSession ? (hadSession ? 'ready' : 'created') : 'failed',
  };
}
