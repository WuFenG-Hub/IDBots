/**
 * Human user identity (single-row user_identity table).
 *
 * The local human user holds a mnemonic-derived MetaID identity just like a
 * MetaBot, but represents the person who owns MetaBots. Only one user
 * identity may exist locally at a time; switching accounts means logging out
 * (deleting the row) and importing/creating again.
 */
export interface UserIdentity {
  /** Always 1; the table enforces a single row via CHECK (id = 1). */
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
  /** Avatar as data URL string for display; null = no avatar. */
  avatar: string | null;
  created_at: number;
  updated_at: number;
}

/** Input for creating the local user identity (timestamps assigned by store). */
export interface UserIdentityInsert {
  mnemonic: string;
  path?: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id?: string | null;
  metaid: string;
  globalmetaid?: string | null;
  name: string;
  avatar?: string | null;
}

/** Input for updating profile-ish fields of the local user identity. */
export interface UserIdentityUpdate {
  name?: string;
  avatar?: string | null;
  chat_public_key_pin_id?: string | null;
  globalmetaid?: string | null;
}
