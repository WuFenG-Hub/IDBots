/**
 * RRSI evolution P5 (design §6.5 P5.1): the pure instance-marker detector —
 * pin ids, txids, GlobalMetaIDs, UUIDs, ISO dates — plus scope normalization
 * and the compact marker rendering shown to the reconciliation panel.
 *
 * Covers:
 *   1. detection vectors — each kind, boundaries (CJK neighbors, 63/66 hex),
 *      a pin's hex part never double-counted as a txid, case-insensitive with
 *      lowercased values, ordering by first occurrence, duplicate removal,
 *   2. titleHasHardInstanceMarker,
 *   3. formatInstanceMarkers — labels, short forms, the maxShown overflow,
 *   4. normalizeCapabilityScope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getColumns } from './memoryTestUtils.mjs';
import { MARKERS, createDreamHarness, dayStartMs, dreamJson, seedSession, validationVerdicts } from './fixtures/rrsiDreamHarness.mjs';

const require = Module.createRequire(import.meta.url);

const {
  detectInstanceMarkers,
  titleHasHardInstanceMarker,
  formatInstanceMarkers,
  normalizeCapabilityScope,
} = require('../dist-electron/main/libs/capabilitySpecificity.js');
const {
  buildCapabilityReconciliationPrompt,
  parseCapabilityReconciliationOutput,
} = require('../dist-electron/main/libs/capabilityReconciliationPrompt.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');

const PIN = '3f225f43dde31ed107fdaf6c49ed9eba4bfa60ddd563186e5abc0fbabb5495edi0';
const TX = '5d45547839dacb7d1872fb5e9f4d821a7cc46d433141b0f458c1ae5553691c8a';
const GM = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
const HEX_63 = '5d45547839dacb7d1872fb5e9f4d821a7cc46d433141b0f458c1ae5553691c';
const HEX_66 = '5d45547839dacb7d1872fb5e9f4d821a7cc46d433141b0f458c1ae5553691c8a0d';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

test('detects a pin id and never reports its hex part as a txid', () => {
  assert.deepEqual(detectInstanceMarkers(`引用 ${PIN}`), [{ kind: 'pin', value: PIN }]);
});

test('txid requires exactly 64 hex chars at word boundaries', () => {
  assert.deepEqual(detectInstanceMarkers(TX), [{ kind: 'txid', value: TX }]);
  assert.deepEqual(detectInstanceMarkers(HEX_63), []);
  assert.deepEqual(detectInstanceMarkers(HEX_66), []);
});

test('globalmetaid needs the idq1 prefix and at least 20 more chars', () => {
  assert.deepEqual(detectInstanceMarkers(GM), [{ kind: 'globalmetaid', value: GM }]);
  assert.deepEqual(detectInstanceMarkers('idq1short'), []);
});

test('uuid matches the canonical 8-4-4-4-12 hex shape', () => {
  assert.deepEqual(detectInstanceMarkers(UUID), [{ kind: 'uuid', value: UUID.toLowerCase() }]);
});

test('an ISO date matches with CJK neighbors as boundaries', () => {
  assert.deepEqual(detectInstanceMarkers('在2026-08-02交付'), [{ kind: 'date', value: '2026-08-02' }]);
});

test('detection is case-insensitive and lowercases values (dates excepted)', () => {
  assert.deepEqual(detectInstanceMarkers(PIN.toUpperCase()), [{ kind: 'pin', value: PIN }]);
});

test('mixed text: kinds ordered by first occurrence, duplicates removed', () => {
  const mixed = `给 ${GM} 的订单 ${TX} 在 2026-08-02,再看 ${TX}`;
  assert.deepEqual(
    detectInstanceMarkers(mixed).map((marker) => marker.kind),
    ['globalmetaid', 'txid', 'date'],
  );
});

test('plain lessons carry no markers; a marker in the title is hard', () => {
  assert.deepEqual(detectInstanceMarkers('先验证再交付'), []);
  assert.equal(titleHasHardInstanceMarker(`给 ${GM} 先发预览`), true);
});

test('formatInstanceMarkers: labels, short forms, overflow, empty', () => {
  const mixed = `给 ${GM} 的订单 ${TX} 在 2026-08-02,再看 ${TX}`;
  assert.equal(
    formatInstanceMarkers(detectInstanceMarkers(mixed)),
    'GlobalMetaID idq14hmv23…;txid 5d455478…;日期 2026-08-02',
  );
  assert.equal(formatInstanceMarkers([]), '无');
  const dates = Array.from({ length: 8 }, (_, index) => ({
    kind: 'date',
    value: `2026-01-0${index + 1}`,
  }));
  assert.equal(
    formatInstanceMarkers(dates, 6),
    '日期 2026-01-01;日期 2026-01-02;日期 2026-01-03;日期 2026-01-04;日期 2026-01-05;日期 2026-01-06;等 8 个',
  );
  assert.equal(
    formatInstanceMarkers(detectInstanceMarkers(`引用 ${PIN}`)),
    'pin 3f225f43…i0',
  );
});

test('normalizeCapabilityScope: trims, lowercases, maps dashes to underscores', () => {
  assert.equal(normalizeCapabilityScope('Scorer-Fitted'), 'scorer_fitted');
  assert.equal(normalizeCapabilityScope(' Situational '), 'situational');
  assert.equal(normalizeCapabilityScope('GENERAL'), 'general');
  assert.equal(normalizeCapabilityScope('local'), null);
  assert.equal(normalizeCapabilityScope(''), null);
  assert.equal(normalizeCapabilityScope(null), null);
});

// ---------------------------------------------------------------------------
// Store: the scope column and the technique-roster exclusion (RRSI P5 Task 2)
// ---------------------------------------------------------------------------

test('store: scope column migrates idempotently and legacy rows read scope null', async () => {
  const { db, store, userDataPath, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    assert.ok(getColumns(db, 'capability_drafts').includes('scope'));
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '旧草案', description: 'd', capabilityType: 'skill' },
    ]);
    // Running the whole schema pass again is a no-op; legacy rows keep NULL.
    store.initializeTables(userDataPath);
    store.initializeTables(userDataPath);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    assert.equal(draft.scope, null);
  } finally {
    cleanup();
  }
});

test('store: setCapabilityDraftScope round-trips; unknown ids refuse', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '范围草案', description: 'd', capabilityType: 'skill' },
    ]);
    const draft = () => coworkStore.listCapabilityDrafts(5)[0];
    assert.equal(
      coworkStore.setCapabilityDraftScope({ id: draft().id, metabotId: 5, scope: 'situational' }),
      true,
    );
    assert.equal(draft().scope, 'situational');
    assert.equal(
      coworkStore.setCapabilityDraftScope({ id: draft().id, metabotId: 5, scope: 'scorer_fitted' }),
      true,
    );
    assert.equal(draft().scope, 'scorer_fitted');
    assert.equal(coworkStore.setCapabilityDraftScope({ id: draft().id, metabotId: 5, scope: 'general' }), true);
    assert.equal(draft().scope, 'general');
    // Wrong bot / missing row refuse (no row changes).
    assert.equal(coworkStore.setCapabilityDraftScope({ id: draft().id, metabotId: 999, scope: 'general' }), false);
    assert.equal(coworkStore.setCapabilityDraftScope({ id: 99999, metabotId: 5, scope: 'general' }), false);
    // An unknown stored scope text reads back as null (mapper normalizes).
    db.run("UPDATE capability_drafts SET scope = 'weird' WHERE id = ?", [draft().id]);
    assert.equal(draft().scope, null);
  } finally {
    cleanup();
  }
});

test('store: listInjectableTechniques excludes situational drafts, keeps general and unassessed', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '通用技巧', description: 'd', capabilityType: 'skill' },
      { title: '特定对象技巧', description: 'd', capabilityType: 'skill' },
      { title: '未评估技巧', description: 'd', capabilityType: 'skill' },
    ]);
    const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((entry) => entry.title === title);
    for (const title of ['通用技巧', '特定对象技巧', '未评估技巧']) {
      coworkStore.updateCapabilityDraftValidation({ id: byTitle(title).id, metabotId: 5, status: 'validated', validationScore: 0.9 });
    }
    coworkStore.setCapabilityDraftScope({ id: byTitle('通用技巧').id, metabotId: 5, scope: 'general' });
    coworkStore.setCapabilityDraftScope({ id: byTitle('特定对象技巧').id, metabotId: 5, scope: 'situational' });

    const roster = coworkStore.listInjectableTechniques(5, 10);
    const titles = roster.map((entry) => entry.title);
    assert.ok(!titles.includes('特定对象技巧'), 'situational never rides <proven_techniques>');
    assert.ok(titles.includes('通用技巧'));
    assert.ok(titles.includes('未评估技巧'), 'scope NULL behaves exactly like general');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Reconciliation scope verdict, host marker rule, situational promotion (P5 T3)
// ---------------------------------------------------------------------------

const PIN_FLOW = '3f225f43dde31ed107fdaf6c49ed9eba4bfa60ddd563186e5abc0fbabb5495edi0';
const GM_FLOW = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
const D1 = '2026-08-02';
const D2 = '2026-08-03';
const D3 = '2026-08-04';
const DAYMS = 86_400_000;

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

const validationCallsOf = (router) => router.calls.filter((call) => call.system.includes(MARKERS.validation));

const distillOnD1 = async (h, learning) => {
  seedSession(h.coworkStore, h.db, D1, [
    { type: 'user', content: '视频好了吗' },
    { type: 'assistant', content: '好了' },
  ]);
  h.router.setFallback(() => dreamJson({ capability_learnings: [learning] }));
  await h.runNight(D1);
};

const validateOnD2 = (h) => {
  seedSession(h.coworkStore, h.db, D2, [
    { type: 'user', content: '上次那样交付很棒' },
    { type: 'assistant', content: '谢谢' },
  ]);
  h.router.setFallback(() => dreamJson({ daily_summary: '交付后用户点赞。' }));
  h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
    verdict: 'validated', score: 0.9, rationale: '2026-08-03 日记显示照做后获赞',
  })));
};

test('reconciliation prompt carries the scope rules and the per-draft marker line', () => {
  const withMarkers = buildCapabilityReconciliationPrompt({
    botName: '小火',
    date: D2,
    drafts: [{
      id: 7, dreamDate: D1, title: '对特殊订单建核对单', description: `订单 ${PIN_FLOW} 交付前单独核对`,
      capabilityType: 'workflow', validationScore: 0.9,
    }],
    conflictsByDraftId: new Map(),
    recentSummaries: [],
  });
  assert.ok(withMarkers.system.includes('scope'));
  assert.ok(withMarkers.system.includes('general'));
  assert.ok(withMarkers.system.includes('situational'));
  assert.ok(withMarkers.system.includes('scorer_fitted'));
  assert.ok(withMarkers.user.includes('实例标记:pin 3f225f43…i0'));
  const clean = buildCapabilityReconciliationPrompt({
    botName: '小火',
    date: D2,
    drafts: [{
      id: 8, dreamDate: D1, title: '先验证再交付', description: '交付前自检一遍',
      capabilityType: 'workflow', validationScore: 0.9,
    }],
    conflictsByDraftId: new Map(),
    recentSummaries: [],
  });
  assert.ok(clean.user.includes('实例标记:无'));
  assert.ok(clean.user.includes('"scope": "general" | "situational" | "scorer_fitted"', 'contract carries the scope field'));
});

test('parser: scope coerces case/dash, defaults to general, drop rules unchanged', () => {
  const base = { conditions: '交付前', uncertainty: '', conflicts_with: [], note: 'n' };
  const situational = parseCapabilityReconciliationOutput(JSON.stringify({
    verdicts: [{ id: 1, action: 'keep', scope: 'Situational', ...base }],
  }), new Set([1]));
  assert.equal(situational.verdicts[0].scope, 'situational');
  const missing = parseCapabilityReconciliationOutput(JSON.stringify({
    verdicts: [{ id: 1, action: 'keep', ...base }],
  }), new Set([1]));
  assert.equal(missing.verdicts[0].scope, 'general');
  const unknown = parseCapabilityReconciliationOutput(JSON.stringify({
    verdicts: [{ id: 1, action: 'keep', scope: 'local', ...base }],
  }), new Set([1]));
  assert.equal(unknown.verdicts[0].scope, 'general');
  // Existing drop rule: a keep without conditions is still dropped entirely.
  const dropped = parseCapabilityReconciliationOutput(JSON.stringify({
    verdicts: [{ id: 1, action: 'keep', scope: 'situational', conditions: '', note: 'n' }],
  }), new Set([1]));
  assert.equal(dropped.ok, false, 'contract gate unchanged by the scope field');
});

test('flow: keep + situational keeps the draft validated but off every injection roster', async () => {
  const h = await createDreamHarness();
  try {
    await distillOnD1(h, {
      title: '对特殊订单建核对单',
      description: `订单 ${PIN_FLOW} 交付前单独建一张核对单`,
      capability_type: 'workflow',
    });
    validateOnD2(h);
    h.router.on(MARKERS.reconciliation, ({ user }) => {
      const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
      return {
        verdicts: ids.map((id) => ({
          id, action: 'keep', scope: 'situational', conditions: '仅该客户的订单', uncertainty: '', conflicts_with: [], note: '只对该订单成立',
        })),
      };
    });
    await h.runNight(D2);

    const draft = h.coworkStore.listCapabilityDrafts(5)[0];
    assert.equal(draft.status, 'validated', 'situational never changes the status');
    assert.equal(draft.scope, 'situational');
    assert.deepEqual(
      h.coworkStore.listInjectableTechniques(5, 10).map((entry) => entry.title),
      [],
      'absent from listInjectableTechniques',
    );
    const { CoworkRunner } = loadRunnerModule();
    const runner = new CoworkRunner(h.coworkStore, { knowledgeStore: h.knowledgeStore });
    const session = h.coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
    const block = runner.buildExperiencePromptBlocksXml(session.id);
    assert.ok(!block.includes('对特殊订单建核对单'), 'absent from <proven_techniques> in the runner prompt');
    assert.equal(h.telemetry(D2)?.reconciliation?.scope?.situational, 1);
    assert.equal(h.telemetry(D2)?.reconciliation?.kept, 1);
  } finally {
    h.cleanup();
  }
});

test('flow: a hard marker in the title overrides a general verdict', async () => {
  const h = await createDreamHarness();
  try {
    await distillOnD1(h, {
      title: `给 ${GM_FLOW} 先发预览`,
      description: '交付前先给这位客户发预览',
      capability_type: 'workflow',
    });
    validateOnD2(h);
    h.router.on(MARKERS.reconciliation, ({ user }) => {
      const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
      return {
        verdicts: ids.map((id) => ({
          id, action: 'keep', scope: 'general', conditions: '交付前', uncertainty: '', conflicts_with: [], note: '通用做法',
        })),
      };
    });
    await h.runNight(D2);

    const draft = h.coworkStore.listCapabilityDrafts(5)[0];
    assert.equal(draft.scope, 'situational', 'the host rule wins over the panel verdict');
    const scope = h.telemetry(D2)?.reconciliation?.scope;
    assert.equal(scope.hardMarkerOverrides, 1);
    assert.equal(scope.general, 0);
    assert.equal(scope.situational, 1);
  } finally {
    h.cleanup();
  }
});

test('flow: the host marker rule still runs when the reconciliation output is unparseable', async () => {
  const h = await createDreamHarness();
  try {
    await distillOnD1(h, {
      title: `给 ${GM_FLOW} 先发预览`,
      description: '交付前先给这位客户发预览',
      capability_type: 'workflow',
    });
    validateOnD2(h);
    h.router.on(MARKERS.reconciliation, () => 'not json');
    await h.runNight(D2);

    const draft = h.coworkStore.listCapabilityDrafts(5)[0];
    assert.equal(draft.status, 'validated', 'parse failure never strands a validated draft');
    assert.equal(draft.scope, 'situational', 'the marker rule runs without a verdict');
    assert.equal(h.telemetry(D2)?.reconciliation?.scope?.hardMarkerOverrides, 1);
  } finally {
    h.cleanup();
  }
});

test('flow: scorer_fitted moves the draft to disputed and re-enters validation next night', async () => {
  const h = await createDreamHarness();
  try {
    await distillOnD1(h, {
      title: '多写客套话拿好评',
      description: '回复里多写客套话能拿到好评',
      capability_type: 'communication',
    });
    validateOnD2(h);
    h.router.on(MARKERS.reconciliation, ({ user }) => {
      const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
      return {
        verdicts: ids.map((id) => ({
          id, action: 'keep', scope: 'scorer_fitted', conditions: '回复时', uncertainty: '', conflicts_with: [], note: '只是讨好评分',
        })),
      };
    });
    await h.runNight(D2);

    const draft = h.coworkStore.listCapabilityDrafts(5)[0];
    assert.equal(draft.status, 'disputed');
    assert.ok(draft.validationNotes.startsWith('reconciliation scorer_fitted'), draft.validationNotes);
    assert.equal(draft.scope, 'scorer_fitted');
    assert.deepEqual(h.coworkStore.listFalsifiedHypotheses(5), [], 'no falsified-ledger row');
    assert.equal(h.telemetry(D2)?.reconciliation?.scope?.scorerFitted, 1);
    assert.equal(h.telemetry(D2)?.reconciliation?.disputed, 1);

    // Next night the disputed draft re-enters the validation gate (both panels).
    const before = validationCallsOf(h.router).length;
    seedSession(h.coworkStore, h.db, D3, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好的' },
    ]);
    h.router.setFallback(() => dreamJson({}));
    h.router.on(MARKERS.reconciliation, () => 'not json');
    await h.runNight(D3);
    const d3Validation = validationCallsOf(h.router).slice(before);
    assert.equal(d3Validation.length, 2, 'both panels see the disputed draft');
    for (const call of d3Validation) {
      assert.ok(call.user.includes(`草案 #${draft.id}`), 'its id appears in both 能力验证 prompts');
    }
  } finally {
    h.cleanup();
  }
});

test('promotion: a situational draft hardens recall-only with the situational status line', async () => {
  const h = await createDreamHarness();
  try {
    h.coworkStore.insertCapabilityDrafts(5, D1, [
      { title: '特殊渠道交付核对', description: '从特殊渠道交付前单独核对', capabilityType: 'workflow' },
    ]);
    const draft = h.coworkStore.listCapabilityDrafts(5)[0];
    h.coworkStore.updateCapabilityDraftValidation({
      id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9,
    });
    h.db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [new Date(2026, 7, 1).getTime(), draft.id]);
    h.coworkStore.setCapabilityDraftScope({ id: draft.id, metabotId: 5, scope: 'situational' });

    await h.runNight(D2);

    const procedures = h.knowledgeStore.listProcedures({ metabotId: 5, status: 'active' });
    assert.equal(procedures.length, 1);
    assert.equal(procedures[0].hotEligible, false);
    assert.equal(procedures[0].hotReason, 'situational');
    assert.deepEqual(h.knowledgeStore.listHotProcedures(5), [], 'never hot');
    assert.equal(h.coworkStore.listCapabilityDrafts(5)[0].promotedProcedureId, procedures[0].id);

    const { CoworkRunner } = loadRunnerModule();
    const runner = new CoworkRunner(h.coworkStore, { knowledgeStore: h.knowledgeStore });
    const session = h.coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
    const recalled = runner.runProcedureRecallTool({ query: '核对' }, session.id);
    assert.equal(recalled.isError, false);
    assert.ok(recalled.text.includes('status: only held in a specific situation'), recalled.text);
    const block = runner.buildExperiencePromptBlocksXml(session.id);
    const proceduresSection = block.slice(
      block.indexOf('<procedures>'),
      block.indexOf('</procedures>') + '</procedures>'.length,
    );
    assert.ok(!proceduresSection.includes('特殊渠道交付核对'), 'absent from <procedures>');
  } finally {
    h.cleanup();
  }
});

test('promotion: a situational draft never demotes an existing hot namesake procedure', async () => {
  const h = await createDreamHarness();
  try {
    const hot = h.knowledgeStore.upsertProcedure({
      metabotId: 5, title: '特殊渠道交付核对', triggerText: '特殊渠道交付时', steps: ['核对一遍'], origin: 'dream',
    }).entry;
    h.coworkStore.insertCapabilityDrafts(5, D1, [
      { title: '特殊渠道交付核对', description: '从特殊渠道交付前单独核对', capabilityType: 'workflow' },
    ]);
    const draft = h.coworkStore.listCapabilityDrafts(5)[0];
    h.coworkStore.updateCapabilityDraftValidation({
      id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9,
    });
    h.db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [new Date(2026, 7, 1).getTime(), draft.id]);
    h.coworkStore.setCapabilityDraftScope({ id: draft.id, metabotId: 5, scope: 'situational' });

    await h.runNight(D2);

    const after = h.knowledgeStore.getProcedure(hot.id);
    assert.equal(after.hotEligible, true, 'the existing general procedure stays hot');
    assert.equal(after.hotReason, null);
    assert.ok(h.knowledgeStore.listHotProcedures(5).some((entry) => entry.id === hot.id));
    assert.equal(h.coworkStore.listCapabilityDrafts(5)[0].promotedProcedureId, hot.id, 'the draft still promoted into it');
  } finally {
    h.cleanup();
  }
});

test('promotion: a situational probation ticket leaves its source recall-only, never hot', async () => {
  const h = await createDreamHarness();
  try {
    const saved = h.knowledgeStore.upsertProcedure({
      metabotId: 5, title: '试用中的特殊渠道流程', triggerText: '当用户要求时', steps: ['先核对'], sourcePinIds: [], origin: 'agent',
    });
    assert.equal(saved.needsGate, true, 'an agent save starts in probation');
    const ticket = h.coworkStore.ensureProbationDraftForProcedure({
      metabotId: 5, procedureId: saved.entry.id, title: '试用中的特殊渠道流程',
      description: '触发:当用户要求时\n步骤:先核对', dreamDate: D1,
    });
    h.coworkStore.updateCapabilityDraftValidation({
      id: ticket.draftId, metabotId: 5, status: 'validated', validationScore: 0.9,
    });
    h.db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [dayStartMs(D1), ticket.draftId]);
    h.coworkStore.setCapabilityDraftScope({ id: ticket.draftId, metabotId: 5, scope: 'situational' });

    await h.runNight(D2);

    const procedure = h.knowledgeStore.getProcedure(saved.entry.id);
    assert.equal(procedure.status, 'active');
    assert.equal(procedure.hotEligible, false, 'the source never turns hot');
    assert.equal(procedure.hotReason, 'situational');
    const draft = h.coworkStore.listCapabilityDrafts(5).find((row) => row.id === ticket.draftId);
    assert.equal(draft.promotedProcedureId, saved.entry.id, 'promoted with the source id');
    assert.equal(h.telemetry(D2)?.promotionBudget?.promoted, 1, 'counted against the night budget');
  } finally {
    h.cleanup();
  }
});
