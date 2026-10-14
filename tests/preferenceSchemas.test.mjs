import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CANDIDATES, ROUND_AT, ballot, pair, pid, roundBody } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { parseRound, parseCommit, parseRevealEnvelope, checkBallot, parseLesson } = require(
  '../dist-electron/main/services/preference/schemas.js',
);

const parsedRound = () => {
  const result = parseRound(roundBody(), ROUND_AT);
  assert.equal(result.ok, true, result.reason);
  return result.value;
};

test('valid round parses and normalizes optional lists', () => {
  const result = parseRound(roundBody({ dimensions: undefined }), ROUND_AT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.dimensions, []);
  assert.deepEqual(result.value.tasks, []);
  assert.equal(result.value.subject, undefined);
});

test('round bounds and uniqueness are enforced', () => {
  const cases = [
    [{ candidates: CANDIDATES.slice(0, 1) }, 'round:candidates'],
    [{ candidates: [CANDIDATES[0], { ...CANDIDATES[1], id: 'c1' }] }, 'round:candidate-duplicate'],
    [{ candidates: [CANDIDATES[0], { ...CANDIDATES[1], artifact: 'https://x' }] }, 'round:candidate-shape'],
    [{ judges: [{ id: CANDIDATES[0].author, kind: 'robot' }] }, 'round:judge-shape'],
    [{ decision: { kinds: [], minBallots: 1 } }, 'round:decision'],
    [{ decision: { kinds: ['human'], minBallots: 0 } }, 'round:decision'],
    [{ category: ['UI:Bad'] }, 'round:category'],
    [{ commitCloseAt: ROUND_AT + 3599 }, 'round:windows'],
    [{ revealCloseAt: roundBody().commitCloseAt + 3599 }, 'round:windows'],
    [{ subject: { taskid: 'not-a-pin', node: 'UI' } }, 'round:subject'],
  ];
  for (const [over, reason] of cases) {
    assert.deepEqual(parseRound(roundBody(over), ROUND_AT), { ok: false, reason }, JSON.stringify(over));
  }
});

test('commit and reveal envelopes check shapes only', () => {
  assert.equal(parseCommit({ round: pid(1), hash: 'a'.repeat(64) }).ok, true);
  assert.deepEqual(parseCommit({ round: pid(1), hash: 'A'.repeat(64) }), { ok: false, reason: 'commit:shape' });
  assert.equal(parseRevealEnvelope({ round: pid(1), commit: pid(2), salt: 'b'.repeat(64), ballot: {} }).ok, true);
  assert.deepEqual(parseRevealEnvelope({ round: pid(1), commit: pid(2), salt: 'b'.repeat(63), ballot: {} }), {
    ok: false,
    reason: 'reveal:shape',
  });
});

test('ballot validity follows protocol §4 rule 4', () => {
  const round = parsedRound();
  assert.equal(checkBallot(ballot(pair('c1', 'c2', 'a', { dims: { visual: 'tie' } })), round).ok, true);
  const cases = [
    [ballot(pair('c1', 'c1', 'a')), 'ballot:pair-candidates'],
    [ballot(pair('c1', 'c9', 'a')), 'ballot:pair-candidates'],
    [ballot(pair('c1', 'c2', 'a'), pair('c2', 'c1', 'b')), 'ballot:pair-duplicate'],
    [ballot(pair('c1', 'c2', 'left')), 'ballot:pick'],
    [ballot({ a: 'c1', b: 'c2', pick: 'a', reason: '   ' }), 'ballot:reason'],
    [ballot({ a: 'c1', b: 'c2', pick: 'a', reason: 'x'.repeat(1001) }), 'ballot:reason'],
    [ballot(pair('c1', 'c2', 'a', { dims: { speed: 'a' } })), 'ballot:dims'],
    [{ pairs: [] }, 'ballot:pairs'],
  ];
  for (const [value, reason] of cases) {
    assert.deepEqual(checkBallot(value, round), { ok: false, reason }, JSON.stringify(value));
  }
});

test('ballot normalization drops unknown keys but keeps dims and note', () => {
  const round = parsedRound();
  const result = checkBallot({ pairs: [{ ...pair('c1', 'c2', 'b'), extra: 1 }], note: 'n' }, round);
  assert.deepEqual(result, { ok: true, value: { pairs: [pair('c1', 'c2', 'b')], note: 'n' } });
});

test('lesson shape', () => {
  const lesson = {
    round: pid(1),
    category: ['ui:qa-community'],
    summary: 'Dense feeds won.',
    principles: [{ text: 'Show five questions per screen.', conditions: 'Desktop readers.', uncertainty: '', evidence: [pid(9)] }],
    exemplars: { preferred: 'c3', rejected: ['c1'] },
    tallyHash: 'c'.repeat(64),
  };
  assert.equal(parseLesson(lesson).ok, true);
  assert.deepEqual(parseLesson({ ...lesson, exemplars: { preferred: 'c3', rejected: ['c3'] } }), {
    ok: false,
    reason: 'lesson:exemplars',
  });
  assert.deepEqual(parseLesson({ ...lesson, principles: [{ ...lesson.principles[0], evidence: [] }] }), {
    ok: false,
    reason: 'lesson:evidence',
  });
  assert.deepEqual(parseLesson({ ...lesson, principles: [{ ...lesson.principles[0], text: 'too short' }] }), {
    ok: false,
    reason: 'lesson:principle-shape',
  });
});
