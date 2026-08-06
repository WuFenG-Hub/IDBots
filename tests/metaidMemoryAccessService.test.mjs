import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLegacyMemoryDb,
  createSqliteStore,
  getColumns,
  getIndexNames,
  getRow,
} from './memoryTestUtils.mjs';

let MetaIDExperienceStore;
let MetaIDImpressionStore;
let MetaIDMemoryGrantStore;
let ensureMetaIDMemoryGrantSchema;
let MetaIDRelationshipResolver;
let MetaIDMemoryAccessService;
try {
  ({ MetaIDExperienceStore } = await import('../dist-electron/main/metaidExperienceStore.js'));
  ({ MetaIDImpressionStore } = await import('../dist-electron/main/metaidImpressionStore.js'));
  ({
    MetaIDMemoryGrantStore,
    ensureMetaIDMemoryGrantSchema,
  } = await import('../dist-electron/main/metaidMemoryGrantStore.js'));
  ({ MetaIDRelationshipResolver } = await import('../dist-electron/main/services/metaidRelationshipResolver.js'));
  ({ MetaIDMemoryAccessService } = await import('../dist-electron/main/services/metaidMemoryAccessService.js'));
} catch {
  ({ MetaIDExperienceStore } = await import('../dist-electron/metaidExperienceStore.js'));
  ({ MetaIDImpressionStore } = await import('../dist-electron/metaidImpressionStore.js'));
  ({
    MetaIDMemoryGrantStore,
    ensureMetaIDMemoryGrantSchema,
  } = await import('../dist-electron/metaidMemoryGrantStore.js'));
  ({ MetaIDRelationshipResolver } = await import('../dist-electron/services/metaidRelationshipResolver.js'));
  ({ MetaIDMemoryAccessService } = await import('../dist-electron/services/metaidMemoryAccessService.js'));
}

const OWNER = 'idq1observer';
const SUBJECT = 'idq1subject';
const READER = 'idq1reader';
const TWIN = 'idq1twin';
const BOSS = 'idq1boss';

const NOW = 1_800_000_000_000;

function sha(char) {
  return char.repeat(64);
}

function seedSnapshot(db, { subject = SUBJECT, owner = OWNER } = {}) {
  const experience = new MetaIDExperienceStore(db, () => {}, () => NOW);
  const impressions = new MetaIDImpressionStore(db, () => {}, () => NOW);
  const episode = experience.createEpisode({
    ownerGlobalMetaID: owner,
    episodeType: 'direct_interaction',
    sourceChannel: 'test',
    sourceKey: `episode:${owner}:${subject}`,
    startedAt: NOW - 60_000,
  }).episode;
  experience.addParticipant({ episodeId: episode.id, globalMetaID: owner, role: 'observer', source: 'test' });
  experience.addParticipant({ episodeId: episode.id, globalMetaID: subject, role: 'counterparty', source: 'test' });
  const evidence = experience.addEvidence({
    episodeId: episode.id,
    evidenceType: 'message',
    sourceKey: `evidence:${episode.id}`,
    pinId: `pin-${episode.id}`,
    publisherGlobalMetaID: subject,
    contentHash: sha('a'),
    occurredAt: NOW - 60_000,
  });
  impressions.appendObservation({
    observerGlobalMetaID: owner,
    subjectGlobalMetaID: subject,
    episodeId: episode.id,
    evidenceIds: [evidence.id],
    observationText: 'The subject is dependable.',
    interpretationText: 'A dependable collaborator.',
    dimensions: { styleDescriptors: ['dependable'] },
    communicationGuidance: 'Share the goal and let them execute.',
    confidence: { level: 'medium', uncertainty: 'Small sample.' },
    dreamDate: '2026-08-07',
    dreamVersion: 4,
    sourceHash: sha('b'),
  });
  impressions.rebuildSnapshot(owner, subject);
  return { experience, impressions };
}

function createStores(db, enabled = true) {
  const grants = new MetaIDMemoryGrantStore(db, () => {}, () => NOW);
  const impressions = new MetaIDImpressionStore(db, () => {}, () => NOW);
  const experience = new MetaIDExperienceStore(db, () => {}, () => NOW);
  const service = new MetaIDMemoryAccessService({
    grantStore: grants,
    impressionStore: impressions,
    enabled,
    now: () => NOW,
  });
  return { grants, impressions, experience, service };
}

function makeGrant(grants, overrides = {}) {
  return grants.createGrant({
    resourceOwnerGlobalMetaID: OWNER,
    granteeGlobalMetaID: READER,
    subjectGlobalMetaID: SUBJECT,
    resourceType: 'snapshot',
    capabilities: ['read_summary'],
    scope: {},
    validFrom: NOW - 60_000,
    expiresAt: NOW + 60_000,
    createdByGlobalMetaID: OWNER,
    ...overrides,
  });
}

test('grant schema is additive, idempotent, and enforces ownership and capability contracts', async () => {
  const db = await createLegacyMemoryDb();
  try {
    db.run(`INSERT INTO user_memories (id, text, fingerprint, created_at, updated_at)
      VALUES ('legacy-grant', 'keep me', 'legacy-fingerprint', 1, 1)`);
    ensureMetaIDMemoryGrantSchema(db);
    ensureMetaIDMemoryGrantSchema(db);
    for (const table of ['metaid_memory_grants', 'metaid_memory_access_audit']) {
      assert.ok(getColumns(db, table).length > 0, `${table} should exist`);
    }
    assert.ok(getIndexNames(db, 'metaid_memory_access_audit').some((name) => name.includes('grant')));
    assert.equal(getRow(db, 'SELECT text FROM user_memories WHERE id = ?', ['legacy-grant']).text, 'keep me');

    const grants = new MetaIDMemoryGrantStore(db, () => {}, () => NOW);
    assert.throws(
      () => makeGrant(grants, { capabilities: ['read_secret'] }),
      /Unsupported grant capability/,
    );
    assert.throws(
      () => makeGrant(grants, { createdByGlobalMetaID: READER }),
      /Only the resource owner/,
    );
    assert.throws(
      () => makeGrant(grants, { expiresAt: NOW - 60_000 }),
      /expiresAt must be after validFrom/,
    );
    assert.throws(
      () => makeGrant(grants, { granteeGlobalMetaID: OWNER }),
      /must be different GlobalMetaIDs/,
    );

    const created = makeGrant(grants, { id: 'grant-1' });
    assert.equal(created.created, true);
    assert.equal(grants.getGrant('grant-1').capabilities.includes('read_summary'), true);
    assert.equal(makeGrant(grants, { id: 'grant-1' }).created, false, 'same id is idempotent');
    assert.equal(grants.listGrants({ granteeGlobalMetaID: READER }).length, 1);
    assert.equal(grants.revokeGrant('grant-1', OWNER), true);
    assert.equal(grants.revokeGrant('grant-1', OWNER), false, 'second revoke is a no-op');
    assert.throws(() => grants.revokeGrant('grant-1', READER), /Only the resource owner/);
  } finally {
    db.close();
  }

  const fresh = await createSqliteStore();
  try {
    for (const table of ['metaid_memory_grants', 'metaid_memory_access_audit']) {
      assert.ok(getColumns(fresh.db, table).length > 0, `${table} should exist on fresh stores`);
    }
  } finally {
    fresh.cleanup();
  }
});

test('no grant, disabled gate, and hard relationships never create implicit access', async () => {
  const db = await createLegacyMemoryDb();
  try {
    seedSnapshot(db);

    const disabled = createStores(db, false);
    const gated = await disabled.service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: READER,
      subjectGlobalMetaID: SUBJECT,
      requestId: 'req-disabled',
    });
    assert.equal(gated.allowed, false);
    assert.equal(gated.reasonCode, 'feature_disabled');
    assert.equal(disabled.grants.listAudit({ readerGlobalMetaID: READER }).length, 1);

    const enabled = createStores(db, true);
    const ungranted = await enabled.service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: READER,
      subjectGlobalMetaID: SUBJECT,
      requestId: 'req-no-grant',
    });
    assert.equal(ungranted.allowed, false);
    assert.equal(ungranted.reasonCode, 'no_grant');

    const resolver = new MetaIDRelationshipResolver({
      listMetabots: () => [
        { id: 1, globalmetaid: TWIN, metabot_type: 'twin', boss_global_metaid: BOSS },
        { id: 2, globalmetaid: OWNER, metabot_type: 'worker', boss_global_metaid: BOSS },
      ],
    });
    assert.deepEqual(
      resolver.getHardRelationships(OWNER, TWIN).map((fact) => fact.relationship),
      ['twin'],
    );
    const twinRead = await enabled.service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: TWIN,
      subjectGlobalMetaID: SUBJECT,
      requestId: 'req-twin',
    });
    assert.equal(twinRead.allowed, false);
    assert.equal(twinRead.reasonCode, 'no_grant');
    assert.equal(enabled.grants.listAudit({ readerGlobalMetaID: TWIN })[0].reasonCode, 'no_grant');
  } finally {
    db.close();
  }
});

test('valid grant allows summary-only shared reads with audit and no side effects', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const { impressions, experience, grants, service } = createStores(db, true);
    seedSnapshot(db);
    makeGrant(grants);

    const snapshotBefore = impressions.getSnapshot(OWNER, SUBJECT);
    const guardedImpressions = new Proxy(impressions, {
      get(target, property) {
        if (['listEvidence', 'appendObservation', 'rebuildSnapshot'].includes(String(property))) {
          return () => {
            throw new Error(`unexpected ${String(property)} call on read_summary path`);
          };
        }
        return target[property];
      },
    });
    const guardedService = new MetaIDMemoryAccessService({
      grantStore: grants,
      impressionStore: guardedImpressions,
      enabled: true,
      now: () => NOW,
    });

    const read = await guardedService.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: READER,
      subjectGlobalMetaID: SUBJECT,
      requestId: 'req-allowed',
    });
    assert.equal(read.allowed, true);
    assert.equal(read.reasonCode, 'allowed');
    assert.equal(read.provenance, 'shared');
    assert.equal(read.resourceType, 'snapshot');
    assert.equal(read.requestedCapability, 'read_summary');
    assert.equal(read.grantId, grants.listGrants({ granteeGlobalMetaID: READER })[0].id);
    assert.equal(read.summary, snapshotBefore.summaryText);
    assert.equal(read.snapshotUpdatedAt, snapshotBefore.updatedAt);
    assert.equal(Object.prototype.hasOwnProperty.call(read, 'evidence'), false);

    const audits = grants.listAudit({ readerGlobalMetaID: READER, grantId: read.grantId });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'allowed');
    assert.equal(audits[0].reasonCode, 'allowed');

    const snapshotAfter = impressions.getSnapshot(OWNER, SUBJECT);
    assert.equal(snapshotAfter.updatedAt, snapshotBefore.updatedAt, 'snapshot is not mutated');
    assert.equal(
      experience.listEpisodes({ ownerGlobalMetaID: READER, limit: 50 }).length,
      0,
      'shared read never creates reader interaction episodes',
    );
  } finally {
    db.close();
  }
});

test('expired, revoked, wrong-capability, scope and missing-snapshot grants deny precisely', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const { grants, service } = createStores(db, true);
    seedSnapshot(db);

    const expired = makeGrant(grants, { id: 'grant-expired', expiresAt: NOW - 1 });
    const expiredRead = await service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: READER,
      subjectGlobalMetaID: SUBJECT,
      requestId: 'req-expired',
    });
    assert.equal(expiredRead.allowed, false);
    assert.equal(expiredRead.reasonCode, 'expired');
    assert.equal(expiredRead.grantId, expired.grant.id);

    const revoked = makeGrant(grants, {
      id: 'grant-revoked',
      granteeGlobalMetaID: 'idq1reader2',
      expiresAt: NOW + 60_000,
    });
    grants.revokeGrant(revoked.grant.id, OWNER);
    const revokedRead = await service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: 'idq1reader2',
      subjectGlobalMetaID: SUBJECT,
      requestId: 'req-revoked',
    });
    assert.equal(revokedRead.reasonCode, 'revoked');

    const wrongCapability = makeGrant(grants, {
      id: 'grant-evidence-only',
      granteeGlobalMetaID: 'idq1reader3',
      capabilities: ['read_evidence_index'],
      expiresAt: NOW + 60_000,
    });
    const wrongCapabilityRead = await service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: 'idq1reader3',
      subjectGlobalMetaID: SUBJECT,
      requestId: 'req-capability',
    });
    assert.equal(wrongCapabilityRead.reasonCode, 'missing_capability');

    const scoped = makeGrant(grants, {
      id: 'grant-scoped',
      granteeGlobalMetaID: 'idq1reader4',
      scope: { conversationId: 'conv-1' },
      expiresAt: NOW + 60_000,
    });
    const scopeMismatch = await service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: 'idq1reader4',
      subjectGlobalMetaID: SUBJECT,
      scopeReference: 'conv-2',
      requestId: 'req-scope-mismatch',
    });
    assert.equal(scopeMismatch.reasonCode, 'scope_mismatch');
    const scopeMatch = await service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: 'idq1reader4',
      subjectGlobalMetaID: SUBJECT,
      scopeReference: 'conv-1',
      requestId: 'req-scope-match',
    });
    assert.equal(scopeMatch.allowed, true);

    const noSnapshot = makeGrant(grants, {
      id: 'grant-no-snapshot',
      granteeGlobalMetaID: 'idq1reader5',
      subjectGlobalMetaID: 'idq1othersubject',
      expiresAt: NOW + 60_000,
    });
    const noSnapshotRead = await service.readSharedSummary({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: 'idq1reader5',
      subjectGlobalMetaID: 'idq1othersubject',
      requestId: 'req-no-snapshot',
    });
    assert.equal(noSnapshotRead.allowed, false);
    assert.equal(noSnapshotRead.reasonCode, 'no_snapshot');
    assert.equal(noSnapshotRead.grantId, noSnapshot.grant.id);

    const reasons = grants.listAudit({ readerGlobalMetaID: READER }).map((record) => record.reasonCode);
    assert.deepEqual(reasons, ['expired']);
    assert.deepEqual(
      grants.listAudit({ readerGlobalMetaID: 'idq1reader4' }).map((record) => record.reasonCode).sort(),
      ['allowed', 'scope_mismatch'],
    );
  } finally {
    db.close();
  }
});

test('non-read_summary capabilities are denied and audited without an allowed read', async () => {
  const db = await createLegacyMemoryDb();
  try {
    const { grants, service } = createStores(db, true);
    seedSnapshot(db);
    makeGrant(grants, { id: 'grant-raw', capabilities: ['read_raw_evidence'] });

    const check = await service.checkCapability({
      resourceOwnerGlobalMetaID: OWNER,
      readerGlobalMetaID: READER,
      subjectGlobalMetaID: SUBJECT,
      capability: 'read_raw_evidence',
      requestId: 'req-raw',
    });
    assert.equal(check.allowed, false);
    assert.equal(check.reasonCode, 'capability_not_enabled');
    assert.equal(check.capability, 'read_raw_evidence');
    const audits = grants.listAudit({ readerGlobalMetaID: READER });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, 'denied');
    assert.equal(audits[0].requestedCapability, 'read_raw_evidence');
    assert.equal(audits[0].reasonCode, 'capability_not_enabled');
  } finally {
    db.close();
  }
});
