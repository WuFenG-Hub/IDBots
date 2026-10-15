import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answersToBallot,
  ballotToAnswers,
  buildPairSchedule,
  pairAnswerError,
  pairKey,
  remainingParts,
  scheduleProgress,
} from '../src/renderer/components/preference/preferencePairs.js';

const ROUND = `${'ab'.repeat(32)}i0`;
const candidates = ['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, artifact: `metaapp://${id}`, own: false }));

test('buildPairSchedule covers each pair once, skips own candidates, and is stable', () => {
  const schedule = buildPairSchedule('idq1judgea', ROUND, candidates);
  assert.deepEqual(schedule.map((slot) => slot.key).sort(), ['c1|c2', 'c1|c3', 'c1|c4', 'c2|c3', 'c2|c4', 'c3|c4']);
  for (const slot of schedule) assert.equal(pairKey(slot.left, slot.right), slot.key);
  assert.deepEqual(buildPairSchedule('idq1judgea', ROUND, candidates), schedule);
  const withOwn = buildPairSchedule('idq1judgea', ROUND, candidates.map((c) => (c.id === 'c2' ? { ...c, own: true } : c)));
  assert.deepEqual(withOwn.map((slot) => slot.key).sort(), ['c1|c3', 'c1|c4', 'c3|c4']);
});

test('left/right order differs between judges for the same round', () => {
  const layouts = new Set();
  for (let n = 0; n < 12; n += 1) {
    layouts.add(
      buildPairSchedule(`idq1judge${n}`, ROUND, candidates)
        .map((slot) => `${slot.left}>${slot.right}`)
        .join(','),
    );
  }
  assert.ok(layouts.size > 1);
});

test('answers map to a ballot and back, whatever the orientation', () => {
  const schedule = [
    { key: 'c1|c2', left: 'c2', right: 'c1' },
    { key: 'c1|c3', left: 'c1', right: 'c3' },
  ];
  const answers = {
    'c1|c2': { choice: 'left', reason: '  c2 shows more  ', dims: { visual: 'right' } },
    'c1|c3': { choice: 'tie', reason: 'same', dims: {} },
  };
  const ballot = answersToBallot(schedule, answers, '  overall  ');
  assert.deepEqual(ballot, {
    pairs: [
      { a: 'c2', b: 'c1', pick: 'a', reason: 'c2 shows more', dims: { visual: 'b' } },
      { a: 'c1', b: 'c3', pick: 'tie', reason: 'same' },
    ],
    note: 'overall',
  });
  assert.deepEqual(ballotToAnswers(schedule, ballot), {
    'c1|c2': { choice: 'left', reason: 'c2 shows more', dims: { visual: 'right' } },
    'c1|c3': { choice: 'tie', reason: 'same', dims: {} },
  });
  const flipped = { pairs: [{ a: 'c1', b: 'c2', pick: 'a', reason: 'c1 wins', dims: { visual: 'b' } }] };
  assert.deepEqual(ballotToAnswers(schedule, flipped)['c1|c2'], {
    choice: 'right',
    reason: 'c1 wins',
    dims: { visual: 'left' },
  });
  assert.deepEqual(answersToBallot(schedule, {}, ''), { pairs: [] });
});

test('progress requires a choice and a 1..1000 code-point reason for every pair', () => {
  const schedule = [
    { key: 'c1|c2', left: 'c1', right: 'c2' },
    { key: 'c1|c3', left: 'c1', right: 'c3' },
  ];
  assert.equal(pairAnswerError(undefined), 'missing-choice');
  assert.equal(pairAnswerError({ choice: 'left', reason: '   ', dims: {} }), 'missing-reason');
  assert.equal(pairAnswerError({ choice: 'left', reason: '字'.repeat(1000), dims: {} }), null);
  assert.equal(pairAnswerError({ choice: 'left', reason: '字'.repeat(1001), dims: {} }), 'reason-too-long');
  const partial = { 'c1|c2': { choice: 'right', reason: 'x', dims: {} } };
  assert.deepEqual(scheduleProgress(schedule, partial), { done: 1, total: 2, complete: false });
  const full = { ...partial, 'c1|c3': { choice: 'tie', reason: 'y', dims: {} } };
  assert.deepEqual(scheduleProgress(schedule, full), { done: 2, total: 2, complete: true });
  assert.deepEqual(scheduleProgress([], {}), { done: 0, total: 0, complete: false });
});

test('remainingParts buckets durations', () => {
  assert.deepEqual(remainingParts(-5), { kind: 'now', d: 0, h: 0, m: 0 });
  assert.deepEqual(remainingParts(59), { kind: 'now', d: 0, h: 0, m: 0 });
  assert.deepEqual(remainingParts(25 * 60), { kind: 'm', d: 0, h: 0, m: 25 });
  assert.deepEqual(remainingParts(3 * 3600 + 12 * 60), { kind: 'hm', d: 0, h: 3, m: 12 });
  assert.deepEqual(remainingParts(2 * 86400 + 5 * 3600 + 59), { kind: 'dh', d: 2, h: 5, m: 0 });
});
