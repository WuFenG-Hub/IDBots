import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearA2APeerProfileCache,
  refreshA2APeerProfile,
  type A2APeerProfile,
} from '../src/main/services/a2aPeerProfileRefresh';
import type { CoworkSession } from '../src/main/coworkStore';

let peerSeq = 0;
const nextPeerId = () => `idq1peer${(peerSeq += 1)}`;

const a2aSession = (overrides: Partial<CoworkSession> = {}): CoworkSession => ({
  id: 'session-1',
  title: 'Twin Bot',
  status: 'completed',
  cwd: '/tmp',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  sessionType: 'a2a',
  metabotId: 7,
  peerGlobalMetaId: nextPeerId(),
  peerName: 'Twin Bot',
  peerAvatar: 'metafile://old-avatar',
  ...overrides,
} as CoworkSession);

const createStoreMock = (session: CoworkSession | null) => {
  const updates: Array<{ sessionId: string; peerName?: string | null; peerAvatar?: string | null }> = [];
  return {
    updates,
    coworkStore: {
      getSession: (id: string) => (session && session.id === id ? session : null),
      updateA2APeerProfile: (sessionId: string, input: { peerName?: string | null; peerAvatar?: string | null }) => {
        updates.push({ sessionId, ...input });
        return true;
      },
    },
  };
};

test.beforeEach(() => {
  clearA2APeerProfileCache();
});

test('skips sessions that are not A2A private chats', async () => {
  const { coworkStore, updates } = createStoreMock(a2aSession({ sessionType: 'standard' }));
  let fetches = 0;
  const result = await refreshA2APeerProfile({
    coworkStore,
    sessionId: 'session-1',
    fetchProfile: async () => {
      fetches += 1;
      return { name: 'WuFenGBot', avatar: 'metafile://new' };
    },
  });
  assert.deepEqual(result, { refreshed: false, changed: false });
  assert.equal(fetches, 0);
  assert.equal(updates.length, 0);
});

test('updates the stored peer profile when the latest chain profile differs', async () => {
  const session = a2aSession();
  const { coworkStore, updates } = createStoreMock(session);
  const result = await refreshA2APeerProfile({
    coworkStore,
    sessionId: session.id,
    fetchProfile: async () => ({ name: 'WuFenGBot', avatar: 'metafile://new-avatar' }),
  });
  assert.deepEqual(result, { refreshed: true, changed: true });
  assert.deepEqual(updates, [
    { sessionId: session.id, peerName: 'WuFenGBot', peerAvatar: 'metafile://new-avatar' },
  ]);
});

test('does not write when the latest profile matches the stored one', async () => {
  const session = a2aSession({ peerName: 'WuFenGBot', peerAvatar: 'metafile://new-avatar' });
  const { coworkStore, updates } = createStoreMock(session);
  const result = await refreshA2APeerProfile({
    coworkStore,
    sessionId: session.id,
    fetchProfile: async () => ({ name: 'WuFenGBot', avatar: 'metafile://new-avatar' }),
  });
  assert.deepEqual(result, { refreshed: true, changed: false });
  assert.equal(updates.length, 0);
});

test('never blanks stored values when the latest profile has empty fields', async () => {
  const session = a2aSession({ peerName: 'Twin Bot', peerAvatar: 'metafile://old-avatar' });
  const { coworkStore, updates } = createStoreMock(session);
  const result = await refreshA2APeerProfile({
    coworkStore,
    sessionId: session.id,
    fetchProfile: async () => ({ name: null, avatar: null }),
  });
  assert.deepEqual(result, { refreshed: true, changed: false });
  assert.equal(updates.length, 0);
});

test('serves the profile from the TTL cache instead of refetching', async () => {
  const session = a2aSession();
  const { coworkStore } = createStoreMock(session);
  let fetches = 0;
  const fetchProfile = async (): Promise<A2APeerProfile> => {
    fetches += 1;
    return { name: 'WuFenGBot', avatar: null };
  };

  await refreshA2APeerProfile({ coworkStore, sessionId: session.id, fetchProfile });
  await refreshA2APeerProfile({ coworkStore, sessionId: session.id, fetchProfile });
  assert.equal(fetches, 1);
});

test('force bypasses the TTL cache and refetches the latest profile', async () => {
  const session = a2aSession({ peerName: 'Twin Bot', peerAvatar: 'metafile://old-avatar' });
  const { coworkStore } = createStoreMock(session);
  let fetches = 0;
  // First fetch returns the old profile (so nothing changes on the first call
  // and the cache is populated within the TTL window).
  let latestName = 'Twin Bot';
  let latestAvatar = 'metafile://old-avatar';
  const fetchProfile = async (): Promise<A2APeerProfile> => {
    fetches += 1;
    return { name: latestName, avatar: latestAvatar };
  };

  await refreshA2APeerProfile({ coworkStore, sessionId: session.id, fetchProfile });
  // Peer renames on-chain after the cache was populated.
  latestName = 'WuFenGBot';
  latestAvatar = 'metafile://new-avatar';
  // Without force the TTL cache would be hit (fetches stays 1); force must bypass it.
  const result = await refreshA2APeerProfile({
    coworkStore,
    sessionId: session.id,
    fetchProfile,
    force: true,
  });
  assert.equal(fetches, 2);
  assert.deepEqual(result, { refreshed: true, changed: true });
});

test('refetches after the TTL expires', async () => {
  const session = a2aSession();
  const { coworkStore } = createStoreMock(session);
  let nowValue = 1_000_000;
  let fetches = 0;
  const fetchProfile = async (): Promise<A2APeerProfile> => {
    fetches += 1;
    return { name: 'WuFenGBot', avatar: null };
  };

  await refreshA2APeerProfile({ coworkStore, sessionId: session.id, fetchProfile, ttlMs: 1000, now: () => nowValue });
  nowValue += 1001;
  await refreshA2APeerProfile({ coworkStore, sessionId: session.id, fetchProfile, ttlMs: 1000, now: () => nowValue });
  assert.equal(fetches, 2);
});

test('a fetch failure is non-fatal and cached within the TTL', async () => {
  const session = a2aSession();
  const { coworkStore, updates } = createStoreMock(session);
  let fetches = 0;
  const fetchProfile = async (): Promise<A2APeerProfile | null> => {
    fetches += 1;
    throw new Error('network down');
  };

  const first = await refreshA2APeerProfile({ coworkStore, sessionId: session.id, fetchProfile });
  const second = await refreshA2APeerProfile({ coworkStore, sessionId: session.id, fetchProfile });
  assert.deepEqual(first, { refreshed: false, changed: false });
  assert.deepEqual(second, { refreshed: false, changed: false });
  assert.equal(fetches, 1);
  assert.equal(updates.length, 0);
});
