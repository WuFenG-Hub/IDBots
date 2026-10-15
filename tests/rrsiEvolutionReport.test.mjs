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
