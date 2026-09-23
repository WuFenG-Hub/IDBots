/**
 * Group chat outbox (issue #40): durable delivery obligations for group-chat
 * replies produced by the Cognitive Orchestrator.
 *
 * Why this exists: the orchestrator broadcast was fire-and-forget. A transient
 * createPin failure (fee spike, gateway 5xx, Metalet disconnect) dropped the
 * reply with no persisted trace and no retry path, while the task cursor still
 * advanced past the triggering message — the reply was unrecoverable.
 *
 * This module is the minimal durable slice of the issue-#40 design proposal:
 *
 *   PENDING --inline send ok----------> SUBMITTED   (createPin returned a pinId)
 *   PENDING --inline send failed------> PENDING      (backoff, retried by drain)
 *   PENDING --MAX attempts exhausted--> ABANDONED    (terminal, kept for audit)
 *
 * Invariants:
 *   - The row is written BEFORE the first broadcast attempt (persist-then-send),
 *     so even a crash between INSERT and broadcast leaves a retryable row.
 *   - (group_id, metabot_id, trigger_msg_id) is unique: one obligation per
 *     (bot, triggering message). One trigger message can reach SEVERAL bots of
 *     the same group and each of them owes its own reply — keying by
 *     (group_id, trigger_msg_id) alone silently swallowed every bot after the
 *     first one (rework N1, second review). The per-bot key also guarantees
 *     enqueue/markSubmitted never cross-write another bot's obligation row.
 *   - SUBMITTED is terminal in this slice. External read-back confirmation
 *     (pin readback / verifyPinSources, the issue's CONFIRMED phase) is
 *     deliberately deferred — see fix-plan.md.
 *
 * The table is owned by this module (same pattern as dreamStore /
 * teamCultureStore): ensureGroupChatOutboxSchema() is idempotent and is called
 * by the orchestrator tick before any outbox access, which also keeps
 * hand-built test databases working.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import { createHash } from 'crypto';

export type GroupChatOutboxState = 'pending' | 'submitted' | 'abandoned';

export interface GroupChatOutboxRow {
  id: number;
  metabot_id: number;
  group_id: string;
  trigger_msg_id: number;
  nick_name: string | null;
  content: string;
  content_hash: string | null;
  state: GroupChatOutboxState;
  attempts: number;
  last_error: string | null;
  pin_id: string | null;
  next_attempt_at: number;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Retry backoff for PENDING obligations, indexed by (failed attempts - 1).
 * Explicit constants, no magic numbers: the inline first attempt is immediate,
 * then the drain retries on these delays. The issue-#40 duplicate-send warning
 * (a cooldown must exceed measured indexer latency) applies to the deferred
 * CONFIRMED read-back phase — this slice never re-sends a row that already
 * holds a pinId.
 */
export const GROUP_CHAT_OUTBOX_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;
/** Inline attempt + one retry per backoff entry; the next failure abandons the row. */
export const GROUP_CHAT_OUTBOX_MAX_ATTEMPTS = GROUP_CHAT_OUTBOX_BACKOFF_MS.length + 1;

const ensuredDatabases = new WeakSet<object>();

/** Idempotent schema creation; the orchestrator calls this before any outbox access. */
export function ensureGroupChatOutboxSchema(db: Database): void {
  if (ensuredDatabases.has(db as object)) return;
  db.run(`
    CREATE TABLE IF NOT EXISTS group_chat_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metabot_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      trigger_msg_id INTEGER NOT NULL,
      nick_name TEXT,
      content TEXT NOT NULL,
      content_hash TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      pin_id TEXT,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      -- Per-bot key (rework N1): a trigger message reaching N bots of the same
      -- group owes N obligations, one per bot. This table ships with the
      -- unreleased fix branch, so the constraint is fixed at creation and
      -- needs no migration.
      UNIQUE (group_id, metabot_id, trigger_msg_id)
    );
  `);
  ensuredDatabases.add(db as object);
}

/** Content fingerprint for a later read-back confirmation phase (deferred). */
export function groupChatContentHash(groupId: string, content: string): string {
  return createHash('sha256').update(groupId).update('\n').update(content).digest('hex');
}

function selectRows(db: Database, sql: string, params: unknown[]): GroupChatOutboxRow[] {
  const result = db.exec(sql, params);
  const columns = result[0]?.columns ?? [];
  const values = result[0]?.values ?? [];
  return values.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      record[col] = row[i];
    });
    return record as unknown as GroupChatOutboxRow;
  });
}

function readAttempts(db: Database, id: number): number {
  const rows = db.exec('SELECT attempts FROM group_chat_outbox WHERE id = ? LIMIT 1', [id]);
  const value = rows[0]?.values?.[0]?.[0];
  return value == null ? 0 : Number(value) || 0;
}

/**
 * Persist a NEW delivery obligation for one bot and one triggering message.
 * Safe to call twice for the same (group, bot, trigger message): the per-bot
 * UNIQUE constraint plus INSERT OR IGNORE keeps a single row PER BOT, while
 * another bot enqueueing for the same trigger message still gets its own row.
 * Returns this bot's row id, or 0 when the insert was ignored and the
 * follow-up read found nothing.
 */
export function enqueueGroupChatSend(
  db: Database,
  entry: {
    metabotId: number;
    groupId: string;
    triggerMsgId: number;
    nickName: string;
    content: string;
  }
): number {
  db.run(
    `INSERT OR IGNORE INTO group_chat_outbox
       (metabot_id, group_id, trigger_msg_id, nick_name, content, content_hash, state, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0)`,
    [
      entry.metabotId,
      entry.groupId,
      entry.triggerMsgId,
      entry.nickName,
      entry.content,
      groupChatContentHash(entry.groupId, entry.content),
    ]
  );
  const rows = selectRows(
    db,
    'SELECT * FROM group_chat_outbox WHERE group_id = ? AND metabot_id = ? AND trigger_msg_id = ? LIMIT 1',
    [entry.groupId, entry.metabotId, entry.triggerMsgId]
  );
  return rows[0]?.id ?? 0;
}

/**
 * The obligation for one (bot, triggering message), whatever its state (null
 * when none). Scoped per bot (rework N1): another bot's obligation on the same
 * trigger message must NEVER gate this bot's reply nor mask this bot's own row.
 */
export function findGroupChatSendByTrigger(
  db: Database,
  groupId: string,
  metabotId: number,
  triggerMsgId: number
): GroupChatOutboxRow | null {
  const rows = selectRows(
    db,
    'SELECT * FROM group_chat_outbox WHERE group_id = ? AND metabot_id = ? AND trigger_msg_id = ? LIMIT 1',
    [groupId, metabotId, triggerMsgId]
  );
  return rows[0] ?? null;
}

/**
 * All PENDING obligations for a group, oldest first. Pass metabotId to scope
 * the list to one bot: the cursor floor is per bot task, while the drain
 * retries group-wide because every row is self-contained (bot, nickname, text).
 */
export function listPendingGroupChatSends(
  db: Database,
  groupId: string,
  metabotId?: number
): GroupChatOutboxRow[] {
  if (metabotId == null) {
    return selectRows(
      db,
      `SELECT * FROM group_chat_outbox WHERE group_id = ? AND state = 'pending' ORDER BY id ASC`,
      [groupId]
    );
  }
  return selectRows(
    db,
    `SELECT * FROM group_chat_outbox WHERE group_id = ? AND metabot_id = ? AND state = 'pending' ORDER BY id ASC`,
    [groupId, metabotId]
  );
}

/** Lowest trigger message id across PENDING rows — the cursor floor (null when none). */
export function lowestPendingTriggerMsgId(rows: GroupChatOutboxRow[]): number | null {
  let min: number | null = null;
  for (const row of rows) {
    const id = Number(row.trigger_msg_id);
    if (!Number.isFinite(id)) continue;
    if (min == null || id < min) min = id;
  }
  return min;
}

/**
 * Mark the obligation delivered: the transport returned a pinId, i.e. the pin
 * is signed and broadcast (local-write ACK). pinId is recorded when available.
 */
export function markGroupChatSendSubmitted(db: Database, id: number, pinId: string | null): void {
  db.run(
    `UPDATE group_chat_outbox
        SET state = 'submitted', pin_id = ?, attempts = attempts + 1, last_error = NULL,
            updated_at = datetime('now')
      WHERE id = ?`,
    [pinId, id]
  );
}

/**
 * Record a failed delivery attempt. Stays PENDING with backoff until
 * GROUP_CHAT_OUTBOX_MAX_ATTEMPTS is reached, then becomes the terminal
 * ABANDONED state (row kept for audit; the cursor floor no longer holds).
 */
export function markGroupChatSendFailed(
  db: Database,
  id: number,
  error: string
): { state: GroupChatOutboxState; attempts: number } {
  const attempts = readAttempts(db, id) + 1;
  if (attempts >= GROUP_CHAT_OUTBOX_MAX_ATTEMPTS) {
    db.run(
      `UPDATE group_chat_outbox
          SET state = 'abandoned', attempts = ?, last_error = ?, next_attempt_at = 0,
              updated_at = datetime('now')
        WHERE id = ?`,
      [attempts, error, id]
    );
    return { state: 'abandoned', attempts };
  }
  const backoffMs = GROUP_CHAT_OUTBOX_BACKOFF_MS[Math.min(attempts - 1, GROUP_CHAT_OUTBOX_BACKOFF_MS.length - 1)];
  db.run(
    `UPDATE group_chat_outbox
        SET state = 'pending', attempts = ?, last_error = ?, next_attempt_at = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
    [attempts, error, Date.now() + backoffMs, id]
  );
  return { state: 'pending', attempts };
}
