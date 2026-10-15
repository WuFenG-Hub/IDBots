// RRSI P3 — pure hot-layer ranking, demotion, and re-entry selection (Task 2),
// plus the store roster ranking and the pruning pass flows (Tasks 4–5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  rankHotLayerItems,
  selectHotLayerDemotions,
  selectHotLayerReentries,
} = require('../dist-electron/main/libs/hotLayerPruning.js');

// ---------------------------------------------------------------------------
// Pure selection vectors (RRSI P3 Task 2)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 31);
const c = (key, appliedNights, ageDays, exposedNights = 0) => ({
  key, kind: 'technique', hotSinceMs: NOW - ageDays * DAY, appliedNights, exposedNights,
});
const keys = (items) => items.map((item) => item.key);

test('ranking: no fresh items → applied evidence first, then the most recent zero-applied', () => {
  const items = [c('a', 3, 40), c('b', 0, 30), c('c', 2, 50), c('d', 0, 20), c('e', 1, 60), c('f', 0, 90), c('g', 0, 25)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 5, nowMs: NOW })), ['a', 'c', 'e', 'd', 'g']);
});

test('ranking: the fresh slot is honored over merit', () => {
  const items = [c('a', 3, 40), c('b', 2, 40), c('c', 2, 41), c('d', 1, 40), c('e', 1, 41), c('n', 0, 3)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 5, nowMs: NOW })), ['a', 'b', 'c', 'd', 'n']);
});

test('ranking: only the newest fresh item gets the slot', () => {
  const items = [c('a', 3, 40), c('b', 2, 40), c('c', 2, 41), c('d', 1, 40), c('e', 1, 41), c('n', 0, 3), c('m', 0, 5)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 5, nowMs: NOW })), ['a', 'b', 'c', 'd', 'n']);
});

test('ranking: a fresh item that ranks on merit does not consume a second slot', () => {
  const items = [c('n', 4, 2), c('a', 3, 40), c('b', 2, 40), c('c', 1, 40), c('d', 1, 41), c('e', 0, 40)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 5, nowMs: NOW })), ['n', 'a', 'b', 'c', 'd']);
});

test('ranking: ties fall through to recency then key', () => {
  assert.deepEqual(keys(rankHotLayerItems([c('b', 1, 10), c('a', 1, 10)], { cap: 1, nowMs: NOW, freshSlots: 0 })), ['a']);
});

test('ranking: cap larger than the input returns everything sorted; cap 0 is empty', () => {
  const items = [c('b', 0, 10), c('a', 1, 10)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 10, nowMs: NOW })), ['a', 'b']);
  assert.deepEqual(rankHotLayerItems(items, { cap: 0, nowMs: NOW }), []);
});

test('demotions: past grace + ≥5 audited exposures + never applied', () => {
  const demote = (item) => selectHotLayerDemotions([item], { nowMs: NOW });
  assert.deepEqual(keys(demote(c('x', 0, 30, 5))), ['x']);
  assert.deepEqual(demote(c('y', 0, 30, 4)), [], 'four audited nights are not enough');
  assert.deepEqual(demote(c('z', 0, 10, 9)), [], 'inside the grace period');
  assert.deepEqual(demote(c('w', 1, 30, 9)), [], 'applied at least once');
});

test('demotions: at most two per night, worst exposure first, then oldest', () => {
  const picked = selectHotLayerDemotions(
    [c('i', 0, 30, 6), c('j', 0, 40, 7), c('k', 0, 50, 7), c('h', 0, 30, 9)],
    { nowMs: NOW },
  );
  assert.deepEqual(keys(picked), ['h', 'k']);
});

test('re-entries: at least two applied nights, most applied first', () => {
  const picked = selectHotLayerReentries([c('a', 2, 10), c('b', 1, 10), c('c', 3, 10)]);
  assert.deepEqual(keys(picked), ['c', 'a']);
});

// ---------------------------------------------------------------------------
// Ranked rosters (RRSI P3 Task 4, store section)
// ---------------------------------------------------------------------------

import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';
import { dayStartMs, createDreamHarness, dreamJson, seedSession } from './fixtures/rrsiDreamHarness.mjs';

const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');

const P_DAY = 86_400_000;
const NOW_MS = dayStartMs('2026-08-31');
const dateDaysAgo = (days) => {
  const date = new Date(NOW_MS - days * P_DAY);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** Audited hot usage rows: `nights` consecutive days ending `endDaysAgo`. */
function seedAuditedNights(db, itemId, kind, nights, endDaysAgo, applied, bot = 5) {
  for (let offset = 0; offset < nights; offset += 1) {
    const daysAgo = endDaysAgo + offset;
    db.run(
      `INSERT INTO hot_layer_usage (
         metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count, applied, evidence, audited_at
       ) VALUES (?, ?, ?, ?, 'hot', ?, 1, ?, ?, ?)`,
      [bot, dateDaysAgo(daysAgo), kind, itemId, NOW_MS - daysAgo * P_DAY, applied ? 1 : 0, applied === null ? null : '{"labels":["S1.M1"],"channels":["owner"]}', applied === null ? null : NOW_MS - daysAgo * P_DAY],
    );
  }
}

test('store ranking: listInjectableTechniques orders by applied nights with the fresh slot', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [1, 2, 3, 4, 5, 6].map((n) => ({
      title: `技巧${n}`, description: `做法${n}`, capabilityType: 'workflow',
    })));
    const byTitle = new Map(coworkStore.listCapabilityDrafts(5).map((draft) => [`技巧${draft.title.slice(-1)}`, draft]));
    const t = (n) => byTitle.get(`技巧${n}`);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      coworkStore.updateCapabilityDraftValidation({
        id: t(n).id, metabotId: 5, status: 'validated', validationScore: 0.7,
      });
      db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [NOW_MS - [60, 50, 40, 30, 20, 2][n - 1] * P_DAY, t(n).id]);
    }
    seedAuditedNights(db, String(t(1).id), 'technique', 3, 25, true);
    const injectable = coworkStore.listInjectableTechniques(5, 5, { nowMs: NOW_MS });
    assert.deepEqual(injectable.map((draft) => draft.id), [t(1).id, t(6).id, t(5).id, t(4).id, t(3).id], 'T2 loses the last slot');
  } finally {
    cleanup();
  }
});

test('store ranking: listHotProcedures orders the same way by key', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => NOW_MS);
    const ids = [];
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const result = knowledgeStore.upsertProcedure({
        metabotId: 5, title: `热规程${n}`, triggerText: `当用户要求${n}`, steps: ['一步'], origin: 'dream',
      });
      ids.push(result.entry.id);
    }
    const ages = [60, 50, 40, 30, 20, 2];
    ids.forEach((id, index) => {
      db.run('UPDATE metaid_knowledge_procedures SET hot_since = ? WHERE id = ?', [NOW_MS - ages[index] * P_DAY, id]);
    });
    seedAuditedNights(db, ids[0], 'procedure', 3, 25, true);
    const hot = knowledgeStore.listHotProcedures(5, { limit: 5, nowMs: NOW_MS });
    assert.deepEqual(hot.map((entry) => entry.id), [ids[0], ids[5], ids[4], ids[3], ids[2]], 'P2 loses the last slot');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Pruning pass flows (RRSI P3 Task 4)
// ---------------------------------------------------------------------------

const NIGHT_D = '2026-08-10';
const D_START = dayStartMs(NIGHT_D);

function seedValidatedTechnique(h, title, ageDays) {
  h.coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title, description: `${title}的做法`, capabilityType: 'workflow' },
  ]);
  const draft = h.coworkStore.listCapabilityDrafts(5).find((entry) => entry.title === title);
  h.coworkStore.updateCapabilityDraftValidation({
    id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.7,
  });
  h.db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [D_START - ageDays * P_DAY, draft.id]);
  return draft.id;
}

function seedHotProcedure(h, title, ageDays) {
  const result = h.knowledgeStore.upsertProcedure({
    metabotId: 5, title, triggerText: `当用户要求${title}`, steps: ['一步'], origin: 'dream',
  });
  h.db.run('UPDATE metaid_knowledge_procedures SET hot_since = ? WHERE id = ?', [D_START - ageDays * P_DAY, result.entry.id]);
  return result.entry.id;
}

function seedNightSession(h, night) {
  seedSession(h.coworkStore, h.db, night, [
    { type: 'user', content: '视频好了吗' },
    { type: 'assistant', content: '好了' },
  ]);
  h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
}

const nightDateDaysAgo = (night, days) => {
  const date = new Date(dayStartMs(night) - days * P_DAY);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** Audited hot nights counted back from a dreamed night D: `nights` rows on
 * consecutive days starting `startDaysBefore` days before D and moving closer
 * to it (so they stay inside the 30-day pruning window [D-29, D]). */
function seedAuditedNightsBefore(db, itemId, kind, nights, startDaysBefore) {
  for (let offset = 0; offset < nights; offset += 1) {
    const daysBefore = startDaysBefore - offset;
    db.run(
      `INSERT INTO hot_layer_usage (
         metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count, applied, evidence, audited_at
       ) VALUES (?, ?, ?, ?, 'hot', ?, 1, 0, '{"labels":[],"channels":[]}', ?)`,
      [5, nightDateDaysAgo(NIGHT_D, daysBefore), kind, itemId, D_START - daysBefore * P_DAY, D_START - daysBefore * P_DAY],
    );
  }
}

test('prune: 5 audited nights with 0 applied demotes, 4 does not', async () => {
  const h = await createDreamHarness();
  try {
    const aId = seedValidatedTechnique(h, '技巧甲', 40);
    const bId = seedValidatedTechnique(h, '技巧乙', 40);
    seedAuditedNightsBefore(h.db, String(aId), 'technique', 5, 28);
    seedAuditedNightsBefore(h.db, String(bId), 'technique', 4, 28);
    seedNightSession(h, NIGHT_D);
    await h.runNight(NIGHT_D);
    const a = h.coworkStore.getCapabilityDraft(5, aId);
    assert.equal(a.status, 'dormant');
    assert.ok(a.dormantAt > 0, 'dormant_at is stamped');
    assert.ok(a.validationNotes.endsWith('applied on none'), `notes record the reason: ${a.validationNotes}`);
    const b = h.coworkStore.getCapabilityDraft(5, bId);
    assert.equal(b.status, 'validated', 'four audited nights are not enough');
  } finally {
    h.cleanup();
  }
});

test('prune: inside the grace period nothing demotes', async () => {
  const h = await createDreamHarness();
  try {
    const aId = seedValidatedTechnique(h, '技巧丙', 10);
    seedAuditedNightsBefore(h.db, String(aId), 'technique', 9, 28);
    seedNightSession(h, NIGHT_D);
    await h.runNight(NIGHT_D);
    assert.equal(h.coworkStore.getCapabilityDraft(5, aId).status, 'validated');
  } finally {
    h.cleanup();
  }
});

test('prune: the 2-per-night cap is shared across kinds; telemetry counts', async () => {
  const h = await createDreamHarness();
  try {
    const aId = seedValidatedTechnique(h, '技巧A', 40);
    const bId = seedValidatedTechnique(h, '技巧B', 40);
    const pId = seedHotProcedure(h, '热规程P', 40);
    seedAuditedNightsBefore(h.db, String(aId), 'technique', 7, 28);
    seedAuditedNightsBefore(h.db, String(pId), 'procedure', 6, 28);
    seedAuditedNightsBefore(h.db, String(bId), 'technique', 5, 28);
    const draftsBefore = Number(h.db.exec('SELECT COUNT(*) FROM capability_drafts')[0].values[0][0]);
    const proceduresBefore = Number(h.db.exec('SELECT COUNT(*) FROM metaid_knowledge_procedures')[0].values[0][0]);

    seedNightSession(h, NIGHT_D);
    await h.runNight(NIGHT_D);
    assert.equal(h.coworkStore.getCapabilityDraft(5, aId).status, 'dormant', 'most-exposed technique demotes');
    const procedure = h.knowledgeStore.getProcedure(pId);
    assert.equal(procedure.status, 'active');
    assert.equal(procedure.hotEligible, false);
    assert.equal(procedure.hotReason, 'unused');
    assert.equal(h.coworkStore.getCapabilityDraft(5, bId).status, 'validated', 'the cap stops at two');
    assert.deepEqual(h.telemetry(NIGHT_D)?.hotLayerPruning, { demotedTechniques: 1, demotedProcedures: 1, reentered: 0 });

    seedNightSession(h, '2026-08-11');
    await h.runNight('2026-08-11');
    assert.equal(h.coworkStore.getCapabilityDraft(5, bId).status, 'dormant', 'the leftover demotes the next night');
    assert.deepEqual(h.telemetry('2026-08-11')?.hotLayerPruning, { demotedTechniques: 1, demotedProcedures: 0, reentered: 0 });

    const draftsAfter = Number(h.db.exec('SELECT COUNT(*) FROM capability_drafts')[0].values[0][0]);
    const proceduresAfter = Number(h.db.exec('SELECT COUNT(*) FROM metaid_knowledge_procedures')[0].values[0][0]);
    assert.equal(draftsAfter, draftsBefore, 'no capability_drafts row is deleted');
    assert.equal(proceduresAfter, proceduresBefore, 'no procedure row is deleted');
  } finally {
    h.cleanup();
  }
});

test('prune: a demoted procedure stays recallable with the rarely-applied status line', async () => {
  const h = await createDreamHarness();
  try {
    const pId = seedHotProcedure(h, '热规程Q', 40);
    seedAuditedNightsBefore(h.db, pId, 'procedure', 6, 28);
    seedNightSession(h, NIGHT_D);
    await h.runNight(NIGHT_D);
    const demoted = h.knowledgeStore.getProcedure(pId);
    assert.equal(demoted.status, 'active');
    assert.equal(demoted.hotEligible, false);
    assert.equal(demoted.hotReason, 'unused');
    assert.ok(h.knowledgeStore.listProcedures({ metabotId: 5, status: 'active', query: '热规程Q' }).length === 1, 'recall still finds it');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Re-entry of unused procedures (RRSI P3 Task 5)
// ---------------------------------------------------------------------------

/** Audited recall nights applied (or not) before night D; daysBefore counts
 * down toward D so rows stay inside the caller's window. */
function seedRecallNight(db, itemId, daysBefore, applied) {
  db.run(
    `INSERT INTO hot_layer_usage (
       metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count, applied, evidence, audited_at
     ) VALUES (?, ?, 'procedure', ?, 'recall', ?, 1, ?, ?, ?)`,
    [5, nightDateDaysAgo(NIGHT_D, daysBefore), itemId, D_START - daysBefore * P_DAY,
      applied ? 1 : 0, applied ? '{"labels":["S1.M1"],"channels":["owner"]}' : '{"labels":[],"channels":[]}',
      D_START - daysBefore * P_DAY],
  );
}

test('re-entry: 2 audited applied nights within 14 days make an unused procedure hot again', async () => {
  const h = await createDreamHarness();
  try {
    const pId = seedHotProcedure(h, '热规程R', 40);
    h.knowledgeStore.setProcedureHotEligibility(pId, { eligible: false, reason: 'unused' });
    seedRecallNight(h.db, pId, 5, true);
    seedRecallNight(h.db, pId, 9, true);
    seedNightSession(h, NIGHT_D);
    await h.runNight(NIGHT_D);
    const procedure = h.knowledgeStore.getProcedure(pId);
    assert.equal(procedure.hotEligible, true);
    assert.equal(procedure.hotReason, null);
    assert.equal(procedure.hotSince, dayStartMs(NIGHT_D) + 27 * 60 * 60 * 1000, 'hot_since restarts at the injected clock');
    assert.deepEqual(h.telemetry(NIGHT_D)?.hotLayerPruning, { demotedTechniques: 0, demotedProcedures: 0, reentered: 1 });
  } finally {
    h.cleanup();
  }
});

test('re-entry: 1 applied night, or evidence 20 days old, is not enough', async () => {
  const h = await createDreamHarness();
  try {
    const oneNight = seedHotProcedure(h, '热规程S', 40);
    h.knowledgeStore.setProcedureHotEligibility(oneNight, { eligible: false, reason: 'unused' });
    seedRecallNight(h.db, oneNight, 5, true);
    const staleNight = seedHotProcedure(h, '热规程T', 40);
    h.knowledgeStore.setProcedureHotEligibility(staleNight, { eligible: false, reason: 'unused' });
    seedRecallNight(h.db, staleNight, 5, true);
    seedRecallNight(h.db, staleNight, 20, true);
    seedNightSession(h, NIGHT_D);
    await h.runNight(NIGHT_D);
    assert.equal(h.knowledgeStore.getProcedure(oneNight).hotEligible, false, 'one night stays unused');
    assert.equal(h.knowledgeStore.getProcedure(oneNight).hotReason, 'unused');
    assert.equal(h.knowledgeStore.getProcedure(staleNight).hotEligible, false, 'the 20-day-old night falls outside the window');
    assert.equal(h.telemetry(NIGHT_D)?.hotLayerPruning?.reentered, 0);
  } finally {
    h.cleanup();
  }
});

test('re-entry: a gate_rejected procedure never re-enters through usage evidence', async () => {
  const h = await createDreamHarness();
  try {
    const pId = seedHotProcedure(h, '热规程U', 40);
    h.knowledgeStore.setProcedureHotEligibility(pId, { eligible: false, reason: 'gate_rejected' });
    seedRecallNight(h.db, pId, 5, true);
    seedRecallNight(h.db, pId, 9, true);
    seedNightSession(h, NIGHT_D);
    await h.runNight(NIGHT_D);
    const procedure = h.knowledgeStore.getProcedure(pId);
    assert.equal(procedure.hotEligible, false, 'unchanged');
    assert.equal(procedure.hotReason, 'gate_rejected');
    assert.equal(h.telemetry(NIGHT_D)?.hotLayerPruning?.reentered, 0);
  } finally {
    h.cleanup();
  }
});

test('re-entry: a procedure re-entered tonight is not demoted tonight', async () => {
  const h = await createDreamHarness();
  try {
    const pId = seedHotProcedure(h, '热规程V', 40);
    h.knowledgeStore.setProcedureHotEligibility(pId, { eligible: false, reason: 'unused' });
    // 30-day history would otherwise read as five audited hot nights.
    seedAuditedNightsBefore(h.db, pId, 'procedure', 5, 28);
    seedRecallNight(h.db, pId, 5, true);
    seedRecallNight(h.db, pId, 9, true);
    seedNightSession(h, NIGHT_D);
    await h.runNight(NIGHT_D);
    const procedure = h.knowledgeStore.getProcedure(pId);
    assert.equal(procedure.hotEligible, true, 're-entered');
    assert.equal(procedure.hotReason, null, 'not demoted back');
    assert.deepEqual(h.telemetry(NIGHT_D)?.hotLayerPruning, { demotedTechniques: 0, demotedProcedures: 0, reentered: 1 });
  } finally {
    h.cleanup();
  }
});
