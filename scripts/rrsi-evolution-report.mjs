#!/usr/bin/env node
// RRSI evolution report (P1: gate regularizers) — a READ-ONLY CLI over the
// user's IDBots SQLite database (node:sqlite, readOnly: true). It turns the
// dream-run telemetry the RRSI passes record into a per-bot report, so a rule
// change can later be justified by data (the plan's measurement requirement).
// Never writes; safe to run against the live database. On databases created
// before a table existed, the affected section degrades (null / missing list)
// instead of crashing, so the first run doubles as the pre-phase baseline.

import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;

function defaultDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'IDBots', 'idbots.sqlite');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'IDBots', 'idbots.sqlite');
  }
  return path.join(os.homedir(), '.config', 'IDBots', 'idbots.sqlite');
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Pure YYYY-MM-DD arithmetic (UTC anchor — no DST drift). */
export function shiftDateKey(dateKey, deltaDays) {
  const base = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(base)) throw new Error(`invalid date key: ${dateKey}`);
  return new Date(base + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

function dateKeyStartMs(dateKey) {
  return Date.parse(`${dateKey}T00:00:00Z`);
}

function tableExists(db, name) {
  const rows = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').all('table', name);
  return rows.length > 0;
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseExtraJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Unparseable telemetry degrades to an empty object.
  }
  return {};
}

function nestedNumber(source, key) {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nestedPanels(source, key) {
  const value = source?.[key];
  if (typeof value !== 'object' || value === null) return null;
  return {
    agreed: nestedNumber(value, 'agreed'),
    disagreed: nestedNumber(value, 'disagreed'),
    incomplete: nestedNumber(value, 'incomplete'),
  };
}

function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

function readGateSection(db, metabotId, fromDate, toDate) {
  const gate = {
    nightsWithPanels: 0,
    checked: 0,
    validated: 0,
    rejected: 0,
    deferredSameNight: 0,
    prospectiveDowngraded: 0,
    panels: { agreed: 0, disagreed: 0, incomplete: 0 },
    disagreementRate: null,
    reReviewed: 0,
    demoted: 0,
    reReviewPanels: { agreed: 0, disagreed: 0, incomplete: 0 },
    draftInsert: { inserted: 0, skippedDuplicate: 0, skippedFalsified: 0 },
    promoted: 0,
  };
  if (!tableExists(db, 'metabot_dream_telemetry_daily')) return gate;
  const columns = new Set(columnNames(db, 'metabot_dream_telemetry_daily'));
  const has = (name) => columns.has(name);
  const selected = [
    'empty_day',
    has('validation_checked') ? 'validation_checked' : 'NULL AS validation_checked',
    has('validation_validated') ? 'validation_validated' : 'NULL AS validation_validated',
    has('validation_rejected') ? 'validation_rejected' : 'NULL AS validation_rejected',
    has('promoted_count') ? 'promoted_count' : 'NULL AS promoted_count',
    has('re_reviewed') ? 're_reviewed' : 'NULL AS re_reviewed',
    has('demoted') ? 'demoted' : 'NULL AS demoted',
    has('extra_json') ? 'extra_json' : 'NULL AS extra_json',
  ].join(', ');
  const rows = db
    .prepare(`SELECT ${selected} FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ?`)
    .all(metabotId, fromDate, toDate);
  for (const row of rows) {
    gate.checked += toNumber(row.validation_checked);
    gate.validated += toNumber(row.validation_validated);
    gate.rejected += toNumber(row.validation_rejected);
    gate.promoted += toNumber(row.promoted_count);
    gate.reReviewed += toNumber(row.re_reviewed);
    gate.demoted += toNumber(row.demoted);
    const extra = parseExtraJson(row.extra_json);
    const validation = typeof extra.validation === 'object' && extra.validation !== null ? extra.validation : {};
    gate.deferredSameNight += nestedNumber(validation, 'deferredSameNight');
    gate.prospectiveDowngraded += nestedNumber(validation, 'prospectiveDowngraded');
    const panels = nestedPanels(validation, 'panels');
    if (panels) {
      gate.nightsWithPanels += 1;
      gate.panels.agreed += panels.agreed;
      gate.panels.disagreed += panels.disagreed;
      gate.panels.incomplete += panels.incomplete;
    }
    const reReviewPanels = nestedPanels(extra, 'reReviewPanels');
    if (reReviewPanels) {
      gate.reReviewPanels.agreed += reReviewPanels.agreed;
      gate.reReviewPanels.disagreed += reReviewPanels.disagreed;
      gate.reReviewPanels.incomplete += reReviewPanels.incomplete;
    }
    const draftInsert = typeof extra.capabilityDraftInsert === 'object' && extra.capabilityDraftInsert !== null
      ? extra.capabilityDraftInsert
      : null;
    if (draftInsert) {
      gate.draftInsert.inserted += nestedNumber(draftInsert, 'inserted');
      gate.draftInsert.skippedDuplicate += nestedNumber(draftInsert, 'skippedDuplicate');
      gate.draftInsert.skippedFalsified += nestedNumber(draftInsert, 'skippedFalsified');
    }
  }
  const denominator = gate.panels.agreed + gate.panels.disagreed;
  if (denominator > 0) {
    gate.disagreementRate = round4(gate.panels.disagreed / denominator);
  }
  return gate;
}

function readNights(db, metabotId, fromDate, toDate) {
  if (!tableExists(db, 'metabot_dream_telemetry_daily')) return { total: 0, nonEmpty: 0 };
  const rows = db
    .prepare('SELECT empty_day FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ?')
    .all(metabotId, fromDate, toDate);
  return {
    total: rows.length,
    nonEmpty: rows.filter((row) => toNumber(row.empty_day) === 0).length,
  };
}

function readFalsifiedLedger(db, metabotId, fromDate, toDate) {
  if (!tableExists(db, 'capability_falsified_hypotheses')) return null;
  const columns = new Set(columnNames(db, 'capability_falsified_hypotheses'));
  const size = toNumber(
    db.prepare('SELECT COUNT(*) AS n FROM capability_falsified_hypotheses WHERE metabot_id = ?').get(metabotId)?.n,
  );
  let hitsInWindow = 0;
  if (columns.has('last_hit_at')) {
    hitsInWindow = toNumber(
      db
        .prepare('SELECT COUNT(*) AS n FROM capability_falsified_hypotheses WHERE metabot_id = ? AND last_hit_at >= ? AND last_hit_at < ?')
        .get(metabotId, dateKeyStartMs(fromDate), dateKeyStartMs(toDate) + DAY_MS)?.n,
    );
  }
  const newestTitles = db
    .prepare('SELECT title FROM capability_falsified_hypotheses WHERE metabot_id = ? ORDER BY falsified_at DESC, id DESC LIMIT 5')
    .all(metabotId)
    .map((row) => String(row.title));
  return { size, hitsInWindow, newestTitles };
}

/** RRSI P2 retention metrics: budget annealing, hot-layer footprint (ΔC),
 * the probation funnel, and exposure coverage. Missing tables/columns degrade
 * to null instead of crashing (first run doubles as the pre-phase baseline). */
function readRetentionSection(db, metabotId, fromDate, toDate) {
  const retention = {
    promotionsPerNight: null,
    budgetLatest: null,
    hotLayerChars: { first: null, last: null },
    probation: null,
    exposure: null,
  };
  if (tableExists(db, 'metabot_dream_telemetry_daily')) {
    const rows = db
      .prepare('SELECT extra_json FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ? ORDER BY dream_date ASC')
      .all(metabotId, fromDate, toDate);
    let promotedSum = 0;
    let budgetNights = 0;
    let firstChars = null;
    let lastChars = null;
    for (const row of rows) {
      const extra = parseExtraJson(row.extra_json);
      const budget = typeof extra.promotionBudget === 'object' && extra.promotionBudget !== null
        ? extra.promotionBudget
        : null;
      if (budget) {
        promotedSum += nestedNumber(budget, 'promoted');
        budgetNights += 1;
        retention.budgetLatest = nestedNumber(budget, 'budget');
      }
      const hotLayer = typeof extra.hotLayer === 'object' && extra.hotLayer !== null
        ? extra.hotLayer
        : null;
      if (hotLayer) {
        const chars = nestedNumber(hotLayer, 'procedureBlockChars') + nestedNumber(hotLayer, 'techniqueBlockChars');
        if (firstChars === null) firstChars = chars;
        lastChars = chars;
      }
    }
    if (budgetNights > 0) retention.promotionsPerNight = round4(promotedSum / budgetNights);
    retention.hotLayerChars = { first: firstChars, last: lastChars };
  }
  if (tableExists(db, 'capability_drafts') && columnNames(db, 'capability_drafts').includes('source_procedure_id')) {
    const funnel = db
      .prepare(`SELECT COUNT(*) AS opened,
                       COALESCE(SUM(CASE WHEN status = 'validated' THEN 1 ELSE 0 END), 0) AS validated,
                       COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
                       COALESCE(SUM(CASE WHEN promoted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS promoted
                FROM capability_drafts
                WHERE metabot_id = ? AND source_procedure_id IS NOT NULL AND created_at >= ? AND created_at < ?`)
      .get(metabotId, dateKeyStartMs(fromDate), dateKeyStartMs(toDate) + DAY_MS);
    retention.probation = {
      opened: toNumber(funnel?.opened),
      validated: toNumber(funnel?.validated),
      rejected: toNumber(funnel?.rejected),
      promoted: toNumber(funnel?.promoted),
    };
  }
  if (tableExists(db, 'hot_layer_usage')) {
    const exposure = db
      .prepare('SELECT COUNT(DISTINCT usage_date) AS nights, COUNT(*) AS items FROM hot_layer_usage WHERE metabot_id = ? AND usage_date >= ? AND usage_date <= ?')
      .get(metabotId, fromDate, toDate);
    retention.exposure = { nights: toNumber(exposure?.nights), items: toNumber(exposure?.items) };
  }
  return retention;
}

/** RRSI P3 usage evidence: audit coverage over the window, the applied rate,
 * pruning sums, and the dormant / unused standing pools. Missing table
 * degrades to null; missing columns (pre-phase databases) count as 0. */
function readUsageSection(db, metabotId, fromDate, toDate) {
  if (!tableExists(db, 'hot_layer_usage')) return null;
  const usage = {
    auditedNights: 0,
    parseFailures: 0,
    exposedItems: 0,
    auditedItems: 0,
    appliedItems: 0,
    appliedRate: null,
    demotedTechniques: 0,
    demotedProcedures: 0,
    reentered: 0,
    dormantTotal: 0,
    unusedProcedures: 0,
  };
  const counts = db
    .prepare(`SELECT COUNT(DISTINCT item_kind || ':' || item_id) AS exposed,
                     COUNT(DISTINCT CASE WHEN audited_at IS NOT NULL THEN item_kind || ':' || item_id END) AS audited,
                     COUNT(DISTINCT CASE WHEN applied = 1 THEN item_kind || ':' || item_id END) AS applied
              FROM hot_layer_usage
              WHERE metabot_id = ? AND usage_date >= ? AND usage_date <= ?`)
    .get(metabotId, fromDate, toDate);
  usage.exposedItems = toNumber(counts?.exposed);
  usage.auditedItems = toNumber(counts?.audited);
  usage.appliedItems = toNumber(counts?.applied);
  if (usage.auditedItems > 0) {
    usage.appliedRate = round4(usage.appliedItems / usage.auditedItems);
  }
  if (tableExists(db, 'metabot_dream_telemetry_daily')) {
    const rows = db
      .prepare('SELECT extra_json FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ?')
      .all(metabotId, fromDate, toDate);
    for (const row of rows) {
      const extra = parseExtraJson(row.extra_json);
      const audit = typeof extra.usageAudit === 'object' && extra.usageAudit !== null
        ? extra.usageAudit
        : null;
      if (audit) {
        if (audit.ran === true) usage.auditedNights += 1;
        if (audit.parseFailed === true) usage.parseFailures += 1;
      }
      const pruning = typeof extra.hotLayerPruning === 'object' && extra.hotLayerPruning !== null
        ? extra.hotLayerPruning
        : null;
      if (pruning) {
        usage.demotedTechniques += nestedNumber(pruning, 'demotedTechniques');
        usage.demotedProcedures += nestedNumber(pruning, 'demotedProcedures');
        usage.reentered += nestedNumber(pruning, 'reentered');
      }
    }
  }
  if (tableExists(db, 'capability_drafts') && columnNames(db, 'capability_drafts').includes('dormant_at')) {
    usage.dormantTotal = toNumber(
      db.prepare("SELECT COUNT(*) AS n FROM capability_drafts WHERE metabot_id = ? AND status = 'dormant'").get(metabotId)?.n,
    );
  }
  if (tableExists(db, 'metaid_knowledge_procedures')
    && columnNames(db, 'metaid_knowledge_procedures').includes('hot_reason')) {
    usage.unusedProcedures = toNumber(
      db
        .prepare("SELECT COUNT(*) AS n FROM metaid_knowledge_procedures WHERE metabot_id = ? AND status = 'active' AND hot_reason = 'unused'")
        .get(metabotId)?.n,
    );
  }
  return usage;
}

/** RRSI P4 structured exploration: stall nights, directive compliance, and
 * the component / risk mix of the window's practice proposals. Missing tables
 * or columns degrade to zeros (first run doubles as the pre-phase baseline). */
function readExplorationSection(db, metabotId, fromDate, toDate) {
  const exploration = {
    stalledNights: 0,
    reasons: { no_acceptance: 0, component_collapse: 0 },
    directedNights: 0,
    compliedNights: 0,
    complianceRate: null,
    componentMix: {
      memory: 0, procedure: 0, skill: 0, remote_service: 0,
      collaboration: 0, metaweb: 0, metaapp: 0, unknown: 0,
    },
    directedRiskMix: { read_only: 0, interact_local: 0, chain_write: 0 },
  };
  const directedDates = new Set();
  if (tableExists(db, 'metabot_dream_telemetry_daily')) {
    const rows = db
      .prepare('SELECT dream_date, extra_json FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ?')
      .all(metabotId, fromDate, toDate);
    for (const row of rows) {
      const extra = parseExtraJson(row.extra_json);
      const entry = typeof extra.exploration === 'object' && extra.exploration !== null
        ? extra.exploration
        : null;
      if (!entry) continue;
      if (entry.stalled === true) {
        exploration.stalledNights += 1;
        if (entry.reason === 'no_acceptance' || entry.reason === 'component_collapse') {
          exploration.reasons[entry.reason] += 1;
        }
      }
      if (entry.directed === true) {
        exploration.directedNights += 1;
        directedDates.add(String(row.dream_date));
        if (entry.complied === true) exploration.compliedNights += 1;
      }
    }
  }
  if (exploration.directedNights > 0) {
    exploration.complianceRate = round4(exploration.compliedNights / exploration.directedNights);
  }
  if (tableExists(db, 'dream_practice_proposals')) {
    const hasComponent = columnNames(db, 'dream_practice_proposals').includes('component');
    const selected = [
      'dream_date',
      'risk_class',
      hasComponent ? 'component' : 'NULL AS component',
    ].join(', ');
    const rows = db
      .prepare(`SELECT ${selected} FROM dream_practice_proposals WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ?`)
      .all(metabotId, fromDate, toDate);
    for (const row of rows) {
      const component = row.component == null ? 'unknown' : String(row.component);
      if (component in exploration.componentMix) {
        exploration.componentMix[component] += 1;
      } else {
        exploration.componentMix.unknown += 1;
      }
      const riskClass = row.risk_class == null ? null : String(row.risk_class);
      if (directedDates.has(String(row.dream_date)) && riskClass in exploration.directedRiskMix) {
        exploration.directedRiskMix[riskClass] += 1;
      }
    }
  }
  return exploration;
}

/** RRSI P5 specificity: the window's reconciliation scope verdict mix plus the
 * drafts' current scope standing (validated or disputed rows only). Null when
 * the scope column is missing (pre-phase databases). */
function readScopeSection(db, metabotId, fromDate, toDate) {
  if (!tableExists(db, 'capability_drafts') || !columnNames(db, 'capability_drafts').includes('scope')) {
    return null;
  }
  const assessed = { general: 0, situational: 0, scorerFitted: 0, hardMarkerOverrides: 0 };
  if (tableExists(db, 'metabot_dream_telemetry_daily')) {
    const rows = db
      .prepare('SELECT extra_json FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ?')
      .all(metabotId, fromDate, toDate);
    for (const row of rows) {
      const extra = parseExtraJson(row.extra_json);
      const reconciliation = typeof extra.reconciliation === 'object' && extra.reconciliation !== null
        ? extra.reconciliation
        : {};
      const scope = typeof reconciliation.scope === 'object' && reconciliation.scope !== null
        ? reconciliation.scope
        : null;
      if (!scope) continue;
      assessed.general += nestedNumber(scope, 'general');
      assessed.situational += nestedNumber(scope, 'situational');
      assessed.scorerFitted += nestedNumber(scope, 'scorerFitted');
      assessed.hardMarkerOverrides += nestedNumber(scope, 'hardMarkerOverrides');
    }
  }
  const current = db
    .prepare(`SELECT
                 COALESCE(SUM(CASE WHEN scope = 'general' THEN 1 ELSE 0 END), 0) AS general,
                 COALESCE(SUM(CASE WHEN scope = 'situational' THEN 1 ELSE 0 END), 0) AS situational,
                 COALESCE(SUM(CASE WHEN scope = 'scorer_fitted' THEN 1 ELSE 0 END), 0) AS scorerFitted,
                 COALESCE(SUM(CASE WHEN scope IS NULL THEN 1 ELSE 0 END), 0) AS unassessed
              FROM capability_drafts
              WHERE metabot_id = ? AND status IN ('validated', 'disputed')`)
    .get(metabotId);
  return {
    assessed,
    current: {
      general: toNumber(current?.general),
      situational: toNumber(current?.situational),
      scorerFitted: toNumber(current?.scorerFitted),
      unassessed: toNumber(current?.unassessed),
    },
  };
}

const isOodBucket = (value) => typeof value === 'object' && value !== null
  && typeof value.resolved === 'number' && typeof value.hit === 'number';

/** RRSI P5 OOD split: the newest predictionOod night in the window plus every
 * night's non-null gap, ascending. */
function readOodSection(db, metabotId, fromDate, toDate) {
  const ood = { latest: null, gapByNight: [] };
  if (!tableExists(db, 'metabot_dream_telemetry_daily')) return ood;
  const rows = db
    .prepare('SELECT dream_date, extra_json FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND dream_date >= ? AND dream_date <= ? ORDER BY dream_date ASC')
    .all(metabotId, fromDate, toDate);
  for (const row of rows) {
    const extra = parseExtraJson(row.extra_json);
    const entry = typeof extra.predictionOod === 'object' && extra.predictionOod !== null
      ? extra.predictionOod
      : null;
    if (!entry || !isOodBucket(entry.internal) || !isOodBucket(entry.external)) continue;
    const date = String(row.dream_date);
    ood.latest = {
      date,
      internal: {
        resolved: entry.internal.resolved,
        hit: entry.internal.hit,
        hitRate: typeof entry.internal.hitRate === 'number' ? entry.internal.hitRate : null,
      },
      external: {
        resolved: entry.external.resolved,
        hit: entry.external.hit,
        hitRate: typeof entry.external.hitRate === 'number' ? entry.external.hitRate : null,
      },
      gap: typeof entry.gap === 'number' ? entry.gap : null,
    };
    if (typeof entry.gap === 'number' && Number.isFinite(entry.gap)) {
      ood.gapByNight.push({ date, gap: entry.gap });
    }
  }
  return ood;
}

/** RRSI P5 usage channels: applied hot_layer_usage rows in the window, one
 * count per channel named in the row's evidence JSON. Null without the table. */
function readUsageChannelsSection(db, metabotId, fromDate, toDate) {
  if (!tableExists(db, 'hot_layer_usage')) return null;
  const rows = db
    .prepare('SELECT evidence FROM hot_layer_usage WHERE metabot_id = ? AND usage_date >= ? AND usage_date <= ? AND applied = 1')
    .all(metabotId, fromDate, toDate);
  let ownerAppliedRows = 0;
  let externalAppliedRows = 0;
  for (const row of rows) {
    const evidence = parseExtraJson(row.evidence);
    const channels = Array.isArray(evidence.channels) ? evidence.channels : [];
    if (channels.includes('owner')) ownerAppliedRows += 1;
    if (channels.includes('external')) externalAppliedRows += 1;
  }
  return { ownerAppliedRows, externalAppliedRows };
}

export function buildRrsiReport(db, options = {}) {
  const days = Number.isInteger(options.days) && options.days > 0 ? options.days : 30;
  const toDate = typeof options.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(options.today)
    ? options.today
    : localDateKey(new Date());
  const fromDate = shiftDateKey(toDate, -(days - 1));
  const botId = Number.isInteger(options.botId) ? options.botId : null;

  const missing = [];
  for (const table of ['metabots', 'metabot_dream_telemetry_daily', 'capability_falsified_hypotheses']) {
    if (!tableExists(db, table)) missing.push(table);
  }

  const bots = [];
  if (!missing.includes('metabots')) {
    const columns = new Set(columnNames(db, 'metabots'));
    const nameExpr = columns.has('name') ? 'name' : 'NULL AS name';
    const rows = botId !== null
      ? db.prepare(`SELECT id, ${nameExpr} FROM metabots WHERE id = ?`).all(botId)
      : db.prepare(`SELECT id, ${nameExpr} FROM metabots ORDER BY id ASC`).all();
    for (const row of rows) {
      const metabotId = toNumber(row.id);
      bots.push({
        metabotId,
        name: row.name == null ? `MetaBot ${metabotId}` : String(row.name),
        nights: readNights(db, metabotId, fromDate, toDate),
        gate: readGateSection(db, metabotId, fromDate, toDate),
        falsifiedLedger: readFalsifiedLedger(db, metabotId, fromDate, toDate),
        retention: readRetentionSection(db, metabotId, fromDate, toDate),
        usage: readUsageSection(db, metabotId, fromDate, toDate),
        exploration: readExplorationSection(db, metabotId, fromDate, toDate),
        scope: readScopeSection(db, metabotId, fromDate, toDate),
        ood: readOodSection(db, metabotId, fromDate, toDate),
        usageChannels: readUsageChannelsSection(db, metabotId, fromDate, toDate),
      });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    window: { days, fromDate, toDate },
    missing,
    bots,
  };
}

export function formatRrsiReport(report) {
  const lines = [];
  for (const bot of report.bots ?? []) {
    const gate = bot.gate ?? {};
    const panels = gate.panels ?? { agreed: 0, disagreed: 0, incomplete: 0 };
    const disagreement = typeof gate.disagreementRate === 'number'
      ? `${(gate.disagreementRate * 100).toFixed(2)}%`
      : 'n/a';
    lines.push(
      `Bot ${bot.metabotId} ${bot.name} — ${report.window.days}d window ${report.window.fromDate}..${report.window.toDate} (${bot.nights.total} nights, ${bot.nights.nonEmpty} non-empty)`,
    );
    lines.push(
      `  gate: checked ${gate.checked ?? 0}, validated ${gate.validated ?? 0}, rejected ${gate.rejected ?? 0}, deferred ${gate.deferredSameNight ?? 0}, downgraded ${gate.prospectiveDowngraded ?? 0}`,
    );
    lines.push(
      `  panels: agreed ${panels.agreed}, disagreed ${panels.disagreed}, incomplete ${panels.incomplete} → disagreement ${disagreement}`,
    );
    const rr = gate.reReviewPanels ?? { agreed: 0, disagreed: 0, incomplete: 0 };
    lines.push(
      `  re-review: ${gate.reReviewed ?? 0} reviewed, ${gate.demoted ?? 0} demoted (panels ${rr.agreed}/${rr.disagreed}/${rr.incomplete})`,
    );
    const drafts = gate.draftInsert ?? { inserted: 0, skippedDuplicate: 0, skippedFalsified: 0 };
    lines.push(
      `  drafts: inserted ${drafts.inserted}, dup-skipped ${drafts.skippedDuplicate}, falsified-skipped ${drafts.skippedFalsified}; promoted ${gate.promoted ?? 0}`,
    );
    if (bot.falsifiedLedger === null) {
      lines.push('  falsified ledger: (table missing)');
    } else {
      const ledger = bot.falsifiedLedger;
      const newest = ledger.newestTitles.join(', ');
      lines.push(
        `  falsified ledger: ${ledger.size} rows, ${ledger.hitsInWindow} hit in window; newest: ${newest}${ledger.size > ledger.newestTitles.length ? ', …' : ''}`,
      );
    }
    const retention = bot.retention ?? {};
    const promotions = typeof retention.promotionsPerNight === 'number'
      ? retention.promotionsPerNight.toFixed(2)
      : 'n/a';
    const hotLayerChars = retention.hotLayerChars ?? { first: null, last: null };
    lines.push(
      `  retention: promotions/night ${promotions}, latest budget ${retention.budgetLatest ?? 'n/a'}, hot-layer chars ${hotLayerChars.first ?? '-'} → ${hotLayerChars.last ?? '-'}`,
    );
    if (retention.probation === null) {
      lines.push('  probation: (column missing)');
    } else {
      lines.push(
        `  probation: opened ${retention.probation.opened}, validated ${retention.probation.validated}, rejected ${retention.probation.rejected}, promoted ${retention.probation.promoted}`,
      );
    }
    if (retention.exposure === null) {
      lines.push('  exposure: (table missing)');
    } else {
      lines.push(`  exposure: ${retention.exposure.items} items over ${retention.exposure.nights} night(s)`);
    }
    if (bot.usage === null) {
      lines.push('  usage: (table missing)');
    } else {
      const usage = bot.usage;
      const rate = typeof usage.appliedRate === 'number' ? `${(usage.appliedRate * 100).toFixed(2)}%` : 'n/a';
      lines.push(
        `  usage: audited ${usage.auditedNights} nights (${usage.parseFailures} parse fail), items ${usage.exposedItems} exposed / ${usage.auditedItems} audited / ${usage.appliedItems} applied → ${rate}; demoted ${usage.demotedTechniques}T+${usage.demotedProcedures}P, re-entered ${usage.reentered}; dormant ${usage.dormantTotal}, unused ${usage.unusedProcedures}`,
      );
    }
    const exploration = bot.exploration ?? {};
    const reasons = exploration.reasons ?? { no_acceptance: 0, component_collapse: 0 };
    const reasonText = Object.entries(reasons)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason} ${count}`)
      .join(', ');
    const compliance = typeof exploration.complianceRate === 'number'
      ? `${(exploration.complianceRate * 100).toFixed(2)}%`
      : 'n/a';
    const mix = Object.entries(exploration.componentMix ?? {})
      .filter(([, count]) => count > 0)
      .map(([component, count]) => `${component} ${count}`)
      .join(', ');
    const directedRisk = Object.entries(exploration.directedRiskMix ?? {})
      .filter(([, count]) => count > 0)
      .map(([riskClass, count]) => `${riskClass} ${count}`)
      .join(', ');
    lines.push(
      `  exploration: stalled ${exploration.stalledNights ?? 0} nights${reasonText ? ` (${reasonText})` : ''}, `
      + `directed ${exploration.directedNights ?? 0}, complied ${exploration.compliedNights ?? 0} → ${compliance}`
      + `${mix ? `; mix ${mix}` : ''}${directedRisk ? `; directed risk ${directedRisk}` : ''}`,
    );
    // RRSI P5: one combined line — the OOD hit-rate gap, the scope verdict
    // mix, and the applied-evidence channel split (design §6.5 P5.2/P5.3).
    const ood = bot.ood ?? { latest: null, gapByNight: [] };
    let oodSegment;
    if (ood.latest === null) {
      oodSegment = 'ood: no predictionOod nights in window';
    } else {
      const bucketText = (bucket) => ` ${bucket.hit}/${bucket.resolved} (${(bucket.hitRate * 100).toFixed(2)}%)`;
      const gapText = typeof ood.latest.gap === 'number'
        ? `→ gap ${ood.latest.gap >= 0 ? '+' : ''}${(ood.latest.gap * 100).toFixed(2)}pt`
        : '→ gap n/a';
      oodSegment = `ood: internal${bucketText(ood.latest.internal)} vs external${bucketText(ood.latest.external)} ${gapText}`;
    }
    const scopeSegment = bot.scope === null
      ? 'scope: (column missing)'
      : `scope assessed G${bot.scope.assessed.general} S${bot.scope.assessed.situational} `
        + `F${bot.scope.assessed.scorerFitted} (overrides ${bot.scope.assessed.hardMarkerOverrides})`;
    const appliedSegment = bot.usageChannels === null
      ? 'applied rows: (table missing)'
      : `applied rows owner ${bot.usageChannels.ownerAppliedRows} / external ${bot.usageChannels.externalAppliedRows}`;
    lines.push(`  ${oodSegment}; ${scopeSegment}; ${appliedSegment}`);
  }
  if ((report.missing ?? []).length > 0) {
    lines.push(`missing tables: ${report.missing.join(', ')}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { db: defaultDbPath(), days: 30, bot: null, today: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') options.db = argv[++index];
    else if (arg === '--days') options.days = Number(argv[++index]);
    else if (arg === '--bot') options.bot = Number(argv[++index]);
    else if (arg === '--today') options.today = argv[++index];
    else if (arg === '--json') options.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(options.db, { readOnly: true });
  try {
    const report = buildRrsiReport(db, { days: options.days, botId: options.bot, today: options.today });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatRrsiReport(report)}\n`);
    }
  } finally {
    db.close();
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`rrsi-evolution-report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
