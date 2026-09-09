/**
 * Dialogue cognition store (R10, OpenTeam chat scenario 2026-09, H-50 ③):
 * persistent records of cognition-relevant statements made in group
 * conversations — relationship definitions, boundary declarations, agreed
 * conclusions, self-corrections ("认知改变"). Scope note: THIS milestone ships
 * the storage + interface only (one record can be written and read back,
 * source-pin-cited); automatic model-side extraction and memory-system
 * recall integration are deliberately second-phase — nothing writes to this
 * table from the conversation pipeline yet.
 *
 * Group-scoped by design: an OpenTeam guest host has no local GroupTask row,
 * so records key on the on-chain group id with an optional local task id.
 * Structural pattern follows openTeamMembershipStore.ts (wraps db + saveDb).
 */

import type { SqliteDatabase as Database } from './sqliteTypes';

export type DialogueCognitionKind =
  | 'position'
  | 'boundary'
  | 'agreement'
  | 'correction'
  | 'note';

/** Kinds this store accepts (unknown values normalize to 'note'). */
const DIALOGUE_COGNITION_KINDS: ReadonlySet<string> = new Set([
  'position',
  'boundary',
  'agreement',
  'correction',
  'note',
]);

export interface DialogueCognitionRecord {
  id: number;
  /** On-chain group id the conversation happened in. */
  groupId: string;
  /** Local group_tasks.id when the group has one on this host; else null. */
  taskId: number | null;
  kind: DialogueCognitionKind;
  /** The statement as made (trimmed, length-capped by the writer). */
  statement: string;
  /** Who made the statement (globalMetaId; null = unknown/legacy). */
  authorGlobalMetaId: string | null;
  /** Other participants of the conversation (globalMetaIds, JSON array text). */
  participantsJson: string | null;
  /** Pin of the message carrying the statement; null = off-chain origin. */
  sourcePinId: string | null;
  /** sqlite datetime 'now' (UTC). */
  createdAt: string | null;
}

interface DialogueCognitionRow {
  id: number;
  group_id: string;
  task_id: number | null;
  kind: string;
  statement: string;
  author_global_metaid: string | null;
  participants_json: string | null;
  source_pin_id: string | null;
  created_at: string | null;
}

function rowToDialogueCognition(row: DialogueCognitionRow): DialogueCognitionRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    taskId: row.task_id ?? null,
    kind: (DIALOGUE_COGNITION_KINDS.has(row.kind) ? row.kind : 'note') as DialogueCognitionKind,
    statement: row.statement,
    authorGlobalMetaId: row.author_global_metaid ?? null,
    participantsJson: row.participants_json ?? null,
    sourcePinId: row.source_pin_id ?? null,
    createdAt: row.created_at ?? null,
  };
}

export class DialogueCognitionStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  private getAll(sql: string, params: (string | number | null)[] = []): DialogueCognitionRow[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns as string[];
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, index) => {
        row[col] = values[index];
      });
      return row as unknown as DialogueCognitionRow;
    });
  }

  /**
   * Write one cognition record. Idempotent per source pin: a pin already
   * recorded for this group inserts nothing and returns null (re-delivery of
   * the same chain message must not duplicate cognition history). Returns the
   * stored record.
   */
  recordDialogueCognition(input: {
    groupId: string;
    taskId?: number | null;
    kind?: DialogueCognitionKind;
    statement: string;
    authorGlobalMetaId?: string | null;
    participants?: string[];
    sourcePinId?: string | null;
  }): DialogueCognitionRecord | null {
    const groupId = input.groupId.trim();
    const statement = input.statement.trim();
    if (!groupId || !statement) return null;
    const sourcePinId = input.sourcePinId?.trim() || null;
    if (sourcePinId) {
      const existing = this.getAll(
        'SELECT * FROM dialogue_cognitions WHERE group_id = ? AND source_pin_id = ? LIMIT 1',
        [groupId, sourcePinId],
      );
      if (existing.length > 0) return rowToDialogueCognition(existing[0]!);
    }
    const kind = input.kind && DIALOGUE_COGNITION_KINDS.has(input.kind) ? input.kind : 'note';
    this.db.run(
      `INSERT INTO dialogue_cognitions (
        group_id, task_id, kind, statement, author_global_metaid, participants_json, source_pin_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        input.taskId ?? null,
        kind,
        statement,
        input.authorGlobalMetaId ?? null,
        input.participants?.length ? JSON.stringify(input.participants) : null,
        sourcePinId,
      ],
    );
    this.saveDb();
    const rows = this.getAll(
      'SELECT * FROM dialogue_cognitions WHERE group_id = ? AND statement = ? ORDER BY id DESC LIMIT 1',
      [groupId, statement],
    );
    return rows.length > 0 ? rowToDialogueCognition(rows[0]!) : null;
  }

  /** Every cognition record for one group (oldest first), newest-first when inverted. */
  listDialogueCognitions(groupId: string, opts?: { newestFirst?: boolean }): DialogueCognitionRecord[] {
    const trimmed = groupId.trim();
    if (!trimmed) return [];
    const order = opts?.newestFirst ? 'DESC' : 'ASC';
    return this.getAll(
      `SELECT * FROM dialogue_cognitions WHERE group_id = ? ORDER BY id ${order}`,
      [trimmed],
    ).map(rowToDialogueCognition);
  }
}
