import test from 'node:test';
import assert from 'node:assert/strict';

import { createLegacyMemoryDb } from './memoryTestUtils.mjs';

let MetaIDExperienceStore;
let MetaIDImpressionStore;
let MetaIDRelationshipResolver;
let MetaIDCognitionContextService;
let renderMetaIDCognitionPromptBlock;
try {
  ({ MetaIDExperienceStore } = await import('../dist-electron/main/metaidExperienceStore.js'));
  ({ MetaIDImpressionStore } = await import('../dist-electron/main/metaidImpressionStore.js'));
  ({ MetaIDRelationshipResolver } = await import('../dist-electron/main/services/metaidRelationshipResolver.js'));
  ({ MetaIDCognitionContextService, renderMetaIDCognitionPromptBlock } =
    await import('../dist-electron/main/services/metaidCognitionContext.js'));
} catch {
  ({ MetaIDExperienceStore } = await import('../dist-electron/metaidExperienceStore.js'));
  ({ MetaIDImpressionStore } = await import('../dist-electron/metaidImpressionStore.js'));
  ({ MetaIDRelationshipResolver } = await import('../dist-electron/services/metaidRelationshipResolver.js'));
  ({ MetaIDCognitionContextService, renderMetaIDCognitionPromptBlock } =
    await import('../dist-electron/services/metaidCognitionContext.js'));
}

const OWNER = 'idq1worker';
const TWIN = 'idq1twin';
const BOSS = 'idq1boss';
const PEER = 'idq1peer';

function sha(char) {
  return char.repeat(64);
}

function createInteraction(experience, {
  episodeType = 'direct_interaction',
  sourceKey,
  occurredAt = 1_700_000_000_000,
} = {}) {
  const episode = experience.createEpisode({
    ownerGlobalMetaID: OWNER,
    episodeType,
    sourceChannel: 'test',
    sourceKey: sourceKey ?? `episode:${episodeType}:${occurredAt}`,
    startedAt: occurredAt,
  }).episode;
  experience.addParticipant({
    episodeId: episode.id,
    globalMetaID: OWNER,
    role: 'observer',
    source: 'test',
  });
  experience.addParticipant({
    episodeId: episode.id,
    globalMetaID: PEER,
    role: 'counterparty',
    source: 'test',
  });
  const evidence = experience.addEvidence({
    episodeId: episode.id,
    evidenceType: episodeType === 'direct_interaction' ? 'message' : 'task_result',
    sourceKey: `evidence:${episode.id}`,
    pinId: `pin-${episode.id}`,
    publisherGlobalMetaID: PEER,
    contentHash: sha('a'),
    occurredAt,
  });
  return { episode, evidence };
}

function createService(experience, impressions) {
  const resolver = new MetaIDRelationshipResolver({
    listMetabots: () => [
      { id: 1, globalmetaid: TWIN, metabot_type: 'twin', boss_global_metaid: BOSS },
      { id: 2, globalmetaid: OWNER, metabot_type: 'worker', boss_global_metaid: BOSS },
    ],
  });
  return new MetaIDCognitionContextService({
    experienceStore: experience,
    impressionStore: impressions,
    relationshipResolver: resolver,
  });
}

test('context is observer-relative, excludes the current evidence, and derives first contact safely', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const experience = new MetaIDExperienceStore(db, () => {}, () => 1_800_000_000_000);
    const impressions = new MetaIDImpressionStore(db, () => {}, () => 1_800_000_000_000);
    const direct = createInteraction(experience);
    const service = createService(experience, impressions);

    const firstContact = await service.build({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: PEER,
      excludeEvidenceIds: [direct.evidence.id],
    });
    assert.equal(firstContact.contactState, 'first_contact');
    assert.equal(firstContact.interactionCount, 0);
    assert.equal(firstContact.directInteractionCount, 0);
    assert.deepEqual(firstContact.hardRelationships.map((fact) => fact.relationship), []);

    const afterMessage = await service.build({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: PEER,
    });
    assert.equal(afterMessage.contactState, 'prior_direct_interaction');
    assert.equal(afterMessage.interactionCount, 1);
    assert.equal(afterMessage.directInteractionCount, 1);
    assert.equal(afterMessage.recentEvidence[0].pinId, `pin-${direct.episode.id}`);
  } finally {
    db.close();
  }
});

test('rendered context carries hard facts, private snapshot, provenance, and no raw message text', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const experience = new MetaIDExperienceStore(db, () => {}, () => 1_800_000_000_000);
    const impressions = new MetaIDImpressionStore(db, () => {}, () => 1_800_000_000_000);
    const direct = createInteraction(experience);
    impressions.appendObservation({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: PEER,
      episodeId: direct.episode.id,
      evidenceIds: [direct.evidence.id],
      observationText: 'Peer writes concise messages.',
      interpretationText: 'Likely prefers concrete discussion.',
      dimensions: { styleDescriptors: ['concise'] },
      communicationGuidance: 'Use concrete requests.',
      confidence: { level: 'medium', uncertainty: 'Small sample.' },
      dreamDate: '2026-08-07',
      dreamVersion: 4,
      sourceHash: sha('b'),
    });
    impressions.rebuildSnapshot(OWNER, PEER);

    const service = createService(experience, impressions);
    const context = await service.build({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: PEER,
    });
    assert.deepEqual(context.hardRelationships.map((fact) => fact.relationship), []);
    const rendered = renderMetaIDCognitionPromptBlock(context);
    assert.match(rendered, /<metaid_cognition_context mode="descriptive"/);
    assert.match(rendered, /Peer GlobalMetaID: idq1peer/);
    assert.match(rendered, /Observer-owned current impression/);
    assert.match(rendered, /Use concrete requests/);
    assert.match(rendered, /authoritative relationship facts/i);
    assert.match(rendered, /Impressions are not permissions/);
    assert.match(rendered, /pinId=/);
    assert.doesNotMatch(rendered, /Peer writes concise messages/);
    assert.match(rendered, /Likely prefers concrete discussion/);

    const twinBlock = await service.buildPromptBlock({
      observerGlobalMetaID: OWNER,
      subjectGlobalMetaID: TWIN,
    });
    assert.match(twinBlock, /twin: idq1twin/);
    assert.match(twinBlock, /authoritative source=local_metabots/);
  } finally {
    db.close();
  }

  const resolver = new MetaIDRelationshipResolver({
    listMetabots: () => [
      { id: 1, globalmetaid: TWIN, metabot_type: 'twin', boss_global_metaid: BOSS },
      { id: 2, globalmetaid: OWNER, metabot_type: 'worker', boss_global_metaid: BOSS },
    ],
  });
  assert.deepEqual(resolver.getHardRelationships(OWNER, TWIN).map((fact) => fact.relationship), ['twin']);
});
