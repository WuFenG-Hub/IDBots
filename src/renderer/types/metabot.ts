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
  /** Optional fallback LLM provider key; the chat runtime retries once with it when the primary LLM fails. */
  fallback_llm_id?: string | null;
  tools: string[];
  skills: string[];
  allow_chat_skills: string[];
  /** Max incoming turns per active A2A private-chat session; null = app default. */
  a2a_max_incoming_turns?: number | null;
  /** Cooldown after an auto-bye before the A2A conversation may reopen; null = app default. */
  a2a_bye_cooldown_ms?: number | null;
  /** Homepage pointer JSON string (serialized {uri,renderer,contentType}); null = Default template. */
  homepage?: string | null;
  /** Runtime flag merged by main: this bot is currently running its dream consolidation. */
  dreaming?: boolean;
  created_at: number;
  updated_at: number;
}
