import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * Per-message human feedback (thumbs up/down) on cowork assistant messages.
 *
 * Storage layer for the message_feedback table (created idempotently in
 * sqliteStore.initializeTables): one row per rated message, keyed by
 * message_id. The dream consolidation LEFT JOINs these rows onto the day's
 * messages as the human's per-message alignment signal.
 */

export interface MessageFeedbackRecord {
  messageId: string;
  sessionId: string;
  rating: 'up' | 'down';
  comment: string | null;
  createdAt: number;
  updatedAt: number;
}

const mapFeedbackRow = (row: unknown[]): MessageFeedbackRecord => ({
  messageId: String(row[0]),
  sessionId: String(row[1]),
  rating: String(row[2]) === 'down' ? 'down' : 'up',
  comment: row[3] == null ? null : String(row[3]),
  createdAt: Number(row[4]),
  updatedAt: Number(row[5]),
});

const normalizeComment = (comment: string | null | undefined): string | null => {
  if (comment == null) return null;
  const trimmed = comment.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class MessageFeedbackStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  /**
   * Insert or update the human's rating for one message. When the `comment`
   * key is absent the existing comment is preserved; when present it is
   * stored trimmed (empty string → null). created_at keeps the original
   * value on conflict; updated_at always moves to now.
   */
  upsertFeedback(input: {
    messageId: string;
    sessionId: string;
    rating: 'up' | 'down';
    comment?: string | null;
  }): MessageFeedbackRecord {
    const now = Date.now();
    const hasComment = input.comment !== undefined;
    this.db.run(`
      INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        rating = excluded.rating,
        updated_at = excluded.updated_at${hasComment ? ',\n        comment = excluded.comment' : ''}
    `, [input.messageId, input.sessionId, input.rating, normalizeComment(input.comment), now, now]);
    this.saveDb();

    const record = this.getFeedback(input.messageId);
    if (!record) {
      throw new Error('Failed to persist message feedback');
    }
    return record;
  }

  clearFeedback(messageId: string): boolean {
    if (!this.getFeedback(messageId)) return false;
    this.db.run('DELETE FROM message_feedback WHERE message_id = ?', [messageId]);
    this.saveDb();
    return true;
  }

  getFeedback(messageId: string): MessageFeedbackRecord | null {
    const result = this.db.exec(`
      SELECT message_id, session_id, rating, comment, created_at, updated_at
      FROM message_feedback
      WHERE message_id = ?
      LIMIT 1
    `, [messageId]);
    const row = result[0]?.values[0];
    return row ? mapFeedbackRow(row) : null;
  }

  listFeedbackForSession(sessionId: string): MessageFeedbackRecord[] {
    const result = this.db.exec(`
      SELECT message_id, session_id, rating, comment, created_at, updated_at
      FROM message_feedback
      WHERE session_id = ?
      ORDER BY created_at ASC
    `, [sessionId]);
    return (result[0]?.values ?? []).map(mapFeedbackRow);
  }
}
