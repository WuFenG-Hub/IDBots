import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../dist-electron/main/libs/capabilityGateRegularizers.js');

test('gate config resolves defaults and rejects invalid overrides', () => {
  assert.deepEqual(R.resolveCapabilityGateConfig(), { panels: 2, prospective: true });
  assert.deepEqual(R.resolveCapabilityGateConfig({ panels: 1 }), { panels: 1, prospective: true });
  assert.deepEqual(R.resolveCapabilityGateConfig({ panels: 3, prospective: 'no' }), { panels: 2, prospective: true });
  assert.deepEqual(R.resolveCapabilityGateConfig({ prospective: false }), { panels: 2, prospective: false });
});

test('cited dates are distinct and ordered', () => {
  assert.deepEqual(R.citedDiaryDates('2026-08-03 好评;2026-08-02 来源;再看 2026-08-03'), ['2026-08-03', '2026-08-02']);
  assert.deepEqual(R.citedDiaryDates('没有日期'), []);
});

test('post-origin citation requires a later, provided diary date', () => {
  const evidenceDates = new Set(['2026-08-02', '2026-08-03']);
  const check = (rationale) => R.hasPostOriginCitation({ rationale, draftDreamDate: '2026-08-02', evidenceDates });
  assert.equal(check('2026-08-03 日记显示交付获赞'), true);
  assert.equal(check('2026-08-02 当天就成功了'), false);
  assert.equal(check('2026-08-05 之后也成功'), false);
  assert.equal(check('一直都很好'), false);
});

test('panel outcomes combine by agreement', () => {
  const c = R.combinePanelOutcomes;
  assert.deepEqual(c('promote', 'promote'), { outcome: 'promote', agreement: 'agreed' });
  assert.deepEqual(c('demote', 'demote'), { outcome: 'demote', agreement: 'agreed' });
  assert.deepEqual(c('hold', 'hold'), { outcome: 'hold', agreement: 'agreed' });
  assert.deepEqual(c('promote', 'hold'), { outcome: 'hold', agreement: 'disagreed' });
  assert.deepEqual(c('promote', 'demote'), { outcome: 'hold', agreement: 'disagreed' });
  assert.deepEqual(c('promote', null), { outcome: 'hold', agreement: 'incomplete' });
  assert.deepEqual(c(null, null), { outcome: 'hold', agreement: 'incomplete' });
});

test('panel rationales join and collapse when identical', () => {
  assert.equal(R.joinPanelRationales('甲', '乙'), 'A: 甲 | B: 乙');
  assert.equal(R.joinPanelRationales(' 同 ', '同'), '同');
  assert.equal(R.joinPanelRationales('x'.repeat(700), 'y').length, 600);
});

test('hypothesis keys ignore whitespace, punctuation and case', () => {
  assert.equal(R.hypothesisTitleKey('  先验证、再交付！ '), '先验证再交付');
  assert.equal(R.hypothesisTitleKey('Verify  Before Delivery.'), 'verifybeforedelivery');
});

test('hypothesis similarity is the token overlap coefficient', () => {
  assert.equal(R.hypothesisSimilarity('先验证再交付', '交付前先验证一遍'), 0.6);
  assert.equal(R.hypothesisSimilarity('先验证再交付', '深夜连环追问'), 0);
  assert.equal(R.hypothesisSimilarity('回复', '回复用户'), 0);
});

test('similar falsified lookup prefers exact key, then best overlap', () => {
  const ledger = [
    { id: 1, title: '深夜连环追问', titleKey: R.hypothesisTitleKey('深夜连环追问') },
    { id: 2, title: '交付前先验证一遍', titleKey: R.hypothesisTitleKey('交付前先验证一遍') },
    { id: 3, title: '先验证、再交付', titleKey: R.hypothesisTitleKey('先验证、再交付') },
  ];
  assert.equal(R.findSimilarFalsified('先验证再交付', ledger)?.id, 3);
  // Deviation (user-approved): the plan's query '先验证再交付视频' scores
  // 3/7 = 0.4286 against id 2 — below the 0.6 threshold under the plan's own
  // normative similarity. '先验证一遍' clears it at 4/4 = 1.0.
  assert.equal(R.findSimilarFalsified('先验证一遍', ledger.slice(0, 2))?.id, 2);
  assert.equal(R.findSimilarFalsified('完全无关的标题', ledger), null);
});
