/**
 * Dream-RSI exploration P1, commit 3 (design 2026-10-10 §4 + §6): the memory
 * reconciliation pass — schema columns, the 'disputed' status lifecycle, the
 * keep/narrow/merge/dispute host actions, and the pipeline placement between
 * re-review and promotion.
 *
 * Covers:
 *   1. schema — conditions_text/uncertainty_text columns, idempotent re-init,
 *      pre-existing rows read NULL,
 *   2. parser — fences, unknown ids/actions dropped, contract gates
 *      (conditions required unless dispute; merge needs a procedure ref),
 *      300-char field caps, camelCase alias,
 *   3. store actions — setCapabilityDraftConditions, narrowCapabilityDraft
 *      (host template, score untouched), listStaleDisputedCapabilityDrafts,
 *   4. disputed lifecycle — excluded from promotion and injection reads,
 *      re-enters validation with its conflict note, auto-rejects after 7
 *      nights,
 *   5. end-to-end — three-night loop: validate → dispute → re-enter →
 *      keep → promote with conditions/uncertainty; merge appends a pitfall
 *      and rejects the draft; grounding gate drops merges to non-candidates;
 *      the 5/night cap; telemetry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getColumns } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  buildCapabilityReconciliationPrompt,
  parseCapabilityReconciliationOutput,
  RECONCILE_MAX_DRAFTS_PER_NIGHT,
  RECONCILE_FIELD_MAX_CHARS,
} = require('../dist-electron/main/libs/capabilityReconciliationPrompt.js');
const { DISPUTED_AUTO_REJECT_DAYS } = require('../dist-electron/main/libs/capabilityValidationPrompt.js');

function loadDreamServiceModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');

const DAY1 = '2026-08-02';
const DAY2 = '2026-08-03';
const DAY3 = '2026-08-04';
const DAY1_START = new Date(2026, 7, 2).getTime();
const DAY2_START = new Date(2026, 7, 3).getTime();
const DAYMS = 86_400_000;
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const seedActivity = (coworkStore, db) => {
  const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m1', session.id, 'user', '视频做好了吗', '{}', DAY1_START + 1000, 1]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m2', session.id, 'assistant', '做好了,你看下', '{}', DAY1_START + 2000, 2]
  );
  return session;
};

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const dreamPayload = () => JSON.stringify({
  daily_summary: '普通的一天。',
  sections: {},
  work_reviews: [],
  important_memories: [],
  value_lessons: [],
  self_identity: LONG_IDENTITY,
  capability_learnings: [],
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('schema: capability_drafts gains conditions_text/uncertainty_text; idempotent; legacy rows NULL', async () => {
  const { db, store, userDataPath, cleanup } = await createSqliteStore();
  try {
    const columns = getColumns(db, 'capability_drafts');
    assert.ok(columns.includes('conditions_text'), 'missing conditions_text');
    assert.ok(columns.includes('uncertainty_text'), 'missing uncertainty_text');
    db.run(
      `INSERT INTO capability_drafts (metabot_id, dream_date, title, description, capability_type, status, created_at)
       VALUES (5, '2026-08-01', '技巧', '描述', 'skill', 'validated', 1)`,
    );
    // Re-running the whole schema pass is a no-op; legacy rows keep NULLs.
    store.initializeTables(userDataPath);
    const row = db.exec('SELECT conditions_text, uncertainty_text FROM capability_drafts')[0].values[0];
    assert.equal(row[0], null);
    assert.equal(row[1], null);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const VALID_IDS = new Set([1, 2, 3, 4, 5]);

test('parser accepts fenced JSON, camelCase alias, and drops unknown ids/actions', () => {
  const fenced = '```json\n' + JSON.stringify({
    verdicts: [
      { id: 1, action: 'keep', conditions: '交付前', uncertainty: '', conflicts_with: [], note: '稳' },
      { id: 2, action: 'dispute', conditions: '', uncertainty: '', conflictsWith: ['draft:1'], note: '冲突' },
      { id: 3, action: 'widen', conditions: 'x', note: '未知动作' },
      { id: 99, action: 'keep', conditions: 'x', note: '幽灵id' },
      { id: 1, action: 'dispute', note: '重复id被丢弃' },
    ],
  }) + '\n```';
  const parsed = parseCapabilityReconciliationOutput(fenced, VALID_IDS);
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.verdicts.map((v) => ({ id: v.id, action: v.action })),
    [
      { id: 1, action: 'keep' },
      { id: 2, action: 'dispute' },
    ],
  );
  assert.deepEqual(parsed.verdicts[1].conflictsWith, ['draft:1'], 'camelCase conflictsWith alias');
});

test('parser rejects empty, non-JSON, and verdict-less output', () => {
  assert.equal(parseCapabilityReconciliationOutput('', VALID_IDS).ok, false);
  assert.equal(parseCapabilityReconciliationOutput('no json', VALID_IDS).ok, false);
  assert.equal(parseCapabilityReconciliationOutput('{"foo":1}', VALID_IDS).ok, false);
  assert.equal(parseCapabilityReconciliationOutput('{"verdicts":[]}', VALID_IDS).ok, false);
});

test('parser enforces the contract: conditions required unless dispute; merge needs a procedure ref', () => {
  const parsed = parseCapabilityReconciliationOutput(JSON.stringify({
    verdicts: [
      { id: 1, action: 'keep', conditions: '', note: '没有条件' },
      { id: 2, action: 'narrow', uncertainty: 'u', note: '没有条件' },
      { id: 3, action: 'merge', conditions: 'c', conflicts_with: ['draft:1'], note: '只引用了草案' },
      { id: 4, action: 'merge', conditions: 'c', conflicts_with: ['procedure:abc'], note: '合法' },
      { id: 5, action: 'dispute', note: '无条件的 dispute 合法' },
    ],
  }), VALID_IDS);
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.verdicts.map((v) => [v.id, v.action]),
    [[4, 'merge'], [5, 'dispute']],
  );
});

test('parser caps conditions/uncertainty/note at 300 chars and shape-checks refs', () => {
  const long = '长'.repeat(400);
  const parsed = parseCapabilityReconciliationOutput(JSON.stringify({
    verdicts: [{
      id: 1,
      action: 'keep',
      conditions: long,
      uncertainty: long,
      conflicts_with: ['procedure:ok', 'bogus', 'draft:', 'draft:9'],
      note: long,
    }],
  }), VALID_IDS);
  assert.equal(parsed.ok, true);
  const verdict = parsed.verdicts[0];
  assert.equal(verdict.conditions.length, RECONCILE_FIELD_MAX_CHARS + 1, 'truncated to 300 + ellipsis');
  assert.equal(verdict.uncertainty.length, RECONCILE_FIELD_MAX_CHARS + 1);
  assert.equal(verdict.note.length, RECONCILE_FIELD_MAX_CHARS + 1);
  assert.deepEqual(verdict.conflictsWith, ['procedure:ok', 'draft:9']);
});

test('prompt renders drafts with their candidates and the source diaries', () => {
  const prompt = buildCapabilityReconciliationPrompt({
    botName: '小火',
    date: DAY1,
    drafts: [{ id: 7, dreamDate: '2026-08-01', title: '先验证再交付', description: 'd', capabilityType: 'workflow', validationScore: 0.9 }],
    conflictsByDraftId: new Map([[7, [{ ref: 'procedure:abc', kind: 'procedure', title: '交付清单', excerpt: '触发 / 步骤' }]]]),
    recentSummaries: [{ summaryDate: '2026-08-01', summaryText: '交付视频获赞' }],
  });
  assert.ok(prompt.system.includes('记忆核对'));
  assert.ok(prompt.system.includes('dispute'));
  assert.ok(prompt.user.includes('草案 #7'));
  assert.ok(prompt.user.includes('procedure:abc'));
  assert.ok(prompt.user.includes('[2026-08-01] 交付视频获赞'));
  const empty = buildCapabilityReconciliationPrompt({
    botName: '小火',
    date: DAY1,
    drafts: [{ id: 8, dreamDate: '2026-08-01', title: 't', description: 'd', capabilityType: 'skill', validationScore: null }],
    conflictsByDraftId: new Map(),
    recentSummaries: [],
  });
  assert.ok(empty.user.includes('没有找到标题/触发词重叠的既有记忆'));
});

// ---------------------------------------------------------------------------
// Store actions
// ---------------------------------------------------------------------------

test('keep/narrow store actions write conditions/uncertainty; narrow uses the host template', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '保留', description: '原始描述', capabilityType: 'skill' },
      { title: '收窄', description: '过宽的描述', capabilityType: 'skill' },
    ]);
    const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);

    // keep: columns only, description untouched.
    assert.equal(coworkStore.setCapabilityDraftConditions({
      id: byTitle('保留').id, metabotId: 5, conditionsText: '交付前', uncertaintyText: '未测过弱网',
    }), true);
    const kept = byTitle('保留');
    assert.equal(kept.conditionsText, '交付前');
    assert.equal(kept.uncertaintyText, '未测过弱网');
    assert.equal(kept.description, '原始描述');

    // narrow: host-template rewrite, columns set, score/status untouched.
    coworkStore.updateCapabilityDraftValidation({
      id: byTitle('收窄').id, metabotId: 5, status: 'validated', validationScore: 0.9,
    });
    assert.equal(coworkStore.narrowCapabilityDraft({
      id: byTitle('收窄').id, metabotId: 5, conditionsText: '仅视频交付', uncertaintyText: '未测过图文',
    }), true);
    const narrowed = byTitle('收窄');
    assert.equal(
      narrowed.description,
      '过宽的描述\nApplies when: 仅视频交付\nUntested: 未测过图文',
      'host template: original + Applies when + Untested',
    );
    assert.equal(narrowed.validationScore, 0.9, 'score unchanged');
    assert.equal(narrowed.status, 'validated');
    assert.equal(narrowed.conditionsText, '仅视频交付');

    // Guards: unknown ids / wrong bot / empty conditions refuse.
    assert.equal(coworkStore.setCapabilityDraftConditions({ id: 99999, metabotId: 5, conditionsText: 'x' }), false);
    assert.equal(coworkStore.narrowCapabilityDraft({ id: byTitle('收窄').id, metabotId: 999, conditionsText: 'x' }), false);
    assert.equal(coworkStore.narrowCapabilityDraft({ id: byTitle('收窄').id, metabotId: 5, conditionsText: '  ' }), false);
  } finally {
    cleanup();
  }
});

test('disputed drafts are excluded from promotion and the validated injection read', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    const DAYMS_LOCAL = 86_400_000;
    const old = Date.now() - 10 * DAYMS_LOCAL;
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '可晋升', description: 'd', capabilityType: 'skill' },
      { title: '存疑', description: 'd', capabilityType: 'skill' },
    ]);
    const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
    for (const title of ['可晋升', '存疑']) {
      coworkStore.updateCapabilityDraftValidation({ id: byTitle(title).id, metabotId: 5, status: 'validated', validationScore: 0.95 });
      db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [old, byTitle(title).id]);
    }
    coworkStore.updateCapabilityDraftValidation({
      id: byTitle('存疑').id, metabotId: 5, status: 'disputed', validationNotes: '与 procedure:9 冲突',
    });
    // The dispute stamps validated_at to now; restore the old timestamp so the
    // row WOULD be promotable by age — only the status must exclude it.
    db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [old, byTitle('存疑').id]);

    const promotable = coworkStore.listPromotableCapabilityDrafts(5, {
      minScore: 0.85, validatedBeforeMs: Date.now(), limit: 5,
    });
    assert.deepEqual(promotable.map((draft) => draft.title), ['可晋升'], 'disputed never promotes');

    const injectable = coworkStore.listCapabilityDrafts(5, { status: 'validated' });
    assert.deepEqual(injectable.map((draft) => draft.title), ['可晋升'], 'the <proven_techniques> read excludes disputed');
  } finally {
    cleanup();
  }
});

test('stale disputed drafts auto-reject after DISPUTED_AUTO_REJECT_DAYS via the nightly sweep', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  try {
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '超期存疑', description: 'd', capabilityType: 'skill' },
      { title: '新存疑', description: 'd', capabilityType: 'skill' },
    ]);
    const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
    for (const title of ['超期存疑', '新存疑']) {
      coworkStore.updateCapabilityDraftValidation({ id: byTitle(title).id, metabotId: 5, status: 'disputed', validationNotes: 'n' });
    }
    db.run(
      'UPDATE capability_drafts SET last_reviewed_at = ? WHERE id = ?',
      [Date.now() - (DISPUTED_AUTO_REJECT_DAYS + 1) * DAYMS, byTitle('超期存疑').id],
    );
    assert.equal(DISPUTED_AUTO_REJECT_DAYS, 7);

    // The sweep rides the validation pass; an empty day still runs it.
    const service = new DreamService({
      coworkStore,
      metabotStore: metabotStoreStub(),
      dreamStore,
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 7, 3, 3, 0),
      performChat: async () => { throw new Error('the sweep needs no LLM call when nothing is pending'); },
    });
    await service.runNow(5, DAY2);

    const stale = byTitle('超期存疑');
    assert.equal(stale.status, 'rejected');
    assert.match(stale.validationNotes, /auto-rejected/);
    assert.equal(byTitle('新存疑').status, 'disputed', 'fresh disputes survive');
    // The corpse is purgeable by the existing retention pass.
    assert.equal(coworkStore.purgeExpiredCapabilityDrafts({ cutoffMs: Date.now() + 1000 }), 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// End-to-end pipeline
// ---------------------------------------------------------------------------

test('three-night loop: validate → dispute → re-enter with evidence → keep → promote with conditions', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1000);
  seedActivity(coworkStore, db);

  const calls = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    metaidKnowledgeStore: knowledgeStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    // Subject is the reconciliation loop, not the gate — pin the legacy gate.
    capabilityGate: { panels: 1, prospective: false },
    performChat: async (system, user) => {
      calls.push({ system, user });
      if (system.includes('记忆核对')) {
        const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
        const night = calls.filter((call) => call.system.includes('能力验证')).length;
        return JSON.stringify({
          verdicts: ids.map((id) => night <= 1
            // Night 1: suspend with the conflict evidence.
            ? { id, action: 'dispute', conditions: '', uncertainty: '', conflicts_with: ['draft:999'], note: '与既有草案疑似冲突' }
            // Night 2: resolved — keep with conditions.
            : { id, action: 'keep', conditions: '仅视频交付场景', uncertainty: '图文流程未验证', conflicts_with: [], note: '核对通过' }),
        });
      }
      if (system.includes('能力验证')) {
        const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
        return JSON.stringify({
          verdicts: ids.map((id) => ({ id, verdict: 'validated', score: 0.95, rationale: '日记支撑' })),
        });
      }
      return dreamPayload();
    },
  });
  try {
    // Night 1: the dream distills one capability draft; the gate validates it;
    // reconciliation disputes it — nothing promotes.
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '发布前自检清单', description: '交付前对照清单逐项自检', capabilityType: 'workflow' },
    ]);
    await service.runNow(5, DAY1);
    const draft = () => coworkStore.listCapabilityDrafts(5)[0];
    assert.equal(draft().status, 'disputed', 'the reconciliation verdict suspends the draft');
    assert.match(draft().validationNotes, /reconciliation dispute/);
    assert.match(draft().validationNotes, /与既有草案疑似冲突/);
    assert.equal(knowledgeStore.listProcedures({ metabotId: 5, status: 'active' }).length, 0, 'nothing hardened');
    assert.deepEqual(
      dreamStore.getRun(5, DAY1).telemetry.reconciliation,
      { considered: 1, kept: 0, narrowed: 0, merged: 0, disputed: 1, scope: { general: 0, situational: 0, scorerFitted: 0, hardMarkerOverrides: 0 } },
    );

    // Night 2: the disputed draft re-enters the validation gate WITH its
    // conflict evidence; validated again, kept with conditions this time.
    await service.runNow(5, DAY2);
    const night2Validation = calls.find((call) => call.system.includes('能力验证') && call.user.includes('存疑待裁决'));
    assert.ok(night2Validation, 'disputed draft re-enters validation with its conflict note');
    assert.ok(night2Validation.user.includes('与既有草案疑似冲突'));
    assert.equal(draft().status, 'validated');
    assert.equal(draft().conditionsText, '仅视频交付场景');
    assert.equal(draft().uncertaintyText, '图文流程未验证');
    assert.deepEqual(
      dreamStore.getRun(5, DAY2).telemetry.reconciliation,
      { considered: 1, kept: 1, narrowed: 0, merged: 0, disputed: 0, scope: { general: 1, situational: 0, scorerFitted: 0, hardMarkerOverrides: 0 } },
    );

    // Night 3: with the verdict one calendar day old, the draft promotes — and
    // the procedure carries the conditions in its trigger and the uncertainty
    // in its pitfalls (design §4.4).
    db.run('UPDATE capability_drafts SET validated_at = ? WHERE id = ?', [DAY2_START, draft().id]);
    await service.runNow(5, DAY3);
    const procedures = knowledgeStore.listProcedures({ metabotId: 5, status: 'active' });
    assert.equal(procedures.length, 1);
    assert.equal(procedures[0].title, '发布前自检清单');
    assert.ok(procedures[0].triggerText.includes('适用条件:仅视频交付场景'), 'conditions ride the trigger');
    assert.deepEqual(procedures[0].pitfalls, ['Untested: 图文流程未验证'], 'uncertainty lands as an Untested pitfall');
    assert.equal(draft().promotedProcedureId, procedures[0].id);
  } finally {
    cleanup();
  }
});

test('merge: draft rejects with a merge note; the target procedure gains a reference pitfall; non-candidate merges drop', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1000);
  seedActivity(coworkStore, db);

  const covered = knowledgeStore.upsertProcedure({
    metabotId: 5, title: '发布前自检', triggerText: '发布前自检', steps: ['逐项自检'], origin: 'dream',
  }).entry;
  // An unrelated procedure the model might hallucinate as a merge target.
  const unrelated = knowledgeStore.upsertProcedure({
    metabotId: 5, title: '完全无关的流程', triggerText: 'zzz', steps: ['别的事'], origin: 'dream',
  }).entry;

  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '发布前自检清单', description: '交付前逐项自检', capabilityType: 'workflow' },
    { title: '弱网交付压力测试', description: '弱网环境重跑交付流程', capabilityType: 'workflow' },
  ]);
  const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
  const mergeId = byTitle('发布前自检清单').id;
  const dropId = byTitle('弱网交付压力测试').id;

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    metaidKnowledgeStore: knowledgeStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    // Subject is the merge semantics, not the gate — pin the legacy gate.
    capabilityGate: { panels: 1, prospective: false },
    performChat: async (system) => {
      if (system.includes('记忆核对')) {
        return JSON.stringify({
          verdicts: [
            { id: mergeId, action: 'merge', conditions: '交付前', uncertainty: '', conflicts_with: [`procedure:${covered.id}`], note: '已被覆盖' },
            // Hallucinated target: never presented as a candidate → dropped.
            { id: dropId, action: 'merge', conditions: '弱网', uncertainty: '', conflicts_with: [`procedure:${unrelated.id}`], note: '幻觉引用' },
          ],
        });
      }
      if (system.includes('能力验证')) {
        return JSON.stringify({
          verdicts: [mergeId, dropId].map((id) => ({ id, verdict: 'validated', score: 0.95, rationale: '日记支撑' })),
        });
      }
      return dreamPayload();
    },
  });
  try {
    await service.runNow(5, DAY1);

    const merged = byTitle('发布前自检清单');
    assert.equal(merged.status, 'rejected', 'merged drafts leave the validated pool');
    assert.match(merged.validationNotes, new RegExp(`merged into procedure:${covered.id}`));
    const procedureAfter = knowledgeStore.getProcedure(covered.id);
    assert.ok(
      procedureAfter.pitfalls.some((line) => line.includes(`Merged dream draft #${merged.id}`)),
      'the target procedure gains a reference pitfall',
    );

    const dropped = byTitle('弱网交付压力测试');
    assert.equal(dropped.status, 'validated', 'a merge to a non-candidate never executes');
    assert.ok(!knowledgeStore.getProcedure(unrelated.id).pitfalls.length, 'the unrelated procedure is untouched');
    assert.deepEqual(
      dreamStore.getRun(5, DAY1).telemetry.reconciliation,
      { considered: 2, kept: 0, narrowed: 0, merged: 1, disputed: 0, scope: { general: 0, situational: 0, scorerFitted: 0, hardMarkerOverrides: 0 } },
    );
  } finally {
    cleanup();
  }
});

test('reconciliation considers at most RECONCILE_MAX_DRAFTS_PER_NIGHT drafts, highest score first', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  assert.equal(RECONCILE_MAX_DRAFTS_PER_NIGHT, 5);

  const titles = ['甲等', '乙等', '丙等', '丁等', '戊等', '己等', '庚等'];
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', titles.map((title) => ({
    title, description: `d-${title}`, capabilityType: 'skill',
  })));
  // Scores: 甲等 0.99 … 庚等 0.93 — the top 5 must win the cap.
  const scoreByTitle = new Map(titles.map((title, index) => [title, 0.99 - index * 0.01]));
  const reconcileCalls = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    // Subject is the per-night reconciliation cap, not the gate.
    capabilityGate: { panels: 1, prospective: false },
    performChat: async (system, user) => {
      if (system.includes('记忆核对')) {
        reconcileCalls.push(user);
        const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
        return JSON.stringify({
          verdicts: ids.map((id) => ({ id, action: 'keep', conditions: 'c', uncertainty: 'u', conflicts_with: [], note: 'n' })),
        });
      }
      if (system.includes('能力验证')) {
        const verdicts = [...user.matchAll(/### 草案 #(\d+)[\s\S]*?标题:([^\n]+)/g)].map((match) => ({
          id: Number(match[1]),
          verdict: 'validated',
          score: scoreByTitle.get(match[2]) ?? 0.5,
          rationale: 'r',
        }));
        return JSON.stringify({ verdicts });
      }
      return dreamPayload();
    },
  });
  try {
    await service.runNow(5, DAY1);
    assert.equal(reconcileCalls.length, 1);
    const reconciledTitles = [...reconcileCalls[0].matchAll(/标题:([^\n]+)/g)].map((match) => match[1]);
    assert.deepEqual(reconciledTitles, titles.slice(0, 5), 'top-5 by score face the memory bank');
    const telemetry = dreamStore.getRun(5, DAY1).telemetry;
    assert.equal(telemetry.reconciliation.considered, 5);
    assert.equal(telemetry.reconciliation.kept, 5);
    // The two drafts beyond the cap got no conditions tonight.
    const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
    assert.equal(byTitle('甲等').conditionsText, 'c');
    assert.equal(byTitle('己等').conditionsText, null, 'beyond the cap: untouched tonight');
    assert.equal(byTitle('庚等').conditionsText, null);
  } finally {
    cleanup();
  }
});

test('an unparseable reconciliation output leaves the drafts validated and the run green', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '技巧', description: 'd', capabilityType: 'skill' },
  ]);
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    // Subject is the reconciliation parse failure, not the gate.
    capabilityGate: { panels: 1, prospective: false },
    performChat: async (system) => {
      if (system.includes('记忆核对')) return 'not json at all';
      if (system.includes('能力验证')) {
        return JSON.stringify({ verdicts: [{ id: 1, verdict: 'validated', score: 0.95, rationale: 'r' }] });
      }
      return dreamPayload();
    },
  });
  try {
    await service.runNow(5, DAY1);
    const draft = coworkStore.listCapabilityDrafts(5)[0];
    assert.equal(draft.status, 'validated', 'parse failure never strands a validated draft');
    assert.equal(draft.conditionsText, null);
    assert.equal(dreamStore.getRun(5, DAY1).status, 'completed');
    assert.deepEqual(
      dreamStore.getRun(5, DAY1).telemetry.reconciliation,
      { considered: 1, kept: 0, narrowed: 0, merged: 0, disputed: 0, scope: { general: 0, situational: 0, scorerFitted: 0, hardMarkerOverrides: 0 } },
      'considered counts the batch even when nothing parses',
    );
  } finally {
    cleanup();
  }
});
