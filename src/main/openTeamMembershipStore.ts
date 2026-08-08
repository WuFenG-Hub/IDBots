/**
 * OpenTeam store: invitee-side group memberships (openteam_memberships) and
 * inviter-side invite tracking (openteam_invites).
 * Structural pattern follows groupTaskStore.ts (wraps SqliteStore db + saveDb).
 */

import type { SqliteDatabase as Database } from './sqliteTypes';

export type OpenTeamMembershipStatus = 'active' | 'left';
export type OpenTeamInviteStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface OpenTeamMembership {
  id: number;
  groupId: string;
  metabotId: number;
  globalmetaid: string | null;
  inviterGlobalmetaid: string | null;
  taskTitle: string | null;
  invitePinId: string | null;
  joinedPinId: string | null;
  status: OpenTeamMembershipStatus;
  createdAt: string | null;
  /** Guest-daemon cursor: group_chat_messages.id up to which this bot processed. */
  lastProcessedMsgId: number;
}

export interface OpenTeamInvite {
  id: number;
  taskId: number;
  groupId: string;
  inviteeGlobalmetaid: string;
  inviteeName: string | null;
  invitePinId: string | null;
  status: OpenTeamInviteStatus;
  declineReason: string | null;
  createdAt: string | null;
  respondedAt: string | null;
}

export interface UpsertOpenTeamMembershipInput {
  groupId: string;
  metabotId: number;
  globalmetaid?: string | null;
  inviterGlobalmetaid?: string | null;
  taskTitle?: string | null;
  invitePinId?: string | null;
  joinedPinId?: string | null;
}

export interface CreateOpenTeamInviteInput {
  taskId: number;
  groupId: string;
  inviteeGlobalmetaid: string;
  inviteeName?: string | null;
  invitePinId?: string | null;
}

interface OpenTeamMembershipRow {
  id: number;
  group_id: string;
  metabot_id: number;
  globalmetaid: string | null;
  inviter_globalmetaid: string | null;
  task_title: string | null;
  invite_pin_id: string | null;
  joined_pin_id: string | null;
  status: string;
  created_at: string | null;
  last_processed_msg_id: number | null;
}

interface OpenTeamInviteRow {
  id: number;
  task_id: number;
  group_id: string;
  invitee_globalmetaid: string;
  invitee_name: string | null;
  invite_pin_id: string | null;
  status: string;
  decline_reason: string | null;
  created_at: string | null;
  responded_at: string | null;
}

function rowToOpenTeamMembership(row: OpenTeamMembershipRow): OpenTeamMembership {
  return {
    id: row.id,
    groupId: row.group_id,
    metabotId: row.metabot_id,
    globalmetaid: row.globalmetaid ?? null,
    inviterGlobalmetaid: row.inviter_globalmetaid ?? null,
    taskTitle: row.task_title ?? null,
    invitePinId: row.invite_pin_id ?? null,
    joinedPinId: row.joined_pin_id ?? null,
    status: row.status === 'left' ? 'left' : 'active',
    createdAt: row.created_at ?? null,
    lastProcessedMsgId: Number(row.last_processed_msg_id) || 0,
  };
}

function rowToOpenTeamInvite(row: OpenTeamInviteRow): OpenTeamInvite {
  const status = row.status;
  return {
    id: row.id,
    taskId: row.task_id,
    groupId: row.group_id,
    inviteeGlobalmetaid: row.invitee_globalmetaid,
    inviteeName: row.invitee_name ?? null,
    invitePinId: row.invite_pin_id ?? null,
    status: status === 'accepted' || status === 'declined' || status === 'expired' ? status : 'pending',
    declineReason: row.decline_reason ?? null,
    createdAt: row.created_at ?? null,
    respondedAt: row.responded_at ?? null,
  };
}

export class OpenTeamMembershipStore {
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

  // --- openteam_memberships ---

  /**
   * Record (or refresh) an active membership for one of this machine's bots in
   * an external OpenTeam group. UNIQUE(group_id, metabot_id) conflicts flip the
   * row back to active and refresh the invite snapshot (re-invite after left).
   */
  upsertActiveMembership(input: UpsertOpenTeamMembershipInput): OpenTeamMembership {
    const existing = this.getOne<OpenTeamMembershipRow>(
      'SELECT * FROM openteam_memberships WHERE group_id = ? AND metabot_id = ?',
      [input.groupId, input.metabotId],
    );
    if (existing) {
      this.db.run(
        `UPDATE openteam_memberships
         SET status = 'active',
           globalmetaid = COALESCE(?, globalmetaid),
           inviter_globalmetaid = COALESCE(?, inviter_globalmetaid),
           task_title = COALESCE(?, task_title),
           invite_pin_id = COALESCE(?, invite_pin_id),
           joined_pin_id = COALESCE(?, joined_pin_id)
         WHERE group_id = ? AND metabot_id = ?`,
        [
          input.globalmetaid ?? null,
          input.inviterGlobalmetaid ?? null,
          input.taskTitle ?? null,
          input.invitePinId ?? null,
          input.joinedPinId ?? null,
          input.groupId,
          input.metabotId,
        ],
      );
      this.saveDb();
      const updated = this.getMembership(input.groupId, input.metabotId);
      if (!updated) throw new Error(`upsertActiveMembership failed for group ${input.groupId}`);
      return updated;
    }
    this.db.run(
      `INSERT INTO openteam_memberships (
        group_id, metabot_id, globalmetaid, inviter_globalmetaid, task_title,
        invite_pin_id, joined_pin_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        input.groupId,
        input.metabotId,
        input.globalmetaid ?? null,
        input.inviterGlobalmetaid ?? null,
        input.taskTitle ?? null,
        input.invitePinId ?? null,
        input.joinedPinId ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<OpenTeamMembershipRow>(
      'SELECT * FROM openteam_memberships WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`upsertActiveMembership failed: row ${id} not found after insert`);
    return rowToOpenTeamMembership(row);
  }

  listActiveMemberships(): OpenTeamMembership[] {
    const rows = this.getAll<OpenTeamMembershipRow>(
      `SELECT * FROM openteam_memberships WHERE status = 'active' ORDER BY id ASC`,
    );
    return rows.map(rowToOpenTeamMembership);
  }

  /** group_id of every active membership (group-chat backfill targets). */
  listActiveGroupIds(): string[] {
    const rows = this.getAll<{ group_id: string }>(
      `SELECT DISTINCT group_id FROM openteam_memberships
       WHERE status = 'active' AND TRIM(group_id) != ''`,
    );
    return rows.map((row) => row.group_id);
  }

  getMembership(groupId: string, metabotId: number): OpenTeamMembership | null {
    const row = this.getOne<OpenTeamMembershipRow>(
      'SELECT * FROM openteam_memberships WHERE group_id = ? AND metabot_id = ?',
      [groupId, metabotId],
    );
    return row ? rowToOpenTeamMembership(row) : null;
  }

  /** Mark a membership as left (kick / owner opt-out). Returns false when absent. */
  markLeft(groupId: string, metabotId: number): boolean {
    const existing = this.getMembership(groupId, metabotId);
    if (!existing) return false;
    this.db.run(
      `UPDATE openteam_memberships SET status = 'left' WHERE group_id = ? AND metabot_id = ?`,
      [groupId, metabotId],
    );
    this.saveDb();
    return true;
  }

  /**
   * Advance the guest-daemon message cursor (group_chat_messages.id processed
   * so far). Monotonic: never moves backwards, mirroring
   * groupTaskStore.updateLastProcessedMsgId semantics.
   */
  updateLastProcessedMsgId(groupId: string, metabotId: number, msgId: number): void {
    const id = Math.trunc(Number(msgId));
    if (!Number.isFinite(id) || id <= 0) return;
    this.db.run(
      `UPDATE openteam_memberships
       SET last_processed_msg_id = MAX(last_processed_msg_id, ?)
       WHERE group_id = ? AND metabot_id = ?`,
      [id, groupId, metabotId],
    );
    this.saveDb();
  }

  /**
   * Fast-forward the cursor to the newest group_chat_messages row currently in
   * the local DB. Called right after a join so the guest daemon only responds
   * to messages arriving after the bot entered the group.
   */
  catchUpCursorToLatest(groupId: string, metabotId: number): void {
    this.db.run(
      `UPDATE openteam_memberships
       SET last_processed_msg_id = MAX(
         last_processed_msg_id,
         COALESCE((SELECT MAX(id) FROM group_chat_messages WHERE group_id = ?), 0)
       )
       WHERE group_id = ? AND metabot_id = ?`,
      [groupId, groupId, metabotId],
    );
    this.saveDb();
  }

  // --- openteam_invites ---

  createInvite(input: CreateOpenTeamInviteInput): OpenTeamInvite {
    this.db.run(
      `INSERT INTO openteam_invites (
        task_id, group_id, invitee_globalmetaid, invitee_name, invite_pin_id, status
      ) VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        input.taskId,
        input.groupId,
        input.inviteeGlobalmetaid,
        input.inviteeName ?? null,
        input.invitePinId ?? null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<OpenTeamInviteRow>(
      'SELECT * FROM openteam_invites WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`createInvite failed: row ${id} not found after insert`);
    return rowToOpenTeamInvite(row);
  }

  /**
   * Transition an invite out of pending, stamping responded_at. Identified by
   * id or invite_pin_id (the inviteId carried by OpenTeam envelopes).
   */
  updateInviteStatus(
    identity: { id?: number; invitePinId?: string },
    status: OpenTeamInviteStatus,
    declineReason?: string | null,
  ): OpenTeamInvite | null {
    const existing = identity.id != null
      ? this.getOne<OpenTeamInviteRow>(
          'SELECT * FROM openteam_invites WHERE id = ?',
          [identity.id],
        )
      : identity.invitePinId
        ? this.getOne<OpenTeamInviteRow>(
            'SELECT * FROM openteam_invites WHERE invite_pin_id = ?',
            [identity.invitePinId],
          )
        : undefined;
    if (!existing) return null;
    this.db.run(
      `UPDATE openteam_invites
       SET status = ?, decline_reason = ?, responded_at = datetime('now')
       WHERE id = ?`,
      [status, declineReason ?? null, existing.id],
    );
    this.saveDb();
    const updated = this.getOne<OpenTeamInviteRow>(
      'SELECT * FROM openteam_invites WHERE id = ?',
      [existing.id],
    );
    return updated ? rowToOpenTeamInvite(updated) : null;
  }

  listPendingInvites(): OpenTeamInvite[] {
    const rows = this.getAll<OpenTeamInviteRow>(
      `SELECT * FROM openteam_invites WHERE status = 'pending' ORDER BY id ASC`,
    );
    return rows.map(rowToOpenTeamInvite);
  }

  getInviteByPinId(invitePinId: string): OpenTeamInvite | null {
    const row = this.getOne<OpenTeamInviteRow>(
      'SELECT * FROM openteam_invites WHERE invite_pin_id = ?',
      [invitePinId],
    );
    return row ? rowToOpenTeamInvite(row) : null;
  }

  /** Code-level dedupe: one pending invite per (task, invitee) at a time. */
  hasPendingInvite(taskId: number, inviteeGlobalmetaid: string): boolean {
    const row = this.getOne<{ found: number }>(
      `SELECT 1 AS found FROM openteam_invites
       WHERE task_id = ? AND invitee_globalmetaid = ? AND status = 'pending' LIMIT 1`,
      [taskId, inviteeGlobalmetaid],
    );
    return Boolean(row);
  }
}
