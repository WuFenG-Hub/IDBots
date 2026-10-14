import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { C3_BEST, FINAL_NOW, H1, H2, REVEAL_CLOSE, ROUND_AT, chain, pid, roundBody } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { tallyRound } = require('../dist-electron/main/services/preference/engine.js');
const { canonicalRoundForSubject, checkLesson, verifyLessonPin } = require(
  '../dist-electron/main/services/preference/lesson.js',
);

const decidedRound = () => {
  const c = chain();
  const round = c.openRound();
  const h1 = c.vote(round, H1, C3_BEST);
  c.vote(round, H2, C3_BEST);
  const tally = tallyRound(c.events, round, { nowSec: FINAL_NOW }).result;
  const lesson = {
    round,
    category: ['ui:qa-community'],
    summary: 'Judges preferred the denser feed.',
    principles: [{
      text: 'Show five or more questions per screen.',
      conditions: 'Browse-first readers on desktop.',
      uncertainty: 'Two judges only.',
      evidence: [h1.reveal.pinId],
    }],
    exemplars: { preferred: 'c3', rejected: ['c1'] },
    tallyHash: tally.tallyHash,
  };
  return { c, round, tally, lesson, h1 };
};

test('a lesson matching the final tally is valid', () => {
  const { c, lesson } = decidedRound();
  assert.equal(checkLesson(lesson, tallyRound(c.events, lesson.round, { nowSec: FINAL_NOW }).result).ok, true);
  const pin = c.add('lesson', lesson, H1, REVEAL_CLOSE + 9_000);
  assert.equal(verifyLessonPin(c.events, pin.pinId, FINAL_NOW).ok, true);
});

test('lesson rejections', () => {
  const { tally, lesson, h1 } = decidedRound();
  const cases = [
    [{ ...lesson, exemplars: { preferred: 'c2', rejected: [] } }, 'lesson:preferred-not-winner'],
    [{ ...lesson, tallyHash: 'f'.repeat(64) }, 'lesson:tally-hash-mismatch'],
    [{ ...lesson, round: pid(999) }, 'lesson:round-mismatch'],
    [{ ...lesson, exemplars: { preferred: 'c3', rejected: ['c7'] } }, 'lesson:unknown-rejected'],
    [{ ...lesson, principles: [{ ...lesson.principles[0], evidence: [h1.commit.pinId] }] }, 'lesson:evidence-not-in-tally'],
  ];
  for (const [body, reason] of cases) assert.deepEqual(checkLesson(body, tally), { ok: false, reason });
});

test('a lesson against an unfinished round is rejected', () => {
  const { c, lesson } = decidedRound();
  const early = tallyRound(c.events, lesson.round, { nowSec: REVEAL_CLOSE }).result;
  assert.deepEqual(checkLesson(lesson, early), { ok: false, reason: 'lesson:round-not-decided' });
});

test('canonical round: earliest root-author round that did not end no decision', () => {
  const subject = { taskid: pid(500), node: 'UI' };
  const c = chain();
  const failed = c.openRound({ subject });
  c.vote(failed, H1, C3_BEST);
  c.add('round', roundBody({ subject }), H1, ROUND_AT);
  const second = c.openRound({ subject });
  c.vote(second, H1, C3_BEST);
  c.vote(second, H2, C3_BEST);
  const query = { ...subject, rootAuthor: c.events[0].author };
  const final = canonicalRoundForSubject(c.events, query, FINAL_NOW);
  assert.equal(final.state, 'decided');
  assert.equal(final.roundPinId, second);
  assert.deepEqual(canonicalRoundForSubject(c.events, query, REVEAL_CLOSE), { state: 'pending', roundPinId: failed });
  assert.deepEqual(canonicalRoundForSubject(c.events, { ...query, node: 'OTHER' }, FINAL_NOW), { state: 'none' });
});
