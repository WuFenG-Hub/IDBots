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
  type GroupTaskMemberStatus,
  type GroupTaskTransition,
  type GroupTaskDeliverable,
  type GroupTaskStatus,
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
import {
  validateDeliverableLines,
  type DeliverableValidation,
} from './groupTaskDeliverableParser';
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';

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
}

export interface GroupTaskDetail extends GroupTask {
  members: GroupTaskMember[];
  deliverables: GroupTaskDeliverable[];
  /** P0-5: state-transition audit log (who/from/to/reason). */
  transitions: GroupTaskTransition[];
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
  // P0-2: lastSpeakAt is computed for BOTH views — the detail/UI member list
  // shows the member state badge plus when each member last spoke.
  const speakMap = task.groupId
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
    transitions: store.listTaskTransitions(id),
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
  return store.addMember({
    taskId,
    metabotId,
    globalmetaid: metabot.globalmetaid ?? null,
    role: 'worker',
    joinedPinId: pinId,
  });
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
 * Close a task via the store state machine (sets closed_at for terminal states).
 * `reason` is accepted for API completeness but not persisted (no column in M1).
 * When closing as 'done', the owner's acceptance rating (1-5 + optional
 * comment) is persisted alongside; automated callers (RPC) may omit it.
 */
export async function closeGroupTask(
  taskId: number,
  opts: { status: 'done' | 'cancelled'; reason?: string; rating?: number; ratingComment?: string },
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
        ? bridge.acceptGroupTask(taskId).groupTask
        : bridge.cancelGroupTask(taskId).groupTask;
    }
    return getGroupTaskStore().updateTaskStatus(taskId, opts.status);
  })();
  if (closed.status === 'done' && opts.rating != null) {
    return getGroupTaskStore().updateTaskRating(taskId, opts.rating, opts.ratingComment);
  }
  return closed;
}
