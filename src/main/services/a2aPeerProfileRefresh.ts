/**
 * A2A peer profile refresh.
 *
 * The peer name/avatar shown in an A2A private-chat session was historically
 * captured only when a message arrived (from the socket payload's userInfo)
 * or when the session was created, so a peer that renamed itself or changed
 * its avatar kept showing stale data forever. This service refreshes the
 * stored peer profile from the latest chain data (same MetaSO P2P API the
 * Bot Browser profile page uses) with a short in-memory TTL so repeated
 * triggers (session open, incoming messages) stay cheap.
 */

import type { CoworkSession, CoworkStore } from '../coworkStore';

export interface A2APeerProfile {
  name: string | null;
  avatar: string | null;
}

export type FetchA2APeerProfileFn = (peerGlobalMetaId: string) => Promise<A2APeerProfile | null>;

export interface RefreshA2APeerProfileResult {
  /** True when a fresh profile was fetched (or served from cache) successfully. */
  refreshed: boolean;
  /** True when the stored session peer name/avatar actually changed. */
  changed: boolean;
}

export const A2A_PEER_PROFILE_REFRESH_TTL_MS = 5 * 60_000;

interface ProfileCacheEntry {
  fetchedAt: number;
  profile: A2APeerProfile | null;
}

const profileCache = new Map<string, ProfileCacheEntry>();

/** Test hook: drop all cached profiles. */
export const clearA2APeerProfileCache = (): void => {
  profileCache.clear();
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const sameText = (a: unknown, b: unknown): boolean => normalizeText(a) === normalizeText(b);

export const refreshA2APeerProfile = async (input: {
  coworkStore: Pick<CoworkStore, 'getSession' | 'updateA2APeerProfile'>;
  sessionId: string;
  fetchProfile: FetchA2APeerProfileFn;
  ttlMs?: number;
  now?: () => number;
  /**
   * Bypass the in-memory TTL cache and always re-fetch from the chain. Used by
   * user-triggered refresh (e.g. clicking a peer avatar) so a peer that renamed
   * or changed its avatar shows up immediately instead of waiting out the TTL.
   */
  force?: boolean;
}): Promise<RefreshA2APeerProfileResult> => {
  const sessionId = normalizeText(input.sessionId);
  if (!sessionId) return { refreshed: false, changed: false };

  const session = input.coworkStore.getSession(sessionId);
  if (!session || session.sessionType !== 'a2a') return { refreshed: false, changed: false };
  const peerGlobalMetaId = normalizeText(session.peerGlobalMetaId);
  if (!peerGlobalMetaId) return { refreshed: false, changed: false };

  const ttlMs = Math.max(1, Math.floor(input.ttlMs ?? A2A_PEER_PROFILE_REFRESH_TTL_MS));
  const now = input.now ?? Date.now;
  const force = input.force === true;

  let profile: A2APeerProfile | null = null;
  const cached = profileCache.get(peerGlobalMetaId);
  if (!force && cached && now() - cached.fetchedAt < ttlMs) {
    profile = cached.profile;
  } else {
    try {
      profile = await input.fetchProfile(peerGlobalMetaId);
    } catch (error) {
      console.warn(
        `[A2A PeerProfile] Failed to fetch profile for ${peerGlobalMetaId.slice(0, 12)}…: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      profile = null;
    }
    profileCache.set(peerGlobalMetaId, { fetchedAt: now(), profile });
  }
  if (!profile) return { refreshed: false, changed: false };

  const peerName = normalizeText(profile.name) || null;
  const peerAvatar = normalizeText(profile.avatar) || null;
  // Avoid no-op writes; also never blank out an existing value with an empty one.
  const nextName = peerName ?? (normalizeText(session.peerName) || null);
  const nextAvatar = peerAvatar ?? (normalizeText(session.peerAvatar) || null);
  if (sameText(nextName, session.peerName) && sameText(nextAvatar, session.peerAvatar)) {
    return { refreshed: true, changed: false };
  }

  const changed = input.coworkStore.updateA2APeerProfile(sessionId, {
    peerName: nextName,
    peerAvatar: nextAvatar,
  });
  return { refreshed: true, changed };
};
