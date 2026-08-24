import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getColumns } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadCompiled(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const loadHygieneModule = () => {
  try {
    return loadCompiled('../dist-electron/main/services/memoryHygieneService.js');
  } catch {
    return loadCompiled('../dist-electron/services/memoryHygieneService.js');
  }
};

const { MemoryHygieneService } = loadHygieneModule();

const insertMetabot = (db, id, globalMetaId) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `pub-${id}`, `chatpub-${id}`, `Bot ${id}`, `metaid-${id}`, globalMetaId]
  );
};

const setup = async (now, extraDeps = {}) => {
  const { db, cleanup } = await createSqliteStore();
  insertMetabot(db, 9, 'metaid://stub-owner');
  const coworkStore = createCoworkStore(db);
  const events = [];
  const service = new MemoryHygieneService({
    coworkStore,
    metabotStore: {
      listMetabots: () => [{ id: 9, globalmetaid: 'metaid://stub-owner' }],
    },
    emitToRenderer: (channel, payload) => events.push({ channel, payload }),
    now: () => new Date(now),
    ...extraDeps,
  });
  return { db, cleanup, coworkStore, service, events, botId: 9 };
};

test('memory hygiene config defaults, clamping and persisted roundtrip', async () => {
  const { cleanup, coworkStore } = await setup(new Date(2026, 7, 25, 10, 0));
  try {
    const defaults = coworkStore.getMemoryHygieneConfig();
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.observationRetentionDays, 90);
    assert.equal(defaults.observationAnchorsPerPair, 8);
    assert.equal(defaults.episodeArchiveDays, 180);
    assert.equal(defaults.memoryDecayDays, 180);
    assert.equal(defaults.tombstonePurgeDays, 365);
    assert.equal(defaults.knowledgeRevisionKeep, 5);
    assert.equal(defaults.dreamRunRetentionDays, 90);

    const saved = coworkStore.setMemoryHygieneConfig({
      observationRetentionDays: 1,
      episodeArchiveDays: 400,
      enabled: false,
    });
    assert.equal(saved.observationRetentionDays, 14, 'below-min values clamp up');
    assert.equal(saved.episodeArchiveDays, 400);
    assert.equal(saved.enabled, false);
    assert.equal(coworkStore.getMemoryHygieneConfig().episodeArchiveDays, 400);
  } finally {
    cleanup();
  }
});

test('per-bot hygiene policy column migrates and resolves with override + reset', async () => {
  const { cleanup, coworkStore, db, botId } = await setup(new Date(2026, 7, 25, 10, 0));
  try {
    assert.ok(getColumns(db, 'metabot_memory_policies').includes('hygiene_enabled'));

    assert.equal(coworkStore.getEffectiveMemoryPolicyForMetabot(botId).hygieneEnabled, true);
    coworkStore.setMemoryPolicyForMetabot(botId, { hygieneEnabled: false });
    assert.equal(coworkStore.getEffectiveMemoryPolicyForMetabot(botId).hygieneEnabled, false);
    // Dream policy stays untouched by the hygiene toggle.
    assert.equal(coworkStore.getEffectiveMemoryPolicyForMetabot(botId).dreamEnabled, true);

    coworkStore.deleteMemoryPolicyForMetabot(botId);
    assert.equal(coworkStore.getEffectiveMemoryPolicyForMetabot(botId).hygieneEnabled, true);
  } finally {
    cleanup();
  }
});

test('scheduled tick: before 04:00 never runs', async () => {
  const { cleanup, coworkStore, service } = await setup(new Date(2026, 7, 25, 2, 0));
  try {
    await service.tick();
    assert.equal(coworkStore.getMemoryHygieneLastRun(), null);
  } finally {
    cleanup();
  }
});

test('scheduled tick: runs once per night after 04:00 and emits status', async () => {
  const { cleanup, coworkStore, service, events } = await setup(new Date(2026, 7, 25, 4, 30));
  try {
    await service.tick();
    const first = coworkStore.getMemoryHygieneLastRun();
    assert.ok(first, 'run is persisted');
    assert.equal(first.trigger, 'scheduled');
    assert.equal(first.dateKey, '2026-08-25');
    assert.deepEqual(first.counts, {});
    assert.deepEqual(first.errors, []);
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'memoryHygiene:statusChanged');

    await service.tick();
    assert.equal(coworkStore.getMemoryHygieneLastRun().ranAt, first.ranAt, 'deduped within the same night');
  } finally {
    cleanup();
  }
});

test('scheduled tick: global disable skips without stamping the night', async () => {
  const { cleanup, coworkStore, service } = await setup(new Date(2026, 7, 25, 4, 30));
  try {
    coworkStore.setMemoryHygieneConfig({ enabled: false });
    await service.tick();
    assert.equal(coworkStore.getMemoryHygieneLastRun(), null);
    // Manual runs still work while globally disabled.
    const stats = await service.runNow();
    assert.equal(stats.trigger, 'manual');
    assert.equal(coworkStore.getMemoryHygieneLastRun().trigger, 'manual');
  } finally {
    cleanup();
  }
});

test('runNow bypasses the time gate and records manual trigger', async () => {
  const { cleanup, coworkStore, service } = await setup(new Date(2026, 7, 25, 10, 7));
  try {
    const stats = await service.runNow();
    assert.equal(stats.trigger, 'manual');
    assert.equal(stats.dateKey, '2026-08-25');
    const persisted = coworkStore.getMemoryHygieneLastRun();
    assert.equal(persisted.trigger, 'manual');
    assert.equal(persisted.dateKey, '2026-08-25');
  } finally {
    cleanup();
  }
});

test('steps run isolated: one failure never blocks the others', async () => {
  const { cleanup, coworkStore, service } = await setup(new Date(2026, 7, 25, 4, 30));
  try {
    service.steps.push(
      { name: 'healthy', run: () => ({ healthyCount: 3 }) },
      { name: 'broken', run: () => { throw new Error('boom'); } },
      { name: 'late', run: async () => ({ lateCount: 1 }) },
    );
    const stats = await service.runNow();
    assert.equal(stats.counts.healthyCount, 3);
    assert.equal(stats.counts.lateCount, 1);
    assert.equal(stats.errors.length, 1);
    assert.match(stats.errors[0], /^broken: boom$/);
  } finally {
    cleanup();
  }
});

test('resolveDisabledOwners reflects per-bot opt-out', async () => {
  const { cleanup, coworkStore, service, botId } = await setup(new Date(2026, 7, 25, 10, 0));
  try {
    assert.equal(service.resolveDisabledOwners().size, 0);
    coworkStore.setMemoryPolicyForMetabot(botId, { hygieneEnabled: false });
    const owners = service.resolveDisabledOwners();
    assert.equal(owners.size, 1);
    assert.ok(owners.has('metaid://stub-owner'));
  } finally {
    cleanup();
  }
});

const loadImpressionStoreModule = async () => {
  try {
    return await import('../dist-electron/main/metaidImpressionStore.js');
  } catch {
    return import('../dist-electron/metaidImpressionStore.js');
  }
};

const loadExperienceStoreModule = async () => {
  try {
    return await import('../dist-electron/main/metaidExperienceStore.js');
  } catch {
    return import('../dist-electron/metaidExperienceStore.js');
  }
};

test('impression compaction step is wired into the nightly run', async () => {
  const { MetaIDImpressionStore } = await loadImpressionStoreModule();
  const { MetaIDExperienceStore } = await loadExperienceStoreModule();
  const { db, cleanup } = await createSqliteStore();
  insertMetabot(db, 9, 'metaid://stub-owner');
  const coworkStore = createCoworkStore(db);
  const oldNow = 1_700_000_000_000;
  let now = oldNow;
  const experience = new MetaIDExperienceStore(db, () => {}, () => now);
  const impressions = new MetaIDImpressionStore(db, () => {}, () => now);
  for (const [index, source] of ['a', 'b', 'c'].entries()) {
    now = oldNow + index * 1_000;
    const episode = experience.createEpisode({
      ownerGlobalMetaID: 'idq1observer',
      episodeType: 'direct_interaction',
      sourceChannel: 'test',
      sourceKey: `hygiene-step:${index}`,
      startedAt: oldNow + index * 1_000,
    }).episode;
    experience.addParticipant({
      episodeId: episode.id,
      globalMetaID: 'idq1observer',
      role: 'observer',
      source: 'test',
    });
    experience.addParticipant({
      episodeId: episode.id,
      globalMetaID: 'idq1subject',
      role: 'counterparty',
      source: 'test',
    });
    const evidence = experience.addEvidence({
      episodeId: episode.id,
      evidenceType: 'message',
      sourceKey: `evidence:${episode.id}`,
      publisherGlobalMetaID: 'idq1subject',
      contentHash: source.repeat(64),
      occurredAt: oldNow + index * 1_000,
    });
    impressions.appendObservation({
      observerGlobalMetaID: 'idq1observer',
      subjectGlobalMetaID: 'idq1subject',
      episodeId: episode.id,
      evidenceIds: [evidence.id],
      observationText: `raw ${source}`,
      interpretationText: `interp ${source}`,
      dreamDate: `2023-11-0${index + 1}`,
      dreamVersion: 1,
      sourceHash: source.repeat(64),
    });
  }
  const service = new MemoryHygieneService({
    coworkStore,
    metabotStore: { listMetabots: () => [{ id: 9, globalmetaid: 'metaid://stub-owner' }] },
    metaidImpressionStore: impressions,
    now: () => new Date(2026, 7, 25, 10, 0),
  });
  try {
    coworkStore.setMemoryHygieneConfig({ observationAnchorsPerPair: 1 });
    const stats = await service.runNow();
    assert.equal(stats.counts.observationPairsCompacted, 1);
    assert.equal(stats.counts.observationsSuperseded, 2);
    assert.equal(stats.counts.observationSnapshotsRebuilt, 1);
    const active = impressions.listObservations({
      observerGlobalMetaID: 'idq1observer',
      subjectGlobalMetaID: 'idq1subject',
    });
    assert.equal(active.length, 1);
    assert.equal(active[0].interpretationText, 'interp c');
  } finally {
    cleanup();
  }
});
