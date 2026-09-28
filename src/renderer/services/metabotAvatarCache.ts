import type { CoworkSessionSummary } from '../types/cowork';

interface MetabotAvatarEntry {
  avatar: string | null;
  /** The metabotAvatarVersion the entry was read for. */
  version: number;
}

/** Mirrors the main-process cap on one avatar read (SQLite bind-parameter budget). */
const MAX_IDS_PER_FETCH = 200;

/**
 * Display-avatar cache for the local-chat list.
 *
 * Session summaries carry the owning metabot id and that row's revision, not the
 * avatar image: inlining the image into every row shipped ~36MB across IPC per
 * refresh on a real library. This cache resolves the image by id, reading only
 * the bots it has never seen or whose revision moved, and keeps the previously
 * read avatar when a read fails so a list refresh never blocks on avatars.
 */
export class MetabotAvatarCache {
  private entries = new Map<number, MetabotAvatarEntry>();
  private pendingFetch: Promise<void> | null = null;

  /** The same summaries with `metabotAvatar` filled in from the cache. */
  async attachAvatars(sessions: CoworkSessionSummary[]): Promise<CoworkSessionSummary[]> {
    // One read at a time: a refresh that lands mid-read waits for it and only
    // asks for what is still unknown or stale afterwards.
    if (this.pendingFetch) {
      await this.pendingFetch;
    }
    const stale = this.collectStaleBots(sessions);
    if (stale.length > 0) {
      const fetch = this.fetchAvatars(stale);
      this.pendingFetch = fetch;
      try {
        await fetch;
      } finally {
        if (this.pendingFetch === fetch) {
          this.pendingFetch = null;
        }
      }
    }

    return sessions.map((session) => {
      const id = session.metabotId;
      if (id == null) return session;
      const entry = this.entries.get(id);
      return entry ? { ...session, metabotAvatar: entry.avatar } : session;
    });
  }

  private collectStaleBots(sessions: CoworkSessionSummary[]): Array<{ id: number; version: number }> {
    const stale = new Map<number, number>();
    for (const session of sessions) {
      const id = session.metabotId;
      if (id == null || !Number.isInteger(id) || id <= 0) continue;
      const version = session.metabotAvatarVersion ?? 0;
      const entry = this.entries.get(id);
      if (!entry || entry.version !== version) {
        if (!stale.has(id)) {
          stale.set(id, version);
        }
      }
    }
    return [...stale].map(([id, version]) => ({ id, version })).slice(0, MAX_IDS_PER_FETCH);
  }

  /** Best effort by design: a failed read leaves the cache untouched, so the
   * previous avatar stays on screen and the next refresh retries. */
  private async fetchAvatars(stale: Array<{ id: number; version: number }>): Promise<void> {
    let avatars: Array<{ metabotId: number; avatar: string | null }>;
    try {
      const result = await window.electron?.cowork?.listMetabotAvatars?.(stale.map((item) => item.id));
      if (!result?.success || !Array.isArray(result.avatars)) {
        return;
      }
      avatars = result.avatars;
    } catch {
      return;
    }

    const byId = new Map(avatars.map((item) => [item.metabotId, item.avatar ?? null]));
    for (const { id, version } of stale) {
      // A bot the read did not answer for has no avatar to show; remembering
      // that at this revision keeps the next refresh from asking again.
      this.entries.set(id, { avatar: byId.get(id) ?? null, version });
    }
  }
}

export const metabotAvatarCache = new MetabotAvatarCache();
