import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { getSqlJs } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);
const {
  PROCEDURE_HOT_REASONS,
  normalizeProcedureHotReason,
  buildProbationDraftDescription,
} = require('../dist-electron/main/libs/procedureProbation.js');
const { MetaIDKnowledgeStore, ensureMetaIDKnowledgeSchema } =
  require('../dist-electron/main/metaidKnowledgeStore.js');

const CLOCK = 1_700_000_000_000;

// The pre-P2 DDL of metaid_knowledge_procedures, copied verbatim from
// metaidKnowledgeStore.ts with ${ORIGINS_SQL} expanded ('agent', 'dream',
// 'user') — the shape every production database has before this phase.
const PRE_P2_PROCEDURES_DDL = `
  CREATE TABLE IF NOT EXISTS metaid_knowledge_procedures (
    id TEXT PRIMARY KEY,
    metabot_id INTEGER NOT NULL REFERENCES metabots(id),
    title TEXT NOT NULL CHECK (trim(title) <> ''),
    title_fingerprint TEXT NOT NULL CHECK (trim(title_fingerprint) <> ''),
    trigger_text TEXT NOT NULL CHECK (trim(trigger_text) <> ''),
    steps_json TEXT NOT NULL DEFAULT '[]',
    pitfalls_json TEXT NOT NULL DEFAULT '[]',
    source_pin_ids_json TEXT NOT NULL DEFAULT '[]',
    category TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.75 CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'dream', 'user')),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    last_used_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(metabot_id, title_fingerprint)
  );
`;

async function createStore() {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE metabots (id INTEGER PRIMARY KEY, name TEXT)');
  db.run("INSERT INTO metabots (id, name) VALUES (5, '小火')");
  const store = new MetaIDKnowledgeStore(db, () => {}, () => CLOCK);
  return { db, store };
}

const saveAgent = (store, title, overrides = {}) => store.upsertProcedure({
  metabotId: 5,
  title,
  triggerText: '当用户要求交付时',
  steps: ['先自检', '再交付'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Store section (RRSI P2 Task 3)
// ---------------------------------------------------------------------------

test('migration: pre-P2 procedures are grandfathered hot, idempotent schema run', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.run(PRE_P2_PROCEDURES_DDL);
  db.run(`
    INSERT INTO metaid_knowledge_procedures (
      id, metabot_id, title, title_fingerprint, trigger_text, steps_json,
      pitfalls_json, source_pin_ids_json, category, tags_json, confidence,
      status, origin, use_count, last_used_at, version, created_at, updated_at
    ) VALUES (
      'legacy-proc-1', 5, '老规程', 'fp-legacy', '当…', '["一步"]',
      '[]', '[]', NULL, '[]', 0.75, 'active', 'agent', 0, NULL, 1, 1, 1
    );
  `);
  ensureMetaIDKnowledgeSchema(db);
  ensureMetaIDKnowledgeSchema(db);
  const store = new MetaIDKnowledgeStore(db, () => {}, () => CLOCK);
  const entry = store.getProcedure('legacy-proc-1');
  assert.equal(entry.status, 'active');
  assert.equal(entry.hotEligible, true);
  assert.equal(entry.hotReason, null);
});

test('insert by origin: agent enters probation, dream is hot immediately', async () => {
  const { store } = await createStore();
  try {
    const agent = saveAgent(store, '新学规程');
    assert.equal(agent.created, true);
    assert.equal(agent.entry.hotEligible, false);
    assert.equal(agent.entry.hotReason, 'probation');
    assert.equal(agent.needsGate, true);

    const dream = store.upsertProcedure({
      metabotId: 5,
      title: '梦境规程',
      triggerText: '当…',
      steps: ['一步'],
      origin: 'dream',
    });
    assert.equal(dream.entry.hotEligible, true);
    assert.equal(dream.entry.hotSince, CLOCK);
    assert.equal(dream.needsGate, false);
  } finally {
    void store;
  }
});

test('archived resurrection closes: agent re-save re-activates on probation', async () => {
  const { store } = await createStore();
  try {
    const created = saveAgent(store, '复活的规程');
    assert.equal(store.setProcedureHotEligibility(created.entry.id, { eligible: true, reason: null }), true);
    assert.ok(store.archiveProcedureByTitle(5, '复活的规程'));
    const revived = saveAgent(store, '复活的规程');
    assert.equal(revived.created, false);
    assert.equal(revived.entry.status, 'active');
    assert.equal(revived.entry.hotEligible, false);
    assert.equal(revived.entry.hotReason, 'probation');
  } finally {
    void store;
  }
});

test('a hot procedure revised by agent stays hot with its hotSince', async () => {
  const { store } = await createStore();
  try {
    const created = saveAgent(store, '热规程');
    assert.equal(store.setProcedureHotEligibility(created.entry.id, { eligible: true, reason: null, atMs: CLOCK + 50 }), true);
    const revised = saveAgent(store, '热规程', { steps: ['新步骤'] });
    assert.equal(revised.entry.hotEligible, true);
    assert.equal(revised.entry.hotReason, null);
    assert.equal(revised.entry.hotSince, CLOCK + 50);
  } finally {
    void store;
  }
});

test('reason rules: gate_rejected revises to probation; unused stays unused', async () => {
  const { store } = await createStore();
  try {
    const rejected = saveAgent(store, '被拒规程');
    store.setProcedureHotEligibility(rejected.entry.id, { eligible: false, reason: 'gate_rejected' });
    const afterReject = saveAgent(store, '被拒规程', { steps: ['改进步骤'] });
    assert.equal(afterReject.entry.hotEligible, false);
    assert.equal(afterReject.entry.hotReason, 'probation');
    assert.equal(afterReject.needsGate, true);

    const unused = saveAgent(store, '闲置规程');
    store.setProcedureHotEligibility(unused.entry.id, { eligible: false, reason: 'unused' });
    const afterUnused = saveAgent(store, '闲置规程', { steps: ['又一次'] });
    assert.equal(afterUnused.entry.hotEligible, false);
    assert.equal(afterUnused.entry.hotReason, 'unused');
    assert.equal(afterUnused.needsGate, false);
  } finally {
    void store;
  }
});

test('a dream upsert promotes a probation procedure to hot', async () => {
  const { store } = await createStore();
  try {
    saveAgent(store, '候选规程');
    const promoted = store.upsertProcedure({
      metabotId: 5,
      title: '候选规程',
      triggerText: '当…',
      steps: ['一步'],
      origin: 'dream',
    });
    assert.equal(promoted.entry.hotEligible, true);
    assert.equal(promoted.entry.hotReason, null);
    assert.equal(promoted.entry.hotSince, CLOCK);
  } finally {
    void store;
  }
});

test('setProcedureHotEligibility refuses archived rows and keeps updatedAt', async () => {
  const { store } = await createStore();
  try {
    const created = saveAgent(store, '归档规程');
    assert.equal(store.setProcedureHotEligibility(created.entry.id, { eligible: true, reason: null }), true);
    const updatedAtBefore = store.getProcedure(created.entry.id).updatedAt;
    assert.ok(store.archiveProcedureByTitle(5, '归档规程'));
    assert.equal(
      store.setProcedureHotEligibility(created.entry.id, { eligible: false, reason: 'demoted' }),
      false,
      'archived rows are refused',
    );
    assert.equal(store.getProcedure(created.entry.id).updatedAt, updatedAtBefore);
  } finally {
    void store;
  }
});

test('listHotProcedures filters recall-only and archived; recall still returns them', async () => {
  const { store } = await createStore();
  try {
    saveAgent(store, '召回规程');
    saveAgent(store, '归档规程2');
    store.archiveProcedureByTitle(5, '归档规程2');
    store.upsertProcedure({
      metabotId: 5, title: '热规程2', triggerText: '当…', steps: ['一步'], origin: 'dream',
    });
    const hot = store.listHotProcedures(5);
    assert.deepEqual(hot.map((entry) => entry.title), ['热规程2']);
    const recall = store.listProcedures({ metabotId: 5, status: 'active' });
    assert.deepEqual(
      recall.map((entry) => entry.title).sort(),
      ['召回规程', '热规程2'],
    );
  } finally {
    void store;
  }
});

// ---------------------------------------------------------------------------
// Pure helpers (RRSI P2 Task 3)
// ---------------------------------------------------------------------------

test('PROCEDURE_HOT_REASONS and normalizeProcedureHotReason', () => {
  assert.deepEqual(PROCEDURE_HOT_REASONS, [
    'probation', 'gate_rejected', 'demoted', 'rollback', 'unused', 'situational',
  ]);
  assert.equal(normalizeProcedureHotReason('probation'), 'probation');
  assert.equal(normalizeProcedureHotReason('unused'), 'unused');
  assert.equal(normalizeProcedureHotReason('nope'), null);
  assert.equal(normalizeProcedureHotReason(null), null);
  assert.equal(normalizeProcedureHotReason(undefined), null);
  assert.equal(normalizeProcedureHotReason(42), null);
});

test('buildProbationDraftDescription renders sections and omits empty ones', () => {
  const full = buildProbationDraftDescription({
    triggerText: '当用户要求发布视频',
    steps: ['先检查字幕', '再导出'],
    pitfalls: ['不要跳过审阅'],
    sourcePinIds: ['pin-abc'],
  });
  assert.equal(
    full,
    '触发:当用户要求发布视频\n步骤:先检查字幕 → 再导出\n避免:不要跳过审阅\n来源 pin:pin-abc',
  );
  const minimal = buildProbationDraftDescription({
    triggerText: '当…',
    steps: ['一步'],
    pitfalls: [],
    sourcePinIds: [],
  });
  assert.equal(minimal, '触发:当…\n步骤:一步');
});

test('buildProbationDraftDescription caps at 1200 chars', () => {
  const description = buildProbationDraftDescription({
    triggerText: '当…',
    steps: ['超长步骤'.repeat(600)],
    pitfalls: [],
    sourcePinIds: [],
  });
  assert.equal(description.length, 1200);
  assert.ok(description.endsWith('…'));
});
