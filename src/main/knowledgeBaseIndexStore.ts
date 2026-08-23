import fs from 'fs';
import path from 'path';
import { createNativeSqliteDatabase } from './nativeSqliteDatabase';
import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * Per-knowledge-base derived search index (`<kbDir>/index/kb.sqlite`).
 *
 * Holds the document fingerprint state (for incremental learning), the chunk
 * table and — when the runtime's SQLite has FTS5 (node:sqlite does; the sql.js
 * fallback bundle does not) — an FTS5 index over pre-tokenized chunk text.
 * Everything here is derived data: deleting the file and re-running a full
 * learn rebuilds it from the raw documents.
 *
 * Compared with the old wiki skill runtime this replaces the load-everything-
 * into-memory JSON indexes with real per-document incremental upserts/deletes.
 */

export interface KnowledgeBaseDocRow {
  relpath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  title: string;
  chunkCount: number;
  ingestedAt: string;
}

export interface KnowledgeBaseChunkRow {
  rowid: number;
  docRelpath: string;
  ord: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface KnowledgeBaseIndexCounts {
  docs: number;
  chunks: number;
}

const INDEX_DB_FILENAME = 'kb.sqlite';

export class KnowledgeBaseIndexStore {
  readonly ftsEnabled: boolean;

  /** Use {@link openKnowledgeBaseIndex} — it probes schema/FTS5 and handles null. */
  constructor(private readonly db: Database, ftsEnabled: boolean) {
    this.ftsEnabled = ftsEnabled;
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

  private lastInsertRowid(): number {
    const row = this.getOne<{ value: number | bigint }>('SELECT last_insert_rowid() AS value');
    return Number(row?.value ?? 0);
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.run('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.run('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // rollback best-effort
      }
      throw error;
    }
  }

  listDocs(): KnowledgeBaseDocRow[] {
    return this.getAll<Record<string, unknown>>(
      'SELECT relpath, sha256, size, mtime_ms, title, chunk_count, ingested_at FROM docs',
    ).map((row) => ({
      relpath: String(row.relpath),
      sha256: String(row.sha256),
      size: Number(row.size) || 0,
      mtimeMs: Number(row.mtime_ms) || 0,
      title: String(row.title || ''),
      chunkCount: Number(row.chunk_count) || 0,
      ingestedAt: String(row.ingested_at || ''),
    }));
  }

  /** Stat fields changed but content hash is identical: refresh the fingerprint only. */
  touchDoc(relpath: string, stat: { size: number; mtimeMs: number; sha256: string }): void {
    this.db.run('UPDATE docs SET size = ?, mtime_ms = ?, sha256 = ? WHERE relpath = ?', [
      stat.size,
      stat.mtimeMs,
      stat.sha256,
      relpath,
    ]);
  }

  replaceDoc(
    doc: { relpath: string; sha256: string; size: number; mtimeMs: number; title: string; ingestedAt: string },
    chunks: Array<{ ord: number; text: string; tokenText: string; startOffset: number; endOffset: number }>,
  ): void {
    this.inTransaction(() => {
      this.deleteDocChunks(doc.relpath);
      this.db.run(
        `INSERT INTO docs (relpath, sha256, size, mtime_ms, title, chunk_count, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(relpath) DO UPDATE SET
           sha256 = excluded.sha256, size = excluded.size, mtime_ms = excluded.mtime_ms,
           title = excluded.title, chunk_count = excluded.chunk_count,
           ingested_at = excluded.ingested_at`,
        [doc.relpath, doc.sha256, doc.size, doc.mtimeMs, doc.title, chunks.length, doc.ingestedAt],
      );
      for (const chunk of chunks) {
        this.db.run(
          `INSERT INTO chunks (doc_relpath, ord, text, token_text, start_offset, end_offset)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [doc.relpath, chunk.ord, chunk.text, chunk.tokenText, chunk.startOffset, chunk.endOffset],
        );
        if (this.ftsEnabled) {
          this.db.run('INSERT INTO chunks_fts (rowid, token_text) VALUES (?, ?)', [
            this.lastInsertRowid(),
            chunk.tokenText,
          ]);
        }
      }
    });
  }

  private deleteDocChunks(relpath: string): void {
    if (this.ftsEnabled) {
      this.db.run(
        'DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE doc_relpath = ?)',
        [relpath],
      );
    }
    this.db.run('DELETE FROM chunks WHERE doc_relpath = ?', [relpath]);
  }

  removeDoc(relpath: string): void {
    this.inTransaction(() => {
      this.deleteDocChunks(relpath);
      this.db.run('DELETE FROM docs WHERE relpath = ?', [relpath]);
    });
  }

  clear(): void {
    this.inTransaction(() => {
      if (this.ftsEnabled) {
        this.db.run('DELETE FROM chunks_fts');
      }
      this.db.run('DELETE FROM chunks');
      this.db.run('DELETE FROM docs');
    });
  }

  counts(): KnowledgeBaseIndexCounts {
    const docs = this.getOne<{ n: number }>('SELECT COUNT(*) AS n FROM docs');
    const chunks = this.getOne<{ n: number }>('SELECT COUNT(*) AS n FROM chunks');
    return { docs: Number(docs?.n) || 0, chunks: Number(chunks?.n) || 0 };
  }

  /** FTS5 BM25 candidates. Lower rank = better match. */
  searchFts(matchQuery: string, limit: number): Array<{ rowid: number; rank: number }> {
    if (!this.ftsEnabled || !matchQuery) return [];
    return this.getAll<Record<string, unknown>>(
      'SELECT rowid, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?',
      [matchQuery, limit],
    ).map((row) => ({ rowid: Number(row.rowid), rank: Number(row.rank) }));
  }

  getChunksByRowids(rowids: number[]): KnowledgeBaseChunkRow[] {
    if (!rowids.length) return [];
    const placeholders = rowids.map(() => '?').join(', ');
    const rows = this.getAll<Record<string, unknown>>(
      `SELECT rowid, doc_relpath, ord, text, start_offset, end_offset
       FROM chunks WHERE rowid IN (${placeholders})`,
      rowids,
    );
    const byRowid = new Map<number, KnowledgeBaseChunkRow>();
    for (const row of rows) {
      byRowid.set(Number(row.rowid), {
        rowid: Number(row.rowid),
        docRelpath: String(row.doc_relpath),
        ord: Number(row.ord) || 0,
        text: String(row.text || ''),
        startOffset: Number(row.start_offset) || 0,
        endOffset: Number(row.end_offset) || 0,
      });
    }
    return rowids.map((rowid) => byRowid.get(rowid)).filter((row): row is KnowledgeBaseChunkRow => Boolean(row));
  }

  /** Fallback candidate selection when FTS5 is unavailable: substring prefilter. */
  searchLike(terms: string[], limit: number): KnowledgeBaseChunkRow[] {
    const usable = terms.map((term) => String(term || '').trim()).filter(Boolean).slice(0, 8);
    if (!usable.length) return [];
    const where = usable.map(() => 'text LIKE ?').join(' OR ');
    const params = usable.map((term) => `%${term.replace(/[%_]/g, '')}%`);
    return this.getAll<Record<string, unknown>>(
      `SELECT rowid, doc_relpath, ord, text, start_offset, end_offset
       FROM chunks WHERE ${where} LIMIT ?`,
      [...params, limit],
    ).map((row) => ({
      rowid: Number(row.rowid),
      docRelpath: String(row.doc_relpath),
      ord: Number(row.ord) || 0,
      text: String(row.text || ''),
      startOffset: Number(row.start_offset) || 0,
      endOffset: Number(row.end_offset) || 0,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function ensureIndexSchema(db: Database): boolean {
  db.run(`
    CREATE TABLE IF NOT EXISTS docs (
      relpath TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      doc_relpath TEXT NOT NULL,
      ord INTEGER NOT NULL,
      text TEXT NOT NULL,
      token_text TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      PRIMARY KEY (doc_relpath, ord)
    );
  `);
  try {
    db.run('CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(token_text)');
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens (creating if needed) the per-KB index under `<kbDir>/index/`.
 * Returns null when the runtime provides no native SQLite (node:sqlite) —
 * knowledge bases require it; the caller should surface a clear error.
 */
export function openKnowledgeBaseIndex(kbDir: string): KnowledgeBaseIndexStore | null {
  const indexDir = path.join(kbDir, 'index');
  fs.mkdirSync(indexDir, { recursive: true });
  const db = createNativeSqliteDatabase(path.join(indexDir, INDEX_DB_FILENAME));
  if (!db) return null;
  let ftsEnabled = false;
  try {
    ftsEnabled = ensureIndexSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new KnowledgeBaseIndexStore(db, ftsEnabled);
}
