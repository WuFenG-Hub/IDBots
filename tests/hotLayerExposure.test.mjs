import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { getSqlJs, createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';
import {
  createDreamHarness,
  dreamJson,
  seedSession,
} from './fixtures/rrsiDreamHarness.mjs';

const require = createRequire(import.meta.url);
const {
  renderProcedureBlock,
  buildProcedureBlock,
} = require('../dist-electron/main/libs/procedurePromptBlocks.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');
const { MemoryHygieneService } = require('../dist-electron/main/services/memoryHygieneService.js');
const {
  HOT_LAYER_USAGE_RETENTION_DAYS,
} = require('../dist-electron/main/coworkStore.js');

const localDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

function loadRunnerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

// ---------------------------------------------------------------------------
// Single injection path (RRSI P2 Task 6)
// ---------------------------------------------------------------------------

test('listInjectableTechniques returns only validated, never-promoted drafts', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '已晋升技巧', description: '已经硬化成规程', capabilityType: 'workflow' },
      { title: '待晋升技巧', description: '还在注入层', capabilityType: 'workflow' },
      { title: '未验证技巧', description: '尚是草案', capabilityType: 'workflow' },
    ]);
    const drafts = coworkStore.listCapabilityDrafts(5);
    const promoted = drafts.find((draft) => draft.title === '已晋升技巧');
    const pending = drafts.find((draft) => draft.title === '待晋升技巧');
    const plain = drafts.find((draft) => draft.title === '未验证技巧');
    for (const draft of [promoted, pending]) {
      coworkStore.updateCapabilityDraftValidation({
        id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9,
      });
    }
    assert.equal(coworkStore.markCapabilityDraftPromoted({
      id: promoted.id, metabotId: 5, procedureId: 'proc-promoted-1',
    }), true);

    const injectable = coworkStore.listInjectableTechniques(5);
    assert.deepEqual(injectable.map((draft) => draft.title), ['待晋升技巧']);
    assert.equal(injectable[0].id, pending.id);
    assert.deepEqual(coworkStore.listInjectableTechniques(5, 1).map((draft) => draft.id), [pending.id], 'limit clamps');
    void plain;
  } finally {
    cleanup();
  }
});

test('runner: a promoted draft moves from <proven_techniques> to <procedures>', async () => {
  const { CoworkRunner } = loadRunnerModule();
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1_700_000_000_000);
    const runner = new CoworkRunner(coworkStore, { knowledgeStore });
    const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);

    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '已晋升技巧', description: '硬化后的做法', capabilityType: 'workflow' },
      { title: '待晋升技巧', description: '仍在注入', capabilityType: 'workflow' },
    ]);
    const drafts = coworkStore.listCapabilityDrafts(5);
    for (const draft of drafts) {
      coworkStore.updateCapabilityDraftValidation({
        id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9,
      });
    }
    const promoted = drafts.find((draft) => draft.title === '已晋升技巧');
    const promotedProcedure = knowledgeStore.upsertProcedure({
      metabotId: 5, title: '已晋升技巧', triggerText: '已晋升技巧', steps: ['硬化后的做法'], origin: 'dream',
    });
    coworkStore.markCapabilityDraftPromoted({
      id: promoted.id, metabotId: 5, procedureId: promotedProcedure.entry.id,
    });
    // A recall-only (probation) procedure: reachable by recall, never hot.
    knowledgeStore.upsertProcedure({
      metabotId: 5, title: '试用中的规程', triggerText: '当用户要求试用', steps: ['先自检'], origin: 'agent',
    });

    const block = runner.buildExperiencePromptBlocksXml(session.id);
    assert.ok(block.includes('<proven_techniques>'), 'the technique block rendered');
    assert.ok(block.includes('待晋升技巧'), 'the unpromoted validated draft is injected');
    assert.ok(block.includes('<procedures>'), 'the procedure block rendered');
    const techniquesSection = block.slice(
      block.indexOf('<proven_techniques>'),
      block.indexOf('</proven_techniques>') + '</proven_techniques>'.length,
    );
    const proceduresSection = block.slice(
      block.indexOf('<procedures>'),
      block.indexOf('</procedures>') + '</procedures>'.length,
    );
    assert.ok(!techniquesSection.includes('已晋升技巧'), 'a promoted draft never rides <proven_techniques>');
    assert.ok(proceduresSection.includes('已晋升技巧'), 'the promoted title is a procedure');
    assert.ok(!block.includes('试用中的规程'), 'a recall-only procedure appears in neither block');
  } finally {
    cleanup();
  }
});

test('renderProcedureBlock reports included ids and buildProcedureBlock matches its text', () => {
  const entry = (id, marker) => ({
    id,
    title: `规程${marker}`,
    triggerText: `当用户要求${marker}`,
    steps: [`${marker}第一步很有长度`.repeat(12)],
    pitfalls: [],
    sourcePinIds: [],
  });
  const entries = [entry('p1', '一'), entry('p2', '二'), entry('p3', '三'), { ...entry('p4', '四'), id: undefined }];
  const { text, includedIds } = renderProcedureBlock(entries, 5, 300);
  assert.ok(text.length > 0);
  assert.ok(includedIds.length < entries.length, 'the 300-char budget drops entries');
  assert.ok(!includedIds.includes(undefined), 'entries without an id are never listed');
  assert.equal(buildProcedureBlock(entries), renderProcedureBlock(entries).text, 'byte-identical to the legacy builder');
  const full = renderProcedureBlock(entries);
  assert.equal(full.text, buildProcedureBlock(entries, 5, 1800));
  assert.deepEqual(full.includedIds.filter(Boolean), ['p1', 'p2', 'p3']);
});

// ---------------------------------------------------------------------------
// Exposure ledger (RRSI P2 Task 7)
// ---------------------------------------------------------------------------

const usageRow = (db, where, params = []) => {
  const result = db.exec(`SELECT item_kind, item_id, exposure, exposure_count FROM hot_layer_usage WHERE ${where}`, params);
  const values = result[0]?.values?.[0];
  return values ? { kind: values[0], id: values[1], exposure: values[2], count: values[3] } : null;
};

const usageCount = (db) => Number(db.exec('SELECT COUNT(*) FROM hot_layer_usage')[0].values[0][0]);

test('markCapabilityDraftsInjected writes one hot technique row per day, bumping the count', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '技巧一', description: 'd', capabilityType: 'workflow' },
    ]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    const today = localDateKey(new Date());
    assert.equal(coworkStore.markCapabilityDraftsInjected([draft.id]), 1);
    assert.equal(coworkStore.markCapabilityDraftsInjected([draft.id]), 1);
    coworkStore.flushHotLayerExposureBuffer();
    const row = usageRow(db, 'metabot_id = 5 AND usage_date = ? AND item_kind = ?', [today, 'technique']);
    assert.deepEqual(row, { kind: 'technique', id: String(draft.id), exposure: 'hot', count: 2 });
    assert.equal(coworkStore.listCapabilityDrafts(5)[0].timesInjected, 2, 'the counter still bumps');
  } finally {
    cleanup();
  }
});

test('recordHotLayerExposures: hot wins over recall within a day', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const today = localDateKey(new Date());
    const written = coworkStore.recordHotLayerExposures({
      metabotId: 5,
      usageDate: today,
      items: [
        { kind: 'procedure', id: 'p-recall-then-hot', exposure: 'recall' },
        { kind: 'procedure', id: 'p-hot-then-recall', exposure: 'hot' },
        { kind: 'procedure', id: 'p-recall-only', exposure: 'recall' },
      ],
    });
    assert.equal(written, 3);
    coworkStore.recordHotLayerExposures({
      metabotId: 5,
      usageDate: today,
      items: [
        { kind: 'procedure', id: 'p-recall-then-hot', exposure: 'hot' },
        { kind: 'procedure', id: 'p-hot-then-recall', exposure: 'recall' },
      ],
    });
    coworkStore.flushHotLayerExposureBuffer();
    assert.equal(usageRow(db, "item_id = 'p-recall-then-hot'").exposure, 'hot');
    assert.equal(usageRow(db, "item_id = 'p-hot-then-recall'").exposure, 'hot', 'hot is sticky once set');
    assert.equal(usageRow(db, "item_id = 'p-recall-only'").exposure, 'recall');
  } finally {
    cleanup();
  }
});

test('runner: the hot block and the recall tool write exposure rows', async () => {
  const { CoworkRunner } = loadRunnerModule();
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1_700_000_000_000);
    const runner = new CoworkRunner(coworkStore, { knowledgeStore });
    const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);

    for (const title of ['热规程甲', '热规程乙']) {
      knowledgeStore.upsertProcedure({
        metabotId: 5, title, triggerText: `当用户要求${title}`, steps: ['一步'], origin: 'dream',
      });
    }
    const recallOnly = knowledgeStore.upsertProcedure({
      metabotId: 5, title: '查重专用规程', triggerText: '当用户要求查重', steps: ['先查重'], origin: 'agent',
    });

    const block = runner.buildExperiencePromptBlocksXml(session.id);
    assert.ok(block.includes('热规程甲'));
    coworkStore.flushHotLayerExposureBuffer();
    const today = localDateKey(new Date());
    const hotRows = db.exec(
      "SELECT item_id FROM hot_layer_usage WHERE metabot_id = 5 AND usage_date = ? AND item_kind = 'procedure' AND exposure = 'hot'",
      [today],
    )[0].values.flat();
    assert.equal(hotRows.length, 2, 'each rendered hot procedure writes one row');

    const recalled = runner.runProcedureRecallTool({ query: '查重' }, session.id);
    assert.equal(recalled.isError, false);
    coworkStore.flushHotLayerExposureBuffer();
    const recallRow = usageRow(db, "item_id = ?", [recallOnly.entry.id]);
    assert.equal(recallRow.exposure, 'recall');
    assert.equal(recallRow.kind, 'procedure');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Dream review P3: write-behind buffer (per-turn UPSERT amplification)
// ---------------------------------------------------------------------------

test('buffering: exposures are invisible until flushed, then land with accumulated counts', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const today = localDateKey(new Date());
    for (let index = 0; index < 3; index += 1) {
      coworkStore.recordHotLayerExposures({
        metabotId: 5,
        usageDate: today,
        items: [{ kind: 'procedure', id: 'p-buffered', exposure: 'hot' }],
      });
    }
    assert.equal(usageCount(db), 0, 'rows stay in the buffer until the flush');
    const flushed = coworkStore.flushHotLayerExposureBuffer();
    assert.equal(flushed, 1, 'same-day repeats coalesce into one row');
    const row = usageRow(db, "item_id = 'p-buffered'");
    assert.equal(row.count, 3, 'the flush accumulates the buffered count');
    assert.equal(row.exposure, 'hot');
    assert.equal(coworkStore.flushHotLayerExposureBuffer(), 0, 'an empty buffer flushes as zero');
  } finally {
    cleanup();
  }
});

test('buffering: hot stays sticky through the buffer, recall merges into hot', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const today = localDateKey(new Date());
    coworkStore.recordHotLayerExposures({
      metabotId: 5,
      usageDate: today,
      items: [{ kind: 'technique', id: 't-sticky', exposure: 'recall' }],
    });
    coworkStore.recordHotLayerExposures({
      metabotId: 5,
      usageDate: today,
      items: [{ kind: 'technique', id: 't-sticky', exposure: 'hot' }],
    });
    coworkStore.recordHotLayerExposures({
      metabotId: 5,
      usageDate: today,
      items: [{ kind: 'technique', id: 't-sticky', exposure: 'recall' }],
    });
    coworkStore.flushHotLayerExposureBuffer();
    assert.equal(usageRow(db, "item_id = 't-sticky'").exposure, 'hot', 'hot wins within the buffer too');
    assert.equal(usageRow(db, "item_id = 't-sticky'").count, 3);
  } finally {
    cleanup();
  }
});

test('buffering: the 200-key burst cap flushes synchronously', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const today = localDateKey(new Date());
    const items = Array.from({ length: 200 }, (_, index) => ({
      kind: 'procedure',
      id: `p-burst-${index}`,
      exposure: 'hot',
    }));
    coworkStore.recordHotLayerExposures({ metabotId: 5, usageDate: today, items });
    assert.equal(usageCount(db), 200, 'the burst cap flushed without waiting for the timer');
  } finally {
    cleanup();
  }
});

test('app cleanup drains the exposure buffer before the database closes', async () => {
  const { runAppCleanup } = await import('../dist-electron/main/services/appCleanup.js');
  let flushed = false;
  const noop = () => {};
  const asyncNoop = async () => {};
  await runAppCleanup({
    destroyTray: noop,
    stopSkillWatching: noop,
    closeMetaidRpcServer: noop,
    stopCoworkSessions: noop,
    flushHotLayerExposures: () => {
      flushed = true;
    },
    closeDshRuntime: asyncNoop,
    stopOpenAICompatProxy: asyncNoop,
    stopSkillServices: asyncNoop,
    stopIMGateways: asyncNoop,
    stopScheduler: noop,
    stopCognitiveOrchestrator: noop,
    stopDreamService: noop,
    stopProviderDiscovery: noop,
    deactivateGroupChatTasks: noop,
    log: noop,
    error: noop,
  });
  assert.equal(flushed, true, 'the shutdown path flushes buffered exposure telemetry');
});

test('a failing exposure write never breaks markCapabilityDraftsInjected', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '技巧二', description: 'd', capabilityType: 'workflow' },
    ]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    db.run('DROP TABLE hot_layer_usage');
    assert.doesNotThrow(() => coworkStore.markCapabilityDraftsInjected([draft.id]));
    assert.equal(coworkStore.listCapabilityDrafts(5)[0].timesInjected, 1, 'times_injected still bumped');
  } finally {
    cleanup();
  }
});

test('hygiene purges hot-layer usage rows past the 120-day retention', async () => {
  const now = new Date(2026, 7, 25, 10, 0);
  const { db, cleanup } = await createSqliteStore();
  try {
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key,
        chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
        role, soul, created_at, updated_at
      ) VALUES (9, 1, 'mvc-9', 'btc-9', 'doge-9', 'pub-9', 'chatpub-9', 'Bot 9', 'metaid-9', 'metaid://stub-owner', 'worker', 'test', 'role', 'soul', 1, 1)`,
    );
    const coworkStore = createCoworkStore(db);
    const DAYMS = 86_400_000;
    assert.equal(HOT_LAYER_USAGE_RETENTION_DAYS, 120);
    const oldDate = localDateKey(new Date(now.getTime() - 121 * DAYMS));
    const freshDate = localDateKey(new Date(now.getTime() - 119 * DAYMS));
    coworkStore.recordHotLayerExposures({
      metabotId: 9, usageDate: oldDate, items: [{ kind: 'technique', id: 't-old', exposure: 'hot' }],
      atMs: now.getTime() - 121 * DAYMS,
    });
    coworkStore.recordHotLayerExposures({
      metabotId: 9, usageDate: freshDate, items: [{ kind: 'technique', id: 't-fresh', exposure: 'hot' }],
      atMs: now.getTime() - 119 * DAYMS,
    });
    coworkStore.flushHotLayerExposureBuffer();
    assert.equal(usageCount(db), 2);

    const service = new MemoryHygieneService({
      coworkStore,
      metabotStore: { listMetabots: () => [{ id: 9, globalmetaid: 'metaid://stub-owner' }] },
      now: () => new Date(now),
    });
    const stats = await service.runNow();
    assert.equal(stats.counts.hotLayerUsagePurged, 1);
    assert.equal(usageCount(db), 1);
    assert.ok(getRow(db, 'SELECT item_id FROM hot_layer_usage WHERE item_id = ?', ['t-fresh']));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Footprint telemetry (RRSI P2 Task 8)
// ---------------------------------------------------------------------------

const NIGHT = '2026-08-02';

test('a night with one hot procedure reports a positive procedureBlockChars', async () => {
  const h = await createDreamHarness();
  try {
    h.knowledgeStore.upsertProcedure({
      metabotId: 5, title: '热规程丙', triggerText: '当用户要求丙', steps: ['一步'], origin: 'dream',
    });
    h.knowledgeStore.upsertProcedure({
      metabotId: 5, title: '试用规程丁', triggerText: '当用户要求丁', steps: ['两步'], origin: 'agent',
    });
    seedSession(h.coworkStore, h.db, NIGHT, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    await h.runNight(NIGHT);
    const hotLayer = h.telemetry(NIGHT)?.hotLayer;
    assert.ok(hotLayer, 'hotLayer telemetry present on the non-empty path');
    assert.equal(hotLayer.hotProcedures, 1);
    assert.equal(hotLayer.probationProcedures, 1);
    assert.equal(hotLayer.injectableTechniques, 0);
    assert.ok(hotLayer.procedureBlockChars > 0, 'one hot procedure renders a non-empty block');
    assert.equal(hotLayer.techniqueBlockChars, 0);
    assert.equal(hotLayer.exposedItems, 0, 'the dream itself does not inject');
  } finally {
    h.cleanup();
  }
});

test('a night with no hot procedures reports zero procedureBlockChars', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, NIGHT, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    await h.runNight(NIGHT);
    const hotLayer = h.telemetry(NIGHT)?.hotLayer;
    assert.ok(hotLayer, 'empty days still report the current footprint');
    assert.equal(hotLayer.hotProcedures, 0);
    assert.equal(hotLayer.procedureBlockChars, 0);
    assert.equal(hotLayer.exposedItems, 0);
  } finally {
    h.cleanup();
  }
});
