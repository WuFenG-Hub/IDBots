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
