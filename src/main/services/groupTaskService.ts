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
} from '../groupTaskStore';
import {
  createGroupChat,
  joinGroupChat,
  sendGroupChatMessage,
  waitForGroupIndexed,
} from './groupChatTransport';

export interface CreateGroupTaskOptions {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  /** Worker metabot ids; chair (the current twin) is added automatically. */
  memberMetabotIds?: number[];
  createdBy: 'user' | 'twinbot';
}

export interface GroupTaskDetail extends GroupTask {
  members: GroupTaskMember[];
  deliverables: GroupTaskDeliverable[];
}

export interface PostGroupTaskMessageOptions {
  contentType?: string;
  replyPin?: string;
  mention?: string[];
}

const TERMINAL_STATUSES: ReadonlySet<GroupTaskStatus> = new Set(['done', 'cancelled']);

let metabotStoreGetter: (() => MetabotStore) | null = null;
let groupTaskStoreGetter: (() => GroupTaskStore) | null = null;

export function setGroupTaskServiceMetabotStoreGetter(getter: () => MetabotStore): void {
  metabotStoreGetter = getter;
}

export function setGroupTaskServiceGroupTaskStoreGetter(getter: () => GroupTaskStore): void {
  groupTaskStoreGetter = getter;
}

// Transport function seams (same setter-injection style; defaults are the real
// implementations). Tests override these to avoid chain writes.
let createGroupChatFn = createGroupChat;
let joinGroupChatFn = joinGroupChat;
let sendGroupChatMessageFn = sendGroupChatMessage;
let waitForGroupIndexedFn = waitForGroupIndexed;

export interface GroupTaskServiceTransportOverrides {
  createGroupChat?: typeof createGroupChat;
  joinGroupChat?: typeof joinGroupChat;
  sendGroupChatMessage?: typeof sendGroupChatMessage;
  waitForGroupIndexed?: typeof waitForGroupIndexed;
}

export function setGroupTaskServiceTransport(overrides: GroupTaskServiceTransportOverrides): void {
  createGroupChatFn = overrides.createGroupChat ?? createGroupChat;
  joinGroupChatFn = overrides.joinGroupChat ?? joinGroupChat;
  sendGroupChatMessageFn = overrides.sendGroupChatMessage ?? sendGroupChatMessage;
  waitForGroupIndexedFn = overrides.waitForGroupIndexed ?? waitForGroupIndexed;
}

export function resetGroupTaskServiceTransport(): void {
  createGroupChatFn = createGroupChat;
  joinGroupChatFn = joinGroupChat;
  sendGroupChatMessageFn = sendGroupChatMessage;
  waitForGroupIndexedFn = waitForGroupIndexed;
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

function requireRunnableTask(taskId: number): GroupTask {
  const task = requireTask(taskId);
  if (TERMINAL_STATUSES.has(task.status)) {
    throw new Error(`Group task ${taskId} is ${task.status}; no further messages or members allowed`);
  }
  if (!task.groupId) {
    throw new Error(`Group task ${taskId} has no on-chain group id`);
  }
  return task;
}

/** Kickoff message posted by the chair right after group creation. */
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
    `Chair: @${input.chairName}`,
    input.memberNames.length > 0
      ? `Members: ${input.memberNames.map((name) => `@${name}`).join(', ')}`
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

  const workerIds = [...new Set((opts.memberMetabotIds ?? [])
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

export async function getGroupTask(id: number): Promise<GroupTaskDetail> {
  const store = getGroupTaskStore();
  const task = requireTask(id);
  return {
    ...task,
    members: store.listMembers(id),
    deliverables: store.listDeliverables(id),
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
  return getGroupTaskStore().updateTaskStatus(taskId, opts.status);
}
