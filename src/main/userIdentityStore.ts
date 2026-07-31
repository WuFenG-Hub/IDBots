import type { SqliteDatabase as Database } from './sqliteTypes';
import type {
  UserIdentity,
  UserIdentityInsert,
  UserIdentityUpdate,
} from './types/userIdentity';

const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";
/** The user_identity table is single-row by design; the row id is always 1. */
const USER_IDENTITY_ROW_ID = 1;

interface UserIdentityRow {
  id: number;
  mnemonic: string;
  path: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string | null;
  metaid: string;
  globalmetaid: string | null;
  name: string;
  avatar: string | null;
  created_at: number;
  updated_at: number;
}

function rowToUserIdentity(row: UserIdentityRow): UserIdentity {
  return {
    id: row.id,
    mnemonic: row.mnemonic,
    path: row.path,
    mvc_address: row.mvc_address,
    btc_address: row.btc_address,
    doge_address: row.doge_address,
    public_key: row.public_key,
    chat_public_key: row.chat_public_key,
    chat_public_key_pin_id: row.chat_public_key_pin_id ?? null,
    metaid: row.metaid,
    globalmetaid: row.globalmetaid ?? null,
    name: row.name,
    avatar: row.avatar ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class UserIdentityStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

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

  /** Returns the local user identity, or null when none exists. */
  get(): UserIdentity | null {
    const row = this.getOne<UserIdentityRow>(
      'SELECT * FROM user_identity WHERE id = ? LIMIT 1',
      [USER_IDENTITY_ROW_ID],
    );
    return row ? rowToUserIdentity(row) : null;
  }

  /** Creates the local user identity. Throws when one already exists. */
  insert(data: UserIdentityInsert): UserIdentity {
    if (this.get()) {
      throw new Error('User identity already exists; log out before creating or importing another one.');
    }
    const now = Date.now();
    this.db.run(
      `INSERT INTO user_identity (
        id, mnemonic, path, mvc_address, btc_address, doge_address, public_key,
        chat_public_key, chat_public_key_pin_id, metaid, globalmetaid, name, avatar,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER_IDENTITY_ROW_ID,
        data.mnemonic,
        data.path ?? DEFAULT_WALLET_PATH,
        data.mvc_address,
        data.btc_address,
        data.doge_address,
        data.public_key,
        data.chat_public_key,
        data.chat_public_key_pin_id ?? null,
        data.metaid,
        data.globalmetaid ?? null,
        data.name,
        data.avatar ?? null,
        now,
        now,
      ],
    );
    this.saveDb();
    const created = this.get();
    if (!created) throw new Error('Failed to create user identity.');
    return created;
  }

  /** Updates profile fields; returns the updated identity, or null when none exists. */
  update(patch: UserIdentityUpdate): UserIdentity | null {
    const existing = this.get();
    if (!existing) return null;
    const next = {
      name: patch.name ?? existing.name,
      avatar: patch.avatar === undefined ? existing.avatar : patch.avatar,
      chat_public_key_pin_id:
        patch.chat_public_key_pin_id === undefined
          ? existing.chat_public_key_pin_id
          : patch.chat_public_key_pin_id,
      globalmetaid:
        patch.globalmetaid === undefined ? existing.globalmetaid : patch.globalmetaid,
    };
    this.db.run(
      `UPDATE user_identity
       SET name = ?, avatar = ?, chat_public_key_pin_id = ?, globalmetaid = ?, updated_at = ?
       WHERE id = ?`,
      [next.name, next.avatar, next.chat_public_key_pin_id, next.globalmetaid, Date.now(), USER_IDENTITY_ROW_ID],
    );
    this.saveDb();
    return this.get();
  }

  /** Deletes the local user identity (logout). Returns true when a row was removed. */
  remove(): boolean {
    const existing = this.get();
    if (!existing) return false;
    this.db.run('DELETE FROM user_identity WHERE id = ?', [USER_IDENTITY_ROW_ID]);
    this.saveDb();
    return true;
  }
}
