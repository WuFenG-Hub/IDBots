// RRSI P3 — usage evidence storage (Task 1) and the usage-audit pass (Task 3).
//
// Storage section: the shared hot-layer usage stats query, DreamStore read /
// write methods over hot_layer_usage, and the capability-draft dormant field.
// Audit section: excerpt sampling, prompt shape, parser coercion, and the
// DreamService pass driven through the shared dream harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { getSqlJs, createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';
import {
  createDreamHarness,
  dreamJson,
  seedSession,
  MARKERS,
} from './fixtures/rrsiDreamHarness.mjs';

const require = createRequire(import.meta.url);
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const {
  queryHotLayerUsageStats,
} = require('../dist-electron/main/libs/hotLayerUsageQueries.js');
const {
  sampleUsageAuditExcerpts,
  buildHotLayerUsageAuditPrompt,
  parseHotLayerUsageAuditOutput,
} = require('../dist-electron/main/libs/hotLayerUsageAudit.js');

// ---------------------------------------------------------------------------
// Usage stats (RRSI P3 Task 1)
// ---------------------------------------------------------------------------

/** Seed one hot_layer_usage row; audited=audited_at ms (null = never audited). */
function seedUsage(db, { date, kind, id, exposure, applied, audited, count = 1, bot = 5 }) {
  db.run(
    `INSERT INTO hot_layer_usage (
       metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count, applied, evidence, audited_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bot, date, kind, id, exposure, 1_000, count, applied, applied === null ? null : '{"labels":[],"channels":[]}', audited],
  );
}

/** Six dates D1..D6 with a mix of hot/recall, audited/unaudited, applied 1/0/NULL. */
function seedSixDays(db) {
  // technique 7: applied on 2 nights (one hot, one recall), 3 audited hot nights.
  seedUsage(db, { date: '2026-08-25', kind: 'technique', id: '7', exposure: 'hot', applied: 1, audited: 1_000 });
  seedUsage(db, { date: '2026-08-26', kind: 'technique', id: '7', exposure: 'hot', applied: 0, audited: 2_000 });
  seedUsage(db, { date: '2026-08-27', kind: 'technique', id: '7', exposure: 'recall', applied: 1, audited: 3_000 });
  seedUsage(db, { date: '2026-08-28', kind: 'technique', id: '7', exposure: 'hot', applied: null, audited: null });
  seedUsage(db, { date: '2026-08-29', kind: 'technique', id: '7', exposure: 'recall', applied: null, audited: null });
  seedUsage(db, { date: '2026-08-30', kind: 'technique', id: '7', exposure: 'hot', applied: null, audited: 6_000 });
  // procedure proc-1: audited hot on 3 nights, never applied.
  seedUsage(db, { date: '2026-08-25', kind: 'procedure', id: 'proc-1', exposure: 'hot', applied: 0, audited: 1_000 });
  seedUsage(db, { date: '2026-08-27', kind: 'procedure', id: 'proc-1', exposure: 'hot', applied: 0, audited: 3_000 });
  seedUsage(db, { date: '2026-08-29', kind: 'procedure', id: 'proc-1', exposure: 'hot', applied: 0, audited: 5_000 });
}

test('usage stats: applied counts hot and recall, exposed counts audited hot only', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedSixDays(db);
    const dreamStore = new DreamStore(db, () => {});
    const stats = dreamStore.listHotLayerUsageStats(5, {
      kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30',
    });
    assert.deepEqual(stats.get('7'), { itemId: '7', appliedNights: 2, exposedNights: 3, auditedNights: 4 });
    const procedureStats = dreamStore.listHotLayerUsageStats(5, {
      kind: 'procedure', sinceDate: '2026-08-25', untilDate: '2026-08-30',
    });
    assert.deepEqual(procedureStats.get('proc-1'), { itemId: 'proc-1', appliedNights: 0, exposedNights: 3, auditedNights: 3 });
    // The pure helper agrees with the store method.
    const direct = queryHotLayerUsageStats(db, {
      metabotId: 5, kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30',
    });
    assert.deepEqual(direct.get('7'), stats.get('7'));
  } finally {
    cleanup();
  }
});

test('usage stats: date bounds are inclusive and the itemIds filter works', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedSixDays(db);
    const dreamStore = new DreamStore(db, () => {});
    const inner = dreamStore.listHotLayerUsageStats(5, {
      kind: 'technique', sinceDate: '2026-08-26', untilDate: '2026-08-29',
    });
    assert.deepEqual(inner.get('7'), { itemId: '7', appliedNights: 1, exposedNights: 1, auditedNights: 2 });
    const filtered = dreamStore.listHotLayerUsageStats(5, {
      kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30', itemIds: ['7', '999'],
    });
    assert.ok(filtered.has('7'));
    assert.ok(!filtered.has('999'), 'items without rows never appear');
    const empty = dreamStore.listHotLayerUsageStats(5, {
      kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30', itemIds: [],
    });
    assert.equal(empty.size, 0, 'an empty itemIds list skips the query entirely');
  } finally {
    cleanup();
  }
});

test('usage stats: a database without the table returns an empty map', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  try {
    const stats = queryHotLayerUsageStats(db, {
      metabotId: 5, kind: 'technique', sinceDate: '2026-08-25', untilDate: '2026-08-30',
    });
    assert.equal(stats.size, 0);
  } finally {
    db.close();
  }
});

test('listHotLayerExposures orders hot first, then exposure_count, kind, id', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedUsage(db, { date: '2026-08-26', kind: 'procedure', id: 'p-b', exposure: 'hot', applied: null, audited: null, count: 3 });
    seedUsage(db, { date: '2026-08-26', kind: 'technique', id: '7', exposure: 'hot', applied: null, audited: null, count: 1 });
    seedUsage(db, { date: '2026-08-26', kind: 'procedure', id: 'p-a', exposure: 'hot', applied: null, audited: null, count: 5 });
    seedUsage(db, { date: '2026-08-26', kind: 'procedure', id: 'p-c', exposure: 'recall', applied: null, audited: null, count: 9 });
    const dreamStore = new DreamStore(db, () => {});
    const rows = dreamStore.listHotLayerExposures(5, '2026-08-26');
    assert.deepEqual(rows.map((row) => `${row.kind}:${row.itemId}`), [
      'procedure:p-a',
      'procedure:p-b',
      'technique:7',
      'procedure:p-c',
    ]);
    assert.deepEqual(rows[0], {
      kind: 'procedure', itemId: 'p-a', exposure: 'hot', exposureCount: 5, applied: null, auditedAt: null,
    });
    assert.deepEqual(dreamStore.listHotLayerExposures(5, '2026-08-27'), [], 'other dates stay out');
  } finally {
    cleanup();
  }
});

test('recordHotLayerUsageVerdicts writes evidence JSON and a re-run overwrites', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    seedUsage(db, { date: '2026-08-26', kind: 'technique', id: '7', exposure: 'hot', applied: null, audited: null });
    seedUsage(db, { date: '2026-08-26', kind: 'procedure', id: 'proc-1', exposure: 'hot', applied: null, audited: null });
    const dreamStore = new DreamStore(db, () => {});
    const changed = dreamStore.recordHotLayerUsageVerdicts(5, '2026-08-26', [
      { kind: 'technique', itemId: '7', applied: true, evidence: { labels: ['S1.M2'], channels: ['owner'] } },
      { kind: 'procedure', itemId: 'proc-1', applied: false, evidence: { labels: [], channels: [] } },
    ], 42_000);
    assert.equal(changed, 2);
    const technique = getRow(db, "SELECT applied, evidence, audited_at FROM hot_layer_usage WHERE item_id = '7'");
    assert.equal(technique.applied, 1);
    assert.equal(technique.audited_at, 42_000);
    assert.equal(technique.evidence, '{"labels":["S1.M2"],"channels":["owner"]}');
    const procedure = getRow(db, "SELECT applied, evidence, audited_at FROM hot_layer_usage WHERE item_id = 'proc-1'");
    assert.equal(procedure.applied, 0);
    assert.equal(procedure.audited_at, 42_000);

    const rewritten = dreamStore.recordHotLayerUsageVerdicts(5, '2026-08-26', [
      { kind: 'technique', itemId: '7', applied: false, evidence: { labels: [], channels: [] } },
    ], 84_000);
    assert.equal(rewritten, 1, 'a re-audit only rewrites rows that exist');
    const after = getRow(db, "SELECT applied, evidence, audited_at FROM hot_layer_usage WHERE item_id = '7'");
    assert.equal(after.applied, 0);
    assert.equal(after.evidence, '{"labels":[],"channels":[]}');
    assert.equal(after.audited_at, 84_000, 'the second call overwrites the first');
  } finally {
    cleanup();
  }
});

test('getCapabilityDraft returns the row with dormantAt null for pre-P3 drafts', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '旧技巧', description: 'd', capabilityType: 'workflow' },
    ]);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    const loaded = coworkStore.getCapabilityDraft(5, draft.id);
    assert.ok(loaded, 'the bot owns the row');
    assert.equal(loaded.id, draft.id);
    assert.equal(loaded.dormantAt, null, 'pre-P3 rows read back dormant-free');
    assert.equal(coworkStore.getCapabilityDraft(6, draft.id), null, 'another bot gets null');
    assert.equal(coworkStore.getCapabilityDraft(5, 999_999), null, 'a missing row is null');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Usage audit pass — pure helpers (RRSI P3 Task 3)
// ---------------------------------------------------------------------------

test('sampling: labels count every message, channels follow session kind, text collapses and cuts', () => {
  const sessions = [
    {
      sessionType: 'standard', isOrder: false,
      messages: [
        { type: 'user', content: '视频好了吗' },
        { type: 'assistant', content: '我先  查重\n\n再   发布' },
        { type: 'user', content: '继续' },
        { type: 'assistant', content: 'x'.repeat(300) },
      ],
    },
    {
      sessionType: 'a2a', isOrder: false,
      messages: [
        { type: 'user', content: '外部请求' },
        { type: 'assistant', content: '外部回答' },
      ],
    },
  ];
  const excerpts = sampleUsageAuditExcerpts(sessions);
  assert.deepEqual(excerpts.map((excerpt) => excerpt.label), ['S1.M2', 'S1.M4', 'S2.M2']);
  assert.deepEqual(excerpts.map((excerpt) => excerpt.channel), ['owner', 'owner', 'external']);
  assert.equal(excerpts[0].text, '我先 查重 再 发布');
  assert.equal(excerpts[1].text.length, 280, 'a 300-char reply cuts to 280');
  assert.equal(excerpts[1].text, 'x'.repeat(280));

  const big = [{
    sessionType: 'standard', isOrder: false,
    messages: Array.from({ length: 100 }, (_, index) => ({
      type: index % 2 === 0 ? 'assistant' : 'user',
      content: 'ignored',
    })).map((message, index) => ({ ...message, type: 'assistant', content: `回复${index + 1}` })),
  }];
  const sampled = sampleUsageAuditExcerpts(big);
  assert.equal(sampled.length, 40);
  assert.equal(sampled[0].label, 'S1.M1', 'even sampling keeps the first message');
});

test('prompt: system carries the 使用核查 marker, user lists items and excerpts verbatim', () => {
  const prompt = buildHotLayerUsageAuditPrompt({
    date: '2026-08-10',
    items: [{ ref: 'technique:7', kind: 'technique', itemId: '7', title: '发布前查重', gist: '交付前先查重' }],
    excerpts: [{ label: 'S1.M2', channel: 'owner', text: '我先查重再发布' }],
  });
  assert.ok(prompt.system.includes('使用核查'));
  assert.ok(!prompt.system.includes('能力验证'));
  assert.ok(!prompt.system.includes('记忆核对'));
  assert.ok(prompt.system.includes('2026-08-10'));
  const lines = prompt.user.split('\n');
  assert.equal(lines[0], '日期:2026-08-10');
  assert.ok(lines.includes('## 记忆条目'));
  assert.ok(lines.includes('- technique:7「发布前查重」:交付前先查重'));
  assert.ok(lines.includes('## 回复摘录'));
  assert.ok(lines.includes('[S1.M2](owner) 我先查重再发布'));
});

test('parser: coerces applied without valid labels, drops unknown refs, keeps the first duplicate', () => {
  const refs = new Set(['technique:1', 'technique:2', 'technique:3']);
  const labels = new Set(['S1.M1', 'S1.M2']);
  const parse = (items) => parseHotLayerUsageAuditOutput(JSON.stringify({ items }), refs, labels);

  const coerced = parse([{ ref: 'technique:1', applied: true, evidence: ['S9.M9'] }]);
  assert.deepEqual(coerced.verdicts, [{ ref: 'technique:1', applied: false, labels: [] }]);

  const stringly = parse([{ ref: 'technique:1', applied: 'yes', evidence: ['S1.M1'] }]);
  assert.equal(stringly.verdicts[0].applied, false);

  const dropped = parse([
    { ref: 'technique:99', applied: true, evidence: ['S1.M1'] },
    { ref: 'technique:2', applied: true, evidence: ['S1.M1', 'S1.M1', 'S9.M9', 'S1.M2', 'unknown-key', 5] },
  ]);
  assert.deepEqual(dropped.verdicts, [
    { ref: 'technique:2', applied: true, labels: ['S1.M1', 'S1.M2'] },
  ], 'unknown refs drop, labels dedupe in input order, unknown labels filter');

  const duplicate = parse([
    { ref: 'technique:1', applied: true, evidence: ['S1.M1'] },
    { ref: 'technique:1', applied: false, evidence: [] },
  ]);
  assert.deepEqual(duplicate.verdicts, [{ ref: 'technique:1', applied: true, labels: ['S1.M1'] }]);

  const extra = parse([{ ref: 'technique:3', applied: false, evidence: [], note: 'extra key' }]);
  assert.deepEqual(extra.verdicts, [{ ref: 'technique:3', applied: false, labels: [] }]);

  assert.equal(parseHotLayerUsageAuditOutput('{"verdicts":[]}', refs, labels).ok, false, 'missing items array fails');
  const fenced = parseHotLayerUsageAuditOutput(
    '```json\n{"items":[{"ref":"technique:1","applied":true,"evidence":["S1.M2"]}]}\n```',
    refs,
    labels,
  );
  assert.equal(fenced.ok, true, 'fenced JSON parses');
});

// ---------------------------------------------------------------------------
// Usage audit pass — dream flow (RRSI P3 Task 3)
// ---------------------------------------------------------------------------

const NIGHT = '2026-08-10';

function seedAuditNight(h, night) {
  h.coworkStore.insertCapabilityDrafts(5, '2026-08-05', [
    { title: '发布前查重', description: '交付前先查重再发布', capabilityType: 'workflow' },
  ]);
  const draft = h.coworkStore.listCapabilityDrafts(5)[0];
  h.coworkStore.updateCapabilityDraftValidation({
    id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.7,
  });
  const procedure = h.knowledgeStore.upsertProcedure({
    metabotId: 5, title: '热规程甲', triggerText: '当用户要求甲', steps: ['一步'], origin: 'dream',
  });
  h.coworkStore.recordHotLayerExposures({
    metabotId: 5, usageDate: night,
    items: [
      { kind: 'technique', id: String(draft.id), exposure: 'hot' },
      { kind: 'procedure', id: procedure.entry.id, exposure: 'hot' },
    ],
  });
  seedSession(h.coworkStore, h.db, night, [
    { type: 'user', content: '视频发布了吗' },
    { type: 'assistant', content: '我先查重再发布,按记忆里的做法完成了。' },
  ]);
  h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
  return { draftId: draft.id, procedureId: procedure.entry.id };
}

test('flow: audited verdicts fill the day\'s exposure rows and telemetry', async () => {
  const h = await createDreamHarness();
  try {
    const seeded = seedAuditNight(h, NIGHT);
    h.router.on(MARKERS.usageAudit, () => ({
      items: [
        { ref: `technique:${seeded.draftId}`, applied: true, evidence: ['S1.M2'] },
        { ref: `procedure:${seeded.procedureId}`, applied: false, evidence: [] },
      ],
    }));
    await h.runNight(NIGHT);
    const technique = getRow(
      h.db, "SELECT applied, evidence, audited_at FROM hot_layer_usage WHERE item_kind = 'technique'",
    );
    assert.equal(technique.applied, 1);
    assert.equal(technique.evidence, '{"labels":["S1.M2"],"channels":["owner"]}');
    assert.ok(technique.audited_at > 0);
    const procedure = getRow(
      h.db, "SELECT applied, audited_at FROM hot_layer_usage WHERE item_kind = 'procedure'",
    );
    assert.equal(procedure.applied, 0);
    assert.ok(procedure.audited_at > 0);
    assert.deepEqual(h.telemetry(NIGHT)?.usageAudit, {
      ran: true, items: 2, applied: 1, excerpts: 1, parseFailed: false,
      knowledgeItems: 0, knowledgeApplied: 0, memoryItems: 0, memoryApplied: 0,
    });
    assert.equal(h.coworkStore.getCapabilityDraft(5, seeded.draftId).status, 'validated', 'score 0.7 stays unpromoted');
  } finally {
    h.cleanup();
  }
});

test('flow: garbage audit output marks parseFailed and writes nothing', async () => {
  const h = await createDreamHarness();
  try {
    seedAuditNight(h, NIGHT);
    h.router.on(MARKERS.usageAudit, () => 'not json');
    await h.runNight(NIGHT);
    const audited = h.db.exec('SELECT audited_at FROM hot_layer_usage')[0].values.flat();
    assert.equal(audited.length, 2);
    assert.ok(audited.every((value) => value === null), 'no row is marked audited');
    assert.deepEqual(h.telemetry(NIGHT)?.usageAudit, {
      ran: true, items: 2, applied: 0, excerpts: 1, parseFailed: true,
      knowledgeItems: 0, knowledgeApplied: 0, memoryItems: 0, memoryApplied: 0,
    });
    assert.ok(h.dreamStore.getRun(5, NIGHT), 'the dream run still completes');
  } finally {
    h.cleanup();
  }
});

test('flow: nights without exposures skip the audit call entirely', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, NIGHT, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    await h.runNight(NIGHT);
    assert.ok(!h.router.calls.some((call) => call.system.includes('使用核查')), 'no audit prompt was sent');
    assert.deepEqual(h.telemetry(NIGHT)?.usageAudit, {
      ran: false, items: 0, applied: 0, excerpts: 0, parseFailed: false,
      knowledgeItems: 0, knowledgeApplied: 0, memoryItems: 0, memoryApplied: 0,
    });
  } finally {
    h.cleanup();
  }
});
