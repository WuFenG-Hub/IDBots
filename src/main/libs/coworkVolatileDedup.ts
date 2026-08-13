/**
 * Content-hash deduplication for the per-turn volatile context tail.
 *
 * The runner injects volatile context (memory blocks, browser tabs, remote
 * services, experience summaries) into the CURRENT user message so the
 * cacheable prompt head stays byte-stable. Every injected token sits in the
 * request tail, which is a guaranteed cache miss each turn — so re-injecting
 * a section whose bytes are identical to the previous turn's injection buys
 * nothing and only grows the miss denominator. This module dedups those
 * sections: a byte-identical section is omitted because the model can still
 * read the previous injection in the conversation history.
 *
 * Validity of "still in history" is bounded by the SDK session identity: a
 * reset session (claudeSessionId cleared — system-prompt change, compaction,
 * stale-session retry) has no history to fall back on, so the dedup state is
 * keyed by that generation and a changed generation invalidates all cached
 * hashes (everything is injected again). Mirrors the DeepSeek Harness
 * RuntimeContextProjection semantics: the retained hash always tracks the
 * LAST injected text, so a section that changed away and changed back is
 * re-injected instead of being wrongly deduped.
 *
 * Pure module: no I/O, no Electron imports.
 */

import { createHash } from 'crypto';

/** One rendered volatile section. `key` is the dedup-cache identity. */
export interface VolatileSection {
  key: string;
  text: string;
  /**
   * Sections that must be injected every turn regardless of hash (e.g. the
   * memory block, which is re-ranked by the current user text and carries
   * user facts). Dedup is skipped for these.
   */
  alwaysInject?: boolean;
}

/** Dedup state for one session, invalidated by an SDK-session generation change. */
export interface VolatileDedupState {
  /** SDK session identity the cached hashes belong to; null = fresh session. */
  generation: string | null;
  hashes: Map<string, string>;
}

export function createVolatileDedupState(generation: string | null): VolatileDedupState {
  return { generation, hashes: new Map() };
}

export function hashVolatileSection(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Apply content dedup to a list of rendered sections. Returns the texts to
 * inject, in order. Empty texts are dropped; identical-to-previous sections
 * are omitted; every hash is recorded so the comparison always tracks the
 * LAST injection (A -> B -> A re-injects A).
 */
export function applyVolatileDedup(
  sections: VolatileSection[],
  state: VolatileDedupState
): string[] {
  const kept: string[] = [];
  for (const section of sections) {
    const text = typeof section.text === 'string' ? section.text.trim() : '';
    if (!text) {
      continue;
    }
    const hash = hashVolatileSection(text);
    const previousHash = state.hashes.get(section.key);
    state.hashes.set(section.key, hash);
    if (section.alwaysInject !== true && previousHash === hash) {
      // Byte-identical to the previous injection of this SDK-session
      // generation — still visible in history, so skip it.
      continue;
    }
    kept.push(text);
  }
  return kept;
}
