import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * Knowledge base registry ("知识库").
 *
 * A knowledge base is a per-MetaBot corpus of raw documents (legal codes,
 * tutorials, saved MetaWeb/Web2 finds, …) that the bot can citation-query at
 * runtime. This table only holds the registry metadata; the documents live on
 * the filesystem under `userData/knowledge-bases/<metabotId>/<kbId>/` (or in a
 * user-chosen external directory) and the derived search index lives in a
 * per-KB sqlite file that can always be rebuilt from the raw documents.
 *
 * Sibling to the distilled knowledge-point memory (metaid_knowledge_entries):
 * knowledge bases hold the source corpus; knowledge points hold distilled
 * takeaways. They complement each other and are deliberately not merged.
 */

export interface KnowledgeBaseRecord {
  id: string;
  metabotId: number;
  name: string;
  description: string;
  rawDir: string;
  isDefault: boolean;
  autoLearn: boolean;
  docCount: number;
  chunkCount: number;
  lastLearnedAt: string | null;
  lastAutoLearnDate: string | null;
  createdAt: string;
  updatedAt: string;
}

interface KnowledgeBaseRow {
  id: string;
  metabot_id: number;
  name: string;
  description: string;
  raw_dir: string;
  is_default: number;
  auto_learn: number;
  doc_count: number;
  chunk_count: number;
  last_learned_at: string | null;
  last_auto_learn_date: string | null;
  created_at: string;
  updated_at: string;
}

const rowToRecord = (row: KnowledgeBaseRow): KnowledgeBaseRecord => ({
  id: row.id,
  metabotId: row.metabot_id,
  name: row.name,
  description: row.description || '',
  rawDir: row.raw_dir,
  isDefault: row.is_default === 1,
  autoLearn: row.auto_learn === 1,
  docCount: Number(row.doc_count) || 0,
  chunkCount: Number(row.chunk_count) || 0,
  lastLearnedAt: row.last_learned_at || null,
  lastAutoLearnDate: row.last_auto_learn_date || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Create the knowledge base registry without changing existing user data. */
export function ensureKnowledgeBaseSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL,
      name TEXT NOT NULL CHECK (trim(name) <> ''),
      description TEXT NOT NULL DEFAULT '',
      raw_dir TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      auto_learn INTEGER NOT NULL DEFAULT 1,
      doc_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      last_learned_at TEXT,
      last_auto_learn_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_bases_metabot
      ON knowledge_bases(metabot_id, is_default DESC, created_at ASC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_bases_auto_learn
      ON knowledge_bases(auto_learn, last_auto_learn_date);
  `);
}

export class KnowledgeBaseStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
  ) {
    ensureKnowledgeBaseSchema(db);
  }

  private getOne<T>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    const values = result[0]?.values?.[0];
    if (!values) return null;
    return Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T;
  }

  private getAll<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T
    );
  }

  listByMetabot(metabotId: number): KnowledgeBaseRecord[] {
    return this.getAll<KnowledgeBaseRow>(
      'SELECT * FROM knowledge_bases WHERE metabot_id = ? ORDER BY is_default DESC, created_at ASC',
      [metabotId],
    ).map(rowToRecord);
  }

  getById(metabotId: number, kbId: string): KnowledgeBaseRecord | null {
    const row = this.getOne<KnowledgeBaseRow>(
      'SELECT * FROM knowledge_bases WHERE metabot_id = ? AND id = ? LIMIT 1',
      [metabotId, kbId],
    );
    return row ? rowToRecord(row) : null;
  }

  getDefault(metabotId: number): KnowledgeBaseRecord | null {
    const row = this.getOne<KnowledgeBaseRow>(
      'SELECT * FROM knowledge_bases WHERE metabot_id = ? AND is_default = 1 LIMIT 1',
      [metabotId],
    );
    return row ? rowToRecord(row) : null;
  }

  insert(record: KnowledgeBaseRecord): void {
    this.db.run(
      `INSERT INTO knowledge_bases
        (id, metabot_id, name, description, raw_dir, is_default, auto_learn,
         doc_count, chunk_count, last_learned_at, last_auto_learn_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.metabotId,
        record.name,
        record.description,
        record.rawDir,
        record.isDefault ? 1 : 0,
        record.autoLearn ? 1 : 0,
        record.docCount,
        record.chunkCount,
        record.lastLearnedAt,
        record.lastAutoLearnDate,
        record.createdAt,
        record.updatedAt,
      ],
    );
    this.saveDb();
  }

  update(
    metabotId: number,
    kbId: string,
    patch: { name?: string; description?: string; autoLearn?: boolean },
    updatedAt: string,
  ): void {
    const assignments: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      assignments.push('name = ?');
      params.push(patch.name);
    }
    if (patch.description !== undefined) {
      assignments.push('description = ?');
      params.push(patch.description);
    }
    if (patch.autoLearn !== undefined) {
      assignments.push('auto_learn = ?');
      params.push(patch.autoLearn ? 1 : 0);
    }
    if (!assignments.length) return;
    assignments.push('updated_at = ?');
    params.push(updatedAt, metabotId, kbId);
    this.db.run(
      `UPDATE knowledge_bases SET ${assignments.join(', ')} WHERE metabot_id = ? AND id = ?`,
      params,
    );
    this.saveDb();
  }

  updateLearnStats(
    kbId: string,
    stats: { docCount: number; chunkCount: number; lastLearnedAt: string },
  ): void {
    this.db.run(
      `UPDATE knowledge_bases
       SET doc_count = ?, chunk_count = ?, last_learned_at = ?, updated_at = ?
       WHERE id = ?`,
      [stats.docCount, stats.chunkCount, stats.lastLearnedAt, stats.lastLearnedAt, kbId],
    );
    this.saveDb();
  }

  markAutoLearned(kbId: string, dateStr: string): void {
    this.db.run('UPDATE knowledge_bases SET last_auto_learn_date = ? WHERE id = ?', [dateStr, kbId]);
    this.saveDb();
  }

  /** KBs due for the nightly auto-learn window on the given local date. */
  listDueForAutoLearn(todayStr: string): KnowledgeBaseRecord[] {
    return this.getAll<KnowledgeBaseRow>(
      `SELECT * FROM knowledge_bases
       WHERE auto_learn = 1 AND (last_auto_learn_date IS NULL OR last_auto_learn_date < ?)`,
      [todayStr],
    ).map(rowToRecord);
  }

  remove(metabotId: number, kbId: string): void {
    this.db.run('DELETE FROM knowledge_bases WHERE metabot_id = ? AND id = ?', [metabotId, kbId]);
    this.saveDb();
  }
}
