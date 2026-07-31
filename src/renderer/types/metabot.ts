/** MetaBot type for renderer (aligns with electron IPC and main types) */
export interface Metabot {
  id: number;
  wallet_id: number;
  mvc_address?: string;
  btc_address?: string;
  doge_address?: string;
  chat_public_key_pin_id?: string | null;
  metabot_info_pinid?: string | null;
  name: string;
  avatar: string | null;
  enabled: boolean;
  globalmetaid: string | null;
  metabot_type: 'twin' | 'worker';
  role: string;
  soul: string;
  goal: string | null;
  bio: string | null;
  /** Deprecated compatibility field; v3 Bot Info uses `bio`. */
  background: string | null;
  boss_id: number | null;
  boss_global_metaid: string | null;
  /** Pin id of the signed /info/owner binding; null means unsigned legacy claim or no owner. */
  owner_binding_pinid?: string | null;
  llm_id: string | null;
  tools: string[];
  skills: string[];
  allow_chat_skills: string[];
  /** Homepage pointer JSON string (serialized {uri,renderer,contentType}); null = Default template. */
  homepage?: string | null;
  created_at: number;
  updated_at: number;
}
