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
  type GroupTaskDeliverable,
  type GroupTaskStatus,
  type GroupTaskStatusEvent,
  type GroupTaskStatusEventActor,
  type GroupChatTranscriptMessage,
} from '../groupTaskStore';
import {
  createGroupChat,
  joinGroupChat,
  joinGroupChatAsIdentity,
  sendGroupChatMessage,
  sendGroupChatMessageAsIdentity,
  waitForGroupIndexed,
} from './groupChatTransport';
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';
import {
  ensureGroupTaskMemberReady,
  GROUP_TASK_CONVERSATION_CHANNEL,
} from './groupTaskSession';
import {
  GROUP_TASK_DRIVER_KV_PREFIX,
  GROUP_TASK_OWNER_REPORTED_KV_PREFIX,
} from './groupTaskDaemon';

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
  members: GroupTaskMemberSummary[];
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
  /** P1-5: status transition history (newest first). */
  statusEvents: GroupTaskStatusEvent[];
  /** P2-8: the daemon instance currently driving this task (kv heartbeat claim). */
  driver: GroupTaskDriverInfo | null;
}

/** P2-8: who drives a task right now (multi-window/multi-session annotation). */
export interface GroupTaskDriverInfo {
  instanceId: string;
  atMs: number;
}

/** P1-4: host-computed member work state (idle/working/error/unknown). */
export type GroupTaskMemberWorkStatus = 'working' | 'error' | 'idle' | 'unknown';

/** Minutes a [WORKING] tag stays "working" after its last occurrence. */
export const GROUP_TASK_WORKING_WINDOW_MINUTES = 20;
/** Minutes a failed canonical attempt stays "error" after it finished. */
export const GROUP_TASK_ERROR_WINDOW_MINUTES = 60;

/** Round-4: minutes of host inactivity before a non-terminal task reads as stalled. */
export const GROUP_TASK_STALL_AFTER_MINUTES = 30;

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
let sendGroupChatMessageFn = sendGroupChatMessage;
let sendGroupChatMessageAsIdentityFn = sendGroupChatMessageAsIdentity;
let waitForGroupIndexedFn = waitForGroupIndexed;

export interface GroupTaskServiceTransportOverrides {
  createGroupChat?: typeof createGroupChat;
  joinGroupChat?: typeof joinGroupChat;
  joinGroupChatAsIdentity?: typeof joinGroupChatAsIdentity;
  sendGroupChatMessage?: typeof sendGroupChatMessage;
  sendGroupChatMessageAsIdentity?: typeof sendGroupChatMessageAsIdentity;
  waitForGroupIndexed?: typeof waitForGroupIndexed;
}

export function setGroupTaskServiceTransport(overrides: GroupTaskServiceTransportOverrides): void {
  createGroupChatFn = overrides.createGroupChat ?? createGroupChat;
  joinGroupChatFn = overrides.joinGroupChat ?? joinGroupChat;
  joinGroupChatAsIdentityFn = overrides.joinGroupChatAsIdentity ?? joinGroupChatAsIdentity;
  sendGroupChatMessageFn = overrides.sendGroupChatMessage ?? sendGroupChatMessage;
  sendGroupChatMessageAsIdentityFn = overrides.sendGroupChatMessageAsIdentity ?? sendGroupChatMessageAsIdentity;
  waitForGroupIndexedFn = overrides.waitForGroupIndexed ?? waitForGroupIndexed;
}

export function resetGroupTaskServiceTransport(): void {
  createGroupChatFn = createGroupChat;
  joinGroupChatFn = joinGroupChat;
  joinGroupChatAsIdentityFn = joinGroupChatAsIdentity;
  sendGroupChatMessageFn = sendGroupChatMessage;
  sendGroupChatMessageAsIdentityFn = sendGroupChatMessageAsIdentity;
  waitForGroupIndexedFn = waitForGroupIndexed;
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
  /** P1-4: epoch seconds of the member's last `[WORKING]` tag message. */
  lastWorkingAt: number | null;
  /** P1-4: host-computed work state — the chair can query instead of guessing. */
  workStatus: GroupTaskMemberWorkStatus;
}

/**
 * P1-4: pure workStatus derivation. Priority: a RUNNING canonical attempt, a
 * fresh `[WORKING]` tag (working window), a recent FAILED attempt (error
 * window), any speech (idle), otherwise unknown.
 */
export function computeGroupTaskMemberWorkStatus(input: {
  metabotId: number | null;
  lastSpeakAt: number | null;
  lastWorkingAt: number | null;
  attemptStatus: 'running' | 'failed' | null;
  attemptAtMs: number | null;
  nowMs?: number;
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
    return 'error';
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
  const speakMap = view === 'summary' && task.groupId
    ? store.getMembersLastSpeakAt(task.groupId!, members.map((m) => m.globalmetaid))
    : new Map<string, number>();
  const workingMap = view === 'summary' && task.groupId
    ? store.getMembersWorkingAt(task.groupId!, members.map((m) => m.globalmetaid))
    : new Map<string, number>();
  const bridge = orchestrationBridgeGetter?.();
  const membersWithStatus: GroupTaskMemberSummary[] = members.map((member) => {
    const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
    const lastSpeakAt = gmid ? (speakMap.get(gmid) ?? null) : null;
    const lastWorkingAt = gmid ? (workingMap.get(gmid) ?? null) : null;
    const attempt: { status: 'running' | 'failed' | null; atMs: number | null } =
      member.metabotId != null && bridge?.getWorkerAttemptStatus
        ? bridge.getWorkerAttemptStatus(id, member.metabotId)
        : { status: null, atMs: null };
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
      }),
    };
  });
  return {
    ...task,
    members: membersWithStatus,
    deliverables: store.listDeliverables(id),
    messages: task.groupId
      ? store.listGroupChatMessages(task.groupId, { limit: view === 'full' ? 50 : 5 })
      : [],
    stall: stall.stall,
    stallAfterMinutes: stall.stallAfterMinutes,
    // P1-5: status transition history (who/when/from->to).
    statusEvents: store.listStatusEvents(id),
    // P2-8: current driving daemon instance (kv heartbeat claim).
    driver: readGroupTaskDriver(getKvStore(), id),
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
 * `actor` is recorded on the status-transition event (P1-5).
 */
export async function closeGroupTask(
  taskId: number,
  opts: { status: 'done' | 'cancelled'; reason?: string; actor?: GroupTaskStatusEventActor },
): Promise<GroupTask> {
  if (opts.status !== 'done' && opts.status !== 'cancelled') {
    throw new Error(`closeGroupTask status must be 'done' or 'cancelled'`);
  }
  if (opts.reason?.trim()) {
    console.log(`[GroupTask] Closing task ${taskId} as ${opts.status}: ${opts.reason.trim()}`);
  }
  if (orchestrationBridgeGetter) {
    const bridge = orchestrationBridgeGetter();
    return opts.status === 'done'
      ? bridge.acceptGroupTask(taskId, opts.actor).groupTask
      : bridge.cancelGroupTask(taskId, opts.actor).groupTask;
  }
  return getGroupTaskStore().updateTaskStatus(taskId, opts.status, { actor: opts.actor });
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
  // Rework-hatch parity: the next review must report to the owner again.
  try {
    getKvStore().delete(`${GROUP_TASK_OWNER_REPORTED_KV_PREFIX}${taskId}`);
  } catch (error) {
    console.warn(
      `[GroupTask] Failed to clear owner-report guard after reopen of task ${taskId}: ` +
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
