import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLegacyMemoryDb,
  createSqliteStore,
  getColumns,
  getRow,
} from './memoryTestUtils.mjs';

let MetaIDExperienceStore;
let MetaIDImpressionStore;
let ensureMetaIDImpressionSchema;
try {
  ({ MetaIDExperienceStore } = await import('../dist-electron/main/metaidExperienceStore.js'));
  ({
    MetaIDImpressionStore,
    ensureMetaIDImpressionSchema,
  } = await import('../dist-electron/main/metaidImpressionStore.js'));
} catch {
  ({ MetaIDExperienceStore } = await import('../dist-electron/metaidExperienceStore.js'));
  ({
    MetaIDImpressionStore,
    ensureMetaIDImpressionSchema,
  } = await import('../dist-electron/metaidImpressionStore.js'));
}

const OWNER = 'idq1observer';
const SUBJECT = 'idq1subject';
const OTHER_OWNER = 'idq1otherowner';

function sha(char) {
  return char.repeat(64);
}

function createEvidence(experience, {
  owner = OWNER,
  subject = SUBJECT,
  episodeType = 'direct_interaction',
  sourceKey,
  occurredAt,
} = {}) {
  const episode = experience.createEpisode({
    ownerGlobalMetaID: owner,
    episodeType,
    sourceChannel: 'test',
    sourceKey: sourceKey ?? `episode:${owner}:${subject}:${occurredAt}`,
    startedAt: occurredAt,
  }).episode;
  experience.addParticipant({
    episodeId: episode.id,
    globalMetaID: owner,
    role: 'observer',
    source: 'test',
  });
  experience.addParticipant({
    episodeId: episode.id,
    globalMetaID: subject,
    role: 'counterparty',
    source: 'test',
  });
  const evidence = experience.addEvidence({
    episodeId: episode.id,
    evidenceType: 'message',
    sourceKey: `evidence:${episode.id}`,
    pinId: `pin-${episode.id}`,
    publisherGlobalMetaID: subject,
    contentHash: sha('a'),
    occurredAt,
  });
  return { episode, evidence };
}

test('impression schema is additive and idempotent on fresh and legacy stores', async () => {
  const db = await createLegacyMemoryDb();
  try {
    db.run(`INSERT INTO user_memories (id, text, fingerprint, created_at, updated_at)
      VALUES ('legacy-memory', 'keep me', 'legacy-fingerprint', 1, 1)`);
    ensureMetaIDImpressionSchema(db);
    ensureMetaIDImpressionSchema(db);
    for (const table of [
      'metaid_impression_observations',
      'metaid_impression_observation_evidence',
      'metaid_impression_snapshots',
    ]) {
      assert.ok(getColumns(db, table).length > 0, `${table} should exist`);
    }
    assert.equal(getRow(db, 'SELECT text FROM user_memories WHERE id = ?', ['legacy-memory']).text, 'keep me');
  } finally {
    db.close();
  }
});

test('observations are evidence-scoped, append-only, idempotent, and repair by superseding', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const experience = new MetaIDExperienceStore(db, () => {}, () => 1_800_000_000_000);
    const impressions = new MetaIDImpressionStore(db, () => {}, () => 1_800_000_000_000);
    const firstSource = createEvidence(experience, { sourceKey: 'episode:first', occurredAt: 1_700_000_000_000 });
    const secondSource = createEvidence(experience, { sourceKey: 'episode:second', occurredAt: 1_700_000_001_000 });
    const inaccessible = createEvidence(experience, {
      owner: OTHER_OWNER,
      sourceKey: 'episode:other-owner',
      occurredAt: 1_700_000_002_000,
    });

    const first = impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      episodeId: firstSource.episode.id,
      evidenceIds: [firstSource.evidence.id],
      observationText: 'The subject communicates precisely.',
      interpretationText: 'A careful collaborator.',
      dimensions: { styleDescriptors: ['precise'], reliability: 'unknown' },
      communicationGuidance: 'Use concrete requests.',
      confidence: { level: 'medium', uncertainty: 'Only one interaction so far.' },
      dreamDate: '2026-08-06',
      dreamVersion: 1,
      sourceHash: sha('b'),
    });
    assert.equal(first.created, true);
    assert.equal(impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      episodeId: firstSource.episode.id,
      evidenceIds: [firstSource.evidence.id],
      observationText: 'Different retry text is ignored.',
      interpretationText: 'Retry must not overwrite.',
      dreamDate: '2026-08-06',
      dreamVersion: 1,
      sourceHash: sha('b'),
    }).created, false);
    assert.throws(() => impressions.appendObservation({
      observerGlobalMetaID: OTHER_OWNER,
      subjectGlobalMetaID: SUBJECT,
      evidenceIds: [inaccessible.evidence.id],
      observationText: 'A colliding key must not cross owner scope.',
      interpretationText: 'Reject the collision.',
      idempotencyKey: first.observation.idempotencyKey,
      dreamDate: '2026-08-06',
      dreamVersion: 1,
      sourceHash: sha('b'),
    }), /another observer\/subject pair/);
    assert.throws(() => impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      evidenceIds: [inaccessible.evidence.id],
      observationText: 'Should not cross the owner boundary.',
      interpretationText: 'Should be rejected.',
      dreamDate: '2026-08-06',
      dreamVersion: 1,
      sourceHash: sha('c'),
    }), /not accessible/);
    assert.throws(() => impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: OWNER,
      evidenceIds: [firstSource.evidence.id],
      observationText: 'Self.',
      interpretationText: 'Self.',
      dreamDate: '2026-08-06',
      dreamVersion: 1,
      sourceHash: sha('d'),
    }), /Self-impressions/);

    const repair = impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      episodeId: secondSource.episode.id,
      evidenceIds: [secondSource.evidence.id],
      observationText: 'A later interaction was dependable.',
      interpretationText: 'Reliability is becoming more likely.',
      dimensions: { reliability: 'promising' },
      confidence: { level: 'high', uncertainty: 'Still a small sample.' },
      dreamDate: '2026-08-07',
      dreamVersion: 2,
      sourceHash: sha('e'),
      supersedesObservationId: first.observation.id,
    });
    assert.equal(repair.created, true);
    assert.equal(impressions.getObservation(first.observation.id).status, 'superseded');
    assert.equal(impressions.listObservations({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      includeSuperseded: true,
    }).length, 2);
    assert.equal(impressions.getObservationEvidence(repair.observation.id).length, 1);
  } finally {
    db.close();
  }
});

test('snapshot rebuild is deterministic and derives per-subject counts without a trust score', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const experience = new MetaIDExperienceStore(db, () => {}, () => 1_800_000_000_000);
    const impressions = new MetaIDImpressionStore(db, () => {}, () => 1_800_000_000_000);
    const firstSource = createEvidence(experience, { sourceKey: 'episode:direct', occurredAt: 1_700_000_000_000 });
    const secondSource = createEvidence(experience, {
      episodeType: 'task_participation',
      sourceKey: 'episode:task',
      occurredAt: 1_700_000_010_000,
    });
    const first = impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      episodeId: firstSource.episode.id,
      evidenceIds: [firstSource.evidence.id],
      observationText: 'Measured and concise.',
      interpretationText: 'Initially cautious.',
      dimensions: { styleDescriptors: ['concise'], cooperation: 'unproven' },
      communicationGuidance: 'Be specific.',
      confidence: { uncertainty: 'Small sample.' },
      dreamDate: '2026-08-06',
      dreamVersion: 1,
      sourceHash: sha('f'),
    }).observation;
    impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      episodeId: secondSource.episode.id,
      evidenceIds: [secondSource.evidence.id],
      observationText: 'The task contribution was dependable.',
      interpretationText: 'A dependable collaborator in this task.',
      dimensions: { styleDescriptors: ['dependable'], cooperation: 'promising' },
      communicationGuidance: 'Share the goal and let them execute.',
      confidence: { uncertainty: 'More evidence is still useful.' },
      dreamDate: '2026-08-07',
      dreamVersion: 1,
      sourceHash: sha('d'),
    });

    const snapshot = impressions.rebuildSnapshot(OWNER, SUBJECT);
    assert.equal(snapshot.interactionCount, 2);
    assert.equal(snapshot.directInteractionCount, 1);
    assert.equal(snapshot.firstSeenAt, 1_700_000_000_000);
    assert.equal(snapshot.lastSeenAt, 1_700_000_010_000);
    assert.equal(snapshot.summaryText, 'A dependable collaborator in this task.');
    assert.deepEqual(snapshot.styleDescriptors, ['concise', 'dependable']);
    assert.equal(snapshot.cooperationContext, 'promising');
    assert.equal(snapshot.communicationGuidance, 'Share the goal and let them execute.');
    assert.equal(snapshot.uncertaintyText, 'More evidence is still useful.');
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'trustScore'), false);
    const firstHash = snapshot.sourceHash;
    db.run('DELETE FROM metaid_impression_snapshots WHERE observer_globalmetaid = ? AND subject_globalmetaid = ?', [OWNER, SUBJECT]);
    const rebuilt = impressions.rebuildSnapshot(OWNER, SUBJECT);
    assert.deepEqual({
      firstSeenAt: rebuilt.firstSeenAt,
      lastSeenAt: rebuilt.lastSeenAt,
      interactionCount: rebuilt.interactionCount,
      directInteractionCount: rebuilt.directInteractionCount,
      summaryText: rebuilt.summaryText,
      styleDescriptors: rebuilt.styleDescriptors,
      cooperationContext: rebuilt.cooperationContext,
      communicationGuidance: rebuilt.communicationGuidance,
      uncertaintyText: rebuilt.uncertaintyText,
      latestObservationId: rebuilt.latestObservationId,
      sourceHash: rebuilt.sourceHash,
    }, {
      firstSeenAt: snapshot.firstSeenAt,
      lastSeenAt: snapshot.lastSeenAt,
      interactionCount: snapshot.interactionCount,
      directInteractionCount: snapshot.directInteractionCount,
      summaryText: snapshot.summaryText,
      styleDescriptors: snapshot.styleDescriptors,
      cooperationContext: snapshot.cooperationContext,
      communicationGuidance: snapshot.communicationGuidance,
      uncertaintyText: snapshot.uncertaintyText,
      latestObservationId: snapshot.latestObservationId,
      sourceHash: firstHash,
    });
    assert.equal(impressions.getSnapshot(OWNER, SUBJECT).latestObservationId, rebuilt.latestObservationId);
  } finally {
    db.close();
  }
});

test('SqliteStore initializes impression tables on a normal database upgrade', async () => {
  const harness = await createSqliteStore();
  try {
    for (const table of [
      'metaid_impression_observations',
      'metaid_impression_observation_evidence',
      'metaid_impression_snapshots',
    ]) {
      assert.ok(getColumns(harness.db, table).length > 0, `${table} should exist`);
    }
  } finally {
    harness.cleanup();
  }
});
