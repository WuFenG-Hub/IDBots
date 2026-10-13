import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Loaded lazily so schema tests run before sealing.ts exists. */
const sealing = () => require('../../../dist-electron/main/services/preference/sealing.js');

export const pid = (n) => `${n.toString(16).padStart(64, '0')}i0`;
export const gid = (name) => `idq1${name}`.padEnd(42, '0');
export const saltOf = (n) => n.toString(16).padStart(64, '0');

export const ROUND_AT = 1_792_000_000;
export const COMMIT_CLOSE = ROUND_AT + 86_400;
export const REVEAL_CLOSE = COMMIT_CLOSE + 86_400;
export const FINAL_NOW = REVEAL_CLOSE + 7_201;

export const TWIN = gid('twin1');
export const B1 = gid('builder1');
export const B2 = gid('builder2');
export const B3 = gid('builder3');
export const H1 = gid('human1');
export const H2 = gid('human2');
export const H3 = gid('human3');
export const A1 = gid('ai1');
export const P1 = gid('public1');

export const CANDIDATES = [
  { id: 'c1', ref: pid(1), artifact: `metaapp://${pid(11)}`, author: B1 },
  { id: 'c2', ref: pid(2), artifact: `metaapp://${pid(12)}`, author: B2 },
  { id: 'c3', ref: pid(3), artifact: `metaapp://${pid(13)}`, author: B3 },
];

export const DEFAULT_JUDGES = [
  { id: H1, kind: 'human' },
  { id: H2, kind: 'human' },
  { id: H3, kind: 'human' },
  { id: A1, kind: 'ai' },
];

export const roundBody = (over = {}) => ({
  title: 'Q&A UI v2',
  category: ['ui:qa-community'],
  candidates: CANDIDATES,
  judges: DEFAULT_JUDGES,
  decision: { kinds: ['human'], minBallots: 2 },
  dimensions: [{ id: 'visual', label: 'Visual quality' }],
  commitCloseAt: COMMIT_CLOSE,
  revealCloseAt: REVEAL_CLOSE,
  ...over,
});

export const pair = (a, b, pick, extra = {}) => ({ a, b, pick, reason: `${a} vs ${b}: ${pick}`, ...extra });
export const ballot = (...pairs) => ({ pairs });

export { sealing };

/** A synthetic chain: pins get strictly increasing heights in creation order. */
export function chain() {
  let serial = 100;
  const events = [];
  const add = (path, body, author, atSec, over = {}) => {
    serial += 1;
    const event = {
      pinId: pid(serial),
      path,
      author,
      height: over.height ?? 200_000 + serial,
      txIndex: 0,
      timestampMs: atSec * 1000,
      body,
    };
    events.push(event);
    return event;
  };
  const openRound = (over = {}) => add('round', roundBody(over), TWIN, ROUND_AT).pinId;
  const vote = (roundPinId, judge, ballotValue, opts = {}) => {
    const salt = saltOf(serial + 1);
    const hash = sealing().ballotCommitHash({ round: roundPinId, judge, salt, ballot: ballotValue });
    const commit = add('commit', { round: roundPinId, hash }, judge, opts.commitAt ?? COMMIT_CLOSE - 7_200, opts.commitOver);
    const reveal = add(
      'reveal',
      { round: roundPinId, commit: commit.pinId, salt, ballot: opts.revealBallot ?? ballotValue },
      judge,
      opts.revealAt ?? COMMIT_CLOSE + 600,
      opts.revealOver,
    );
    return { commit, reveal };
  };
  return { events, add, openRound, vote };
}

/** c3 > c2 > c1 */
export const C3_BEST = ballot(pair('c1', 'c3', 'b'), pair('c2', 'c3', 'b'), pair('c1', 'c2', 'b'));
/** c1 > c2 > c3 */
export const C1_BEST = ballot(pair('c1', 'c3', 'a'), pair('c2', 'c3', 'a'), pair('c1', 'c2', 'a'));

const AGREE = ballot(pair('c1', 'c2', 'a'), pair('c1', 'c3', 'b'), pair('c2', 'c3', 'b'));
const DISSENT = ballot(pair('c1', 'c2', 'b'), pair('c1', 'c3', 'b'), pair('c2', 'c3', 'a'));
const SHADOW = ballot(pair('c1', 'c2', 'a'), pair('c1', 'c3', 'b'), pair('c2', 'c3', 'tie'));

const NO_DECISION_ONE_BALLOT = {
  status: 'no_decision',
  winner: null,
  ballots: { deciding: 1, shadow: 0, public: 0 },
  hashed: true,
};

/** H1 votes C3_BEST normally; H2's vote is broken as described by `h2`. */
const oneBrokenVote = (id, h2, ignoredReasons, h2Ballot = C3_BEST) => ({
  id,
  nowSec: FINAL_NOW,
  build() {
    const c = chain();
    const round = c.openRound();
    c.vote(round, H1, C3_BEST);
    c.vote(round, H2, h2Ballot, h2);
    return { round, events: c.events };
  },
  expect: { ...NO_DECISION_ONE_BALLOT, ignoredReasons },
});

const basicWinner = () => {
  const c = chain();
  const round = c.openRound();
  c.vote(round, H1, C3_BEST);
  c.vote(round, H2, C3_BEST);
  return { round, events: c.events };
};

const unfinished = (id, nowSec, status) => ({
  id,
  nowSec,
  build: basicWinner,
  expect: { status, winner: null, rankingIds: ['c3', 'c2', 'c1'], ballots: { deciding: 2, shadow: 0, public: 0 }, hashed: false },
});

export const SCENARIOS = [
  {
    id: 'basic-winner',
    nowSec: FINAL_NOW,
    build: basicWinner,
    expect: {
      status: 'decided',
      winner: 'c3',
      rankingIds: ['c3', 'c2', 'c1'],
      ballots: { deciding: 2, shadow: 0, public: 0 },
      ranking: { c3: { copeland: 4, points: 8, wins: 2, losses: 0, ties: 0 } },
      evidenceCount: 2,
      hashed: true,
    },
  },
  {
    // Copeland 2/2/2 (a cycle); points c1 5, c3 4, c2 3.
    id: 'tiebreak-points',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      c.vote(round, H1, ballot(pair('c1', 'c2', 'a'), pair('c2', 'c3', 'a'), pair('c1', 'c3', 'b')));
      c.vote(round, H2, ballot(pair('c1', 'c2', 'a'), pair('c2', 'c3', 'tie'), pair('c1', 'c3', 'tie')));
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c1',
      rankingIds: ['c1', 'c3', 'c2'],
      ranking: { c1: { copeland: 2, points: 5 }, c3: { copeland: 2, points: 4 }, c2: { copeland: 2, points: 3 } },
      hashed: true,
    },
  },
  {
    // All ties: copeland 2 and points 2 everywhere, so ref ascending decides.
    id: 'tiebreak-ref',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound({ decision: { kinds: ['human'], minBallots: 1 } });
      c.vote(round, H1, ballot(pair('c1', 'c2', 'tie'), pair('c1', 'c3', 'tie'), pair('c2', 'c3', 'tie')));
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c1',
      rankingIds: ['c1', 'c2', 'c3'],
      ranking: { c1: { copeland: 2, points: 2, ties: 2 } },
      hashed: true,
    },
  },
  {
    // B1 authored c1 and is also a deciding judge: only its c2/c3 pair counts.
    // c2 and c3 then tie on copeland 3 and points 4; ref pid(2) < pid(3).
    id: 'conflict-of-interest',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound({ judges: [...DEFAULT_JUDGES, { id: B1, kind: 'human' }] });
      c.vote(round, B1, C1_BEST);
      c.vote(round, H1, C3_BEST);
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c2',
      rankingIds: ['c2', 'c3', 'c1'],
      ballots: { deciding: 2, shadow: 0, public: 0 },
      judges: [{ id: B1, class: 'deciding', pairs: 1 }, { id: H1, class: 'deciding', pairs: 3 }],
      hashed: true,
    },
  },
  oneBrokenVote('commit-after-close', { commitAt: COMMIT_CLOSE + 1 }, ['commit:after-close', 'reveal:not-effective-commit']),
  oneBrokenVote('reveal-before-close', { revealAt: COMMIT_CLOSE }, ['reveal:before-commit-close']),
  oneBrokenVote('reveal-after-close', { revealAt: REVEAL_CLOSE + 1 }, ['reveal:after-close']),
  oneBrokenVote('hash-mismatch', { revealBallot: C1_BEST }, ['reveal:hash-mismatch']),
  {
    // H1 re-commits; the reveal of the first commit is ignored, the second counts.
    id: 'recommit-latest-wins',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      const { ballotCommitHash } = sealing();
      const first = saltOf(901);
      const second = saltOf(902);
      const commit1 = c.add('commit', { round, hash: ballotCommitHash({ round, judge: H1, salt: first, ballot: C3_BEST }) }, H1, COMMIT_CLOSE - 10_000);
      const commit2 = c.add('commit', { round, hash: ballotCommitHash({ round, judge: H1, salt: second, ballot: C1_BEST }) }, H1, COMMIT_CLOSE - 5_000);
      c.add('reveal', { round, commit: commit1.pinId, salt: first, ballot: C3_BEST }, H1, COMMIT_CLOSE + 600);
      c.add('reveal', { round, commit: commit2.pinId, salt: second, ballot: C1_BEST }, H1, COMMIT_CLOSE + 700);
      c.vote(round, H2, C1_BEST);
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c1',
      rankingIds: ['c1', 'c2', 'c3'],
      ballots: { deciding: 2, shadow: 0, public: 0 },
      ignoredReasons: ['commit:superseded', 'reveal:not-effective-commit'],
      hashed: true,
    },
  },
  oneBrokenVote('duplicate-pair', {}, ['ballot:pair-duplicate'], ballot(pair('c1', 'c2', 'a'), pair('c2', 'c1', 'b'))),
  oneBrokenVote('unknown-candidate', {}, ['ballot:pair-candidates'], ballot(pair('c1', 'c9', 'a'))),
  oneBrokenVote('unconfirmed-ignored', { revealOver: { height: -1 } }, ['reveal:unconfirmed']),
  {
    id: 'public-never-decides',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      c.vote(round, H1, C3_BEST);
      c.vote(round, P1, C1_BEST);
      return { round, events: c.events };
    },
    expect: {
      status: 'no_decision',
      winner: null,
      ballots: { deciding: 1, shadow: 0, public: 1 },
      judges: [{ id: H1, class: 'deciding' }, { id: P1, kind: 'public', class: 'public' }],
      evidenceCount: 1,
      hashed: true,
    },
  },
  {
    id: 'below-min-ballots',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      c.vote(round, H1, C3_BEST);
      return { round, events: c.events };
    },
    expect: { ...NO_DECISION_ONE_BALLOT, rankingIds: ['c3', 'c2', 'c1'] },
  },
  {
    // Only deciding dims count: c3 gets 2 (H1 "b" on c1/c3) + 1 (H1 tie on c2/c3); c2 gets 1.
    id: 'dimensions',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      c.vote(round, H1, ballot(
        pair('c1', 'c3', 'b', { dims: { visual: 'b' } }),
        pair('c2', 'c3', 'tie', { dims: { visual: 'tie' } }),
        pair('c1', 'c2', 'b'),
      ));
      c.vote(round, H2, C3_BEST);
      c.vote(round, A1, ballot(pair('c1', 'c3', 'a', { dims: { visual: 'a' } })));
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c3',
      rankingIds: ['c3', 'c2', 'c1'],
      ballots: { deciding: 2, shadow: 1, public: 0 },
      dimensions: { visual: { c1: 0, c2: 1, c3: 3 } },
      evidenceCount: 3,
      hashed: true,
    },
  },
  {
    // Full P: c1>c2 4:2, c3>c1 6:0, c3>c2 4:2.
    // A1 (shadow, full P): 3 strict pairs, hits c1/c2 + c1/c3, tie pick misses -> 6000.
    // H1 (leave-one-out = H2+H3): only c1/c3 strict, hit -> 6666.
    // H3 (leave-one-out = H1+H2): 3 strict pairs, 1 hit -> 4000.
    id: 'agreement',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound({ decision: { kinds: ['human'], minBallots: 3 } });
      c.vote(round, H1, AGREE);
      c.vote(round, H2, AGREE);
      c.vote(round, H3, DISSENT);
      c.vote(round, A1, SHADOW);
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c3',
      rankingIds: ['c3', 'c1', 'c2'],
      ballots: { deciding: 3, shadow: 1, public: 0 },
      judges: [
        { id: A1, kind: 'ai', class: 'shadow', agreeN: 3, agreeHits: 2, agreementBP: 6000 },
        { id: H1, class: 'deciding', agreeN: 1, agreeHits: 1, agreementBP: 6666 },
        { id: H3, class: 'deciding', agreeN: 3, agreeHits: 1, agreementBP: 4000 },
      ],
      hashed: true,
    },
  },
  unfinished('status-collecting', COMMIT_CLOSE, 'collecting'),
  unfinished('status-revealing', COMMIT_CLOSE + 1, 'revealing'),
  unfinished('status-settling', REVEAL_CLOSE + 7_200, 'settling'),
];

/** Returns human-readable mismatches; an empty array means the expectation holds. */
export function checkScenario(result, expect) {
  const problems = [];
  const out = result.output;
  const eq = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      problems.push(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    }
  };
  eq('status', out.status, expect.status);
  eq('winner', out.winner, expect.winner ?? null);
  if (expect.rankingIds) eq('rankingIds', out.ranking.map((entry) => entry.id), expect.rankingIds);
  if (expect.ballots) eq('ballots', out.ballots, expect.ballots);
  for (const [id, fields] of Object.entries(expect.ranking ?? {})) {
    const entry = out.ranking.find((candidate) => candidate.id === id);
    for (const [key, value] of Object.entries(fields)) eq(`ranking.${id}.${key}`, entry?.[key], value);
  }
  for (const wanted of expect.judges ?? []) {
    const entry = out.judges.find((judge) => judge.id === wanted.id);
    for (const [key, value] of Object.entries(wanted)) eq(`judges.${wanted.id}.${key}`, entry?.[key], value);
  }
  if (expect.dimensions) eq('dimensions', out.dimensions, expect.dimensions);
  if (expect.evidenceCount !== undefined) eq('evidenceCount', out.evidence.length, expect.evidenceCount);
  for (const reason of expect.ignoredReasons ?? []) {
    if (!result.diagnostics.ignored.some((item) => item.reason === reason)) problems.push(`ignored: missing ${reason}`);
  }
  eq('hashed', result.tallyHash !== null, expect.hashed);
  return problems;
}
