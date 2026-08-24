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

test('dream-shaped collaborationFacts survive snapshot rebuild', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const experience = new MetaIDExperienceStore(db, () => {}, () => 1_800_000_000_000);
    const impressions = new MetaIDImpressionStore(db, () => {}, () => 1_800_000_000_000);
    const source = createEvidence(experience, {
      sourceKey: 'episode:dream-fact',
      occurredAt: 1_700_000_020_000,
    });
    impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      episodeId: source.episode.id,
      evidenceIds: [source.evidence.id],
      observationText: 'Closed the intro task together.',
      interpretationText: 'Reliable content collaborator.',
      dimensions: {
        subjectKind: 'collaborator',
        capabilityTags: ['content'],
        collaborationFacts: [{
          pinId: source.evidence.pinId,
          taskTitle: '技能介绍',
          outcome: 'done',
          taskId: 21,
        }],
      },
      communicationGuidance: 'Give a clear brief.',
      confidence: { uncertainty: 'One task.' },
      dreamDate: '2026-08-08',
      dreamVersion: 10,
      sourceHash: sha('c'),
    });
    const snapshot = impressions.rebuildSnapshot(OWNER, SUBJECT);
    assert.equal(snapshot.collaborationFacts.length, 1);
    assert.equal(snapshot.collaborationFacts[0].taskId, 21);
    assert.equal(snapshot.collaborationFacts[0].title, '技能介绍');
    assert.equal(snapshot.collaborationFacts[0].outcome, 'done');
    assert.deepEqual(snapshot.collaborationFacts[0].pinIds, [source.evidence.pinId]);
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

const OLD_TS = 1_700_000_000_000;
const RECENT_TS = 1_800_000_000_000;
const THIRTY_DAYS_MS = 30 * 86_400_000;

const setupCompactionPair = async (owner, subject, seeds) => {
  const db = await createLegacyMemoryDb();
  ensureMetaIDImpressionSchema(db);
  let now = OLD_TS;
  const experience = new MetaIDExperienceStore(db, () => {}, () => now);
  const impressions = new MetaIDImpressionStore(db, () => {}, () => now);
  for (const [index, seed] of seeds.entries()) {
    now = seed.recent ? RECENT_TS + index * 1_000 : OLD_TS + index * 1_000;
    const source = createEvidence(experience, {
      owner,
      subject,
      sourceKey: `compaction:${owner}:${index}`,
      occurredAt: now,
    });
    impressions.appendObservation({
      observerGlobalMetaID: owner,
      subjectGlobalMetaID: subject,
      episodeId: source.episode.id,
      evidenceIds: [source.evidence.id],
      observationText: `raw ${seed.source}`,
      interpretationText: `interp ${seed.source}`,
      dimensions: { styleDescriptors: [`style-${seed.source}`] },
      dreamDate: seed.recent ? '2027-01-10' : `2023-11-${String(index + 1).padStart(2, '0')}`,
      dreamVersion: 1,
      sourceHash: seed.source.repeat(64),
    });
  }
  return { db, impressions, experience };
};

test('compactObservations supersedes stale observations beyond anchors and rebuilds the snapshot', async () => {
  const { db, impressions } = await setupCompactionPair(OWNER, SUBJECT, [
    { source: 'a' }, { source: 'b' }, { source: 'c' }, { source: 'd' }, { source: 'e' },
    { source: 'f', recent: true }, { source: '9', recent: true },
  ]);
  try {
    const snapshotBefore = impressions.rebuildSnapshot(OWNER, SUBJECT);
    assert.equal(impressions.listObservations({ observerGlobalMetaID: OWNER, subjectGlobalMetaID: SUBJECT }).length, 7);

    const result = impressions.compactObservations({
      cutoffMs: RECENT_TS - THIRTY_DAYS_MS,
      anchorsPerPair: 2,
    });
    assert.equal(result.pairsCompacted, 1);
    assert.equal(result.observationsSuperseded, 5);
    assert.equal(result.snapshotsRebuilt, 1);

    const active = impressions.listObservations({ observerGlobalMetaID: OWNER, subjectGlobalMetaID: SUBJECT });
    assert.deepEqual(active.map((observation) => observation.interpretationText), ['interp 9', 'interp f']);
    const all = impressions.listObservations({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      includeSuperseded: true,
    });
    assert.equal(all.length, 7, 'superseded rows are retained, never deleted');

    const snapshot = impressions.getSnapshot(OWNER, SUBJECT);
    assert.ok(snapshot, 'snapshot survives compaction as the compressed state');
    assert.equal(snapshot.latestObservationId, snapshotBefore.latestObservationId);
    assert.deepEqual(snapshot.styleDescriptors, ['style-f', 'style-9']);
    assert.equal(snapshot.summaryText, 'interp 9');

    // Idempotent: a second pass with the same policy has nothing left to do.
    const again = impressions.compactObservations({
      cutoffMs: RECENT_TS - THIRTY_DAYS_MS,
      anchorsPerPair: 2,
    });
    assert.equal(again.pairsCompacted, 0);
    assert.equal(again.observationsSuperseded, 0);
  } finally {
    db.close();
  }
});

test('compactObservations keeps at least one anchor so the snapshot never loses its latest row', async () => {
  const { db, impressions } = await setupCompactionPair(OWNER, SUBJECT, [
    { source: 'a' }, { source: 'b' },
  ]);
  try {
    impressions.rebuildSnapshot(OWNER, SUBJECT);
    const result = impressions.compactObservations({
      cutoffMs: RECENT_TS,
      anchorsPerPair: 0,
    });
    assert.equal(result.observationsSuperseded, 1);
    const active = impressions.listObservations({ observerGlobalMetaID: OWNER, subjectGlobalMetaID: SUBJECT });
    assert.equal(active.length, 1);
    assert.equal(active[0].interpretationText, 'interp b');
    assert.ok(impressions.getSnapshot(OWNER, SUBJECT));
  } finally {
    db.close();
  }
});

test('compactObservations leaves recent observations alone and honors excludeObservers', async () => {
  const { db, impressions, experience } = await setupCompactionPair(OWNER, SUBJECT, [
    { source: 'a' }, { source: 'b' }, { source: 'f', recent: true },
  ]);
  try {
    const otherSource = createEvidence(experience, {
      owner: OTHER_OWNER,
      subject: SUBJECT,
      sourceKey: 'compaction:other:0',
      occurredAt: OLD_TS,
    });
    impressions.appendObservation({
      observerGlobalMetaID: OTHER_OWNER,
      subjectGlobalMetaID: SUBJECT,
      episodeId: otherSource.episode.id,
      evidenceIds: [otherSource.evidence.id],
      observationText: 'excluded raw',
      interpretationText: 'excluded interp',
      dreamDate: '2023-11-01',
      dreamVersion: 1,
      sourceHash: 'f'.repeat(64),
    });
    const result = impressions.compactObservations({
      cutoffMs: RECENT_TS - THIRTY_DAYS_MS,
      anchorsPerPair: 1,
      excludeObservers: new Set([OTHER_OWNER]),
    });
    assert.equal(result.pairsCompacted, 1);
    assert.equal(result.observationsSuperseded, 2, 'both stale rows go; the recent row is the anchor');
    assert.equal(
      impressions.listObservations({ observerGlobalMetaID: OTHER_OWNER, subjectGlobalMetaID: SUBJECT }).length,
      1,
      'excluded observer pair untouched',
    );
  } finally {
    db.close();
  }
});

test('reputation temperature distills outcomes deterministically with recency weighting', async () => {
  const db = await createLegacyMemoryDb();
  ensureMetaIDImpressionSchema(db);
  try {
    assert.ok(getColumns(db, 'metaid_impression_snapshots').includes('reputation_score'));
    assert.ok(getColumns(db, 'metaid_impression_snapshots').includes('reputation_samples'));

    let now = OLD_TS;
    const experience = new MetaIDExperienceStore(db, () => {}, () => now);
    const impressions = new MetaIDImpressionStore(db, () => {}, () => now);
    const seedOutcome = (index, source, dimensions) => {
      now = OLD_TS + index * 10_000;
      const evidenceRow = createEvidence(experience, {
        sourceKey: `reputation:${index}`,
        occurredAt: now,
      });
      impressions.appendObservation({
        observerGlobalMetaID: OWNER,
        subjectGlobalMetaID: SUBJECT,
        episodeId: evidenceRow.episode.id,
        evidenceIds: [evidenceRow.evidence.id],
        observationText: `raw ${source}`,
        interpretationText: `interp ${source}`,
        dimensions,
        dreamDate: `2023-11-${String(index + 1).padStart(2, '0')}`,
        dreamVersion: 1,
        sourceHash: source.repeat(64),
      });
    };
    seedOutcome(0, 'a', { collaborationFacts: [{ taskId: 1, title: 'task one', outcome: 'rejected', pinIds: ['pin-1'], at: OLD_TS + 1 }] });
    seedOutcome(1, 'b', { collaborationFacts: [{ taskId: 2, title: 'task two', outcome: 'accepted', pinIds: ['pin-2'], at: OLD_TS + 2 }] });
    seedOutcome(2, 'c', { deliverablesAccepted: 3, deliverablesRejected: 1 });
    seedOutcome(3, 'd', { deliverablesAccepted: 2, deliverablesRejected: 0 });

    const snapshot = impressions.rebuildSnapshot(OWNER, SUBJECT);
    // Samples ordered by time: fact(rejected,0) -> fact(accepted,1) -> stats(0.75) -> stats(1.0).
    // EWMA alpha .3 from .5: .35 -> .545 -> .6065 -> .72455 → 72.5 (rounded to one decimal).
    assert.equal(snapshot.reputationSamples, 4);
    assert.equal(snapshot.reputationScore, 72.5);
    assert.ok(snapshot.reputationUpdatedAt > 0);
  } finally {
    db.close();
  }
});

test('reputation temperature stays null before any outcome sample', async () => {
  const db = await createLegacyMemoryDb();
  ensureMetaIDImpressionSchema(db);
  try {
    let now = OLD_TS;
    const experience = new MetaIDExperienceStore(db, () => {}, () => now);
    const impressions = new MetaIDImpressionStore(db, () => {}, () => now);
    const evidenceRow = createEvidence(experience, { sourceKey: 'reputation:none', occurredAt: now });
    impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: SUBJECT,
      episodeId: evidenceRow.episode.id,
      evidenceIds: [evidenceRow.evidence.id],
      observationText: 'plain note',
      interpretationText: 'no collaboration outcome here',
      dimensions: { styleDescriptors: ['concise'] },
      dreamDate: '2023-11-01',
      dreamVersion: 1,
      sourceHash: 'e'.repeat(64),
    });
    const snapshot = impressions.rebuildSnapshot(OWNER, SUBJECT);
    assert.equal(snapshot.reputationScore, null);
    assert.equal(snapshot.reputationSamples, 0);
    assert.equal(snapshot.reputationUpdatedAt, null);
  } finally {
    db.close();
  }
});
