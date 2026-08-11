/**
 * OpenTeam store: invitee-side group memberships (openteam_memberships) and
 * inviter-side invite tracking (openteam_invites).
 * Structural pattern follows groupTaskStore.ts (wraps SqliteStore db + saveDb).
 */

import type { SqliteDatabase as Database } from './sqliteTypes';

export type OpenTeamMembershipStatus = 'active' | 'left';
export type OpenTeamInviteStatus = 'pending' | 'accepted' | 'declined' | 'expired';

/**
 * Guest decline reasons that express the owner's intent not to collaborate
 * (bot kill switch off / remote-collab switch off). These are the only
 * declines hasDeclinedInvite treats as negative history; every other reason
 * the guest emits is transient or technical. Persisted rows carry
 * `<reason>: <detail>`, so callers match the reason as a prefix.
 */
export const OPENTEAM_OWNER_INTENT_DECLINE_REASONS = ['bot_disabled', 'remote_collab_disabled'] as const;

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
  /**
   * This activation's start (refreshed by every upsertActiveMembership,
   * including a left->active revival). The guest self-check grace runs from
   * here, not from created_at.
   */
  activatedAt: string | null;
  /** Guest-daemon cursor: group_chat_messages.id up to which this bot processed. */
  lastProcessedMsgId: number;
}

export interface OpenTeamInvite {
  id: number;
  taskId: number;
  groupId: string;
  inviteeGlobalmetaid: string;
  /** Legacy metaId identity form (join watchers poll the indexer with both). */
  inviteeMetaid: string | null;
  inviteeName: string | null;
  invitePinId: string | null;
  status: OpenTeamInviteStatus;
  declineReason: string | null;
  createdAt: string | null;
  respondedAt: string | null;
  /**
   * P1-2: join pin echoed by the guest's [OPENTEAM_ACCEPT] envelope. Persisted
   * here when the ACCEPT lands and copied into the remote member row by the
   * join-confirmation watcher, so "already joined" is readable from the member
   * row instead of staying null forever.
   */
  joinedPinId: string | null;
  /**
   * #13: why the invitee was invited (the chair's `required_skills`, JSON
   * array text). Read by the join-welcome handshake so the welcome broadcast
   * can state why the remote member joined.
   */
  requiredSkills: string[];
}

/** P0-1: guest-side invite history row (one per received [OPENTEAM_INVITE]). */
export interface OpenTeamGuestInvite {
  id: number;
  groupId: string;
  inviterGlobalmetaid: string;
  inviterName: string | null;
  taskTitle: string | null;
  goalSummary: string | null;
  requiredSkills: string[];
  invitePinId: string | null;
  targetGlobalmetaid: string | null;
  /** Envelope expiresAt (unix seconds); null when the envelope omitted it. */
  expiresAt: number | null;
  status: OpenTeamGuestInviteStatus;
  declineReason: string | null;
  joinedPinId: string | null;
  createdAt: string | null;
  respondedAt: string | null;
}

export type OpenTeamGuestInviteStatus = 'invited' | 'accepted' | 'declined' | 'skipped' | 'expired';

/**
 * Owner-facing traceability row (openTeamCollab:list): one membership plus the
 * local bot's display name and a group_chat_messages activity digest.
 */
export interface OpenTeamCollabSummary extends OpenTeamMembership {
  /** metabots.name for metabotId; null when the bot row is gone. */
  botName: string | null;
  /** Total locally indexed group_chat_messages rows for the group. */
  messageCount: number;
  /** chain_timestamp of the newest indexed message; null when none. */
  lastMessageAt: number | null;
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
  /** Legacy metaId identity form, persisted so restarted watchers keep it. */
  inviteeMetaid?: string | null;
  inviteeName?: string | null;
  invitePinId?: string | null;
  /**
   * #13: why the invitee is invited (chair-provided required skills). Stored
   * as JSON text; read by the join-welcome handshake for the welcome message.
   */
  requiredSkills?: string[];
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
  activated_at: string | null;
  last_processed_msg_id: number | null;
}

interface OpenTeamInviteRow {
  id: number;
  task_id: number;
  group_id: string;
  invitee_globalmetaid: string;
  invitee_metaid: string | null;
  invitee_name: string | null;
  invite_pin_id: string | null;
  status: string;
  decline_reason: string | null;
  created_at: string | null;
  responded_at: string | null;
  joined_pin_id: string | null;
  required_skills: string | null;
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
    activatedAt: row.activated_at ?? null,
    lastProcessedMsgId: Number(row.last_processed_msg_id) || 0,
  };
}

function rowToOpenTeamInvite(row: OpenTeamInviteRow): OpenTeamInvite {
  const status = row.status;
  let requiredSkills: string[] = [];
  try {
    const parsed = JSON.parse(row.required_skills ?? '[]');
    if (Array.isArray(parsed)) {
      requiredSkills = parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
  } catch {
    requiredSkills = [];
  }
  return {
    id: row.id,
    taskId: row.task_id,
    groupId: row.group_id,
    inviteeGlobalmetaid: row.invitee_globalmetaid,
    inviteeMetaid: row.invitee_metaid ?? null,
    inviteeName: row.invitee_name ?? null,
    invitePinId: row.invite_pin_id ?? null,
    status: status === 'accepted' || status === 'declined' || status === 'expired' ? status : 'pending',
    declineReason: row.decline_reason ?? null,
    createdAt: row.created_at ?? null,
    respondedAt: row.responded_at ?? null,
    joinedPinId: row.joined_pin_id ?? null,
    requiredSkills,
  };
}

interface OpenTeamGuestInviteRow {
  id: number;
  group_id: string;
  inviter_globalmetaid: string;
  inviter_name: string | null;
  task_title: string | null;
  goal_summary: string | null;
  required_skills: string | null;
  invite_pin_id: string | null;
  target_globalmetaid: string | null;
  expires_at: number | null;
  status: string;
  decline_reason: string | null;
  joined_pin_id: string | null;
  created_at: string | null;
  responded_at: string | null;
}

function rowToOpenTeamGuestInvite(row: OpenTeamGuestInviteRow): OpenTeamGuestInvite {
  const status = row.status;
  let requiredSkills: string[] = [];
  try {
    const parsed = JSON.parse(row.required_skills ?? '[]');
    if (Array.isArray(parsed)) {
      requiredSkills = parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
  } catch {
    requiredSkills = [];
  }
  return {
    id: row.id,
    groupId: row.group_id,
    inviterGlobalmetaid: row.inviter_globalmetaid,
    inviterName: row.inviter_name ?? null,
    taskTitle: row.task_title ?? null,
    goalSummary: row.goal_summary ?? null,
    requiredSkills,
    invitePinId: row.invite_pin_id ?? null,
    targetGlobalmetaid: row.target_globalmetaid ?? null,
    expiresAt: row.expires_at != null && Number.isFinite(Number(row.expires_at))
      ? Number(row.expires_at)
      : null,
    status: status === 'accepted' || status === 'declined' || status === 'skipped' || status === 'expired'
      ? status
      : 'invited',
    declineReason: row.decline_reason ?? null,
    joinedPinId: row.joined_pin_id ?? null,
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
   * Every call — insert or revival — restamps activated_at, so the guest
   * self-check grace always runs from THIS activation (created_at survives a
   * revival and cannot serve as the grace anchor).
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
           joined_pin_id = COALESCE(?, joined_pin_id),
           activated_at = datetime('now')
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
        invite_pin_id, joined_pin_id, status, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))`,
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

  /**
   * All memberships (active + left), newest first, enriched with the local
   * bot's name and a group_chat_messages digest. Backs the owner-facing
   * "External collaborations" view: an auto-accepted invite must still be
   * visible to the machine owner.
   */
  listCollabSummaries(): OpenTeamCollabSummary[] {
    const rows = this.getAll<OpenTeamMembershipRow & {
      bot_name: string | null;
      message_count: number;
      last_message_at: number | null;
    }>(
      `SELECT m.*, mb.name AS bot_name,
         (SELECT COUNT(*) FROM group_chat_messages g WHERE g.group_id = m.group_id) AS message_count,
         (SELECT MAX(g.chain_timestamp) FROM group_chat_messages g WHERE g.group_id = m.group_id) AS last_message_at
       FROM openteam_memberships m
       LEFT JOIN metabots mb ON mb.id = m.metabot_id
       ORDER BY m.id DESC`,
    );
    return rows.map((row) => {
      const lastMessageAt = Number(row.last_message_at);
      return {
        ...rowToOpenTeamMembership(row),
        botName: row.bot_name ?? null,
        messageCount: Number(row.message_count) || 0,
        lastMessageAt: row.last_message_at != null && Number.isFinite(lastMessageAt)
          ? lastMessageAt
          : null,
      };
    });
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

  /**
   * True when ANY local bot has (or had — left memberships still count, their
   * transcript stays readable) a membership row for this group. Gates the
   * openTeamCollab:listMessages IPC so arbitrary group ids cannot be read.
   */
  hasMembershipForGroup(groupId: string): boolean {
    const trimmed = (groupId ?? '').trim();
    if (!trimmed) return false;
    const row = this.getOne<{ found: number }>(
      'SELECT 1 AS found FROM openteam_memberships WHERE group_id = ? LIMIT 1',
      [trimmed],
    );
    return Boolean(row);
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
    // created_at is restamped explicitly at millisecond precision: it anchors
    // the pending window and the kick-vs-invite ordering (hasRemovedMember),
    // where a same-second kick + re-invite must stay unambiguous.
    this.db.run(
      `INSERT INTO openteam_invites (
        task_id, group_id, invitee_globalmetaid, invitee_metaid, invitee_name, invite_pin_id, status, created_at, required_skills
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%d %H:%M:%f','now'), ?)`,
      [
        input.taskId,
        input.groupId,
        input.inviteeGlobalmetaid,
        input.inviteeMetaid ?? null,
        input.inviteeName ?? null,
        input.invitePinId ?? null,
        input.requiredSkills?.length ? JSON.stringify(input.requiredSkills) : null,
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
   * responded_at is millisecond-precision: it anchors the join-confirmation
   * budget, and a seconds-precision read-back would truncate up to ~1s off it.
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
       SET status = ?, decline_reason = ?, responded_at = strftime('%Y-%m-%d %H:%M:%f','now')
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

  listAcceptedInvites(): OpenTeamInvite[] {
    const rows = this.getAll<OpenTeamInviteRow>(
      `SELECT * FROM openteam_invites WHERE status = 'accepted' ORDER BY id ASC`,
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

  /**
   * Negative-history check (M3 re-invite policy): a declined invite blocks
   * re-inviting the same invitee unless the caller explicitly allows it —
   * but only when the decline expresses the guest OWNER's intent. The stored
   * decline_reason is `<reason>: <detail>`, so matching is exact or prefix
   * (`reason:*`). Transient/technical declines (rate_limited,
   * group_verify_failed, invite_expired, target_mismatch, sender_mismatch,
   * already_member, invalid_group, inviter_not_chair, join_failed,
   * membership_record_failed, ...) say nothing about the owner's willingness
   * and must not permanently freeze re-invites. Expired invites are not
   * negative history either (retrying the next candidate is the normal flow)
   * and stay out of this check.
   */
  hasDeclinedInvite(taskId: number, inviteeGlobalmetaid: string): boolean {
    // GLOB (not LIKE): reasons contain '_' which is a LIKE wildcard.
    const ownerIntentClause = OPENTEAM_OWNER_INTENT_DECLINE_REASONS
      .map(() => 'decline_reason = ? OR decline_reason GLOB ?')
      .join(' OR ');
    const row = this.getOne<{ found: number }>(
      `SELECT 1 AS found FROM openteam_invites
       WHERE task_id = ? AND invitee_globalmetaid = ? AND status = 'declined'
         AND (${ownerIntentClause}) LIMIT 1`,
      [
        taskId,
        inviteeGlobalmetaid,
        ...OPENTEAM_OWNER_INTENT_DECLINE_REASONS.flatMap((reason) => [reason, `${reason}:*`]),
      ],
    );
    return Boolean(row);
  }

  /**
   * P1-2: persist the join pin echoed by the guest's [OPENTEAM_ACCEPT] on the
   * invite row. The join-confirmation watcher copies it into the remote member
   * row when the join is confirmed. Returns the updated row (null when the
   * invite is unknown).
   */
  updateInviteJoinedPinId(invitePinId: string, joinedPinId: string): OpenTeamInvite | null {
    const normalized = (joinedPinId ?? '').trim();
    if (!normalized) return null;
    const existing = this.getOne<OpenTeamInviteRow>(
      'SELECT * FROM openteam_invites WHERE invite_pin_id = ?',
      [invitePinId],
    );
    if (!existing) return null;
    this.db.run(
      `UPDATE openteam_invites SET joined_pin_id = ?
       WHERE id = ?`,
      [normalized, existing.id],
    );
    this.saveDb();
    const updated = this.getOne<OpenTeamInviteRow>(
      'SELECT * FROM openteam_invites WHERE id = ?',
      [existing.id],
    );
    return updated ? rowToOpenTeamInvite(updated) : null;
  }

  /**
   * P1-1: newest invite row for one (task, invitee) — the member_status invite
   * readout and the expired-pending release both key off this. null when the
   * invitee was never invited to this task.
   */
  getLatestInvite(taskId: number, inviteeGlobalmetaid: string): OpenTeamInvite | null {
    const row = this.getOne<OpenTeamInviteRow>(
      `SELECT * FROM openteam_invites
       WHERE task_id = ? AND invitee_globalmetaid = ?
       ORDER BY id DESC LIMIT 1`,
      [taskId, inviteeGlobalmetaid],
    );
    return row ? rowToOpenTeamInvite(row) : null;
  }

  // --- openteam_guest_invites (P0-1: guest-side invite history) ---

  /**
   * Record an incoming [OPENTEAM_INVITE] the moment it is handled, so the
   * invite exists in the guest-side history even when the bot later declines
   * or the join fails. Deduped by invite_pin_id: re-deliveries (socket +
   * backfill) update nothing and return the existing row.
   */
  createGuestInvite(input: {
    groupId: string;
    inviterGlobalmetaid: string;
    inviterName?: string | null;
    taskTitle?: string | null;
    goalSummary?: string | null;
    requiredSkills?: string[];
    invitePinId?: string | null;
    targetGlobalmetaid?: string | null;
    expiresAt?: number | null;
  }): OpenTeamGuestInvite {
    const existing = input.invitePinId
      ? this.getOne<OpenTeamGuestInviteRow>(
          'SELECT * FROM openteam_guest_invites WHERE invite_pin_id = ?',
          [input.invitePinId],
        )
      : undefined;
    if (existing) return rowToOpenTeamGuestInvite(existing);
    this.db.run(
      `INSERT INTO openteam_guest_invites (
        group_id, inviter_globalmetaid, inviter_name, task_title, goal_summary,
        required_skills, invite_pin_id, target_globalmetaid, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'invited')`,
      [
        input.groupId,
        input.inviterGlobalmetaid,
        input.inviterName ?? null,
        input.taskTitle ?? null,
        input.goalSummary ?? null,
        JSON.stringify(input.requiredSkills ?? []),
        input.invitePinId ?? null,
        input.targetGlobalmetaid ?? null,
        input.expiresAt != null && Number.isFinite(input.expiresAt) ? Math.trunc(input.expiresAt) : null,
      ],
    );
    const id = this.lastInsertId();
    this.saveDb();
    const row = this.getOne<OpenTeamGuestInviteRow>(
      'SELECT * FROM openteam_guest_invites WHERE id = ?',
      [id],
    );
    if (!row) throw new Error(`createGuestInvite failed: row ${id} not found after insert`);
    return rowToOpenTeamGuestInvite(row);
  }

  /**
   * Finalize a guest invite row after the handling outcome (accepted /
   * declined / skipped / expired), stamping responded_at. `reason` carries the
   * decline reason (or 'duplicate_invite' for skips); `joinedPinId` rides the
   * accept outcome.
   */
  updateGuestInviteStatus(
    invitePinId: string,
    status: OpenTeamGuestInviteStatus,
    options?: { reason?: string | null; joinedPinId?: string | null },
  ): OpenTeamGuestInvite | null {
    const existing = this.getOne<OpenTeamGuestInviteRow>(
      'SELECT * FROM openteam_guest_invites WHERE invite_pin_id = ?',
      [invitePinId],
    );
    if (!existing) return null;
    this.db.run(
      `UPDATE openteam_guest_invites
       SET status = ?,
         decline_reason = COALESCE(?, decline_reason),
         joined_pin_id = COALESCE(?, joined_pin_id),
         responded_at = strftime('%Y-%m-%d %H:%M:%f','now')
       WHERE id = ?`,
      [
        status,
        options?.reason ?? null,
        options?.joinedPinId ?? null,
        existing.id,
      ],
    );
    this.saveDb();
    const updated = this.getOne<OpenTeamGuestInviteRow>(
      'SELECT * FROM openteam_guest_invites WHERE id = ?',
      [existing.id],
    );
    return updated ? rowToOpenTeamGuestInvite(updated) : null;
  }

  /** All guest-side invite history, newest first (backs the collab UI). */
  listGuestInvites(): OpenTeamGuestInvite[] {
    const rows = this.getAll<OpenTeamGuestInviteRow>(
      'SELECT * FROM openteam_guest_invites ORDER BY id DESC',
    );
    return rows.map(rowToOpenTeamGuestInvite);
  }

  getGuestInviteByPinId(invitePinId: string): OpenTeamGuestInvite | null {
    const row = this.getOne<OpenTeamGuestInviteRow>(
      'SELECT * FROM openteam_guest_invites WHERE invite_pin_id = ?',
      [invitePinId],
    );
    return row ? rowToOpenTeamGuestInvite(row) : null;
  }
}
