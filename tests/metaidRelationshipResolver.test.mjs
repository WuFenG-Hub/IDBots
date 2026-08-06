import test from 'node:test';
import assert from 'node:assert/strict';

let normalizeGlobalMetaID;
let isGlobalMetaID;
let requireGlobalMetaID;
let MetaIDRelationshipResolver;
try {
  ({ normalizeGlobalMetaID, isGlobalMetaID, requireGlobalMetaID } =
    await import('../dist-electron/main/shared/globalMetaId.js'));
  ({ MetaIDRelationshipResolver } = await import('../dist-electron/main/services/metaidRelationshipResolver.js'));
} catch {
  ({ normalizeGlobalMetaID, isGlobalMetaID, requireGlobalMetaID } =
    await import('../dist-electron/shared/globalMetaId.js'));
  ({ MetaIDRelationshipResolver } = await import('../dist-electron/services/metaidRelationshipResolver.js'));
}

const TWIN = 'idq1twin';
const WORKER = 'idq1worker';
const BOSS = 'idq1boss';
const PEER = 'idq1peer';

test('GlobalMetaID normalization is canonical, opaque, and rejects legacy wrappers', () => {
  assert.equal(normalizeGlobalMetaID(`  ${TWIN.toUpperCase()}  `), TWIN);
  assert.equal(normalizeGlobalMetaID('metaid:idq1wrapped'), null);
  assert.equal(normalizeGlobalMetaID('metaid-worker'), null);
  assert.equal(normalizeGlobalMetaID(null), null);
  assert.equal(isGlobalMetaID(TWIN), true);
  assert.equal(isGlobalMetaID('gmid-twin'), false);
  assert.equal(requireGlobalMetaID(TWIN), TWIN);
  assert.throws(() => requireGlobalMetaID(''), /GlobalMetaID is missing or invalid/);
});

function createResolver({ friendProvider, now = 1234 } = {}) {
  const metabots = [
    { id: 2, globalmetaid: WORKER, metabot_type: 'worker', boss_global_metaid: BOSS },
    { id: 1, globalmetaid: TWIN, metabot_type: 'twin', boss_global_metaid: BOSS },
  ];
  return new MetaIDRelationshipResolver({
    listMetabots: () => metabots,
    friendProvider,
    now: () => now,
  });
}

test('worker receives authoritative Boss and machine Twin facts', () => {
  const resolver = createResolver();
  assert.deepEqual(resolver.getHardRelationships(WORKER), [
    {
      observerGlobalMetaID: WORKER,
      subjectGlobalMetaID: BOSS,
      relationship: 'boss',
      source: 'local_metabots',
      authoritative: true,
    },
    {
      observerGlobalMetaID: WORKER,
      subjectGlobalMetaID: TWIN,
      relationship: 'twin',
      source: 'local_metabots',
      authoritative: true,
    },
  ]);
  assert.deepEqual(resolver.getHardRelationships(WORKER, TWIN).map((fact) => fact.relationship), ['twin']);
  assert.deepEqual(resolver.getHardRelationships(TWIN), [
    {
      observerGlobalMetaID: TWIN,
      subjectGlobalMetaID: BOSS,
      relationship: 'boss',
      source: 'local_metabots',
      authoritative: true,
    },
  ]);
});

test('unknown observer or malformed relationship IDs produce no hard facts', () => {
  const resolver = createResolver();
  assert.deepEqual(resolver.getHardRelationships('gmid-worker'), []);
  assert.deepEqual(resolver.getHardRelationships(WORKER, 'gmid-twin'), []);
});

test('Friend provider states are current tri-state facts', async () => {
  const calls = [];
  const resolver = createResolver({
    friendProvider: {
      async resolveFriendStatus(input) {
        calls.push(input);
        return 'confirmed';
      },
    },
    now: 5678,
  });
  assert.deepEqual(await resolver.resolveFriend(WORKER, PEER), {
    observerGlobalMetaID: WORKER,
    subjectGlobalMetaID: PEER,
    relationship: 'friend',
    status: 'confirmed',
    source: 'friend_api',
    authoritative: true,
    checkedAt: 5678,
  });
  assert.deepEqual(calls, [{ firstGlobalMetaID: WORKER, secondGlobalMetaID: PEER }]);
});

test('Friend provider failure and absent provider resolve to unknown, never not_confirmed', async () => {
  const failing = createResolver({
    friendProvider: {
      async resolveFriendStatus() {
        throw new Error('indexer unavailable');
      },
    },
    now: 9876,
  });
  assert.equal((await failing.resolveFriend(WORKER, PEER)).status, 'unknown');
  assert.equal((await createResolver().resolveFriend(WORKER, PEER)).status, 'unknown');
});
