/**
 * Dream review P1 (2026-10-23), item P1-1: the hot-layer usage audit extends
 * to knowledge hot-layer entries and value_boundary / work_review memories,
 * and "injected" is separated from "applied".
 *
 * Covers:
 *   1. hot_layer_usage item_kind CHECK widening — a legacy two-kind table is
 *      rebuilt by the idempotent migration, preserving rows,
 *   2. exposure recording for the new kinds ('knowledge', 'memory'),
 *   3. end-to-end dream run: one shared audit call judges knowledge + memory
 *      items; verdicts land in hot_layer_usage; applied memory rows get
 *      user_memories.last_applied_at; telemetry carries the per-kind counts,
 *   4. knowledge cooling: ≥5 audited hot nights in the 30-day window with 0
 *      applied flips hot_eligible = 0 (≤2/night, nothing deleted, recall
 *      unaffected),
 *   5. hygiene decay reads the applied clock: a fresh last_applied_at keeps a
 *      stale-injection memory alive; prompt eviction prefers applied rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  buildHotLayerUsageAuditPrompt,
} = require('../dist-electron/main/libs/hotLayerUsageAudit.js');
const {
  buildScopedMemoryPromptBlocksDetailed,
} = require('../dist-electron/main/memory/memoryPromptBlocks.js');

const {
  createDreamHarness,
  dayStartMs,
  seedSession,
  MARKERS,
  BOT_ID,
} = await import('./fixtures/rrsiDreamHarness.mjs');

const NIGHT = '2026-08-10';

// ---------------------------------------------------------------------------
// CHECK widening migration
// ---------------------------------------------------------------------------

test('schema: a legacy two-kind hot_layer_usage table is rebuilt with the wide CHECK, rows preserved', async () => {
  const { getSqlJs } = await import('./memoryTestUtils.mjs');
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  // Simulate a pre-P1 database: the old CREATE with the two-kind CHECK.
  db.run(`
    CREATE TABLE hot_layer_usage (
      metabot_id INTEGER NOT NULL,
      usage_date TEXT NOT NULL,
      item_kind TEXT NOT NULL CHECK (item_kind IN ('technique', 'procedure')),
      item_id TEXT NOT NULL,
      exposure TEXT NOT NULL CHECK (exposure IN ('hot', 'recall')),
      first_exposed_at INTEGER NOT NULL,
      exposure_count INTEGER NOT NULL DEFAULT 1,
      applied INTEGER CHECK (applied IS NULL OR applied IN (0, 1)),
      evidence TEXT,
      audited_at INTEGER,
      PRIMARY KEY (metabot_id, usage_date, item_kind, item_id)
    );
  `);
  db.run(
    `INSERT INTO hot_layer_usage (metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count)
     VALUES (5, '2026-08-01', 'technique', '7', 'hot', 1, 3)`,
  );
  const store = new SqliteStore(db, '/tmp/p1-migration-test.sqlite');
  store.initializeTables('/tmp');
  // The widened CHECK accepts the new kinds…
  db.run(
    `INSERT INTO hot_layer_usage (metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count)
     VALUES (5, '2026-08-02', 'knowledge', 'k1', 'hot', 1, 1), (5, '2026-08-02', 'memory', 'm1', 'hot', 1, 1)`,
  );
  assert.equal(
    db.exec("SELECT COUNT(*) AS n FROM hot_layer_usage WHERE item_kind = 'technique'")[0].values[0][0],
    1,
    'legacy rows survive the rebuild',
  );
  // …and re-running the migration is a no-op (idempotent).
  store.initializeTables('/tmp');
  assert.equal(db.exec('SELECT COUNT(*) AS n FROM hot_layer_usage')[0].values[0][0], 3);
});

test('exposures: knowledge and memory kinds record into the widened ledger', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    const coworkStore = createCoworkStore(db);
    const written = coworkStore.recordHotLayerExposures({
      metabotId: BOT_ID,
      usageDate: NIGHT,
      items: [
        { kind: 'knowledge', id: 'k1', exposure: 'hot' },
        { kind: 'memory', id: 'm1', exposure: 'hot' },
        { kind: 'procedure', id: 'p1', exposure: 'recall' },
      ],
    });
    assert.equal(written, 3);
    coworkStore.flushHotLayerExposureBuffer();
    const exposures = dreamStore.listHotLayerExposures(BOT_ID, NIGHT);
    assert.deepEqual(
      exposures.map((row) => row.kind).sort(),
      ['knowledge', 'memory', 'procedure'],
    );
  } finally {
    cleanup();
  }
});

test('audit prompt renders knowledge and memory items alongside techniques/procedures', () => {
  const prompt = buildHotLayerUsageAuditPrompt({
    date: NIGHT,
    items: [
      { ref: 'knowledge:k1', kind: 'knowledge', itemId: 'k1', title: '用户喜欢的设计风格', gist: '用户喜欢的设计风格;偏好简约风。' },
      { ref: 'memory:m1', kind: 'memory', itemId: 'm1', title: '交付前先自查', gist: '交付前必须先自己验证一遍结果再回复。' },
    ],
    excerpts: [{ label: 'S1.M2', channel: 'owner', text: '已经完成了,我自查过一遍。' }],
  });
  assert.ok(prompt.user.includes('knowledge:k1'));
  assert.ok(prompt.user.includes('memory:m1'));
  assert.ok(prompt.user.includes('交付前必须先自己验证一遍结果再回复。'));
});

// ---------------------------------------------------------------------------
// End-to-end: audit extension + last_applied_at
// ---------------------------------------------------------------------------

test('dream run audits knowledge + memory exposures and stamps last_applied_at on applied memories', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, NIGHT, [
      { type: 'user', content: '视频做好了吗' },
      { type: 'assistant', content: '做好了,我按照先渲染预览再导出的流程走了一遍。', feedback: undefined },
    ]);
    const knowledge = h.knowledgeStore.upsertKnowledge({
      metabotId: BOT_ID,
      topic: '视频导出流程',
      summary: '先渲染预览确认无误再导出正式版。',
      kind: 'know_how',
    }).entry;
    // The memory is a PREVIOUS night's dream row (the night's own batch is
    // soft-deleted before the audit runs, like real injected guidance).
    const memory = h.coworkStore.createDreamUserMemory({
      metabotId: BOT_ID,
      text: '交付前必须先自己验证一遍结果再回复。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-08-09' },
    }).memory;
    h.coworkStore.recordHotLayerExposures({
      metabotId: BOT_ID,
      usageDate: NIGHT,
      items: [
        { kind: 'knowledge', id: knowledge.id, exposure: 'hot' },
        { kind: 'memory', id: memory.id, exposure: 'hot' },
      ],
    });
    h.coworkStore.flushHotLayerExposureBuffer();
    h.router.on(MARKERS.usageAudit, () => ({
      items: [
        { ref: `knowledge:${knowledge.id}`, applied: true, evidence: ['S1.M2'] },
        { ref: `memory:${memory.id}`, applied: true, evidence: ['S1.M2'] },
      ],
    }));
    await h.runNight(NIGHT);

    const knowledgeRow = getRow(
      h.db,
      "SELECT applied, audited_at FROM hot_layer_usage WHERE item_kind = 'knowledge'",
    );
    assert.equal(knowledgeRow.applied, 1);
    assert.ok(knowledgeRow.audited_at > 0);
    const memoryRow = getRow(
      h.db,
      "SELECT applied, audited_at FROM hot_layer_usage WHERE item_kind = 'memory'",
    );
    assert.equal(memoryRow.applied, 1);

    // The "was actually used" stamp — the injection touch alone never writes it.
    const appliedStamp = getRow(
      h.db,
      'SELECT last_applied_at, last_used_at FROM user_memories WHERE id = ?',
      [memory.id],
    );
    assert.ok(appliedStamp.last_applied_at > 0, 'applied verdict stamps last_applied_at');

    const audit = h.telemetry(NIGHT)?.usageAudit;
    assert.equal(audit.knowledgeItems, 1);
    assert.equal(audit.knowledgeApplied, 1);
    assert.equal(audit.memoryItems, 1);
    assert.equal(audit.memoryApplied, 1);
    assert.equal(audit.items, 2);
    assert.equal(audit.applied, 2);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Knowledge cooling
// ---------------------------------------------------------------------------

test('knowledge cooling: 5+ audited hot nights with 0 applied flips hot_eligible (≤2/night, recall unaffected)', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, NIGHT, [
      { type: 'user', content: '在吗' },
      { type: 'assistant', content: '在的' },
    ]);
    const stale = h.knowledgeStore.upsertKnowledge({
      metabotId: BOT_ID,
      topic: '老旧做法',
      summary: '一条早就不用的做法。',
      kind: 'know_how',
    }).entry;
    const fresh = h.knowledgeStore.upsertKnowledge({
      metabotId: BOT_ID,
      topic: '现行做法',
      summary: '现在一直在用的做法。',
      kind: 'know_how',
    }).entry;
    // The stale entry entered the hot pool long ago; the fresh one is new.
    const oldMs = dayStartMs(NIGHT) - 20 * 86_400_000;
    h.db.run('UPDATE metaid_knowledge_entries SET updated_at = ? WHERE id = ?', [oldMs, stale.id]);
    // Five audited hot nights in the trailing 30-day window, applied on none.
    for (let offset = 6; offset >= 2; offset -= 1) {
      const date = new Date(dayStartMs(NIGHT) - offset * 86_400_000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      h.coworkStore.recordHotLayerExposures({
        metabotId: BOT_ID,
        usageDate: key,
        items: [{ kind: 'knowledge', id: stale.id, exposure: 'hot' }],
      });
      h.coworkStore.flushHotLayerExposureBuffer();
      h.dreamStore.recordHotLayerUsageVerdicts(BOT_ID, key, [
        { kind: 'knowledge', itemId: stale.id, applied: false, evidence: { labels: [], channels: [] } },
      ], dayStartMs(key) + 1000);
    }
    await h.runNight(NIGHT);

    const staleRow = h.knowledgeStore.getKnowledge(stale.id);
    const freshRow = h.knowledgeStore.getKnowledge(fresh.id);
    assert.equal(staleRow.hotEligible, false, 'stale knowledge cooled out of the hot pool');
    assert.equal(freshRow.hotEligible, true, 'fresh knowledge untouched (inside grace)');
    // Nothing deleted: plain recall still returns both.
    const recalled = h.knowledgeStore.listKnowledge({ metabotId: BOT_ID, status: 'active', limit: 50 });
    assert.ok(recalled.some((entry) => entry.id === stale.id), 'cooled entry stays recallable');
    // …but the hot pool filter excludes it.
    const hotPool = h.knowledgeStore.listKnowledge({ metabotId: BOT_ID, status: 'active', limit: 50, hotEligibleOnly: true });
    assert.ok(!hotPool.some((entry) => entry.id === stale.id), 'cooled entry leaves the hot pool');
    assert.ok(hotPool.some((entry) => entry.id === fresh.id));
    assert.equal(h.telemetry(NIGHT)?.knowledgeCooling?.cooled, 1, 'cooling count lands in telemetry');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Applied-clock semantics: hygiene decay + prompt eviction
// ---------------------------------------------------------------------------

test('hygiene decay reads the applied clock: a fresh last_applied_at keeps a stale-injection memory alive', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const old = 1_000_000;
    const recent = Date.now();
    const applied = coworkStore.createDreamUserMemory({
      metabotId: BOT_ID,
      text: '被用上的准则',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-08-01' },
    });
    const neglected = coworkStore.createDreamUserMemory({
      metabotId: BOT_ID,
      text: '被注入但没用的准则',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-08-01' },
    });
    db.run('UPDATE user_memories SET updated_at = ?, last_used_at = ? WHERE id = ?', [old, old, applied.memory.id]);
    db.run('UPDATE user_memories SET updated_at = ?, last_used_at = ? WHERE id = ?', [old, old, neglected.memory.id]);
    db.run('UPDATE user_memories SET last_applied_at = ? WHERE id = ?', [recent, applied.memory.id]);

    const archived = coworkStore.archiveDecayedDreamMemories({ cutoffMs: old + 1000, archivedAt: recent });
    const archivedIds = db.exec('SELECT id FROM user_memories WHERE archived_at IS NOT NULL')[0]?.values?.map((row) => row[0]) ?? [];
    assert.ok(!archivedIds.includes(applied.memory.id), 'fresh applied stamp survives the decay cutoff');
    assert.ok(archivedIds.includes(neglected.memory.id), 'stale injection-only memory still decays');
    assert.equal(archived, archivedIds.length);
  } finally {
    cleanup();
  }
});

test('prompt eviction prefers the applied memory over the merely-injected one', () => {
  const recent = 5_000;
  const old = 1_000;
  const applied = {
    id: 'm-applied',
    text: '乙'.repeat(1600),
    usageClass: 'value_boundary',
    updatedAt: old,
    lastUsedAt: old,
    lastAppliedAt: recent,
    importance: 0.5,
  };
  const injectedOnly = {
    id: 'm-injected',
    text: '甲'.repeat(1600),
    usageClass: 'work_review',
    updatedAt: old,
    lastUsedAt: old,
    lastAppliedAt: null,
    importance: 0.5,
  };
  // Equal importance, equal injection clock: only the applied stamp differs —
  // the eviction tie-break (lastAppliedAt ?? lastUsedAt ?? updatedAt) must
  // keep the applied row and evict the injected-only one.
  const { xml, injectedIds } = buildScopedMemoryPromptBlocksDetailed({
    // 'cowork_ui' is the owner-channel here — anything else is external and
    // owner memories never render.
    channel: 'cowork_ui',
    ownerEntries: [injectedOnly, applied],
    maxOwnerEntries: 2,
    maxScopedEntries: 2,
    maxTotalChars: 2000,
  });
  assert.ok(xml.includes('乙'.repeat(1600)), 'the applied memory survives the char budget');
  assert.ok(!xml.includes('甲'.repeat(1600)), 'the merely-injected memory is evicted first');
  assert.deepEqual(injectedIds, ['m-applied']);
});


test('review Minor 1: knowledge_recall records exposure rows and cooled knowledge re-enters on applied evidence', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  try {
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key,
        chat_public_key, name, metaid, metabot_type, created_by, role, soul, created_at, updated_at
      ) VALUES (5, 1, 'mvc-5', 'btc-5', 'doge-5', 'pub-5', 'chat-5', '小火', 'metaid-5', 'worker', 'test', 'role', 'soul', 1, 1)`,
    );
    const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');
    const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1_800_000_000_000);
    const entry = knowledgeStore.upsertKnowledge({
      metabotId: 5, topic: '回流知识点', summary: '被冷却后靠 recall 应用回流。', kind: 'know_how',
    }).entry;
    // Cool it out of the hot pool, then record two applied recall nights.
    knowledgeStore.setKnowledgeHotEligibility(entry.id, { eligible: false });
    for (const offset of [3, 2]) {
      const date = new Date(Date.now() - offset * 86_400_000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      coworkStore.recordHotLayerExposures({
        metabotId: 5, usageDate: key,
        items: [{ kind: 'knowledge', id: entry.id, exposure: 'recall' }],
      });
      coworkStore.flushHotLayerExposureBuffer();
      dreamStore.recordHotLayerUsageVerdicts(5, key, [
        { kind: 'knowledge', itemId: entry.id, applied: true, evidence: { labels: [], channels: [] } },
      ], Date.now());
    }
    // The re-entry rule lives in the dream pass; assert the pieces it reads:
    // the exposure rows are there (recall accounting) and the candidate list
    // exposes the cooled entry.
    const rows = db.exec("SELECT COUNT(*) FROM hot_layer_usage WHERE item_kind = 'knowledge' AND exposure = 'recall'")[0].values[0][0];
    assert.equal(rows, 2, 'recall exposure rows land in the ledger');
    const cooled = knowledgeStore.listCooledKnowledge(5);
    assert.ok(cooled.some((row) => row.id === entry.id), 'the cooled entry is a re-entry candidate');
    const stats = dreamStore.listHotLayerUsageStats(5, {
      kind: 'knowledge',
      sinceDate: new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10),
      untilDate: new Date().toISOString().slice(0, 10),
    });
    assert.ok((stats.get(entry.id)?.appliedNights ?? 0) >= 2, 'applied nights feed the re-entry rule');
  } finally {
    cleanup();
  }
});


test('review Minor 4: per-kind quotas keep knowledge and memory auditable under a technique flood', async () => {
  const h = await createDreamHarness();
  const D = '2026-08-10';
  try {
    seedSession(h.coworkStore, h.db, D, [
      { type: 'user', content: '视频做好了吗' },
      { type: 'assistant', content: '做好了,按照先渲染预览再导出的流程走了一遍。' },
    ]);
    // Twenty hot technique/procedure exposures crowd the day.
    for (let index = 0; index < 20; index += 1) {
      const draft = h.coworkStore.insertCapabilityDraftsChecked(h.coworkStore ? 5 : 5, '2026-08-01', [
        { title: `技巧 ${index}`, description: 'd', capabilityType: 'skill' },
      ]);
      h.db.run('UPDATE capability_drafts SET status = ? WHERE id = ?', ['validated', draft.insertedIds[0]]);
      h.coworkStore.recordHotLayerExposures({
        metabotId: BOT_ID,
        usageDate: D,
        items: [{ kind: 'technique', id: String(draft.insertedIds[0]), exposure: 'hot' }],
      });
    }
    const knowledge = h.knowledgeStore.upsertKnowledge({
      metabotId: BOT_ID, topic: '视频导出流程', summary: '先渲染预览确认无误再导出正式版。', kind: 'know_how',
    }).entry;
    const memory = h.coworkStore.createDreamUserMemory({
      metabotId: BOT_ID,
      text: '交付前必须先自己验证一遍结果再回复。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
      isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-08-09' },
    }).memory;
    h.coworkStore.recordHotLayerExposures({
      metabotId: BOT_ID,
      usageDate: D,
      items: [
        { kind: 'knowledge', id: knowledge.id, exposure: 'hot' },
        { kind: 'memory', id: memory.id, exposure: 'hot' },
      ],
    });
    h.coworkStore.flushHotLayerExposureBuffer();
    h.router.on(MARKERS.usageAudit, () => ({ items: [] }));
    await h.runNight(D);
    const audit = h.telemetry(D)?.usageAudit;
    assert.equal(audit.knowledgeItems, 1, 'knowledge keeps an audit seat despite the flood');
    assert.equal(audit.memoryItems, 1, 'memory keeps an audit seat despite the flood');
    assert.ok(audit.items <= 16, 'the hard cap still holds');
  } finally {
    h.cleanup();
  }
});
