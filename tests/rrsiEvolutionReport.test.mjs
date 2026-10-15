import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';
import { buildRrsiReport, formatRrsiReport } from '../scripts/rrsi-evolution-report.mjs';

const require = Module.createRequire(import.meta.url);
const { DreamStore } = require('../dist-electron/main/dreamStore.js');

const insertMetabot = (db, id) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `pub-${id}`, `chatpub-${id}`, `Bot ${id}`, `metaid-${id}`, null]
  );
};

const DATES = ['2026-08-01', '2026-08-02', '2026-08-03'];

async function buildFixtureDb() {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  insertMetabot(db, 5);

  dreamStore.beginRun(5, DATES[0], null, 17);
  dreamStore.updateRunTelemetry(5, DATES[0], {
    emptyDay: false,
    validation: {
      checked: 2, validated: 1, rejected: 0, validatedIds: [11],
      deferredSameNight: 1, prospectiveDowngraded: 0,
      panels: { agreed: 1, disagreed: 1, incomplete: 0 },
    },
    reReviewPanels: { agreed: 1, disagreed: 0, incomplete: 0 },
    capabilityDraftInsert: { inserted: 1, skippedDuplicate: 0, skippedFalsified: 0 },
    promotedCount: 1,
    reReviewed: 1,
    demoted: 0,
  });
  dreamStore.beginRun(5, DATES[1], null, 17);
  dreamStore.updateRunTelemetry(5, DATES[1], {
    emptyDay: false,
    validation: {
      checked: 1, validated: 1, rejected: 1, validatedIds: [12],
      deferredSameNight: 0, prospectiveDowngraded: 1,
      panels: { agreed: 2, disagreed: 0, incomplete: 1 },
    },
    capabilityDraftInsert: { inserted: 2, skippedDuplicate: 1, skippedFalsified: 1 },
    promotedCount: 1,
  });
  dreamStore.beginRun(5, DATES[2], null, 17);
  dreamStore.updateRunTelemetry(5, DATES[2], {
    emptyDay: true,
    validation: {
      checked: 0, validated: 0, rejected: 0, validatedIds: [],
      deferredSameNight: 0, prospectiveDowngraded: 0,
      panels: { agreed: 0, disagreed: 0, incomplete: 0 },
    },
  });

  const first = coworkStore.recordFalsifiedHypothesis({
    metabotId: 5, title: '先验证再交付', description: 'd', reason: 'r',
    source: 'validation', sourceDraftId: 1, falsifiedAt: Date.parse('2026-08-01T00:00:00Z'),
  });
  coworkStore.recordFalsifiedHypothesis({
    metabotId: 5, title: '深夜连环追问', description: 'd', reason: 'r',
    source: 're_review', sourceDraftId: 2, falsifiedAt: Date.parse('2026-08-02T00:00:00Z'),
  });
  coworkStore.markFalsifiedHypothesisHit(first.id, Date.parse('2026-08-02T12:00:00Z'));

  return { db, cleanup };
}

const exportDbToFile = (db, suffix) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rrsi-report-')), `idbots-${suffix}.sqlite`);
  fs.writeFileSync(file, Buffer.from(db.export()));
  return file;
};

test('report sums the P1 gate telemetry over the window', async () => {
  const { db, cleanup } = await buildFixtureDb();
  let file = null;
  try {
    file = exportDbToFile(db, 'full');
    const handle = new DatabaseSync(file, { readOnly: true });
    try {
      const report = buildRrsiReport(handle, { days: 30, today: DATES[2] });
      assert.equal(report.missing.length, 0);
      assert.equal(report.bots.length, 1);
      const bot = report.bots[0];
      assert.equal(bot.metabotId, 5);
      assert.equal(bot.name, 'Bot 5');
      assert.deepEqual(bot.nights, { total: 3, nonEmpty: 2 });
      assert.equal(bot.gate.checked, 3);
      assert.equal(bot.gate.validated, 2);
      assert.equal(bot.gate.rejected, 1);
      assert.equal(bot.gate.deferredSameNight, 1);
      assert.equal(bot.gate.prospectiveDowngraded, 1);
      assert.deepEqual(bot.gate.panels, { agreed: 3, disagreed: 1, incomplete: 1 });
      assert.equal(bot.gate.disagreementRate, 0.25);
      assert.equal(bot.gate.nightsWithPanels, 3);
      assert.deepEqual(bot.gate.reReviewPanels, { agreed: 1, disagreed: 0, incomplete: 0 });
      assert.deepEqual(bot.gate.draftInsert, { inserted: 3, skippedDuplicate: 1, skippedFalsified: 1 });
      assert.equal(bot.gate.promoted, 2);
      assert.equal(bot.gate.reReviewed, 1);
      assert.equal(bot.gate.demoted, 0);
      assert.equal(bot.falsifiedLedger.size, 2);
      assert.equal(bot.falsifiedLedger.hitsInWindow, 1);
      assert.deepEqual(bot.falsifiedLedger.newestTitles, ['深夜连环追问', '先验证再交付']);

      const text = formatRrsiReport(report);
      assert.ok(text.includes('disagreement 25.00%'), text);
      assert.ok(text.includes('Bot 5 Bot 5'));
      assert.ok(text.includes('3 nights, 2 non-empty'));
    } finally {
      handle.close();
    }
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    cleanup();
  }
});

test('report degrades on databases without the ledger table', async () => {
  const { db, cleanup } = await buildFixtureDb();
  let file = null;
  try {
    db.run('DROP TABLE capability_falsified_hypotheses');
    file = exportDbToFile(db, 'no-ledger');
    const handle = new DatabaseSync(file, { readOnly: true });
    try {
      const report = buildRrsiReport(handle, { days: 30, today: DATES[2] });
      assert.ok(report.missing.includes('capability_falsified_hypotheses'));
      assert.equal(report.bots[0].falsifiedLedger, null);
      assert.ok(formatRrsiReport(report).includes('(table missing)'));
    } finally {
      handle.close();
    }
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    cleanup();
  }
});

test('CLI smoke: --json prints the report and exits 0', async () => {
  const { db, cleanup } = await buildFixtureDb();
  let file = null;
  try {
    file = exportDbToFile(db, 'cli');
    const result = spawnSync(
      process.execPath,
      [path.resolve('scripts/rrsi-evolution-report.mjs'), '--db', file, '--json', '--today', DATES[2]],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.bots[0].metabotId, 5);
    assert.equal(parsed.bots[0].gate.disagreementRate, 0.25);
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Retention section (RRSI P2 Task 8)
// ---------------------------------------------------------------------------

test('report retention section: budget mean, hot-layer chars, probation funnel, exposure', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    insertMetabot(db, 5);
    for (const [index, date] of DATES.entries()) {
      dreamStore.beginRun(5, date, null, 17);
      dreamStore.updateRunTelemetry(5, date, {
        emptyDay: false,
        promotionBudget: index === 2
          ? { nights: 2, budget: 2, candidates: 1, promoted: 1 }
          : { nights: index, budget: 3, candidates: 2, promoted: 2 },
        hotLayer: index === 2
          ? { hotProcedures: 3, probationProcedures: 1, injectableTechniques: 0, procedureBlockChars: 200, techniqueBlockChars: 60, exposedItems: 4 }
          : { hotProcedures: 1, probationProcedures: 1, injectableTechniques: 1, procedureBlockChars: 100, techniqueBlockChars: 50, exposedItems: 2 },
      });
    }
    // Probation funnel: one promoted (validated), one rejected, one still pending.
    const tickets = ['proc-a', 'proc-b', 'proc-c'];
    for (const [index, procedureId] of tickets.entries()) {
      coworkStore.ensureProbationDraftForProcedure({
        metabotId: 5, procedureId, title: `试用${index}`, description: 'd', dreamDate: DATES[0],
      });
      db.run('UPDATE capability_drafts SET created_at = ? WHERE source_procedure_id = ?', [Date.parse(`${DATES[index]}T00:00:00Z`), procedureId]);
    }
    const drafts = coworkStore.listCapabilityDrafts(5);
    const promotedTicket = drafts.find((draft) => draft.sourceProcedureId === 'proc-a');
    const rejectedTicket = drafts.find((draft) => draft.sourceProcedureId === 'proc-b');
    coworkStore.updateCapabilityDraftValidation({ id: promotedTicket.id, metabotId: 5, status: 'validated', validationScore: 0.9 });
    db.run('UPDATE capability_drafts SET promoted_at = ? WHERE id = ?', [Date.parse(`${DATES[2]}T00:00:00Z`), promotedTicket.id]);
    coworkStore.updateCapabilityDraftValidation({ id: rejectedTicket.id, metabotId: 5, status: 'rejected' });
    coworkStore.recordHotLayerExposures({
      metabotId: 5, usageDate: DATES[1],
      items: [{ kind: 'procedure', id: 'proc-a', exposure: 'hot' }, { kind: 'technique', id: 't1', exposure: 'hot' }],
      atMs: 0,
    });
    coworkStore.recordHotLayerExposures({
      metabotId: 5, usageDate: DATES[2],
      items: [{ kind: 'procedure', id: 'proc-a', exposure: 'hot' }],
      atMs: 0,
    });

    const file = exportDbToFile(db, 'retention');
    const handle = new DatabaseSync(file, { readOnly: true });
    let retention;
    try {
      retention = buildRrsiReport(handle, { days: 3, today: DATES[2], botId: 5 }).bots[0].retention;
    } finally {
      handle.close();
    }
    assert.equal(retention.promotionsPerNight, 1.6667, '(2 + 2 + 1) / 3 nights, report rounds to 4 decimals');
    assert.equal(retention.budgetLatest, 2);
    assert.deepEqual(retention.hotLayerChars, { first: 150, last: 260 });
    assert.deepEqual(retention.probation, { opened: 3, validated: 1, rejected: 1, promoted: 1 });
    assert.deepEqual(retention.exposure, { nights: 2, items: 3 });
  } finally {
    cleanup();
  }
});

test('report retention degrades to nulls without hot_layer_usage or source_procedure_id', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const dreamStore = new DreamStore(db, () => {});
    insertMetabot(db, 5);
    dreamStore.beginRun(5, DATES[0], null, 17);
    dreamStore.updateRunTelemetry(5, DATES[0], {
      emptyDay: false,
      promotionBudget: { nights: 0, budget: 3, candidates: 0, promoted: 0 },
    });
    db.run('DROP TABLE hot_layer_usage');
    db.run('ALTER TABLE capability_drafts DROP COLUMN source_procedure_id');

    const file = exportDbToFile(db, 'retention-degrade');
    const handle = new DatabaseSync(file, { readOnly: true });
    let retention;
    try {
      retention = buildRrsiReport(handle, { days: 1, today: DATES[0], botId: 5 }).bots[0].retention;
    } finally {
      handle.close();
    }
    assert.equal(retention.promotionsPerNight, 0);
    assert.equal(retention.budgetLatest, 3);
    assert.deepEqual(retention.hotLayerChars, { first: null, last: null });
    assert.equal(retention.probation, null, 'missing column degrades to null');
    assert.equal(retention.exposure, null, 'missing table degrades to null');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Usage section (RRSI P3 Task 6)
// ---------------------------------------------------------------------------

test('report usage section: audit coverage, applied rate, pruning sums', async () => {
  const { db, cleanup } = await createSqliteStore();
  let file = null;
  try {
    const dreamStore = new DreamStore(db, () => {});
    insertMetabot(db, 5);
    dreamStore.beginRun(5, DATES[0], null, 17);
    dreamStore.updateRunTelemetry(5, DATES[0], {
      emptyDay: false,
      usageAudit: { ran: true, items: 2, applied: 1, excerpts: 3, parseFailed: false },
      hotLayerPruning: { demotedTechniques: 1, demotedProcedures: 0, reentered: 0 },
    });
    dreamStore.beginRun(5, DATES[1], null, 17);
    dreamStore.updateRunTelemetry(5, DATES[1], {
      emptyDay: false,
      usageAudit: { ran: true, items: 0, applied: 0, excerpts: 0, parseFailed: true },
      hotLayerPruning: { demotedTechniques: 0, demotedProcedures: 1, reentered: 0 },
    });
    db.run(
      `INSERT INTO hot_layer_usage (
         metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count, applied, evidence, audited_at
       ) VALUES
         (5, ?, 'technique', 't1', 'hot', 0, 1, 1, '{}', 100),
         (5, ?, 'technique', 't2', 'hot', 0, 1, 0, '{}', 100),
         (5, ?, 'procedure', 'p1', 'recall', 0, 1, NULL, NULL, NULL)`,
      [DATES[0], DATES[0], DATES[1]],
    );
    // Dormant drafts (all time) and one active unused procedure.
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, DATES[0], [
      { title: '休眠甲', description: 'd', capabilityType: 'workflow' },
      { title: '休眠乙', description: 'd', capabilityType: 'workflow' },
    ]);
    db.run("UPDATE capability_drafts SET status = 'dormant', dormant_at = 100");
    const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');
    const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1);
    const unused = knowledgeStore.upsertProcedure({
      metabotId: 5, title: '闲置规程', triggerText: '当', steps: ['一步'], origin: 'dream',
    });
    knowledgeStore.setProcedureHotEligibility(unused.entry.id, { eligible: false, reason: 'unused' });

    file = exportDbToFile(db, 'usage');
    const handle = new DatabaseSync(file, { readOnly: true });
    let usage;
    let text;
    try {
      const report = buildRrsiReport(handle, { days: 3, today: DATES[2], botId: 5 });
      usage = report.bots[0].usage;
      text = formatRrsiReport(report);
    } finally {
      handle.close();
    }
    assert.equal(usage.auditedNights, 2);
    assert.equal(usage.parseFailures, 1);
    assert.equal(usage.exposedItems, 3);
    assert.equal(usage.auditedItems, 2);
    assert.equal(usage.appliedItems, 1);
    assert.equal(usage.appliedRate, 0.5);
    assert.equal(usage.demotedTechniques, 1);
    assert.equal(usage.demotedProcedures, 1);
    assert.equal(usage.reentered, 0);
    assert.equal(usage.dormantTotal, 2);
    assert.equal(usage.unusedProcedures, 1);
    assert.ok(text.includes('usage: audited 2 nights (1 parse fail), items 3 exposed / 2 audited / 1 applied → 50.00%; demoted 1T+1P, re-entered 0; dormant 2, unused 1'), text);
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    cleanup();
  }
});

test('report usage section is null without hot_layer_usage', async () => {
  const { db, cleanup } = await createSqliteStore();
  let file = null;
  try {
    const dreamStore = new DreamStore(db, () => {});
    insertMetabot(db, 5);
    dreamStore.beginRun(5, DATES[0], null, 17);
    dreamStore.updateRunTelemetry(5, DATES[0], { emptyDay: false });
    db.run('DROP TABLE hot_layer_usage');
    file = exportDbToFile(db, 'usage-missing');
    const handle = new DatabaseSync(file, { readOnly: true });
    let usage;
    let text;
    try {
      const report = buildRrsiReport(handle, { days: 1, today: DATES[0], botId: 5 });
      usage = report.bots[0].usage;
      text = formatRrsiReport(report);
    } finally {
      handle.close();
    }
    assert.equal(usage, null);
    assert.ok(text.includes('usage: (table missing)'), text);
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    cleanup();
  }
});
// Exploration section (RRSI P4 Task 5)
// ---------------------------------------------------------------------------

test('report exploration section: stalls, compliance rate, component and directed-risk mix', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    insertMetabot(db, 5);
    const nights = [
      ['2026-08-01', { stalled: true, reason: 'no_acceptance', directed: true, complied: true }],
      ['2026-08-02', { stalled: true, reason: 'component_collapse', directed: true, complied: false }],
      ['2026-08-03', { stalled: true, reason: 'no_acceptance', directed: true, complied: true }],
      ['2026-08-04', { stalled: false, reason: null, directed: false, complied: null }],
    ];
    for (const [date, exploration] of nights) {
      dreamStore.beginRun(5, date, null, 18);
      dreamStore.updateRunTelemetry(5, date, { emptyDay: false, exploration });
    }
    const proposalNights = [
      ['2026-08-01', 'skill', 'read_only'],
      ['2026-08-01', 'memory', 'read_only'],
      ['2026-08-02', 'skill', 'chain_write'],
      ['2026-08-03', null, 'read_only'],
      ['2026-08-04', 'memory', 'interact_local'],
    ];
    for (const [date, component, riskClass] of proposalNights) {
      coworkStore.insertDreamPracticeProposals(5, date, [
        {
          title: `练习 ${date}`,
          prompt: 'p',
          targetRefs: ['draft:1'],
          riskClass,
          ...(component !== null ? { component } : {}),
        },
      ]);
      db.run(
        'UPDATE dream_practice_proposals SET created_at = ? WHERE dream_date = ?',
        [Date.parse(`${date}T00:00:00Z`), date],
      );
    }

    const file = exportDbToFile(db, 'exploration');
    const handle = new DatabaseSync(file, { readOnly: true });
    let bot;
    let text;
    try {
      const report = buildRrsiReport(handle, { days: 4, today: '2026-08-04', botId: 5 });
      bot = report.bots[0];
      text = formatRrsiReport(report);
    } finally {
      handle.close();
    }
    assert.equal(bot.exploration.stalledNights, 3);
    assert.deepEqual(bot.exploration.reasons, { no_acceptance: 2, component_collapse: 1 });
    assert.equal(bot.exploration.directedNights, 3);
    assert.equal(bot.exploration.compliedNights, 2);
    assert.equal(bot.exploration.complianceRate, 0.6667);
    assert.deepEqual(bot.exploration.componentMix, {
      memory: 2, procedure: 0, skill: 2, remote_service: 0, collaboration: 0,
      metaweb: 0, metaapp: 0, unknown: 1,
    });
    assert.deepEqual(bot.exploration.directedRiskMix, { read_only: 3, interact_local: 0, chain_write: 1 });
    assert.ok(text.includes(
      '  exploration: stalled 3 nights (no_acceptance 2, component_collapse 1), directed 3, complied 2 → 66.67%; '
      + 'mix memory 2, skill 2, unknown 1; directed risk read_only 3, chain_write 1',
    ), text);
  } finally {
    cleanup();
  }
});

test('report exploration: without the component column every proposal counts as unknown', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    insertMetabot(db, 5);
    dreamStore.beginRun(5, '2026-08-01', null, 18);
    dreamStore.updateRunTelemetry(5, '2026-08-01', {
      emptyDay: false,
      exploration: { stalled: true, reason: 'no_acceptance', directed: true, complied: true },
    });
    coworkStore.insertDreamPracticeProposals(5, '2026-08-01', [
      { title: '练习', prompt: 'p', targetRefs: ['draft:1'], riskClass: 'read_only', component: 'skill' },
    ]);
    db.run('ALTER TABLE dream_practice_proposals DROP COLUMN component');

    const file = exportDbToFile(db, 'exploration-no-column');
    const handle = new DatabaseSync(file, { readOnly: true });
    let exploration;
    try {
      exploration = buildRrsiReport(handle, { days: 1, today: '2026-08-01', botId: 5 }).bots[0].exploration;
    } finally {
      handle.close();
    }
    assert.deepEqual(exploration.componentMix, {
      memory: 0, procedure: 0, skill: 0, remote_service: 0, collaboration: 0,
      metaweb: 0, metaapp: 0, unknown: 1,
    });
    assert.deepEqual(exploration.directedRiskMix, { read_only: 1, interact_local: 0, chain_write: 0 });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scope / OOD / usageChannels sections (RRSI P5 Task 5)
// ---------------------------------------------------------------------------

test('report scope, ood and usageChannels sections', async () => {
  const { db, cleanup } = await createSqliteStore();
  let file = null;
  try {
    const dreamStore = new DreamStore(db, () => {});
    insertMetabot(db, 5);
    dreamStore.beginRun(5, '2026-08-01', null, 18);
    dreamStore.updateRunTelemetry(5, '2026-08-01', {
      emptyDay: false,
      predictionOod: { internal: { resolved: 2, hit: 2, hitRate: 1 }, external: { resolved: 0, hit: 0, hitRate: null }, gap: null },
      reconciliation: { considered: 1, kept: 1, narrowed: 0, merged: 0, disputed: 0, scope: { general: 1, situational: 0, scorerFitted: 0, hardMarkerOverrides: 0 } },
    });
    dreamStore.beginRun(5, '2026-08-02', null, 18);
    dreamStore.updateRunTelemetry(5, '2026-08-02', {
      emptyDay: false,
      predictionOod: { internal: { resolved: 4, hit: 3, hitRate: 0.75 }, external: { resolved: 2, hit: 1, hitRate: 0.5 }, gap: 0.25 },
      reconciliation: { considered: 2, kept: 2, narrowed: 0, merged: 0, disputed: 0, scope: { general: 2, situational: 0, scorerFitted: 0, hardMarkerOverrides: 1 } },
    });
    dreamStore.beginRun(5, '2026-08-03', null, 18);
    dreamStore.updateRunTelemetry(5, '2026-08-03', {
      emptyDay: false,
      predictionOod: { internal: { resolved: 5, hit: 3, hitRate: 0.6 }, external: { resolved: 3, hit: 1, hitRate: 1 / 3 }, gap: 0.2667 },
      reconciliation: { considered: 2, kept: 0, narrowed: 1, merged: 0, disputed: 1, scope: { general: 1, situational: 2, scorerFitted: 1, hardMarkerOverrides: 0 } },
    });

    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '通用甲', description: 'd', capabilityType: 'skill' },
      { title: '通用乙', description: 'd', capabilityType: 'skill' },
      { title: '特定丙', description: 'd', capabilityType: 'skill' },
      { title: '讨好丁', description: 'd', capabilityType: 'skill' },
      { title: '未评估戊', description: 'd', capabilityType: 'skill' },
    ]);
    const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
    for (const title of ['通用甲', '通用乙', '特定丙']) {
      coworkStore.updateCapabilityDraftValidation({ id: byTitle(title).id, metabotId: 5, status: 'validated', validationScore: 0.9 });
    }
    coworkStore.setCapabilityDraftScope({ id: byTitle('通用甲').id, metabotId: 5, scope: 'general' });
    coworkStore.setCapabilityDraftScope({ id: byTitle('通用乙').id, metabotId: 5, scope: 'general' });
    coworkStore.setCapabilityDraftScope({ id: byTitle('特定丙').id, metabotId: 5, scope: 'situational' });
    coworkStore.updateCapabilityDraftValidation({ id: byTitle('讨好丁').id, metabotId: 5, status: 'disputed' });
    coworkStore.setCapabilityDraftScope({ id: byTitle('讨好丁').id, metabotId: 5, scope: 'scorer_fitted' });
    coworkStore.updateCapabilityDraftValidation({ id: byTitle('未评估戊').id, metabotId: 5, status: 'disputed' });
    db.run("UPDATE capability_drafts SET status = 'rejected' WHERE title = '通用乙' AND id != (SELECT id FROM capability_drafts WHERE title = '通用乙')");
    // A rejected draft must not count into `current`; keep 通用乙 validated.
    db.run("UPDATE capability_drafts SET status = 'validated' WHERE title = '通用乙'");

    // Usage rows: 8 owner-only, 1 both-channels, 1 external-only, 1 not applied.
    const usageRows = [];
    for (let index = 0; index < 8; index += 1) {
      usageRows.push(`(5, '2026-08-02', 'technique', 't-owner-${index}', 'hot', 0, 1, 1, '{"labels":["A1"],"channels":["owner"]}', 100)`);
    }
    usageRows.push(`(5, '2026-08-02', 'technique', 't-both', 'hot', 0, 1, 1, '{"labels":["A2"],"channels":["owner","external"]}', 100)`);
    usageRows.push(`(5, '2026-08-03', 'procedure', 'p-ext', 'hot', 0, 1, 1, '{"labels":["A3"],"channels":["external"]}', 100)`);
    usageRows.push(`(5, '2026-08-03', 'procedure', 'p-unapplied', 'hot', 0, 1, 0, '{"labels":["A4"],"channels":["owner"]}', 100)`);
    db.run(
      `INSERT INTO hot_layer_usage (
         metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count, applied, evidence, audited_at
       ) VALUES ${usageRows.join(', ')}`,
    );

    file = exportDbToFile(db, 'p5-sections');
    const handle = new DatabaseSync(file, { readOnly: true });
    let bot;
    let text;
    try {
      const report = buildRrsiReport(handle, { days: 3, today: '2026-08-03', botId: 5 });
      bot = report.bots[0];
      text = formatRrsiReport(report);
    } finally {
      handle.close();
    }
    assert.deepEqual(bot.scope.assessed, { general: 4, situational: 2, scorerFitted: 1, hardMarkerOverrides: 1 });
    assert.deepEqual(bot.scope.current, { general: 2, situational: 1, scorerFitted: 1, unassessed: 1 });
    assert.equal(bot.ood.latest.date, '2026-08-03');
    assert.deepEqual(bot.ood.latest.internal, { resolved: 5, hit: 3, hitRate: 0.6 });
    assert.deepEqual(bot.ood.latest.external, { resolved: 3, hit: 1, hitRate: 1 / 3 });
    assert.equal(bot.ood.latest.gap, 0.2667);
    assert.deepEqual(bot.ood.gapByNight, [
      { date: '2026-08-02', gap: 0.25 },
      { date: '2026-08-03', gap: 0.2667 },
    ]);
    assert.deepEqual(bot.usageChannels, { ownerAppliedRows: 9, externalAppliedRows: 2 });
    assert.ok(text.includes(
      '  ood: internal 3/5 (60.00%) vs external 1/3 (33.33%) → gap +26.67pt; '
      + 'scope assessed G4 S2 F1 (overrides 1); applied rows owner 9 / external 2',
    ), text);
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    cleanup();
  }
});

test('report scope is null without the scope column; usageChannels null without hot_layer_usage', async () => {
  const { db, cleanup } = await createSqliteStore();
  let file = null;
  try {
    const dreamStore = new DreamStore(db, () => {});
    insertMetabot(db, 5);
    dreamStore.beginRun(5, '2026-08-01', null, 18);
    dreamStore.updateRunTelemetry(5, '2026-08-01', { emptyDay: false });
    db.run('ALTER TABLE capability_drafts DROP COLUMN scope');
    db.run('DROP TABLE hot_layer_usage');
    file = exportDbToFile(db, 'p5-degrade');
    const handle = new DatabaseSync(file, { readOnly: true });
    let bot;
    let text;
    try {
      const report = buildRrsiReport(handle, { days: 1, today: '2026-08-01', botId: 5 });
      bot = report.bots[0];
      text = formatRrsiReport(report);
    } finally {
      handle.close();
    }
    assert.equal(bot.scope, null);
    assert.equal(bot.usageChannels, null);
    assert.deepEqual(bot.ood, { latest: null, gapByNight: [] });
    assert.ok(text.includes('scope: (column missing)'), text);
    assert.ok(text.includes('applied rows: (table missing)'), text);
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    cleanup();
  }
});
