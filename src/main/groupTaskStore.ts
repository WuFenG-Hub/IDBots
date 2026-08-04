/**
 * Group Task store: CRUD for group_tasks / group_task_members /
 * group_task_deliverables plus the task status state machine.
 * Structural pattern follows scheduledTaskStore.ts (wraps SqliteStore db + saveDb).
 */

import type { SqliteDatabase as Database } from './sqliteTypes';

export type GroupTaskStatus = 'planning' | 'executing' | 'review' | 'done' | 'cancelled';
export type GroupTaskMemberRole = 'chair' | 'worker';
export type GroupTaskDeliverableStatus = 'pending' | 'accepted' | 'rejected';

export interface GroupTask {
  id: number;
  groupId: string | null;
  title: string;
  goal: string;
  acceptanceCriteria: string | null;
  status: GroupTaskStatus;
  chairMetabotId: number;
  createdBy: string;
  lastProcessedMsgId: number;
  createPinId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}

export interface GroupTaskMember {
  id: number;
  taskId: number;
  metabotId: number | null;
  globalmetaid: string | null;
  role: GroupTaskMemberRole;
  joinedPinId: string | null;
  createdAt: string | null;
  /** Joined from metabots for display / mention matching (null for remote members). */
  name: string | null;
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
}

export interface AddGroupTaskDeliverableInput {
  taskId: number;
  msgPinId?: string | null;
  authorGlobalmetaid?: string | null;
  kind?: string | null;
  uri?: string | null;
}

interface GroupTaskRow {
  id: number;
  group_id: string | null;
  title: string;
  goal: string;
  acceptance_criteria: string | null;
  status: string;
  chair_metabot_id: number;
  created_by: string;
  last_processed_msg_id: number;
  create_pin_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
}

interface GroupTaskMemberRow {
  id: number;
  task_id: number;
  metabot_id: number | null;
  globalmetaid: string | null;
  role: string;
  joined_pin_id: string | null;
  created_at: string | null;
  metabot_name: string | null;
  metabot_globalmetaid: string | null;
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

function isGroupTaskStatus(value: string): value is GroupTaskStatus {
  return value === 'planning' || value === 'executing' || value === 'review'
    || value === 'done' || value === 'cancelled';
}

function rowToGroupTask(row: GroupTaskRow): GroupTask {
  return {
    id: row.id,
    groupId: row.group_id ?? null,
    title: row.title,
    goal: row.goal,
    acceptanceCriteria: row.acceptance_criteria ?? null,
    status: isGroupTaskStatus(row.status) ? row.status : 'planning',
    chairMetabotId: row.chair_metabot_id,
    createdBy: row.created_by,
    lastProcessedMsgId: row.last_processed_msg_id ?? 0,
    createPinId: row.create_pin_id ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    closedAt: row.closed_at ?? null,
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
    name: row.metabot_name ?? null,
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
   */
  updateTaskStatus(id: number, nextStatus: GroupTaskStatus): GroupTask {
    const task = this.getTaskById(id);
    if (!task) throw new Error(`Group task ${id} not found`);
    if (task.status === nextStatus) return task;
    const legal = LEGAL_TRANSITIONS[task.status] ?? [];
    if (!legal.includes(nextStatus)) {
      throw new Error(
        `Illegal group task status transition: ${task.status} -> ${nextStatus} (task ${id})`,
      );
    }
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
    return updated;
  }

  isTerminalStatus(status: GroupTaskStatus): boolean {
    return TERMINAL_STATUSES.has(status);
  }

  /** Advance the daemon cursor (monotonic: never moves backwards). */
  updateLastProcessedMsgId(id: number, msgId: number): void {
    this.db.run(
      'UPDATE group_tasks SET last_processed_msg_id = MAX(last_processed_msg_id, ?) WHERE id = ?',
      [Math.trunc(msgId), id],
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
      content, content_type, chain_timestamp, msg_index, reply_pin`;
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

  // --- group_task_members ---

  addMember(input: AddGroupTaskMemberInput): GroupTaskMember {
    this.db.run(
      `INSERT OR IGNORE INTO group_task_members (task_id, metabot_id, globalmetaid, role, joined_pin_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.taskId,
        input.metabotId,
        input.globalmetaid ?? null,
        input.role,
        input.joinedPinId ?? null,
      ],
    );
    this.saveDb();
    const existing = input.metabotId != null
      ? this.getOne<GroupTaskMemberRow>(
          `${MEMBER_SELECT} WHERE m.task_id = ? AND m.metabot_id = ?`,
          [input.taskId, input.metabotId],
        )
      : undefined;
    if (!existing) throw new Error(`addMember failed for task ${input.taskId}`);
    return rowToGroupTaskMember(existing);
  }

  listMembers(taskId: number): GroupTaskMember[] {
    const rows = this.getAll<GroupTaskMemberRow>(
      `${MEMBER_SELECT} WHERE m.task_id = ? ORDER BY m.id ASC`,
      [taskId],
    );
    return rows.map(rowToGroupTaskMember);
  }

  isMember(taskId: number, metabotId: number): boolean {
    const row = this.getOne<{ found: number }>(
      'SELECT 1 AS found FROM group_task_members WHERE task_id = ? AND metabot_id = ? LIMIT 1',
      [taskId, metabotId],
    );
    return Boolean(row);
  }

  updateMemberJoinedPinId(taskId: number, metabotId: number, joinedPinId: string | null): void {
    this.db.run(
      'UPDATE group_task_members SET joined_pin_id = ? WHERE task_id = ? AND metabot_id = ?',
      [joinedPinId, taskId, metabotId],
    );
    this.saveDb();
  }

  // --- group_task_deliverables ---

  addDeliverable(input: AddGroupTaskDeliverableInput): GroupTaskDeliverable {
    this.db.run(
      `INSERT INTO group_task_deliverables (task_id, msg_pin_id, author_globalmetaid, kind, uri)
       VALUES (?, ?, ?, ?, ?)`,
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

  updateDeliverableStatus(id: number, status: GroupTaskDeliverableStatus): void {
    this.db.run('UPDATE group_task_deliverables SET status = ? WHERE id = ?', [status, id]);
    this.saveDb();
  }
}

/** Member SELECT with metabots join (name/globalmetaid for mention matching). */
const MEMBER_SELECT = `
  SELECT m.*, mb.name AS metabot_name, mb.globalmetaid AS metabot_globalmetaid
  FROM group_task_members m
  LEFT JOIN metabots mb ON mb.id = m.metabot_id
`;
