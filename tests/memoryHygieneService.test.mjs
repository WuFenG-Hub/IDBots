import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getColumns, getRow } from './memoryTestUtils.mjs';

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
    assert.equal(first.counts.memoriesArchived, 0, 'dream-memory step runs with the always-present coworkStore');
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

test('episode archival step is wired into the nightly run', async () => {
  const { MetaIDExperienceStore } = await loadExperienceStoreModule();
  const { db, cleanup } = await createSqliteStore();
  insertMetabot(db, 9, 'metaid://stub-owner');
  const coworkStore = createCoworkStore(db);
  const experience = new MetaIDExperienceStore(db, () => {}, () => 1_700_000_000_000);
  experience.createEpisode({
    ownerGlobalMetaID: 'idq1observer',
    episodeType: 'direct_interaction',
    sourceChannel: 'test',
    sourceKey: 'hygiene-episodes:old',
    status: 'completed',
    startedAt: 1_700_000_000_000,
  });
  const service = new MemoryHygieneService({
    coworkStore,
    metabotStore: { listMetabots: () => [{ id: 9, globalmetaid: 'metaid://stub-owner' }] },
    metaidExperienceStore: experience,
    now: () => new Date(2026, 7, 25, 10, 0),
  });
  try {
    const stats = await service.runNow();
    assert.equal(stats.counts.episodesArchived, 1);
    assert.equal(experience.listEpisodes({ ownerGlobalMetaID: 'idq1observer' }).length, 0, 'hot path hides the archived episode');
    assert.equal(
      experience.listEpisodes({ ownerGlobalMetaID: 'idq1observer', includeArchived: true }).length,
      1,
      'explicit recall still sees it',
    );
  } finally {
    cleanup();
  }
});

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

const MEM_OLD_TS = 1_700_000_000_000;

test('dream-memory decay archives only stale dream rows, reversibly', async () => {
  const NOW = new Date(2026, 7, 25, 10, 0).getTime();
  const { cleanup, coworkStore, db } = await setup(new Date(2026, 7, 25, 10, 0));
  try {
    const create = (overrides = {}) => coworkStore.createUserMemory({
      metabotId: 9,
      text: `memory ${Math.random().toString(36).slice(2, 8)}`,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'profile_fact',
      origin: 'dream',
      isExplicit: true,
      forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-01-01' },
      ...overrides,
    });

    const dreamOld = create();
    create(); // dream recent (updated_at = real now)
    create({ origin: 'conversation' }); // conversation-origin: never auto-archived
    const identity = create({ usageClass: 'self_identity' });
    db.run(
      'UPDATE user_memories SET updated_at = ?, last_used_at = ? WHERE id IN (?, ?, ?)',
      [MEM_OLD_TS, MEM_OLD_TS, dreamOld.id, identity.id, identity.id]
    );

    const archived = coworkStore.archiveDecayedDreamMemories({
      cutoffMs: NOW - 30 * 86_400_000,
      archivedAt: NOW,
    });
    assert.equal(archived, 1, 'only the stale dream row archives');

    const visible = coworkStore.listUserMemories({
      metabotId: 9,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      status: 'all',
      limit: 50,
    });
    assert.equal(visible.some((memory) => memory.id === dreamOld.id), false, 'archived row leaves default listings');
    assert.equal(visible.some((memory) => memory.id === identity.id), true, 'self_identity stays');

    const withArchived = coworkStore.listUserMemories({
      metabotId: 9,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      status: 'all',
      limit: 50,
      includeArchived: true,
    });
    const restoredRow = withArchived.find((memory) => memory.id === dreamOld.id);
    assert.equal(restoredRow.archivedAt, NOW);

    assert.equal(coworkStore.unarchiveUserMemories({ ids: [dreamOld.id] }), 1);
    assert.equal(
      coworkStore.listUserMemories({
        metabotId: 9,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        status: 'all',
        limit: 50,
      }).some((memory) => memory.id === dreamOld.id),
      true,
      'unarchive restores visibility'
    );
  } finally {
    cleanup();
  }
});

test('tombstone purge physically removes only aged deleted rows and their sources', async () => {
  const NOW = new Date(2026, 7, 25, 10, 0).getTime();
  const { cleanup, coworkStore, db } = await setup(new Date(2026, 7, 25, 10, 0));
  try {
    const aged = coworkStore.createUserMemory({
      metabotId: 9,
      text: 'aged tombstone',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      origin: 'conversation',
      forceNew: true,
    });
    const fresh = coworkStore.createUserMemory({
      metabotId: 9,
      text: 'fresh tombstone',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      origin: 'conversation',
      forceNew: true,
    });
    assert.equal(coworkStore.deleteUserMemory(aged.id, 9), true);
    assert.equal(coworkStore.deleteUserMemory(fresh.id, 9), true);
    db.run('UPDATE user_memories SET updated_at = ? WHERE id = ?', [MEM_OLD_TS, aged.id]);

    const purged = coworkStore.purgeDeletedMemoryTombstones({
      cutoffMs: NOW - 30 * 86_400_000,
    });
    assert.equal(purged, 1);
    assert.equal(getRow(db, 'SELECT id FROM user_memories WHERE id = ?', [aged.id]), null, 'aged tombstone physically gone');
    assert.ok(getRow(db, 'SELECT id FROM user_memory_sources WHERE memory_id = ?', [aged.id]) === null, 'its sources are gone');
    assert.ok(getRow(db, 'SELECT id FROM user_memories WHERE id = ?', [fresh.id]), 'fresh tombstone survives the grace window');
  } finally {
    cleanup();
  }
});

test('dream-memory hygiene steps are wired into the nightly run', async () => {
  const NOW = new Date(2026, 7, 25, 10, 0).getTime();
  const { cleanup, coworkStore, db } = await setup(new Date(2026, 7, 25, 10, 0));
  try {
    const stale = coworkStore.createUserMemory({
      metabotId: 9,
      text: 'stale dream memory',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
      origin: 'dream',
      isExplicit: true,
      forceNew: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-01-02' },
    });
    db.run('UPDATE user_memories SET updated_at = ?, last_used_at = ? WHERE id = ?', [MEM_OLD_TS, MEM_OLD_TS, stale.id]);

    const stats = await new MemoryHygieneService({
      coworkStore,
      metabotStore: { listMetabots: () => [{ id: 9, globalmetaid: 'metaid://stub-owner' }] },
      now: () => new Date(2026, 7, 25, 10, 0),
    }).runNow();
    assert.equal(stats.counts.memoriesArchived, 1);
    assert.equal(stats.counts.tombstonesPurged, 0);
    void NOW;
  } finally {
    cleanup();
  }
});

const loadKnowledgeStoreModule = async () => {
  try {
    return await import('../dist-electron/main/metaidKnowledgeStore.js');
  } catch {
    return import('../dist-electron/metaidKnowledgeStore.js');
  }
};

test('deep consolidation retires listed beliefs only, stamps cadence, skips within interval', async () => {
  const { MetaIDKnowledgeStore } = await loadKnowledgeStoreModule();
  const { db, cleanup } = await createSqliteStore();
  insertMetabot(db, 9, 'metaid://stub-owner');
  const coworkStore = createCoworkStore(db);
  const knowledge = new MetaIDKnowledgeStore(db, () => {});
  knowledge.upsertKnowledge({ metabotId: 9, topic: 'deploy steps', summary: 'old steps', kind: 'know_how', origin: 'agent' });
  const knowledgeId = knowledge.listKnowledgeForDream(9)[0].id;

  const boundaryIds = [];
  for (let index = 0; index < 8; index += 1) {
    boundaryIds.push(coworkStore.createUserMemory({
      metabotId: 9,
      text: `boundary rule ${index}`,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      forceNew: true,
    }).id);
  }
  // Conversation-origin rows may carry the user's explicit "remember this" —
  // the LLM retire path must never archive them.
  const conversationBoundary = coworkStore.createUserMemory({
    metabotId: 9,
    text: 'user said always double-check invoices',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    usageClass: 'value_boundary',
    origin: 'conversation',
    forceNew: true,
  }).id;
  // Age every seed row to just before the fixed snapshot clock so (a) the
  // notUsedSince guard sees them as pre-inventory and (b) they stay inside
  // the decay window — the deterministic decay step must not eat them first.
  const recentBeforeSnapshot = new Date(2026, 7, 25, 8, 0).getTime();
  db.run('UPDATE user_memories SET updated_at = ?, last_used_at = ? WHERE metabot_id = 9', [recentBeforeSnapshot, recentBeforeSnapshot]);

  const calls = [];
  const service = new MemoryHygieneService({
    coworkStore,
    metabotStore: { listMetabots: () => [{ id: 9, name: 'Twin', llm_id: null, globalmetaid: 'metaid://stub-owner' }] },
    metaidKnowledgeStore: knowledge,
    performChat: async (_system, user) => {
      calls.push(user);
      return '```json\n' + JSON.stringify({
        retire_memory_ids: [boundaryIds[0], 'bogus-memory-id', conversationBoundary],
        retire_knowledge_ids: [knowledgeId, 'bogus-knowledge-id'],
        rewrite_knowledge: [],
        notes: 'cleaned up bygone items',
      }) + '\n```';
    },
    now: () => new Date(2026, 7, 25, 10, 0),
  });
  try {
    const stats = await service.runNow();
    assert.equal(stats.counts.deepConsolidationBots, 1);
    assert.equal(stats.counts.deepRetiredMemories, 1, 'inventory-validated + dream-origin only; bogus and conversation-origin ids dropped');
    assert.equal(stats.counts.deepRetiredKnowledge, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /value_boundary/);
    assert.match(calls[0], /deploy steps/);

    const visibleBoundaries = coworkStore.listUserMemories({
      metabotId: 9,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      status: 'created',
      limit: 50,
    });
    assert.equal(visibleBoundaries.length, 8, '7 untouched + the conversation-origin survivor');
    assert.ok(
      visibleBoundaries.some((memory) => memory.id === conversationBoundary),
      'conversation-origin boundary survives the LLM retire list'
    );
    assert.equal(knowledge.listKnowledgeForDream(9).length, 0, 'the retired knowledge point is archived');

    const again = await service.runNow();
    assert.equal(again.counts.deepConsolidationBots, 0, 'cadence gate skips within the interval');
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test('deep consolidation refuses retire lists that exceed the guardrail and skips disabled bots', async () => {
  const { db, cleanup } = await createSqliteStore();
  insertMetabot(db, 9, 'metaid://stub-owner');
  const coworkStore = createCoworkStore(db);
  for (let index = 0; index < 8; index += 1) {
    coworkStore.createUserMemory({
      metabotId: 9,
      text: `boundary rule ${index}`,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      forceNew: true,
    });
  }
  const retireAllIds = coworkStore.listUserMemories({
    metabotId: 9,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    usageClass: 'value_boundary',
    status: 'created',
    limit: 50,
  }).map((memory) => memory.id);

  const calls = [];
  const service = new MemoryHygieneService({
    coworkStore,
    metabotStore: {
      listMetabots: () => [
        { id: 9, name: 'Twin', llm_id: null, globalmetaid: 'metaid://stub-owner' },
        { id: 10, name: 'Off', llm_id: null, enabled: false },
      ],
    },
    performChat: async () => {
      calls.push('called');
      return '```json\n' + JSON.stringify({
        retire_memory_ids: retireAllIds,
        retire_knowledge_ids: [],
        rewrite_knowledge: [],
        notes: 'purge everything',
      }) + '\n```';
    },
    now: () => new Date(2026, 7, 25, 10, 0),
  });
  try {
    const stats = await service.runNow();
    assert.equal(stats.counts.deepRetiredMemories, 0, 'a retire list eating the whole layer is refused');
    assert.ok(stats.errors.some((line) => line.includes('guardrail')));
    assert.equal(coworkStore.getDeepConsolidationLastRunAt(9), null, 'no cadence stamp on a refused run');
    assert.equal(calls.length, 1, 'the disabled bot never reaches the LLM');
    const visible = coworkStore.listUserMemories({
      metabotId: 9,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      status: 'created',
      limit: 50,
    });
    assert.equal(visible.length, 8);
  } finally {
    cleanup();
  }
});

test('archiveUserMemories notUsedSince guard protects rows touched during the LLM window', async () => {
  const { db, cleanup, coworkStore } = await setup(new Date(2026, 7, 25, 10, 0));
  try {
    const stale = coworkStore.createUserMemory({
      metabotId: 9,
      text: 'untouched dream memory',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
      origin: 'dream',
      forceNew: true,
    });
    const fresh = coworkStore.createUserMemory({
      metabotId: 9,
      text: 'injected-during-window memory',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
      origin: 'dream',
      forceNew: true,
    });
    // Both rows predate the inventory snapshot (but stay inside the decay
    // window); only the injection touch is newer than the snapshot.
    const recentBeforeSnapshot = new Date(2026, 7, 25, 8, 0).getTime();
    db.run('UPDATE user_memories SET updated_at = ?, last_used_at = ? WHERE metabot_id = 9', [recentBeforeSnapshot, recentBeforeSnapshot]);
    const snapshot = new Date(2026, 7, 25, 9, 59, 0).getTime();
    // The fresh row was injected (touched) AFTER the inventory snapshot.
    db.run('UPDATE user_memories SET last_used_at = ? WHERE id = ?', [snapshot + 30_000, fresh.id]);
    const archived = coworkStore.archiveUserMemories({
      ids: [stale.id, fresh.id],
      archivedAt: new Date(2026, 7, 25, 10, 0).getTime(),
      notUsedSince: snapshot,
    });
    assert.equal(archived, 1, 'the touched row survives the stale proposal');
    const survivors = coworkStore.listUserMemories({
      metabotId: 9,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
      status: 'created',
      limit: 50,
    });
    assert.ok(survivors.some((memory) => memory.id === fresh.id));
  } finally {
    cleanup();
  }
});

test('deep consolidation no-ops without performChat or with the switch off', async () => {
  const { db, cleanup } = await createSqliteStore();
  insertMetabot(db, 9, 'metaid://stub-owner');
  const coworkStore = createCoworkStore(db);
  const service = new MemoryHygieneService({
    coworkStore,
    metabotStore: { listMetabots: () => [{ id: 9, globalmetaid: 'metaid://stub-owner' }] },
    now: () => new Date(2026, 7, 25, 10, 0),
  });
  try {
    const stats = await service.runNow();
    assert.equal(stats.counts.deepConsolidationBots, undefined, 'no LLM dep means the step is skipped silently');
  } finally {
    cleanup();
  }
});
