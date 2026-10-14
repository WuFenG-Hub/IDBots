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

const openArgs = (over = {}) => ({
  title: 'Q&A UI v2',
  category: ['ui:qa-community'],
  subject: { rootPinId: TASK, node: 'UI' },
  judges: [{ globalMetaId: H1, kind: 'human' }],
  minBallots: 1,
  commitHours: 48,
  revealHours: 24,
  ...over,
});

test('round_open derives candidates from the MetaTask node and guards the subject', async () => {
  const detail = taskDetail(H2, [sub(20, B1), sub(30, B2), sub(40, B3, { failed: true })]);
  const h = await toolHarness({ tasks: { [TASK]: detail } });
  const opened = await h.call('preference_round_open', openArgs());
  assert.equal(opened.isError, false, opened.text);
  assert.equal(h.state.metataskRefreshes, 1);
  const [write] = h.state.writes;
  assert.equal(write.segment, 'round');
  assert.equal(write.author, H2);
  assert.deepEqual(write.payload.subject, { taskid: TASK, node: 'UI' });
  assert.deepEqual(write.payload.candidates.map((candidate) => candidate.ref), [pid(20), pid(30)]);
  assert.deepEqual(write.payload.judges, [{ id: H1, kind: 'human' }]);
  assert.deepEqual(write.payload.decision, { kinds: ['human'], minBallots: 1 });
  assert.equal(write.payload.commitCloseAt, ROUND_AT + 1000 + 48 * 3600);
  assert.equal(write.payload.revealCloseAt, write.payload.commitCloseAt + 24 * 3600);
  assert.equal(opened.json.roundPinId, write.pinId);

  const again = await h.call('preference_round_open', openArgs());
  assert.equal(again.isError, true);
  assert.match(again.text, /preference:subject-round-unconfirmed/);
  assert.equal(h.state.writes.length, 1);
});

test('round_open refusals never write', async () => {
  const h = await toolHarness({ tasks: { [TASK]: taskDetail(TWIN, [sub(20, B1), sub(30, B2)]) } });
  const cases = [
    [openArgs(), /preference:not-task-author/],
    [openArgs({ candidates: CANDIDATES }), /preference:candidates-derived-from-subject/],
    [openArgs({ subject: undefined }), /preference:candidates-required/],
    [openArgs({ subject: { rootPinId: pid(501), node: 'UI' } }), /preference:task-not-found/],
    [openArgs({ subject: undefined, candidates: CANDIDATES, commitHours: 1 }), /round:windows/],
  ];
  for (const [args, reason] of cases) {
    const refused = await h.call('preference_round_open', args);
    assert.equal(refused.isError, true, `expected refusal ${reason}`);
    assert.match(refused.text, reason);
  }
  assert.equal(h.state.writes.length, 0);
  const noIdentity = await toolHarness({ sessionMetabotId: 9 });
  const refused = await noIdentity.call('preference_round_open', openArgs({ subject: undefined, candidates: CANDIDATES }));
  assert.match(refused.text, /METABOT_IDENTITY_MISSING/);
  assert.equal(noIdentity.state.writes.length, 0);
});

test('round_open with explicit candidates publishes a round without a subject', async () => {
  const h = await toolHarness();
  const opened = await h.call(
    'preference_round_open',
    openArgs({ subject: undefined, candidates: CANDIDATES, decisionKinds: ['ai'], commitHours: 2, revealHours: 2 }),
  );
  assert.equal(opened.isError, false, opened.text);
  assert.equal(h.state.writes[0].payload.subject, undefined);
  assert.deepEqual(h.state.writes[0].payload.decision, { kinds: ['ai'], minBallots: 1 });
});

test('vote_commit seals an AI ballot and refuses invalid input before any write', async () => {
  const { c, round } = aiJudgeRound();
  const h = await toolHarness({ nowSec: COMMIT_CLOSE - 7_200, events: c.events });
  const cases = [
    [{ roundPinId: round, pairs: [{ a: 'c1', b: 'c9', pick: 'a', reason: 'x' }] }, /ballot:pair-candidates/],
    [{ roundPinId: round, pairs: [{ a: 'c1', b: 'c2', pick: 'a', reason: 'x' }] }, /preference:own-candidate-in-ballot/],
    [{ roundPinId: pid(9999), pairs: [{ a: 'c1', b: 'c3', pick: 'a', reason: 'x' }] }, /round:not-found/],
  ];
  for (const [args, reason] of cases) {
    const refused = await h.call('preference_vote_commit', args);
    assert.equal(refused.isError, true);
    assert.match(refused.text, reason);
  }
  assert.equal(h.state.writes.length, 0);

  const ok = await h.call('preference_vote_commit', {
    roundPinId: round,
    pairs: [{ a: 'c3', b: 'c1', pick: 'a', reason: 'c3 shows six questions per screen with answer previews; c1 shows two.' }],
  });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.state.writes[0].segment, 'commit');
  assert.equal(h.state.writes[0].author, H2);
  assert.equal(ok.json.judgeClass, 'shadow');
  assert.equal(ok.json.revealsFrom, COMMIT_CLOSE + 1800);
  const status = await h.call('preference_round_status', { roundPinId: round });
  assert.deepEqual(status.json.myBallots.map((row) => row.status), ['committed']);
});

test('vote_commit refuses a bot that is not a listed judge', async () => {
  const c = chain();
  const round = c.openRound({ judges: [{ id: H1, kind: 'human' }], decision: { kinds: ['human'], minBallots: 1 } });
  const h = await toolHarness({ nowSec: COMMIT_CLOSE - 7_200, events: c.events });
  const refused = await h.call('preference_vote_commit', {
    roundPinId: round,
    pairs: [{ a: 'c1', b: 'c3', pick: 'b', reason: 'c3 is denser.' }],
  });
  assert.match(refused.text, /preference:not-a-listed-judge/);
  assert.equal(h.state.writes.length, 0);
});

test('lesson_publish fills winner, rejected and tallyHash, then points at the LESSON submission', async () => {
  const c = chain();
  const round = c.openRound({ subject: { taskid: TASK, node: 'UI' } });
  const h1 = c.vote(round, H1, C3_BEST);
  c.vote(round, H2, C3_BEST);
  const principles = [
    { text: 'Show five or more questions per screen.', conditions: 'Desktop readers.', evidence: [h1.reveal.pinId] },
  ];

  const early = await toolHarness({ nowSec: COMMIT_CLOSE + 100, events: c.events });
  const tooEarly = await early.call('preference_lesson_publish', { roundPinId: round, summary: 'x', principles });
  assert.match(tooEarly.text, /preference:round-not-decided:revealing/);
  assert.equal(early.state.writes.length, 0);

  const h = await toolHarness({ nowSec: FINAL_NOW, events: c.events });
  const published = await h.call('preference_lesson_publish', {
    roundPinId: round,
    summary: 'Judges preferred the denser feed.',
    principles,
  });
  assert.equal(published.isError, false, published.text);
  const [lesson] = h.state.writes;
  assert.equal(lesson.segment, 'lesson');
  assert.deepEqual(lesson.payload.exemplars, { preferred: 'c3', rejected: ['c2', 'c1'] });
  assert.deepEqual(lesson.payload.category, ['ui:qa-community']);
  assert.equal(lesson.payload.principles[0].uncertainty, '');
  assert.equal(lesson.payload.tallyHash, h.service.roundStatus(round).tally.tallyHash);
  assert.equal(published.json.winnerRef, pid(3));
  assert.ok(published.json.next[0].includes(`pin://${lesson.pinId}`));
  assert.ok(published.json.next[0].includes(`"UI": "${pid(3)}"`));

  const badEvidence = await h.call('preference_lesson_publish', {
    roundPinId: round,
    summary: 'Judges preferred the denser feed.',
    principles: [{ ...principles[0], evidence: [pid(7777)] }],
  });
  assert.equal(badEvidence.isError, true);
  assert.equal(h.state.writes.length, 1);

  confirm(h.state, lesson, FINAL_NOW + 60);
  h.state.nowSec = FINAL_NOW + 120;
  const found = await h.call('preference_lessons_search', { category: ['ui'], refresh: true });
  assert.equal(found.json.lessons.length, 1);
  assert.equal(found.json.lessons[0].lessonPinId, lesson.pinId);
  assert.equal(found.json.lessons[0].preferredArtifact, CANDIDATES[2].artifact);
  assert.deepEqual(found.json.lessons[0].roundSize, { candidates: 3, decidingBallots: 2 });
  const verdict = await h.call('preference_round_status', { roundPinId: round, lessonPinId: lesson.pinId });
  assert.deepEqual(verdict.json.lesson, { pinId: lesson.pinId, valid: true, reason: null });
});
