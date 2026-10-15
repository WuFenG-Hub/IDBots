import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  MARKERS,
  createDreamHarness,
  dreamJson,
  seedSession,
  validationVerdicts,
} from './fixtures/rrsiDreamHarness.mjs';

const require = createRequire(import.meta.url);
const { buildCapabilityValidationPrompt } = require('../dist-electron/main/libs/capabilityValidationPrompt.js');
const { DISPUTED_AUTO_REJECT_DAYS } = require('../dist-electron/main/libs/capabilityValidationPrompt.js');

const D1 = '2026-08-02';
const D2 = '2026-08-03';
const D3 = '2026-08-04';
const DAYMS = 86_400_000;

const draftIdsIn = (user) => [...user.matchAll(/### 草案 #(\d+)/g)].map((match) => Number(match[1]));
const validationCallsOf = (router) => router.calls.filter((call) => call.system.includes(MARKERS.validation));
const reconciliationKeep = (user) => {
  const ids = [...user.matchAll(/草案 #(\d+)/g)].map((match) => Number(match[1]));
  return {
    verdicts: ids.map((id) => ({ id, action: 'keep', conditions: '交付前', uncertainty: '', conflicts_with: [], note: 'n' })),
  };
};

test('prospective rule lines ride the prompt only when requested', () => {
  const base = {
    botName: '小火',
    date: '2026-08-03',
    drafts: [
      { id: 7, dreamDate: '2026-08-02', title: '先验证再交付', description: '交付前自检', capabilityType: 'workflow' },
    ],
    recentSummaries: [{ summaryDate: '2026-08-03', summaryText: '交付后用户点赞' }],
  };
  const prospective = buildCapabilityValidationPrompt({ ...base, prospective: true });
  assert.ok(prospective.system.includes('独立证据规则'));
  assert.ok(prospective.user.includes('较晚日记的日期'));

  const legacy = buildCapabilityValidationPrompt(base);
  assert.ok(!legacy.system.includes('独立证据规则'), 'old callers keep the unchanged prompt');
  assert.ok(!legacy.user.includes('较晚日记的日期'), 'old callers keep the unchanged prompt');
  // Regression: the blank line separating the last section from the output
  // contract is unconditional (branch-point shape), never folded into the
  // falsified-marks branch.
  assert.ok(
    legacy.user.includes('\n\n## 输出契约(严格只输出一个 JSON 对象,不要输出任何其他文字)'),
    'the output contract is always preceded by a blank line',
  );
});

test('similar falsified hypotheses render per draft plus the judging rule', () => {
  const withFalsified = buildCapabilityValidationPrompt({
    botName: '小火',
    date: '2026-08-03',
    drafts: [
      {
        id: 7,
        dreamDate: '2026-08-02',
        title: '先验证再交付',
        description: '交付前自检',
        capabilityType: 'workflow',
        similarFalsified: { title: '先验证再交付', reason: '照做后被差评', falsifiedDate: '2026-07-20' },
      },
    ],
    recentSummaries: [{ summaryDate: '2026-08-03', summaryText: '交付后用户点赞' }],
    prospective: true,
  });
  assert.ok(withFalsified.user.includes('曾被证伪的相似做法:「先验证再交付」(2026-07-20 否决:照做后被差评)'));
  assert.ok(withFalsified.user.includes('标注了「曾被证伪的相似做法」的草案:除非日记里出现了那次否决日期之后的新证据,否则不得判 validated。'));

  const withoutFalsified = buildCapabilityValidationPrompt({
    botName: '小火',
    date: '2026-08-03',
    drafts: [
      { id: 7, dreamDate: '2026-08-02', title: '先验证再交付', description: '交付前自检', capabilityType: 'workflow' },
    ],
    recentSummaries: [{ summaryDate: '2026-08-03', summaryText: '交付后用户点赞' }],
    prospective: true,
  });
  assert.ok(!withoutFalsified.user.includes('曾被证伪的相似做法'));
  assert.ok(!withoutFalsified.user.includes('标注了「曾被证伪的相似做法」'));
});

// ---------------------------------------------------------------------------
// Fresh-draft gate flows (RRSI P1 Task 5)
// ---------------------------------------------------------------------------

test('flow: a draft distilled tonight is not judged tonight', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '先验证再交付', description: '交付前自检一遍', capability_type: 'workflow' },
      ],
    }));
    await h.runNight(D1);
    assert.equal(validationCallsOf(h.router).length, 0, 'no validation call on the distill night');
    const drafts = h.coworkStore.listCapabilityDrafts(5, { status: 'draft' });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].title, '先验证再交付');
    assert.equal(h.telemetry(D1)?.validation?.deferredSameNight, 1);
  } finally {
    h.cleanup();
  }
});

test('flow: next-night validation requires a later citation on both panels', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '先验证再交付', description: '交付前自检一遍', capability_type: 'workflow' },
        { title: '交付前列清单', description: '列一张交付前检查清单', capability_type: 'workflow' },
      ],
    }));
    await h.runNight(D1);

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '上次那样交付很棒' },
      { type: 'assistant', content: '谢谢' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '交付后用户点赞。' }));
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'validated', score: 0.9, rationale: '2026-08-03 日记显示照做后获赞',
    })));
    h.router.on(MARKERS.reconciliation, ({ user }) => reconciliationKeep(user));
    await h.runNight(D2);

    const calls = validationCallsOf(h.router);
    assert.equal(calls.length, 2, 'panel A and panel B each call once');
    assert.deepEqual(draftIdsIn(calls[0].user), [...draftIdsIn(calls[1].user)].reverse(), 'panel B sees the drafts reversed');

    const validated = h.coworkStore.listCapabilityDrafts(5, { status: 'validated' });
    assert.equal(validated.length, 2);
    for (const draft of validated) {
      assert.equal(draft.validationScore, 0.9, 'agreed score is the minimum of both panels');
      assert.equal(draft.validationNotes, '2026-08-03 日记显示照做后获赞', 'identical rationales collapse');
    }
    assert.deepEqual(
      h.telemetry(D2)?.validation?.panels,
      { agreed: 2, disagreed: 0, incomplete: 0 },
    );
  } finally {
    h.cleanup();
  }
});

test('flow: an own-date citation is downgraded before any state change', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '先验证再交付', description: '交付前自检一遍', capability_type: 'workflow' },
      ],
    }));
    await h.runNight(D1);

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'validated', score: 0.9, rationale: '2026-08-02 当天就做成了',
    })));
    await h.runNight(D2);

    assert.equal(h.coworkStore.listCapabilityDrafts(5, { status: 'draft' }).length, 1, 'the draft stays a draft');
    assert.equal(h.coworkStore.listCapabilityDrafts(5, { status: 'validated' }).length, 0);
    assert.equal(h.telemetry(D2)?.validation?.prospectiveDowngraded, 1);
    assert.equal(h.telemetry(D2)?.validation?.panels?.agreed, 1, 'both panels hold after the downgrade');
  } finally {
    h.cleanup();
  }
});

test('flow: panel disagreement holds the draft', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '先验证再交付', description: '交付前自检一遍', capability_type: 'workflow' },
      ],
    }));
    await h.runNight(D1);

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    h.router.on(MARKERS.validation, ({ user, nth }) => validationVerdicts(user, () => (
      nth === 1
        ? { verdict: 'validated', score: 0.9, rationale: '2026-08-03 日记显示照做后获赞' }
        : { verdict: 'keep_draft', score: 0.4, rationale: '证据不足' }
    )));
    await h.runNight(D2);

    assert.equal(h.coworkStore.listCapabilityDrafts(5, { status: 'draft' }).length, 1, 'disagreement changes nothing');
    assert.equal(h.telemetry(D2)?.validation?.panels?.disagreed, 1);
  } finally {
    h.cleanup();
  }
});

test('flow: a panel-B failure is incomplete and never fails the run', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '先验证再交付', description: '交付前自检一遍', capability_type: 'workflow' },
      ],
    }));
    await h.runNight(D1);

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    h.router.on(MARKERS.validation, ({ user, nth }) => (
      nth === 1
        ? validationVerdicts(user, () => ({ verdict: 'validated', score: 0.9, rationale: '2026-08-03 日记显示照做后获赞' }))
        : 'not json'
    ));
    await h.runNight(D2);

    assert.equal(h.coworkStore.listCapabilityDrafts(5, { status: 'draft' }).length, 1, 'incomplete changes nothing');
    assert.equal(h.telemetry(D2)?.validation?.panels?.incomplete, 1);
    assert.equal(h.dreamStore.getRun(5, D2)?.status, 'completed', 'the dream run still completes');
  } finally {
    h.cleanup();
  }
});

test('flow: an agreed rejection writes exactly one ledger row', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '深夜连环追问', description: '深夜连续追问进度', capability_type: 'skill' },
      ],
    }));
    await h.runNight(D1);
    const draftId = h.coworkStore.listCapabilityDrafts(5, { status: 'draft' })[0].id;

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '别问了' },
      { type: 'assistant', content: '好' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'rejected', score: 0.8, rationale: '2026-08-03 照做后被差评',
    })));
    await h.runNight(D2);

    assert.equal(h.coworkStore.listCapabilityDrafts(5, { status: 'rejected' }).length, 1);
    const ledger = h.coworkStore.listFalsifiedHypotheses(5);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].source, 'validation');
    assert.equal(ledger[0].sourceDraftId, draftId);
    assert.equal(ledger[0].title, '深夜连环追问');
  } finally {
    h.cleanup();
  }
});

test('flow: a rejected re-proposal is skipped against the ledger', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '深夜连环追问', description: '深夜连续追问进度', capability_type: 'skill' },
      ],
    }));
    await h.runNight(D1);

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '别问了' },
      { type: 'assistant', content: '好' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'rejected', score: 0.8, rationale: '2026-08-03 照做后被差评',
    })));
    await h.runNight(D2);

    seedSession(h.coworkStore, h.db, D3, [
      { type: 'user', content: '继续' },
      { type: 'assistant', content: '好' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '深夜连环追问', description: '换个说法再提一次', capability_type: 'skill' },
      ],
    }));
    h.router.on(MARKERS.validation, () => JSON.stringify({ verdicts: [] }));
    await h.runNight(D3);

    assert.equal(h.telemetry(D3)?.capabilityDraftInsert?.skippedFalsified, 1);
    const ledger = h.coworkStore.listFalsifiedHypotheses(5);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].hitCount, 1);
    assert.equal(
      h.coworkStore.listCapabilityDrafts(5).filter((draft) => draft.title === '深夜连环追问' && draft.status === 'draft').length,
      0,
      'no new draft row with the falsified title',
    );
    // The falsified section rides the D3 dream prompt with the ledger title.
    const dreamCall = h.router.calls.find(
      (call) => !call.system.includes(MARKERS.validation) && !call.system.includes(MARKERS.reconciliation) && call.user.includes('2026-08-04'),
    );
    assert.ok(dreamCall, 'the D3 dream call exists');
    assert.ok(dreamCall.user.includes('已被证伪的做法'), 'falsified section rides the dream prompt');
    assert.ok(dreamCall.user.includes('「深夜连环追问」'), 'the falsified title is listed');
  } finally {
    h.cleanup();
  }
});

test('flow: an empty ledger renders no falsified section; a re-run does not duplicate drafts', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '先验证再交付', description: '交付前自检一遍', capability_type: 'workflow' },
      ],
    }));
    await h.runNight(D1);
    const dreamCall = h.router.calls.find(
      (call) => !call.system.includes(MARKERS.validation) && !call.system.includes(MARKERS.reconciliation),
    );
    assert.ok(dreamCall, 'the dream call exists');
    assert.ok(!dreamCall.user.includes('已被证伪的做法'), 'an empty ledger renders no falsified section');

    // Version-repair style re-run of the same night: the checked insert must
    // not duplicate the draft.
    await h.service.runNow(5, D1);
    assert.equal(
      h.coworkStore.listCapabilityDrafts(5).filter((draft) => draft.title === '先验证再交付').length,
      1,
      'only one draft row exists after the re-run',
    );
    assert.equal(h.telemetry(D1)?.capabilityDraftInsert?.skippedDuplicate, 1, 'the re-run reports the duplicate skip');
    assert.equal(h.telemetry(D1)?.capabilityDraftInsert?.inserted, 0);
  } finally {
    h.cleanup();
  }
});

test('flow: the disputed-timeout sweep writes no ledger row', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '超期存疑', description: 'd', capabilityType: 'skill' },
    ]);
    const draft = h.coworkStore.listCapabilityDrafts(5)[0];
    h.coworkStore.updateCapabilityDraftValidation({
      id: draft.id, metabotId: 5, status: 'disputed', validationNotes: 'n',
    });
    h.db.run(
      'UPDATE capability_drafts SET last_reviewed_at = ? WHERE id = ?',
      [Date.now() - (DISPUTED_AUTO_REJECT_DAYS + 1) * DAYMS, draft.id],
    );

    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    await h.runNight(D1);

    assert.equal(h.coworkStore.listCapabilityDrafts(5, { status: 'rejected' })[0]?.title, '超期存疑');
    assert.equal(h.coworkStore.listFalsifiedHypotheses(5).length, 0, 'the timeout sweep never writes the ledger');
  } finally {
    h.cleanup();
  }
});

test('flow: legacy single-panel configuration validates the same night', async () => {
  const h = await createDreamHarness({ capabilityGate: { panels: 1, prospective: false } });
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({
      capability_learnings: [
        { title: '先验证再交付', description: '交付前自检一遍', capability_type: 'workflow' },
      ],
    }));
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'validated', score: 0.9, rationale: '2026-08-02 日记显示屡获好评',
    })));
    h.router.on(MARKERS.reconciliation, ({ user }) => reconciliationKeep(user));
    await h.runNight(D1);

    assert.equal(validationCallsOf(h.router).length, 1, 'the pre-P1 behavior: one panel, same night');
    const validated = h.coworkStore.listCapabilityDrafts(5, { status: 'validated' });
    assert.equal(validated.length, 1);
    assert.equal(validated[0].validationScore, 0.9);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Re-review flows (RRSI P1 Task 6)
// ---------------------------------------------------------------------------

const seedReReviewableDraft = (h) => {
  h.coworkStore.insertCapabilityDrafts(5, '2026-06-01', [
    { title: '过期硬技巧', description: '曾经有效的做法', capabilityType: 'skill' },
  ]);
  const draft = h.coworkStore.listCapabilityDrafts(5)[0];
  h.coworkStore.updateCapabilityDraftValidation({
    id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9,
  });
  h.db.run(
    'UPDATE capability_drafts SET validated_at = ?, last_reviewed_at = NULL, dream_date = ? WHERE id = ?',
    [Date.now() - 40 * DAYMS, '2026-06-01', draft.id],
  );
  return draft;
};

test('re-review: an agreed demotion writes a re_review ledger row', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    const seeded = seedReReviewableDraft(h);
    await h.runNight(D1);

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '这个技巧不好用' },
      { type: 'assistant', content: '收到' },
    ]);
    // Night D1 already ran this draft's re-review (unparseable fallback, no
    // writes) — count only night D2's calls.
    const callsBeforeD2 = h.router.calls.length;
    h.router.on(MARKERS.validation, ({ user }) => validationVerdicts(user, () => ({
      verdict: 'rejected', score: 0.5, rationale: '2026-08-03 照做后被差评',
    })));
    await h.runNight(D2);

    const calls = h.router.calls.slice(callsBeforeD2).filter((call) => call.system.includes(MARKERS.validation));
    assert.equal(calls.length, 2, 're-review panels A and B');
    assert.ok(calls.every((call) => call.user.includes(`### 草案 #${seeded.id}`)), 'both prompts carry the seeded draft');
    const draft = h.coworkStore.listCapabilityDrafts(5).find((entry) => entry.id === seeded.id);
    assert.equal(draft.status, 'rejected');
    const ledger = h.coworkStore.listFalsifiedHypotheses(5);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].source, 're_review');
    assert.equal(ledger[0].sourceDraftId, seeded.id);
    assert.equal(h.telemetry(D2)?.demoted, 1);
    assert.equal(h.telemetry(D2)?.reReviewPanels?.agreed, 1);
  } finally {
    h.cleanup();
  }
});

test('re-review: disagreement refreshes the review clock with a note', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    const seeded = seedReReviewableDraft(h);
    await h.runNight(D1);

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '还行' },
      { type: 'assistant', content: '好' },
    ]);
    h.router.on(MARKERS.validation, ({ user, nth }) => validationVerdicts(user, () => (
      nth === 1
        ? { verdict: 'rejected', score: 0.5, rationale: '2026-08-03 照做后被差评' }
        : { verdict: 'validated', score: 0.9, rationale: '2026-08-03 日记显示仍然有效' }
    )));
    await h.runNight(D2);

    const draft = h.coworkStore.listCapabilityDrafts(5).find((entry) => entry.id === seeded.id);
    assert.equal(draft.status, 'validated', 'a disagreement never demotes');
    assert.ok(draft.lastReviewedAt !== null, 'the review clock refreshes');
    assert.match(draft.validationNotes, /^panels disagreed — /);
    assert.equal(h.telemetry(D2)?.reReviewPanels?.disagreed, 1);
  } finally {
    h.cleanup();
  }
});

test('re-review: an incomplete panel retries next night without touching the clock', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, D1, [
      { type: 'user', content: '视频好了吗' },
      { type: 'assistant', content: '好了' },
    ]);
    h.router.setFallback(() => dreamJson({ daily_summary: '普通的一天。' }));
    const seeded = seedReReviewableDraft(h);
    await h.runNight(D1);

    seedSession(h.coworkStore, h.db, D2, [
      { type: 'user', content: '还行' },
      { type: 'assistant', content: '好' },
    ]);
    h.router.on(MARKERS.validation, ({ user, nth }) => (
      nth === 1
        ? validationVerdicts(user, () => ({ verdict: 'validated', score: 0.9, rationale: '2026-08-03 日记显示仍然有效' }))
        : 'not json'
    ));
    await h.runNight(D2);

    const draft = h.coworkStore.listCapabilityDrafts(5).find((entry) => entry.id === seeded.id);
    assert.equal(draft.status, 'validated');
    assert.equal(draft.lastReviewedAt, null, 'incomplete never refreshes the clock');
    assert.equal(h.telemetry(D2)?.reReviewPanels?.incomplete, 1);
  } finally {
    h.cleanup();
  }
});
