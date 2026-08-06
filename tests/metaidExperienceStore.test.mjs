import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLegacyMemoryDb,
  createSqliteStore,
  getColumns,
  getIndexNames,
} from './memoryTestUtils.mjs';

let MetaIDExperienceStore;
let ensureMetaIDExperienceSchema;
try {
  ({ MetaIDExperienceStore, ensureMetaIDExperienceSchema } =
    await import('../dist-electron/main/metaidExperienceStore.js'));
} catch {
  ({ MetaIDExperienceStore, ensureMetaIDExperienceSchema } =
    await import('../dist-electron/metaidExperienceStore.js'));
}

const OWNER = 'idq1owner';
const SUBJECT = 'idq1subject';
const PUBLISHER = 'idq1publisher';

test('SqliteStore creates the experience schema and repeated initialization is idempotent', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    for (const table of [
      'metaid_experience_episodes',
      'metaid_experience_participants',
      'metaid_experience_evidence',
    ]) {
      assert.ok(getColumns(db, table).length > 0, `missing table ${table}`);
    }
    assert.ok(getColumns(db, 'metaid_experience_episodes').includes('owner_globalmetaid'));
    assert.ok(getColumns(db, 'metaid_experience_participants').includes('unresolved_actor_key'));
    assert.ok(getColumns(db, 'metaid_experience_evidence').includes('publisher_globalmetaid'));
    assert.ok(getIndexNames(db, 'metaid_experience_episodes').includes('idx_metaid_experience_episodes_owner_time'));

    ensureMetaIDExperienceSchema(db);
    const tables = db.exec(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'metaid_experience_%'
      ORDER BY name
    `)[0].values.map((row) => row[0]).sort();
    assert.deepEqual(tables, [
      'metaid_experience_episodes',
      'metaid_experience_evidence',
      'metaid_experience_participants',
    ]);
  } finally {
    harness.cleanup();
  }
});

test('legacy databases receive additive experience tables without changing existing rows', async () => {
  const db = await createLegacyMemoryDb();
  db.run(`INSERT INTO user_memories (id, metabot_id, text, fingerprint, created_at, updated_at)
          VALUES ('legacy-memory', 1, 'keep me', 'legacy-fingerprint', 10, 10)`);
  new MetaIDExperienceStore(db, () => {}, () => 1000);

  assert.equal(db.exec("SELECT text FROM user_memories WHERE id = 'legacy-memory'")[0].values[0][0], 'keep me');
  assert.ok(getColumns(db, 'metaid_experience_episodes').length > 0);
});

test('episode, participant, and evidence writes are observer-owned and idempotent', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDExperienceStore(db, () => {}, () => 1000);

  const first = store.createEpisode({
    id: 'episode-1',
    ownerGlobalMetaID: ` ${OWNER.toUpperCase()} `,
    episodeType: 'direct_interaction',
    sourceChannel: 'metaweb_private',
    sourceKey: 'conversation:peer-1:round-1',
    sessionId: 'session-1',
    externalConversationId: 'conversation-1',
    startedAt: 900,
    metadata: { direction: 'inbound' },
  });
  assert.equal(first.created, true);
  assert.equal(first.episode.ownerGlobalMetaID, OWNER);
  assert.deepEqual(first.episode.metadata, { direction: 'inbound' });

  const duplicate = store.createEpisode({
    id: 'should-not-replace-id',
    ownerGlobalMetaID: OWNER,
    episodeType: 'direct_interaction',
    sourceChannel: 'metaweb_private',
    sourceKey: 'conversation:peer-1:round-1',
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.episode.id, 'episode-1');

  const knownParticipant = store.addParticipant({
    episodeId: first.episode.id,
    globalMetaID: SUBJECT.toUpperCase(),
    role: 'sender',
    displayName: 'Peer Bot',
    source: 'a2a_session',
  });
  assert.equal(knownParticipant.identityState, 'known');
  assert.equal(knownParticipant.globalMetaID, SUBJECT);

  const unknownParticipant = store.addParticipant({
    episodeId: first.episode.id,
    unresolvedActorKey: 'private-peer:legacy-1',
    role: 'reviewer',
    source: 'legacy_message',
  });
  assert.equal(unknownParticipant.identityState, 'unknown');
  assert.equal(unknownParticipant.unresolvedActorKey, 'private-peer:legacy-1');
  assert.equal(store.listParticipants(first.episode.id).length, 2);

  const evidence = store.addEvidence({
    episodeId: first.episode.id,
    evidenceType: 'message',
    sourceKey: 'message-1',
    pinId: 'pin-1',
    publisherGlobalMetaID: PUBLISHER,
    messageId: 'message-1',
    contentHash: 'hash-1',
    occurredAt: 950,
    metadata: { sourceChannel: 'metaweb_private' },
  });
  assert.equal(evidence.publisherGlobalMetaID, PUBLISHER);
  assert.equal(store.addEvidence({
    episodeId: first.episode.id,
    evidenceType: 'message',
    sourceKey: 'message-1',
  }).id, evidence.id);

  const filtered = store.listEpisodes({ ownerGlobalMetaID: OWNER, subjectGlobalMetaID: SUBJECT });
  assert.deepEqual(filtered.map((episode) => episode.id), ['episode-1']);
  assert.deepEqual(store.listEpisodes({ ownerGlobalMetaID: 'idq1other', subjectGlobalMetaID: SUBJECT }), []);
  assert.equal(store.listEvidence(first.episode.id)[0].id, evidence.id);

  const completed = store.updateEpisodeStatus({ episodeId: first.episode.id, status: 'completed' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.endedAt, 1000);
});

test('identity and source constraints reject guesses and malformed records', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDExperienceStore(db, () => {}, () => 1000);
  assert.throws(() => store.createEpisode({
    ownerGlobalMetaID: 'gmid-owner',
    episodeType: 'direct_interaction',
    sourceChannel: 'private',
    sourceKey: 'source-1',
  }), /ownerGlobalMetaID is missing or invalid/);
  assert.throws(() => store.createEpisode({
    ownerGlobalMetaID: OWNER,
    episodeType: 'direct_interaction',
    sourceChannel: 'private',
    sourceKey: 'source-invalid-status',
    status: 'not-a-status',
  }), /Unsupported experience episode status/);

  const { episode } = store.createEpisode({
    ownerGlobalMetaID: OWNER,
    episodeType: 'public_pin_observation',
    sourceChannel: 'chain',
    sourceKey: 'pin-source-1',
  });
  assert.throws(() => store.addParticipant({
    episodeId: episode.id,
    globalMetaID: 'gmid-subject',
    unresolvedActorKey: 'also-unknown',
    role: 'sender',
    source: 'test',
  }), /Participant GlobalMetaID is invalid/);
  assert.throws(() => store.addEvidence({
    episodeId: episode.id,
    evidenceType: 'pin',
    sourceKey: 'pin-1',
    publisherGlobalMetaID: 'gmid-publisher',
  }), /Evidence publisher GlobalMetaID is invalid/);
  assert.deepEqual(store.listEpisodes({ ownerGlobalMetaID: OWNER, subjectGlobalMetaID: 'gmid-subject' }), []);
});
