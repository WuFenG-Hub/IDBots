import type { SqliteDatabase, SqliteExecResult } from './sqliteTypes';

interface NativeSqliteModule {
  DatabaseSync: new (filename: string) => NativeDatabaseSync;
}

interface NativeDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): NativeStatementSync;
  close(): void;
}

interface NativeStatementSync {
  sourceSQL?: string;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes?: number | bigint };
  columns(): Array<{ name?: string; column?: string }>;
}

const trimTrailingSemicolons = (sql: string): string =>
  sql.trim().replace(/;+\s*$/u, '').trim();

const hasUnpreparedTrailingSql = (sql: string, statement: NativeStatementSync): boolean => {
  const source = statement.sourceSQL;
  if (!source) return false;
  return trimTrailingSemicolons(source) !== trimTrailingSemicolons(sql);
};

const toSafeNumber = (value: number | bigint | undefined): number => {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value ?? 0;
};

const rowsToExecResult = (
  statement: NativeStatementSync,
  rows: Array<Record<string, unknown>>,
): SqliteExecResult[] => {
  const columns = statement.columns().map((column) => column.name || column.column || '');
  if (columns.length === 0) {
    return [];
  }

  return [{
    columns,
    values: rows.map((row) => columns.map((column) => row[column])),
  }];
};

export class NativeSqliteDatabase implements SqliteDatabase {
  private readonly db: NativeDatabaseSync;
  private rowsModified = 0;
  private closed = false;

  constructor(filename: string, module: NativeSqliteModule) {
    this.db = new module.DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    // 清单 #11: concurrent-write safety. The SQLite defaults (rollback journal,
    // busy_timeout = 0) make a write from ANY second connection fail instantly
    // with SQLITE_BUSY ("database is locked") — reproduced live when a Twin
    // session and a delegated worker session wrote the same database at the
    // same time and the worker session was killed mid-task. WAL lets readers
    // run alongside the single writer without blocking, and busy_timeout makes
    // a writer wait for the other connection's transaction to finish instead
    // of throwing. Both are idempotent per-connection/per-database settings;
    // journal_mode = WAL persists in the database header, so existing user
    // databases keep working and every later connection inherits WAL.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // WAL unavailable (read-only media, exotic filesystems): degrade to the
      // default rollback journal; busy_timeout above still serializes writers.
    }
  }

  exec(sql: string, params: unknown[] = []): SqliteExecResult[] {
    this.assertOpen();
    const statement = this.db.prepare(sql);
    if (params.length === 0 && hasUnpreparedTrailingSql(sql, statement)) {
      this.db.exec(sql);
      return [];
    }
    return rowsToExecResult(statement, statement.all(...params));
  }

  run(sql: string, params: unknown[] = []): unknown {
    this.assertOpen();
    const statement = this.db.prepare(sql);
    if (params.length === 0 && hasUnpreparedTrailingSql(sql, statement)) {
      this.db.exec(sql);
      this.rowsModified = 0;
      return undefined;
    }

    const result = statement.run(...params);
    this.rowsModified = toSafeNumber(result.changes);
    return result;
  }

  getRowsModified(): number {
    return this.rowsModified;
  }

  close(): void {
    if (this.closed) return;
    // Fold any WAL frames back into the main database file so a later
    // main-file-only reader (e.g. the sql.js fallback backend) sees the full
    // contents after a clean shutdown. Best-effort: a concurrent writer can
    // make the checkpoint busy, and the database stays valid either way.
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // best-effort checkpoint; close proceeds regardless
    }
    this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Database closed');
    }
  }
}

export function loadNativeSqliteModule(): NativeSqliteModule | null {
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
      if (args[0] === 'ExperimentalWarning' && String(warning).includes('SQLite')) {
        return;
      }
      return emitWarning.call(process, warning as string, ...(args as [string?, string?, string?]));
    }) as typeof process.emitWarning;
    return require('node:sqlite') as NativeSqliteModule;
  } catch {
    return null;
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function createNativeSqliteDatabase(filename: string): NativeSqliteDatabase | null {
  const sqlite = loadNativeSqliteModule();
  if (!sqlite) return null;
  return new NativeSqliteDatabase(filename, sqlite);
}
