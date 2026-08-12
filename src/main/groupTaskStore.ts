/**
 * Group Task store: CRUD for group_tasks / group_task_members /
 * group_task_deliverables plus the task status state machine.
 * Structural pattern follows scheduledTaskStore.ts (wraps SqliteStore db + saveDb).
 */

import type { SqliteDatabase as Database } from './sqliteTypes';
import { normalizeRawGlobalMetaId } from './shared/globalMetaId';

/**
 * Canonical GlobalMetaID form when the value parses (trim + lowercase), else
 * the trimmed original so legacy non-canonical rows stay comparable. Applied
 * at every globalmetaid entry point, same normalization as the invite path.
 */
function normalizeMemberGlobalMetaId(value: unknown): string {
  return normalizeRawGlobalMetaId(value) ?? (typeof value === 'string' ? value.trim() : '');
}

export type GroupTaskStatus = 'planning' | 'executing' | 'review' | 'done' | 'cancelled';
export type GroupTaskMemberRole = 'chair' | 'worker';
export type GroupTaskMemberStatus = 'assigned' | 'working' | 'standby' | 'done' | 'unreachable';
export type GroupTaskDeliverableStatus = 'pending' | 'accepted' | 'rejected';

/**
 * Who moved a group task between statuses. 'chair' = the chair bot acted
 * (on-chain [STATUS:...] tag or its RPC close), 'owner' = the human owner
 * acted (UI accept/close/back-to-work), 'system' = host-internal transition
 * without a recorded actor (defaults, migration/backfill paths).
 */
export type GroupTaskStatusEventActorKind = 'chair' | 'owner' | 'system';

export interface GroupTaskStatusEventActor {
  kind: GroupTaskStatusEventActorKind;
  globalMetaId?: string | null;
  name?: string | null;
}

/** One recorded status transition (P1-5: who/when/from/to). */
export interface GroupTaskStatusEvent {
  id: number;
  taskId: number;
  fromStatus: GroupTaskStatus;
  toStatus: GroupTaskStatus;
  actorKind: GroupTaskStatusEventActorKind;
  actorGlobalMetaId: string | null;
  actorName: string | null;
  /** sqlite datetime('now') text, UTC. */
  createdAt: string | null;
}

export interface UpdateGroupTaskStatusOptions {
  /** Recorded in group_task_status_events; defaults to a 'system' actor. */
  actor?: GroupTaskStatusEventActor;
}

export interface GroupTask {
  id: number;
  orchestrationTaskId: string | null;
  groupId: string | null;
  title: string;
  goal: string;
  acceptanceCriteria: string | null;
  status: GroupTaskStatus;
  chairMetabotId: number;
  createdBy: string;
  /**
   * Round-4 (semantics): the daemon cursor — id of the LAST MESSAGE THE HOST
   * SUCCESSFULLY PROCESSED. It only advances on success; a failing message is
   * retried (bounded) and never silently skipped.
   */
  lastProcessedMsgId: number;
  /**
   * Round-4: epoch SECONDS of the host's last daemon drive (per-tick heartbeat
   * for the stall signal). null when the daemon has never driven the task.
   */
  lastDrivenAt: number | null;
  createPinId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  /** Owner acceptance rating (1-5 stars), recorded when the task is accepted. */
  rating: number | null;
  /** Optional free-text review from the owner alongside the star rating. */
  ratingComment: string | null;
  /** datetime('now') of the rating; null for unrated tasks. */
  ratedAt: string | null;
}

export interface GroupTaskMember {
  id: number;
  taskId: number;
  metabotId: number | null;
  globalmetaid: string | null;
  role: GroupTaskMemberRole;
  joinedPinId: string | null;
  createdAt: string | null;
  /** Inviter-side name snapshot for remote members (no local metabots row). */
  displayName: string | null;
  /** Set when the member was kicked (M3); active members have NULL. */
  removedAt: string | null;
  /** On-chain /protocols/simplegroupremoveuser pin that removed the member (M3). */
  removePinId: string | null;
  /** Joined from metabots for display / mention matching (falls back to displayName for remote members). */
  name: string | null;
  /** P0-2: member state-machine status (assigned/working/standby/done/unreachable). */
  status: GroupTaskMemberStatus;
  /** P0-2: epoch-seconds (sqlite datetime) of the last status change. */
  statusChangedAt: string | null;
}

export interface GroupTaskDeliverable {
  id: number;
  taskId: number;
  msgPinId: string | null;
  authorGlobalmetaid: string | null;
  kind: string | null;
  uri: string | null;
  status: GroupTaskDeliverableStatus;
  createdAt: string | null;
  /** P0-4: JSON verification report (sources + outcomes) for a deliverable. */
  verification: string | null;
  /**
   * Issue #8: on-chain confirmation of the deliverable's pin, driven by the
   * daemon's multi-source verification (verified=true => 'confirmed'). This is
   * ORTHOGONAL to `status`: a pin can be on-chain confirmed while still
   * pending owner acceptance (status='pending', confirmation='confirmed').
   */
  confirmation: 'unconfirmed' | 'confirmed';
}

/** One transcript row for the Group Task chat view (content already decrypted). */
export interface GroupChatTranscriptMessage {
  id: number;
  pinId: string | null;
  txId: string | null;
  senderName: string | null;
  senderGlobalMetaId: string | null;
  senderAvatar: string | null;
  content: string | null;
  contentType: string | null;
  chainTimestamp: number | null;
  msgIndex: number | null;
  replyPin: string | null;
  /**
   * Round-4 attribution: true when the chain-signature GlobalMetaID could not
   * be resolved OR is neither a task member nor the owner — display-only flag,
   * the sender must never be inferred from senderName.
   */
  senderSuspect: boolean;
}

export interface CreateGroupTaskInput {
  groupId: string;
  title: string;
  goal: string;
  acceptanceCriteria?: string | null;
  chairMetabotId: number;
  createdBy: 'user' | 'twinbot';
  createPinId?: string | null;
}

export interface AddGroupTaskMemberInput {
  taskId: number;
  metabotId: number | null;
  globalmetaid?: string | null;
  role: GroupTaskMemberRole;
  joinedPinId?: string | null;
  /** Name snapshot for remote members (metabotId === null). */
  displayName?: string | null;
}

export interface MarkGroupTaskMemberRemovedInput {
  taskId: number;
  /** Local member path (metabots row id). */
  metabotId?: number | null;
  /** Remote member path (metabot_id IS NULL rows). */
  globalmetaid?: string | null;
  /** The on-chain removeuser pin id, recorded for audit. */
  removePinId?: string | null;
}

export interface AddGroupTaskDeliverableInput {
  taskId: number;
  msgPinId?: string | null;
  authorGlobalmetaid?: string | null;
  kind?: string | null;
  uri?: string | null;
}
export interface GroupTaskTransition {
  id: number;
  taskId: number;
  fromStatus: GroupTaskStatus | null;
  toStatus: GroupTaskStatus;
  actor: string | null;
  reason: string | null;
  createdAt: string | null;
}

export interface AddGroupTaskTransitionInput {
  taskId: number;
  fromStatus: GroupTaskStatus | null;
  toStatus: GroupTaskStatus;
  actor?: string | null;
  reason?: string | null;
}
export type GroupTaskIntegrityEventType = 'correction' | 'honest_report';

export interface GroupTaskIntegrityEvent {
  id: number;
  taskId: number;
  msgPinId: string | null;
  authorGlobalmetaid: string | null;
  eventType: GroupTaskIntegrityEventType;
  /** Human-readable detail (the public declaration text, capped). */
  detail: string | null;
  createdAt: string | null;
}



interface GroupTaskRow {
  id: number;
  orchestration_task_id: string | null;
  group_id: string | null;
  title: string;
  goal: string;
  acceptance_criteria: string | null;
  status: string;
  chair_metabot_id: number;
  created_by: string;
  last_processed_msg_id: number;
  last_driven_at: number | null;
  create_pin_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  rating: number | null;
  rating_comment: string | null;
  rated_at: string | null;
}

interface GroupTaskMemberRow {
  id: number;
  task_id: number;
  metabot_id: number | null;
  globalmetaid: string | null;
  role: string;
  joined_pin_id: string | null;
  created_at: string | null;
  display_name: string | null;
  removed_at: string | null;
  remove_pin_id: string | null;
  metabot_name: string | null;
  metabot_globalmetaid: string | null;
  status: string;
  status_changed_at: string | null;
}

interface GroupTaskDeliverableRow {
  id: number;
  task_id: number;
  msg_pin_id: string | null;
  author_globalmetaid: string | null;
  kind: string | null;
  uri: string | null;
  status: string;
  created_at: string | null;
  verification: string | null;
  confirmation: string | null;
}

interface GroupTaskTransitionRow {
  id: number;
  task_id: number;
  from_status: string | null;
  to_status: string;
  actor: string | null;
  reason: string | null;
  created_at: string | null;
}

interface GroupTaskIntegrityEventRow {
  id: number;
  task_id: number;
  msg_pin_id: string | null;
  author_globalmetaid: string | null;
  event_type: string;
  detail: string | null;
  created_at: string | null;
}

interface GroupTaskStatusEventRow {
  id: number;
  task_id: number;
  from_status: string;
  to_status: string;
  actor_kind: string;
  actor_globalmetaid: string | null;
  actor_name: string | null;
  created_at: string | null;
}

interface GroupChatTranscriptRow {
  id: number;
  pin_id: string | null;
  tx_id: string | null;
  sender_name: string | null;
  sender_global_metaid: string | null;
  sender_avatar: string | null;
  content: string | null;
  content_type: string | null;
  chain_timestamp: number | null;
  msg_index: number | null;
  reply_pin: string | null;
  sender_suspect?: number | null;
}

function rowToGroupTaskStatusEvent(row: GroupTaskStatusEventRow): GroupTaskStatusEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    fromStatus: isGroupTaskStatus(row.from_status) ? row.from_status : 'planning',
    toStatus: isGroupTaskStatus(row.to_status) ? row.to_status : 'planning',
    actorKind: row.actor_kind === 'chair' || row.actor_kind === 'owner' ? row.actor_kind : 'system',
    actorGlobalMetaId: row.actor_globalmetaid ?? null,
    actorName: row.actor_name ?? null,
    createdAt: row.created_at ?? null,
  };
}

function rowToGroupChatTranscriptMessage(row: GroupChatTranscriptRow): GroupChatTranscriptMessage {
  return {
    id: row.id,
    pinId: row.pin_id ?? null,
    txId: row.tx_id ?? null,
    senderName: row.sender_name ?? null,
    senderGlobalMetaId: row.sender_global_metaid ?? null,
    senderAvatar: row.sender_avatar ?? null,
    content: row.content ?? null,
    contentType: row.content_type ?? null,
    chainTimestamp: row.chain_timestamp ?? null,
    msgIndex: row.msg_index ?? null,
    replyPin: row.reply_pin ?? null,
    senderSuspect: Number(row.sender_suspect ?? 0) === 1,
  };
}

const TERMINAL_STATUSES: ReadonlySet<GroupTaskStatus> = new Set(['done', 'cancelled']);

/**
 * Legal transitions: planning→executing→review→done, →cancelled from any
 * non-terminal state, and review→executing as the rework hatch (the chair
 * re-opens work via [STATUS:EXECUTING] when acceptance fails). Terminal states
 * (done/cancelled) allow no further moves.
 */
const LEGAL_TRANSITIONS: Record<GroupTaskStatus, GroupTaskStatus[]> = {
  // The chair-driven flow is planning→executing→review→done, but the owner's
  // accept/close action may shortcut to 'done' from any non-terminal state.
  planning: ['executing', 'done', 'cancelled'],
  executing: ['review', 'done', 'cancelled'],
  review: ['done', 'executing', 'cancelled'],
  done: [],
  cancelled: [],
};

function isGroupTaskMemberStatus(value: string): value is GroupTaskMemberStatus {
  return value === 'assigned' || value === 'working' || value === 'standby'
    || value === 'done' || value === 'unreachable';
}

function isGroupTaskStatus(value: string): value is GroupTaskStatus {
  return value === 'planning' || value === 'executing' || value === 'review'
    || value === 'done' || value === 'cancelled';
}

function rowToGroupTask(row: GroupTaskRow): GroupTask {
  return {
    id: row.id,
    orchestrationTaskId: row.orchestration_task_id ?? null,
    groupId: row.group_id ?? null,
    title: row.title,
    goal: row.goal,
    acceptanceCriteria: row.acceptance_criteria ?? null,
    status: isGroupTaskStatus(row.status) ? row.status : 'planning',
    chairMetabotId: row.chair_metabot_id,
    createdBy: row.created_by,
    lastProcessedMsgId: row.last_processed_msg_id ?? 0,
    lastDrivenAt: row.last_driven_at ?? null,
    createPinId: row.create_pin_id ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    closedAt: row.closed_at ?? null,
    rating: row.rating ?? null,
    ratingComment: row.rating_comment ?? null,
    ratedAt: row.rated_at ?? null,
  };
}

function rowToGroupTaskMember(row: GroupTaskMemberRow): GroupTaskMember {
  return {
    id: row.id,
    taskId: row.task_id,
    metabotId: row.metabot_id ?? null,
    // Prefer the redundant member-row copy; fall back to the metabots table.
    globalmetaid: row.globalmetaid ?? row.metabot_globalmetaid ?? null,
    role: row.role === 'chair' ? 'chair' : 'worker',
    joinedPinId: row.joined_pin_id ?? null,
    createdAt: row.created_at ?? null,
    displayName: row.display_name ?? null,
    removedAt: row.removed_at ?? null,
    removePinId: row.remove_pin_id ?? null,
    // Local members get the metabots-table name; remote members fall back to
    // the display_name snapshot recorded at invite time.
    name: row.metabot_name ?? row.display_name ?? null,
    // P0-2: default status — chair starts 'working', workers 'assigned'. Old
    // rows without a status column default the same way.
    status: isGroupTaskMemberStatus(row.status)
      ? row.status
      : (row.role === 'chair' ? 'working' : 'assigned'),
    statusChangedAt: row.status_changed_at ?? null,
  };
}

function rowToGroupTaskIntegrityEvent(row: GroupTaskIntegrityEventRow): GroupTaskIntegrityEvent {
  const type = row.event_type === 'honest_report' ? 'honest_report' : 'correction';
  return {
    id: row.id,
    taskId: row.task_id,
    msgPinId: row.msg_pin_id ?? null,
    authorGlobalmetaid: row.author_globalmetaid ?? null,
    eventType: type,
    detail: row.detail ?? null,
    createdAt: row.created_at ?? null,
  };
}

function rowToGroupTaskTransition(row: GroupTaskTransitionRow): GroupTaskTransition {
  const from = row.from_status;
  const to = row.to_status;
  return {
    id: row.id,
    taskId: row.task_id,
    fromStatus: from && isGroupTaskStatus(from) ? from : null,
    toStatus: isGroupTaskStatus(to) ? to : 'planning',
    actor: row.actor ?? null,
    reason: row.reason ?? null,
    createdAt: row.created_at ?? null,
  };
}

function rowToGroupTaskDeliverable(row: GroupTaskDeliverableRow): GroupTaskDeliverable {
  const status = row.status;
  return {
    id: row.id,
    taskId: row.task_id,
    msgPinId: row.msg_pin_id ?? null,
    authorGlobalmetaid: row.author_globalmetaid ?? null,
    kind: row.kind ?? null,
    uri: row.uri ?? null,
    status: status === 'accepted' || status === 'rejected' ? status : 'pending',
    createdAt: row.created_at ?? null,
    verification: row.verification ?? null,
    confirmation: row.confirmation === 'confirmed' ? 'confirmed' : 'unconfirmed',
  };
}

export class GroupTaskStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  // Helper method to get a single row from query result
  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as T;
  }

  // Helper method to get all rows from query result
  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  }

  /** Must be called immediately after an INSERT, before saveDb. */
  private lastInsertId(): number {
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const rawId = result[0]?.values?.[0]?.[0];
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`last_insert_rowid returned invalid id (raw=${JSON.stringify(rawId)})`);
    }
    return id;
  }

  // --- group_tasks ---

  createTask(input: CreateGroupTaskInput): GroupTask {
    this.db.run(
      `INSERT INTO group_tasks (
        group_id, title, goal, acceptance_criteria, status, chair_metabot_id, created_by,
        last_processed_msg_id, create_pin_id
      ) VALUES (?, ?, ?, ?, 'planning', ?, ?, 0, ?)`,
      [
        input.groupId,
        input.title,
        input.goal,
        input.acceptanceCriteria ?? null,
        input.chairMetabotId,
        input.createdBy,
        input.createPinId ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const task = this.getTaskById(id);
    if (!task) throw new Error(`createTask failed: task ${id} not found after insert`);
    return task;
  }

  getTaskById(id: number): GroupTask | null {
    const row = this.getOne<GroupTaskRow>('SELECT * FROM group_tasks WHERE id = ?', [id]);
    return row ? rowToGroupTask(row) : null;
  }

  getTaskByGroupId(groupId: string): GroupTask | null {
    const row = this.getOne<GroupTaskRow>('SELECT * FROM group_tasks WHERE group_id = ?', [groupId]);
    return row ? rowToGroupTask(row) : null;
  }

  /**
   * Bind the transport-facing Group Task to its canonical orchestration task.
   * The relationship is immutable once established so retries cannot silently
   * project one group onto a different owner task.
   */
  linkOrchestrationTask(id: number, orchestrationTaskId: string): GroupTask {
    const task = this.getTaskById(id);
    if (!task) throw new Error(`Group task ${id} not found`);
    const canonicalId = orchestrationTaskId.trim();
    if (!canonicalId) throw new Error('orchestrationTaskId is required');
    if (task.orchestrationTaskId && task.orchestrationTaskId !== canonicalId) {
      throw new Error(`Group task ${id} is already linked to orchestration task ${task.orchestrationTaskId}`);
    }
    if (task.orchestrationTaskId === canonicalId) return task;
    this.db.run(
      `UPDATE group_tasks
       SET orchestration_task_id = ?, updated_at = datetime('now')
       WHERE id = ? AND orchestration_task_id IS NULL`,
      [canonicalId, id],
    );
    this.saveDb();
    const linked = this.getTaskById(id);
    if (!linked || linked.orchestrationTaskId !== canonicalId) {
      throw new Error(`Failed to link group task ${id} to orchestration task ${canonicalId}`);
    }
    return linked;
  }

  listTasks(filter?: { status?: GroupTaskStatus }): GroupTask[] {
    const rows = filter?.status
      ? this.getAll<GroupTaskRow>(
          'SELECT * FROM group_tasks WHERE status = ? ORDER BY id DESC',
          [filter.status],
        )
      : this.getAll<GroupTaskRow>('SELECT * FROM group_tasks ORDER BY id DESC');
    return rows.map(rowToGroupTask);
  }

  /**
   * Transition a task to `nextStatus`, enforcing the state machine.
   * Throws on illegal transitions. Sets closed_at when entering a terminal state.
   * Every REAL transition (before !== next) is recorded in
   * group_task_status_events with the given actor (P1-5 status-transition log);
   * a recording failure never breaks the transition itself.
   */
  updateTaskStatus(
    id: number,
    nextStatus: GroupTaskStatus,
    opts?: UpdateGroupTaskStatusOptions,
  ): GroupTask {
    const task = this.getTaskById(id);
    if (!task) throw new Error(`Group task ${id} not found`);
    if (task.status === nextStatus) return task;
    const legal = LEGAL_TRANSITIONS[task.status] ?? [];
    if (!legal.includes(nextStatus)) {
      throw new Error(
        `Illegal group task status transition: ${task.status} -> ${nextStatus} (task ${id})`,
      );
    }
    const beforeStatus = task.status;
    if (TERMINAL_STATUSES.has(nextStatus)) {
      this.db.run(
        `UPDATE group_tasks SET status = ?, updated_at = datetime('now'), closed_at = datetime('now') WHERE id = ?`,
        [nextStatus, id],
      );
    } else {
      this.db.run(
        `UPDATE group_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`,
        [nextStatus, id],
      );
    }
    this.saveDb();
    const updated = this.getTaskById(id);
    if (!updated) throw new Error(`Group task ${id} not found after status update`);
    this.recordStatusEvent(id, beforeStatus, nextStatus, opts?.actor);
    return updated;
  }

  /** Insert one status-transition event row (best-effort, never throws). */
  private recordStatusEvent(
    taskId: number,
    fromStatus: GroupTaskStatus,
    toStatus: GroupTaskStatus,
    actor?: GroupTaskStatusEventActor,
  ): void {
    try {
      this.db.run(
        `INSERT INTO group_task_status_events (task_id, from_status, to_status, actor_kind, actor_globalmetaid, actor_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          taskId,
          fromStatus,
          toStatus,
          actor?.kind ?? 'system',
          actor?.globalMetaId?.trim() || null,
          actor?.name?.trim() || null,
        ],
      );
      this.saveDb();
    } catch (error) {
      console.warn(
        `Failed to record status event for group task ${taskId} (${fromStatus} -> ${toStatus}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Status transition history for one task, newest first (P1-5). */
  listStatusEvents(taskId: number, opts?: { limit?: number }): GroupTaskStatusEvent[] {
    const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 100)));
    const rows = this.getAll<GroupTaskStatusEventRow>(
      `SELECT id, task_id, from_status, to_status, actor_kind, actor_globalmetaid, actor_name, created_at
       FROM group_task_status_events
       WHERE task_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [taskId, limit],
    );
    return rows.map(rowToGroupTaskStatusEvent);
  }

  isTerminalStatus(status: GroupTaskStatus): boolean {
    return TERMINAL_STATUSES.has(status);
  }

  /**
   * Record the owner's acceptance rating (1-5 stars + optional comment).
   * The star rating is mandatory for acceptance and validated here (the DB has
   * no CHECK because the column was added via ALTER TABLE on existing DBs).
   * Idempotent: re-rating a task overwrites the previous rating.
   */
  updateTaskRating(id: number, rating: number, comment?: string | null): GroupTask {
    const task = this.getTaskById(id);
    if (!task) throw new Error(`Group task ${id} not found`);
    const value = Math.trunc(rating);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      throw new Error(`Group task rating must be an integer between 1 and 5 (got ${rating})`);
    }
    const text = (comment ?? '').trim();
    this.db.run(
      `UPDATE group_tasks
       SET rating = ?, rating_comment = ?, rated_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [value, text || null, id],
    );
    this.saveDb();
    const updated = this.getTaskById(id);
    if (!updated) throw new Error(`Group task ${id} not found after rating update`);
    return updated;
  }

  /** Advance the daemon cursor (monotonic: never moves backwards). */
  updateLastProcessedMsgId(id: number, msgId: number): void {
    this.db.run(
      'UPDATE group_tasks SET last_processed_msg_id = MAX(last_processed_msg_id, ?) WHERE id = ?',
      [Math.trunc(msgId), id],
    );
    this.saveDb();
  }

  /** Round-4: heartbeat of the last daemon drive (epoch seconds). */
  updateLastDrivenAt(id: number, epochSec: number): void {
    this.db.run(
      'UPDATE group_tasks SET last_driven_at = ? WHERE id = ?',
      [Math.trunc(epochSec), id],
    );
    this.saveDb();
  }

  /** group_id of every non-terminal task (backfill targets). */
  getActiveGroupIds(): string[] {
    const rows = this.getAll<{ group_id: string }>(
      `SELECT group_id FROM group_tasks
       WHERE status IN ('planning','executing','review')
         AND group_id IS NOT NULL AND TRIM(group_id) != ''`,
    );
    return rows.map((row) => row.group_id);
  }

  /**
   * Paged chat transcript for one group, ascending by id. Content is already
   * decrypted at insert time — returned as-is. Without beforeId, returns the
   * LATEST page (chat semantics); beforeId pages backwards to older rows.
   */
  listGroupChatMessages(
    groupId: string,
    opts?: { beforeId?: number; limit?: number },
  ): GroupChatTranscriptMessage[] {
    const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit ?? 50)));
    const beforeId = opts?.beforeId != null && Number.isFinite(opts.beforeId)
      ? Math.trunc(opts.beforeId)
      : null;
    const columns = `id, pin_id, tx_id, sender_name, sender_global_metaid, sender_avatar,
      content, content_type, chain_timestamp, msg_index, reply_pin, sender_suspect`;
    const rows = (beforeId != null
      ? this.getAll<GroupChatTranscriptRow>(
          `SELECT ${columns} FROM group_chat_messages
           WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
          [groupId, beforeId, limit],
        )
      : this.getAll<GroupChatTranscriptRow>(
          `SELECT ${columns} FROM group_chat_messages
           WHERE group_id = ? ORDER BY id DESC LIMIT ?`,
          [groupId, limit],
        )
    ).reverse();
    return rows.map(rowToGroupChatTranscriptMessage);
  }

  /**
   * Round-4 attribution: persist the GlobalMetaID resolved from the message's
   * chain-signature legacy metaid (manapi /api/info/metaid/{metaid}). The
   * chain signature is the ONLY identity source; sender_name is never used
   * for attribution.
   */
  updateMessageSenderGlobalMetaId(id: number, globalMetaId: string): void {
    this.db.run(
      'UPDATE group_chat_messages SET sender_global_metaid = ? WHERE id = ?',
      [globalMetaId.trim(), id],
    );
    this.saveDb();
  }

  /** Round-4 attribution: mark a message whose sender fails the member/owner check. */
  setMessageSenderSuspect(id: number, suspect: boolean): void {
    this.db.run(
      'UPDATE group_chat_messages SET sender_suspect = ? WHERE id = ?',
      [suspect ? 1 : 0, id],
    );
    this.saveDb();
  }

  // --- group_task_members ---

  /**
   * Add a member row, idempotently. Local members dedupe on (task_id, metabot_id)
   * (backed by the UNIQUE constraint); remote members (metabotId === null) dedupe
   * in code on (task_id, globalmetaid) among active rows, because the UNIQUE
   * constraint does not apply to NULL metabot_id. Returns the existing row when
   * the member is already present instead of throwing after a no-op insert.
   *
   * Re-join after a kick (M3): a LOCAL member whose row is already marked
   * removed is revived in place (removed_at/remove_pin_id cleared, the provided
   * joined_pin_id/display_name refreshed) because the UNIQUE constraint forbids
   * a second row. A removed REMOTE member instead gets a fresh row, keeping the
   * removed row as history.
   */
  addMember(input: AddGroupTaskMemberInput): GroupTaskMember {
    const isRemote = input.metabotId == null;
    const remoteGlobalmetaid = isRemote ? normalizeMemberGlobalMetaId(input.globalmetaid) : '';
    if (isRemote && !remoteGlobalmetaid) {
      throw new Error(`addMember failed for task ${input.taskId}: remote member requires globalmetaid`);
    }

    // Code-level pre-check: an already-present active member is returned as-is.
    const existing = isRemote
      ? this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id IS NULL AND m.globalmetaid = ? AND m.removed_at IS NULL`,
          [input.taskId, remoteGlobalmetaid],
        )
      : this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id = ?`,
          [input.taskId, input.metabotId!],
        );
    if (existing) {
      if (!isRemote && existing.removed_at) {
        // Revive the kicked local member on the same row (UNIQUE forbids a new one).
        this.db.run(
          `UPDATE group_task_members
           SET removed_at = NULL, remove_pin_id = NULL,
               joined_pin_id = COALESCE(?, joined_pin_id),
               display_name = COALESCE(?, display_name)
           WHERE id = ?`,
          [input.joinedPinId ?? null, input.displayName ?? null, existing.id],
        );
        this.saveDb();
        const revived = this.getOne<GroupTaskMemberRow>(`${MEMBER_SELECT} WHERE m.id = ?`, [existing.id]);
        if (!revived || revived.removed_at) {
          throw new Error(`addMember failed for task ${input.taskId}: member ${existing.id} not revived`);
        }
        return rowToGroupTaskMember(revived);
      }
      if (isRemote && existing.joined_pin_id == null && input.joinedPinId) {
        // P1-2: the join watcher previously created a placeholder row (or an
        // indexer-created row predated the ACCEPT); now that the join pin is
        // known, backfill it on the existing row so "already joined" is
        // readable from the member.
        this.db.run(
          `UPDATE group_task_members
           SET joined_pin_id = ?,
               display_name = COALESCE(?, display_name)
           WHERE id = ?`,
          [input.joinedPinId, input.displayName ?? null, existing.id],
        );
        this.saveDb();
        const updated = this.getOne<GroupTaskMemberRow>(`${MEMBER_SELECT} WHERE m.id = ?`, [existing.id]);
        if (updated) return rowToGroupTaskMember(updated);
      }
      return rowToGroupTaskMember(existing);
    }

    this.db.run(
      `INSERT INTO group_task_members (task_id, metabot_id, globalmetaid, role, joined_pin_id, display_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.metabotId,
        isRemote ? remoteGlobalmetaid : normalizeMemberGlobalMetaId(input.globalmetaid) || null,
        input.role,
        input.joinedPinId ?? null,
        input.displayName ?? null,
        input.role === 'chair' ? 'working' : 'assigned',
      ],
    );
    this.saveDb();
    const inserted = isRemote
      ? this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id IS NULL AND m.globalmetaid = ? AND m.removed_at IS NULL`,
          [input.taskId, remoteGlobalmetaid],
        )
      : this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id = ?`,
          [input.taskId, input.metabotId!],
        );
    if (!inserted) throw new Error(`addMember failed for task ${input.taskId}`);
    return rowToGroupTaskMember(inserted);
  }

  /**
   * Members of one task, oldest first. By default only active members are
   * returned (removed_at IS NULL); pass includeRemoved for the full history.
   */
  listMembers(taskId: number, opts?: { includeRemoved?: boolean }): GroupTaskMember[] {
    const rows = opts?.includeRemoved
      ? this.getAll<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? ORDER BY m.id ASC`,
          [taskId],
        )
      : this.getAll<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.removed_at IS NULL ORDER BY m.id ASC`,
          [taskId],
        );
    return rows.map(rowToGroupTaskMember);
  }

  /**
   * P1-1: active remote member row for one GlobalMetaID, or null. A remote row
   * with joined_pin_id NULL is a PLACEHOLDER ("invite sent, join not yet
   * confirmed") — invite_remote retries key off this to decide whether the
   * member actually blocks a re-invite.
   */
  getActiveRemoteMember(taskId: number, globalmetaid?: string | null): GroupTaskMember | null {
    const gmid = normalizeMemberGlobalMetaId(globalmetaid);
    if (!gmid) return null;
    const row = this.getOne<GroupTaskMemberRow>(
      `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id IS NULL AND m.globalmetaid = ? AND m.removed_at IS NULL`,
      [taskId, gmid],
    );
    return row ? rowToGroupTaskMember(row) : null;
  }

  /**
   * Membership check among ACTIVE rows (removed members fail the check). Local
   * members match on metabot_id; remote members (metabotId === null) match on
   * globalmetaid.
   */
  isMember(taskId: number, metabotId: number | null, globalmetaid?: string | null): boolean {
    if (metabotId == null) {
      const gmid = normalizeMemberGlobalMetaId(globalmetaid);
      if (!gmid) return false;
      const row = this.getOne<{ found: number }>(
        `SELECT 1 AS found FROM group_task_members
         WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NULL LIMIT 1`,
        [taskId, gmid],
      );
      return Boolean(row);
    }
    const row = this.getOne<{ found: number }>(
      `SELECT 1 AS found FROM group_task_members
       WHERE task_id = ? AND metabot_id = ? AND removed_at IS NULL LIMIT 1`,
      [taskId, metabotId],
    );
    return Boolean(row);
  }

  /**
   * Record the on-chain join pin. Local members match on metabot_id; remote
   * members (metabotId === null) match the active row by globalmetaid.
   */
  updateMemberJoinedPinId(
    taskId: number,
    metabotId: number | null,
    joinedPinId: string | null,
    globalmetaid?: string | null,
  ): void {
    if (metabotId == null) {
      const gmid = normalizeMemberGlobalMetaId(globalmetaid);
      if (!gmid) {
        throw new Error(`updateMemberJoinedPinId failed for task ${taskId}: remote member requires globalmetaid`);
      }
      this.db.run(
        `UPDATE group_task_members SET joined_pin_id = ?
         WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NULL`,
        [joinedPinId, taskId, gmid],
      );
      this.saveDb();
      return;
    }
    this.db.run(
      'UPDATE group_task_members SET joined_pin_id = ? WHERE task_id = ? AND metabot_id = ?',
      [joinedPinId, taskId, metabotId],
    );
    this.saveDb();
  }

  // --- P0-2: member state machine ---

  /**
   * Set a member's state-machine status with a change timestamp. Local members
   * match by metabot_id; remote members (metabotId === null) by globalmetaid.
   */
  setMemberStatus(
    taskId: number,
    metabotId: number | null,
    status: GroupTaskMemberStatus,
    globalmetaid?: string | null,
  ): GroupTaskMember | undefined {
    if (metabotId == null) {
      const gmid = (globalmetaid ?? '').trim();
      if (!gmid) throw new Error(`setMemberStatus failed for task ${taskId}: remote member requires globalmetaid`);
      this.db.run(
        `UPDATE group_task_members
         SET status = ?, status_changed_at = datetime('now')
         WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NULL`,
        [status, taskId, gmid],
      );
    } else {
      this.db.run(
        `UPDATE group_task_members
         SET status = ?, status_changed_at = datetime('now')
         WHERE task_id = ? AND metabot_id = ?`,
        [status, taskId, metabotId],
      );
    }
    this.saveDb();
    const updated = this.listMembers(taskId).find((member) =>
      metabotId == null
        ? member.globalmetaid?.trim() === (globalmetaid ?? '').trim()
        : member.metabotId === metabotId,
    );
    return updated;
  }

  /** P0-2: list members whose status is one of the given values. */
  listMembersWithStatus(taskId: number, statuses: GroupTaskMemberStatus[]): GroupTaskMember[] {
    const set = new Set(statuses);
    return this.listMembers(taskId).filter((member) => set.has(member.status));
  }

  /** P0-5: update a task's status with an optional transition-log entry (actor/reason). */
  updateTaskStatusWithLog(
    id: number,
    nextStatus: GroupTaskStatus,
    meta?: { actor?: string | null; reason?: string | null },
  ): GroupTask {
    const before = this.getTaskById(id);
    const updated = this.updateTaskStatus(id, nextStatus);
    if (before && before.status !== updated.status) {
      this.addTaskTransition({
        taskId: id,
        fromStatus: before.status,
        toStatus: updated.status,
        actor: meta?.actor ?? null,
        reason: meta?.reason ?? null,
      });
    }
    return updated;
  }

  /** P0-5: append a state-transition log row. */
  addTaskTransition(input: AddGroupTaskTransitionInput): GroupTaskTransition {
    this.db.run(
      `INSERT INTO group_task_transitions (task_id, from_status, to_status, actor, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.fromStatus ?? null,
        input.toStatus,
        input.actor ?? null,
        input.reason ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskTransitionRow>(
      'SELECT * FROM group_task_transitions WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`addTaskTransition failed: row ${id} not found after insert`);
    return rowToGroupTaskTransition(row);
  }

  /** P0-5: full transition history for one task, oldest first. */
  listTaskTransitions(taskId: number): GroupTaskTransition[] {
    const rows = this.getAll<GroupTaskTransitionRow>(
      'SELECT * FROM group_task_transitions WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskTransition);
  }

  /** P0-8: record a public integrity declaration (honest correction/report). */
  addIntegrityEvent(input: {
    taskId: number;
    msgPinId?: string | null;
    authorGlobalmetaid?: string | null;
    eventType: GroupTaskIntegrityEventType;
    detail?: string | null;
  }): GroupTaskIntegrityEvent {
    this.db.run(
      `INSERT INTO group_task_integrity_events (task_id, msg_pin_id, author_globalmetaid, event_type, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.msgPinId ?? null,
        input.authorGlobalmetaid ?? null,
        input.eventType,
        input.detail ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskIntegrityEventRow>(
      'SELECT * FROM group_task_integrity_events WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`addIntegrityEvent failed: row ${id} not found after insert`);
    return rowToGroupTaskIntegrityEvent(row);
  }

  /** P0-8: all integrity events for one task, oldest first. */
  listIntegrityEvents(taskId: number): GroupTaskIntegrityEvent[] {
    const rows = this.getAll<GroupTaskIntegrityEventRow>(
      'SELECT * FROM group_task_integrity_events WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskIntegrityEvent);
  }

  /** P0-8: dedupe check — an event already recorded for this message pin. */
  hasIntegrityEventWithMsgPin(taskId: number, msgPinId: string): boolean {
    const row = this.getOne<{ found: number }>(
      'SELECT 1 AS found FROM group_task_integrity_events WHERE task_id = ? AND msg_pin_id = ? LIMIT 1',
      [taskId, msgPinId],
    );
    return Boolean(row);
  }

  /**
   * Mark a member as kicked (M3): sets removed_at (+ the removeuser pin id for
   * audit) without deleting the row, so history/deliverables stay intact.
   * Local members match on metabot_id (UNIQUE guarantees one row); remote
   * members match the ACTIVE row by globalmetaid. Idempotent: an
   * already-removed member is returned as-is; a never-member throws.
   */
  markMemberRemoved(input: MarkGroupTaskMemberRemovedInput): GroupTaskMember {
    const metabotId = input.metabotId != null ? Math.trunc(Number(input.metabotId)) : null;
    const gmid = normalizeMemberGlobalMetaId(input.globalmetaid);
    if (metabotId == null && !gmid) {
      throw new Error(`markMemberRemoved failed for task ${input.taskId}: metabotId or globalmetaid is required`);
    }

    const row = metabotId != null
      ? this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id = ?`,
          [input.taskId, metabotId],
        )
      : this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id IS NULL AND m.globalmetaid = ?
           ORDER BY m.id DESC LIMIT 1`,
          [input.taskId, gmid],
        );
    if (!row) {
      const who = metabotId != null ? `metabot ${metabotId}` : `globalmetaid ${gmid}`;
      throw new Error(`markMemberRemoved failed for task ${input.taskId}: ${who} is not a member`);
    }
    if (row.removed_at) return rowToGroupTaskMember(row);

    this.db.run(
      `UPDATE group_task_members SET removed_at = strftime('%Y-%m-%d %H:%M:%f','now'), remove_pin_id = ?
       WHERE id = ? AND removed_at IS NULL`,
      [input.removePinId ?? null, row.id],
    );
    this.saveDb();
    const updated = this.getOne<GroupTaskMemberRow>(`${MEMBER_SELECT} WHERE m.id = ?`, [row.id]);
    if (!updated || !updated.removed_at) {
      throw new Error(`markMemberRemoved failed for task ${input.taskId}: member ${row.id} not removed`);
    }
    return rowToGroupTaskMember(updated);
  }

  /**
   * OpenTeam (M3/R2): true when this task has a REMOVED remote member row for
   * the GlobalMetaID. With `notBeforeMs` (epoch ms), only rows kicked at or
   * after that moment count — this distinguishes "the membership this invite
   * created was later kicked" (freeze the invite; never revive) from "an
   * older membership was kicked before this invite existed" (an explicit
   * re-invite must still be able to complete its handshake). The threshold is
   * rendered at millisecond precision (removed_at is stored with %f) so a
   * same-second kick + re-invite stays ordered correctly.
   */
  hasRemovedMember(taskId: number, globalmetaid: string, notBeforeMs?: number): boolean {
    const gmid = normalizeMemberGlobalMetaId(globalmetaid);
    if (!gmid) return false;
    const row = notBeforeMs != null && Number.isFinite(notBeforeMs)
      ? this.getOne<{ found: number }>(
          `SELECT 1 AS found FROM group_task_members
           WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NOT NULL
             AND removed_at >= strftime('%Y-%m-%d %H:%M:%f', ? / 1000.0, 'unixepoch') LIMIT 1`,
          [taskId, gmid, Math.trunc(notBeforeMs)],
        )
      : this.getOne<{ found: number }>(
          `SELECT 1 AS found FROM group_task_members
           WHERE task_id = ? AND metabot_id IS NULL AND globalmetaid = ? AND removed_at IS NOT NULL LIMIT 1`,
          [taskId, gmid],
        );
    return Boolean(row);
  }

  // --- group_task_deliverables ---

  addDeliverable(input: AddGroupTaskDeliverableInput): GroupTaskDeliverable {
    // confirmation is written explicitly ('unconfirmed') even though the
    // schema defaults to it, so the ledger's semantics never depend on the
    // column default; the daemon flips it to 'confirmed' once multi-source
    // on-chain verification succeeds (Issue #8).
    this.db.run(
      `INSERT INTO group_task_deliverables (task_id, msg_pin_id, author_globalmetaid, kind, uri, confirmation)
       VALUES (?, ?, ?, ?, ?, 'unconfirmed')`,
      [
        input.taskId,
        input.msgPinId ?? null,
        input.authorGlobalmetaid ?? null,
        input.kind ?? null,
        input.uri ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<GroupTaskDeliverableRow>(
      'SELECT * FROM group_task_deliverables WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`addDeliverable failed: row ${id} not found after insert`);
    return rowToGroupTaskDeliverable(row);
  }

  listDeliverables(taskId: number): GroupTaskDeliverable[] {
    const rows = this.getAll<GroupTaskDeliverableRow>(
      'SELECT * FROM group_task_deliverables WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    );
    return rows.map(rowToGroupTaskDeliverable);
  }

  /** Code-level dedupe check for [DELIVERABLE] ingestion (no schema constraint). */
  hasDeliverableWithMsgPin(taskId: number, msgPinId: string): boolean {
    const row = this.getOne<{ found: number }>(
      'SELECT 1 AS found FROM group_task_deliverables WHERE task_id = ? AND msg_pin_id = ? LIMIT 1',
      [taskId, msgPinId],
    );
    return Boolean(row);
  }

  /**
   * Round-4: one message now carries one row PER [DELIVERABLE] tag line (a
   * message with two tag lines yields two rows), so the old whole-message
   * msg_pin_id dedupe would drop real URIs. Dedupe is per
   * (msg_pin_id, uri, kind) — identical rows from a retried message are
   * skipped, distinct tag lines are each recorded.
   */
  findDeliverableByMsgPinAndUri(
    taskId: number,
    msgPinId: string,
    uri: string | null,
    kind: string | null,
  ): GroupTaskDeliverable | undefined {
    const row = this.getOne<GroupTaskDeliverableRow>(
      `SELECT * FROM group_task_deliverables
       WHERE task_id = ? AND msg_pin_id = ? AND uri IS ? AND kind = ?
       LIMIT 1`,
      [taskId, msgPinId, uri, kind],
    );
    return row ? rowToGroupTaskDeliverable(row) : undefined;
  }

  /**
   * Round-4 (show summary): last chain speak timestamp (epoch seconds) per
   * sender GlobalMetaID for one group — the summary view's member list shows
   * when each member last spoke. Senders without any timestamp are absent.
   */
  getMembersLastSpeakAt(
    groupId: string,
    globalMetaIds: Array<string | null | undefined>,
  ): Map<string, number> {
    const ids = [...new Set(
      globalMetaIds
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean),
    )];
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.getAll<{ sender_global_metaid: string; last_speak_at: number }>(
      `SELECT sender_global_metaid, MAX(chain_timestamp) AS last_speak_at
       FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid IN (${placeholders})
         AND chain_timestamp IS NOT NULL
       GROUP BY sender_global_metaid`,
      [groupId, ...ids],
    );
    for (const row of rows) {
      const key = String(row.sender_global_metaid ?? '').trim().toLowerCase();
      if (key) result.set(key, Number(row.last_speak_at));
    }
    return result;
  }

  /**
   * P0-2 (round 5): last chain timestamp (epoch seconds) per sender GlobalMetaID
   * of a message carrying the `[WORKING]` status tag — the durable half of the
   * worker ACK/progress protocol. The service derives the member workStatus
   * from these timestamps (fresh [WORKING] within the working window => working).
   */
  getMembersWorkingAt(
    groupId: string,
    globalMetaIds: Array<string | null | undefined>,
  ): Map<string, number> {
    const ids = [...new Set(
      globalMetaIds
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean),
    )];
    const result = new Map<string, number>();
    if (ids.length === 0) return result;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.getAll<{ sender_global_metaid: string; last_working_at: number }>(
      `SELECT sender_global_metaid, MAX(chain_timestamp) AS last_working_at
       FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid IN (${placeholders})
         AND content LIKE '%[WORKING]%' ESCAPE '\\'
         AND chain_timestamp IS NOT NULL
       GROUP BY sender_global_metaid`,
      [groupId, ...ids],
    );
    for (const row of rows) {
      const key = String(row.sender_global_metaid ?? '').trim().toLowerCase();
      if (key) result.set(key, Number(row.last_working_at));
    }
    return result;
  }

  /**
   * OpenTeam M3: one sender's non-suspect message count in a group — feeds the
   * participation stats of collaboration impressions.
   */
  countGroupChatMessagesBySender(groupId: string, senderGlobalMetaId: string): number {
    const row = this.getOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM group_chat_messages
       WHERE group_id = ? AND LOWER(sender_global_metaid) = LOWER(?)
         AND (sender_suspect IS NULL OR sender_suspect = 0)`,
      [groupId, senderGlobalMetaId.trim()],
    );
    return Number(row?.n ?? 0);
  }

  /** Round-4: in-place update of a deliverable (correction-first aggregation). */
  updateDeliverableUri(id: number, uri: string | null, kind: string): void {
    this.db.run(
      'UPDATE group_task_deliverables SET uri = ?, kind = ? WHERE id = ?',
      [uri, kind, id],
    );
    this.saveDb();
  }

  updateDeliverableStatus(id: number, status: GroupTaskDeliverableStatus): void {
    this.db.run('UPDATE group_task_deliverables SET status = ? WHERE id = ?', [status, id]);
    this.saveDb();
  }

  /**
   * Issue #8: the ledger's on-chain confirmation state, driven by the daemon's
   * multi-source verification (verifyPinSources). 'confirmed' means the
   * deliverable's pin is verifiably present on-chain; it is ORTHOGONAL to
   * `status` (owner acceptance). This is the chain-confirmation-driven update
   * path that keeps the ledger in sync with on-chain reality.
   */
  updateDeliverableConfirmation(id: number, confirmation: 'unconfirmed' | 'confirmed'): void {
    this.db.run(
      'UPDATE group_task_deliverables SET confirmation = ? WHERE id = ?',
      [confirmation, id],
    );
    this.saveDb();
  }

  /** P0-4: persist the multi-source verification report for a deliverable. */
  updateDeliverableVerification(id: number, verification: string): void {
    this.db.run(
      'UPDATE group_task_deliverables SET verification = ? WHERE id = ?',
      [verification, id],
    );
    this.saveDb();
  }

  /** Remove a mistakenly recorded deliverable (P1-4 cleanup hatch for the chair). */
  deleteDeliverable(id: number): boolean {
    const row = this.getOne<{ id: number }>(
      'SELECT id FROM group_task_deliverables WHERE id = ?',
      [id],
    );
    if (!row) return false;
    this.db.run('DELETE FROM group_task_deliverables WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }
}

/** Member SELECT with metabots join (name/globalmetaid for mention matching). */
const MEMBER_SELECT = `
  SELECT m.*, mb.name AS metabot_name, mb.globalmetaid AS metabot_globalmetaid
  FROM group_task_members m
  LEFT JOIN metabots mb ON mb.id = m.metabot_id
`;
