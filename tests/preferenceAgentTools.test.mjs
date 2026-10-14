import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  B1,
  B2,
  B3,
  C3_BEST,
  CANDIDATES,
  COMMIT_CLOSE,
  FINAL_NOW,
  H1,
  H2,
  ROUND_AT,
  TWIN,
  ballot,
  chain,
  gid,
  pair,
  pid,
  roundBody,
} from './fixtures/preference/scenarios.mjs';
import { confirm, toolHarness } from './fixtures/preference/toolHarness.mjs';

const require = createRequire(import.meta.url);
const { candidatesFromMetaTaskNode, judgePairOrder } = require('../dist-electron/main/libs/preferenceAgentTools.js');

const TASK = pid(500);
const sub = (n, submitter, over = {}) => ({
  pinId: pid(n),
  submitter,
  attachment: `metaapp://${pid(n + 100)}`,
  chainValid: true,
  verified: true,
  failed: false,
  superseded: false,
  verifiedHeight: 1000 + n,
  verifiedTxIndex: 0,
  ...over,
});
const taskDetail = (publisher, submissions) => ({ rootPinId: TASK, publisher, nodeStates: { UI: { id: 'UI', submissions } } });

test('candidatesFromMetaTaskNode keeps verified chain-valid artifacts and ids them by ref', () => {
  const detail = taskDetail(H2, [
    sub(40, B3, { verifiedHeight: 1003 }),
    sub(20, B1, { verifiedHeight: 1001 }),
    sub(30, B2, { verifiedHeight: 1002 }),
    sub(50, B1, { failed: true }),
    sub(60, B1, { verified: false, chainValid: false, verifiedHeight: null }),
    sub(70, B2, { chainValid: false }),
    sub(80, B3, { superseded: true }),
    sub(90, B3, { attachment: null }),
    sub(95, B3, { attachment: 'https://example.com/app' }),
  ]);
  const result = candidatesFromMetaTaskNode(detail, 'UI');
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, [
    { id: 'c1', ref: pid(20), artifact: `metaapp://${pid(120)}`, author: B1 },
    { id: 'c2', ref: pid(30), artifact: `metaapp://${pid(130)}`, author: B2 },
    { id: 'c3', ref: pid(40), artifact: `metaapp://${pid(140)}`, author: B3 },
  ]);
});

test('candidatesFromMetaTaskNode caps by earliest verification and reports misses', () => {
  const many = taskDetail(H2, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => sub(n * 10, B1, { verifiedHeight: 2000 - n })));
  const capped = candidatesFromMetaTaskNode(many, 'UI', 6);
  assert.deepEqual(capped.candidates.map((candidate) => candidate.ref), [30, 40, 50, 60, 70, 80].map(pid));
  assert.deepEqual(capped.candidates.map((candidate) => candidate.id), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.deepEqual(candidatesFromMetaTaskNode(taskDetail(H2, [sub(20, B1)]), 'UI'), {
    ok: false,
    reason: 'preference:too-few-candidates:1',
  });
  assert.deepEqual(candidatesFromMetaTaskNode(many, 'NOPE'), { ok: false, reason: 'preference:node-not-found:NOPE' });
});

test('judgePairOrder skips own candidates, covers each pair once, and varies by judge', () => {
  const round = roundBody({
    candidates: [
      CANDIDATES[0],
      { ...CANDIDATES[1], author: H2 },
      CANDIDATES[2],
      { id: 'c4', ref: pid(4), artifact: `metaapp://${pid(14)}`, author: B1 },
    ],
  });
  const roundPinId = pid(900);
  const keyOf = (entry) => [entry.a, entry.b].sort().join('|');
  const mine = judgePairOrder(H2, roundPinId, round);
  assert.deepEqual(mine.map(keyOf).sort(), ['c1|c3', 'c1|c4', 'c3|c4']);
  assert.deepEqual(judgePairOrder(H2, roundPinId, round), mine, 'stable for one judge');
  const orientations = new Set();
  for (let n = 0; n < 20; n += 1) {
    const order = judgePairOrder(gid(`judge${n}`), roundPinId, round);
    assert.equal(order.length, 6);
    assert.deepEqual(order.map(keyOf).sort(), ['c1|c2', 'c1|c3', 'c1|c4', 'c2|c3', 'c2|c4', 'c3|c4']);
    orientations.add(order.map((entry) => `${entry.a}>${entry.b}`).join(','));
  }
  assert.ok(orientations.size > 1, 'different judges see different orders');
});

/** c2 belongs to the session bot (H2), which is listed as an `ai` judge; humans decide. */
const aiJudgeRound = () => {
  const c = chain();
  const round = c.openRound({
    candidates: [CANDIDATES[0], { ...CANDIDATES[1], author: H2 }, CANDIDATES[2]],
    judges: [
      { id: H1, kind: 'human' },
      { id: H2, kind: 'ai' },
    ],
    decision: { kinds: ['human'], minBallots: 1 },
  });
  return { c, round };
};

test('all six tools are registered', async () => {
  const h = await toolHarness();
  assert.deepEqual(Object.keys(h.handlers).sort(), [
    'preference_lesson_publish',
    'preference_lessons_search',
    'preference_round_open',
    'preference_round_status',
    'preference_rounds_list',
    'preference_vote_commit',
  ]);
  assert.equal(h.built.length, 6);
});

test('round_status resolves the canonical round from a subject and shows final reasons', async () => {
  const c = chain();
  const round = c.openRound({ subject: { taskid: TASK, node: 'UI' } });
  const h1 = c.vote(round, H1, C3_BEST);
  const h2 = c.vote(round, H2, C3_BEST);
  const h = await toolHarness({ nowSec: FINAL_NOW, events: c.events, tasks: { [TASK]: taskDetail(TWIN, []) } });
  const status = await h.call('preference_round_status', { subject: { rootPinId: TASK, node: 'UI' }, refresh: true });
  assert.equal(status.isError, false, status.text);
  assert.equal(status.json.roundPinId, round);
  assert.equal(status.json.canonical, 'decided');
  assert.equal(status.json.status, 'decided');
  assert.equal(status.json.winner, 'c3');
  assert.equal(status.json.winnerRef, pid(3));
  assert.equal(status.json.winnerArtifact, CANDIDATES[2].artifact);
  assert.match(status.json.tallyHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(status.json.evidence, [h1.reveal.pinId, h2.reveal.pinId].sort());
  assert.equal(status.json.reasons.length, 2);
  assert.equal(status.json.reasons[0].pairs.length, 3);
  assert.deepEqual(status.json.pairsToJudge, []);
  for (const builder of [B1, B2, B3]) assert.equal(status.text.includes(builder), false, 'builder identities stay hidden');

  const listed = await h.call('preference_rounds_list', { mine: true });
  assert.deepEqual(
    listed.json.rounds.map((entry) => [entry.roundPinId, entry.status, entry.myRole]),
    [[round, 'decided', 'human']],
  );
  const none = await h.call('preference_round_status', { subject: { rootPinId: TASK, node: 'OTHER' } });
  assert.equal(none.json.canonical, 'none');
});

test('round_status for an AI judge lists its pairs and never exposes other local sealed ballots', async () => {
  const { c, round } = aiJudgeRound();
  const h = await toolHarness({ nowSec: COMMIT_CLOSE - 7_200, events: c.events });
  await h.service.refresh('test');
  const human = await h.service.commitBallot(
    { type: 'user' },
    round,
    ballot(pair('c1', 'c2', 'a', { reason: 'SECRET-HUMAN-REASON' })),
  );
  assert.equal(typeof human.pinId, 'string');

  const status = await h.call('preference_round_status', { roundPinId: round });
  assert.equal(status.isError, false, status.text);
  assert.equal(status.json.status, 'collecting');
  assert.deepEqual(status.json.myRole, { listed: true, kind: 'ai', class: 'shadow' });
  assert.deepEqual(status.json.pairsToJudge.map((entry) => [entry.a, entry.b].sort().join('|')), ['c1|c3']);
  assert.deepEqual(status.json.myBallots, []);
  assert.deepEqual(status.json.reasons, []);
  assert.deepEqual(
    status.json.candidates.map((candidate) => [candidate.id, candidate.own]),
    [['c1', false], ['c2', true], ['c3', false]],
  );
  assert.equal(status.text.includes('SECRET-HUMAN-REASON'), false);
});

test('round_status refuses unknown rounds and needs a round or subject', async () => {
  const h = await toolHarness();
  const missing = await h.call('preference_round_status', { roundPinId: pid(9999) });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /round:not-found/);
  const empty = await h.call('preference_round_status', {});
  assert.match(empty.text, /preference:round-required/);
});
