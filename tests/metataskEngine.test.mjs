import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonJ, innerHash, outerHash, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');
const { replayMetaTask } = require('../dist-electron/main/services/metatask/engine.js');

/**
 * MetaTask TS engine — conformance vectors (P1).
 *
 * Hash vectors are the five FROZEN calibration values from the v1.2
 * registration draft Appendix A (measured on Python 3.14.3, 2026-09-22):
 * the TS implementation must reproduce them byte-for-byte. Replay vectors
 * port the reference Python engine's discriminator set plus the v1.2
 * H_ACT2-gated features (supersede / amend / challenge / settlement).
 */

// ── frozen hash calibration vectors (Appendix A) ─────────────────────────────

test('hash canon: appendix A positive vectors reproduce exactly', () => {
  const pos1 = { node: 'n4', type: 'counterexample', n: 8, candidates: 28, primes_found: 0, samples: [259, 289] };
  const pos1WithHash = { ...pos1, hash: innerHash(pos1) };
  assert.equal(innerHash(pos1), '6ccdb15eaebd14d0c1b5d3c629d708c6e66af4be53f10ab5a4c7dade3a3e371c');
  assert.equal(outerHash(pos1WithHash), '80df13f4a673b804920607ec260c99348724e96e1f165383d3fdbaa0e8df5ede');

  const pos2 = { node: '节点甲', type: 'triage', well_defined: false, note: null };
  const pos2WithHash = { ...pos2, hash: innerHash(pos2) };
  assert.equal(innerHash(pos2), '72778ba8597bebe051efbafd729b2c510aaa9202cc4e105d6506efeb19127609');
  assert.equal(outerHash(pos2WithHash), '07740603fd75770dd206dd6ee60392b082d0cc1282dc00fcf8f6c67324cb57df');
});

test('hash canon: key insertion order never matters (sort_keys parity)', () => {
  const a = { b: 1, a: 2 };
  const b = { a: 2, b: 1 };
  assert.equal(sha256Hex(canonJ(a)), sha256Hex(canonJ(b)));
});

// ── event scaffolding ────────────────────────────────────────────────────────

let pinCounter = 0;
const nextPinId = () => `pin${String(++pinCounter).padStart(4, '0')}0i0`;

const ev = (path, body, over = {}) => ({
  pinId: over.pinId ?? nextPinId(),
  path,
  author: over.author ?? 'idq1defaultbot',
  height: over.height ?? 189_900,
  txIndex: over.txIndex ?? 0,
  timestampMs: over.timestampMs ?? 1_790_000_000_000,
  body,
});

const P = 'idq1publisheraa';
const S = 'idq1submitterbb';
const R1 = 'idq1reviewercc';
const R2 = 'idq1reviewerdd';
const C = 'idq1challengerE';

const buildTask = (over = {}) => {
  const treePinId = over.treePinId ?? nextPinId();
  const rootPinId = over.rootPinId ?? nextPinId();
  const nodes = over.nodes ?? [
    { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
    { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 7000 },
  ];
  const tree = ev('tree', { root: nodes[0]?.id ?? 'r1', nodes }, { pinId: treePinId, author: P, height: 189_800 });
  const task = ev(
    'task',
    {
      title: over.title ?? 'vector task',
      brief: '',
      treeid: treePinId,
      policy: {
        verify_quorum: over.quorum ?? 2,
        claim_ttl_hours: over.ttlHours ?? 48,
        verify_window_hours: over.windowHours ?? 72,
        ...(over.split ? { split: over.split } : {}),
      },
      tags: [],
    },
    { pinId: rootPinId, author: P, height: 189_801 }
  );
  return { tree, task, rootPinId, treePinId };
};

const claimOn = (rootPinId, node, author, over = {}) =>
  ev('claim', { taskid: rootPinId, node }, { author, ...over });

const submitOn = (rootPinId, node, claimPinId, author, over = {}) => {
  const childIds = Array.isArray(over.childIds) ? over.childIds : [];
  const resultBody = {
    type: 'table',
    hash: '0'.repeat(64),
    rows: [],
    ...(childIds.length > 0 ? { childids: childIds } : {}),
  };
  return ev(
    'submission',
    {
      taskid: rootPinId,
      node,
      claimid: claimPinId,
      result: resultBody,
      hash: '1'.repeat(64),
      contentType: 'application/json;utf-8',
      attachment: null,
      childids: childIds,
      ...(over.supersedeid ? { supersedeid: over.supersedeid } : {}),
    },
    { author, ...over },
  );
};

const voteOn = (targetPinId, verdict, author, over = {}) =>
  ev(
    'verify',
    {
      targetid: targetPinId,
      verdict,
      method: 'replayed spec; hashes match',
      ...(over.semanticCheck === false ? {} : { semantic_check: 'statement matches; definitions aligned' }),
      ...(verdict === 'fail' ? { failreason: over.failreason ?? 'counterexample found in row 3' } : {}),
    },
    { author, ...over }
  );

// ── baseline replay states (pre-H_ACT heights: v1.1 semantics) ──────────────

test('replay: open → claimed → verified baseline', () => {
  const { tree, task, rootPinId } = buildTask();
  const events = [tree, task];
  let projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'open');

  const claim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  projection = replayMetaTask([...events, claim], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'claimed');

  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_910 });
  projection = replayMetaTask([...events, claim, sub], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'claimed');

  const votes = [
    voteOn(sub.pinId, 'pass', R1, { height: 189_920 }),
    voteOn(sub.pinId, 'pass', R2, { height: 189_921 }),
  ];
  projection = replayMetaTask([...events, claim, sub, ...votes], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t1.passVotes, 2);
});

test('replay: release reopens; ignored claim never resurrects', () => {
  const { tree, task, rootPinId } = buildTask();
  const claimA = claimOn(rootPinId, 't1', S, { height: 189_900, txIndex: 0 });
  const claimB = claimOn(rootPinId, 't1', R1, { height: 189_901, txIndex: 0 });
  const release = ev('release', { taskid: rootPinId, node: 't1', claimid: claimA.pinId }, { author: S, height: 189_902 });
  const projection = replayMetaTask([tree, task, claimA, claimB, release], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'open'); // B lost the race; A released
});

test('replay: claim TTL expiry reopens (guard semantics)', () => {
  const { tree, task, rootPinId } = buildTask({ ttlHours: 48 });
  const claim = claimOn(rootPinId, 't1', S, { height: 189_900, timestampMs: 1_790_000_000_000 });
  const now = 1_790_000_000_000 + 49 * 3_600_000;
  const projection = replayMetaTask([tree, task, claim], { rootPinId, now });
  assert.equal(projection.nodeStates.t1.status, 'open');
});

test('replay: review-window expiry without quorum reopens', () => {
  const { tree, task, rootPinId } = buildTask({ windowHours: 72, quorum: 2 });
  const claim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_910, timestampMs: 1_790_000_000_000 });
  const one = voteOn(sub.pinId, 'pass', R1, { height: 189_920 });
  const now = 1_790_000_000_000 + 73 * 3_600_000;
  const projection = replayMetaTask([tree, task, claim, sub, one], { rootPinId, now });
  assert.equal(projection.nodeStates.t1.status, 'open');
});

// ── #8/#9 vote gates (heights at/after H_ACT=190000) ─────────────────────────

test('gates: #9 missing semantic_check -> stored but not counted (post H_ACT)', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 190_010 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_020 });
  const bad = voteOn(sub.pinId, 'pass', R1, { height: 190_030, semanticCheck: false });
  const good = voteOn(sub.pinId, 'pass', R2, { height: 190_031 });
  const projection = replayMetaTask([tree, task, claim, sub, bad, good], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'claimed'); // only 1 counted pass < quorum 2
  assert.ok(projection.ignoredEvents.some((e) => e.pinId === bad.pinId && e.reason === 'missing_semantic_check'));
});

test('gates: same shape below H_ACT still counts (boundary pair)', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 189_990 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_991 });
  const noSc = voteOn(sub.pinId, 'pass', R1, { height: 189_999, semanticCheck: false });
  const good = voteOn(sub.pinId, 'pass', R2, { height: 189_998 });
  const projection = replayMetaTask([tree, task, claim, sub, noSc, good], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified'); // v1.1 semantics: both count
});

test('gates: #8 fail missing failreason -> invalid, does not block verification', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 190_010 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_020 });
  const malformedFail = ev(
    'verify',
    { targetid: sub.pinId, verdict: 'fail', method: 'x', semantic_check: 'checked' },
    { author: R1, height: 190_030 }
  );
  const pass = voteOn(sub.pinId, 'pass', R2, { height: 190_031 });
  const projection = replayMetaTask([tree, task, claim, sub, malformedFail, pass], { rootPinId });
  // quorum 2 but only 1 valid pass -> claimed (malformed fail neither blocks nor counts)
  assert.equal(projection.nodeStates.t1.status, 'claimed');
});

test('gates: valid fail with failreason reopens immediately', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 190_010 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_020 });
  const passes = [voteOn(sub.pinId, 'pass', R1, { height: 190_030 }), voteOn(sub.pinId, 'pass', R2, { height: 190_031 })];
  const fail = voteOn(sub.pinId, 'fail', C, { height: 190_040 });
  const projection = replayMetaTask([tree, task, claim, sub, ...passes, fail], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'open');
});

test('votes: last valid vote per bot wins (pilot #01 fail-then-pass pattern)', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_910 });
  const votes = [
    voteOn(sub.pinId, 'fail', R1, { height: 189_920 }),
    voteOn(sub.pinId, 'fail', R2, { height: 189_921 }),
    voteOn(sub.pinId, 'pass', R1, { height: 189_930 }),
    voteOn(sub.pinId, 'pass', R2, { height: 189_931 }),
  ];
  const projection = replayMetaTask([tree, task, claim, sub, ...votes], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t1.failVotes, 0);
});

test('votes: submitter and root author pass votes never count', () => {
  const { tree, task, rootPinId } = buildTask();
  const claim = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 189_910 });
  const selfVote = voteOn(sub.pinId, 'pass', S, { height: 189_920 });
  const publisherVote = voteOn(sub.pinId, 'pass', P, { height: 189_921 });
  const real = voteOn(sub.pinId, 'pass', R1, { height: 189_922 });
  const projection = replayMetaTask([tree, task, claim, sub, selfVote, publisherVote, real], { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'claimed'); // 1 counted pass < 2
});

// ── settlement (v1.2 §11) ────────────────────────────────────────────────────

const settledTwoNodeTask = () => {
  const { tree, task, rootPinId } = buildTask(); // r1:3000 aggregate, t1:7000 leaf
  const claimT1 = claimOn(rootPinId, 't1', S, { height: 190_100 });
  const subT1 = submitOn(rootPinId, 't1', claimT1.pinId, S, { height: 190_110 });
  const claimR1 = claimOn(rootPinId, 'r1', S, { height: 190_120 });
  const subR1 = submitOn(rootPinId, 'r1', claimR1.pinId, S, { height: 190_130 });
  const events = [
    tree,
    task,
    claimT1,
    subT1,
    voteOn(subT1.pinId, 'pass', R1, { height: 190_140 }),
    voteOn(subT1.pinId, 'pass', R2, { height: 190_141 }),
    claimR1,
    subR1,
    voteOn(subR1.pinId, 'pass', R1, { height: 190_150 }),
    voteOn(subR1.pinId, 'pass', R2, { height: 190_151 }),
  ];
  return { events, rootPinId };
};

test('settlement: integer split, self-check invariant, byte-exact totals', () => {
  const { events, rootPinId } = settledTwoNodeTask();
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.taskComplete, true);
  const manifest = projection.settlement;
  assert.ok(manifest, 'task complete with no open challenges must settle');
  // t1 (7000bp): submitter 5600, pool 1400 -> 700+700 equal accuracy reviewers
  // r1 (3000bp): submitter 2400, pool 600 -> 300+300
  const shares = Object.fromEntries(manifest.shares.map((s) => [s.metaId, s]));
  assert.equal(shares[S].from.submittedBP, 8000);
  assert.equal(shares[S].shareBP, 8000);
  assert.equal(shares[R1].from.reviewedBP, 1000);
  assert.equal(shares[R2].from.reviewedBP, 1000);
  assert.equal(shares[R1].shareBP, 1000);
  const total = manifest.shares.reduce((sum, s) => sum + s.shareBP, 0);
  assert.equal(total, 10000);
  for (const share of manifest.shares) {
    assert.equal(share.shareBP, share.from.submittedBP + share.from.reviewedBP);
  }
});

test('settlement: legacy uniform weights discard the residue', () => {
  const nodes = ['a', 'b', 'c'].map((id, index) => ({
    id,
    parent: index === 0 ? null : 'a',
    title: id,
    kind: index === 0 ? 'aggregate' : 'proof',
    specid: null,
    params: {},
    deps: [],
    // no weight field: pre-H_ACT2 legacy task
  }));
  const treePinId = nextPinId();
  const rootPinId = nextPinId();
  const tree = ev('tree', { root: 'a', nodes }, { pinId: treePinId, author: P, height: 189_800 });
  const task = ev(
    'task',
    { title: 'legacy', treeid: treePinId, policy: { verify_quorum: 1, claim_ttl_hours: 48, verify_window_hours: 72 }, tags: [] },
    { pinId: rootPinId, author: P, height: 189_801 }
  );
  const events = [tree, task];
  const submitters = ['idq1legacyaa', 'idq1legacybb', 'idq1legacycc'];
  const reviewer = 'idq1legacyrev';
  for (let i = 0; i < 3; i += 1) {
    const node = nodes[i].id;
    const claim = claimOn(rootPinId, node, submitters[i], { height: 189_900 + i });
    const sub = submitOn(rootPinId, node, claim.pinId, submitters[i], { height: 189_910 + i });
    events.push(claim, sub, voteOn(sub.pinId, 'pass', reviewer, { height: 189_920 + i }));
  }
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.taskComplete, true);
  const total = projection.settlement.shares.reduce((sum, s) => sum + s.shareBP, 0);
  // uniform floor(10000/3) = 3333 per node; per node sub 2666 + pool 667 = 3333
  // total distributed 9999, the 1bp residue is discarded (rev-2 ruling)
  assert.equal(total, 9999);
});

test('settlement: rework cycles pay only the effective submitter (unpaid history)', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 1 });
  const claim1 = claimOn(rootPinId, 't1', S, { height: 189_900 });
  const sub1 = submitOn(rootPinId, 't1', claim1.pinId, S, { height: 189_910, pinId: 'sub1cyclei0' });
  const fail = voteOn(sub1.pinId, 'fail', R1, { height: 189_920 }); // pre-H_ACT: no failreason needed
  const claim2 = claimOn(rootPinId, 't1', S, { height: 189_930 });
  const sub2 = submitOn(rootPinId, 't1', claim2.pinId, S, { height: 189_940 });
  const pass = voteOn(sub2.pinId, 'pass', R1, { height: 189_950 });
  const events = [tree, task, claim1, sub1, fail, claim2, sub2, pass];
  // also verify the aggregate so the task completes
  const claimR = claimOn(rootPinId, 'r1', S, { height: 189_960 });
  const subR = submitOn(rootPinId, 'r1', claimR.pinId, S, { height: 189_970 });
  const passR = voteOn(subR.pinId, 'pass', R2, { height: 189_980 });
  const projection = replayMetaTask([...events, claimR, subR, passR], { rootPinId });
  assert.equal(projection.taskComplete, true);
  assert.ok(projection.settlement.unpaidHistory.some((h) => h.pinId === 'sub1cyclei0' && h.reason === 'rework_cycle'));
  const shares = Object.fromEntries(projection.settlement.shares.map((s) => [s.metaId, s]));
  // t1 7000bp: sub 5600 + pool 1400 to R1 (only reviewer); r1 3000bp: 2400 + 600 to R2
  assert.equal(shares[S].shareBP, 8000);
  assert.equal(shares[R1].shareBP, 1400);
  assert.equal(shares[R2].shareBP, 600);
});

// ── v1.2 features (H_ACT2-gated) ─────────────────────────────────────────────

test('supersede: valid chain re-anchors; below H_ACT2 stays ignored', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 1 });
  const claim = claimOn(rootPinId, 't1', S, { height: 190_200 });
  const sub1 = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_201, pinId: 'superseded01i0' });
  const sub2 = submitOn(rootPinId, 't1', claim.pinId, S, {
    height: 190_202,
    pinId: 'superseder02i0',
    supersedeid: 'superseded01i0',
  });
  const passOnSub2 = voteOn('superseder02i0', 'pass', R1, { height: 190_203 });

  const active = replayMetaTask([tree, task, claim, sub1, sub2, passOnSub2], { rootPinId, hAct2: 190_200 });
  assert.equal(active.nodeStates.t1.submission.pinId, 'superseder02i0');
  assert.equal(active.nodeStates.t1.status, 'verified');
  assert.ok(active.ignoredEvents.every((e) => e.pinId !== 'superseder02i0'));

  const gated = replayMetaTask([tree, task, claim, sub1, sub2, passOnSub2], { rootPinId, hAct2: 190_300 });
  assert.equal(gated.nodeStates.t1.submission.pinId, 'superseded01i0');
  assert.ok(gated.ignoredEvents.some((e) => e.pinId === 'superseder02i0' && e.reason === 'supersede_predicate_failed'));
});

test('amend: publisher folds ops; frozen and non-publisher amends ignored', () => {
  const { tree, task, rootPinId, treePinId } = buildTask(); // r1:3000 t1:4000... (t1:7000)
  const validAmend = ev(
    'amend',
    {
      taskid: rootPinId,
      bases: treePinId,
      ops: [
        { op: 'reweight', node: 't1', weight: 6000 },
        { op: 'add_node', node: { id: 't2', parent: 'r1', title: 'added', kind: 'proof', specid: null, params: {}, deps: [], weight: 1000 } },
      ],
    },
    { author: P, height: 190_210 }
  );
  const projection = replayMetaTask([tree, task, validAmend], { rootPinId, hAct2: 190_200 });
  const t2 = projection.nodes.find((node) => node.id === 't2');
  assert.ok(t2, 'add_node applied');
  assert.equal(t2.weight, 1000);
  assert.equal(projection.nodes.find((node) => node.id === 't1').weight, 6000);

  // Once t1 is claimed it is frozen: reweight ignored, whole amend drops.
  const claim = claimOn(rootPinId, 't1', S, { height: 190_215 });
  const frozenAmend = ev(
    'amend',
    { taskid: rootPinId, bases: validAmend.pinId, ops: [{ op: 'reweight', node: 't1', weight: 5000 }] },
    { author: P, height: 190_220 }
  );
  const frozen = replayMetaTask([tree, task, validAmend, claim, frozenAmend], { rootPinId, hAct2: 190_200 });
  assert.equal(frozen.nodes.find((node) => node.id === 't1').weight, 6000);
  assert.ok(frozen.ignoredEvents.some((e) => e.pinId === frozenAmend.pinId && e.reason === 'amend_invariant_violation'));

  // Non-publisher amend: ignored outright.
  const rogue = ev(
    'amend',
    { taskid: rootPinId, bases: validAmend.pinId, ops: [{ op: 'reweight', node: 't2', weight: 900 }] },
    { author: S, height: 190_225 }
  );
  const guarded = replayMetaTask([tree, task, validAmend, rogue], { rootPinId, hAct2: 190_200 });
  assert.equal(guarded.nodes.find((node) => node.id === 't2').weight, 1000);
  assert.ok(guarded.ignoredEvents.some((e) => e.pinId === rogue.pinId && e.reason === 'amend_not_publisher'));
});

test('challenge: holdout blocks settlement; withdraw and expiry lift it', () => {
  const { tree, task, rootPinId } = buildTask({ quorum: 1 });
  const claim = claimOn(rootPinId, 't1', S, { height: 190_300 });
  const sub = submitOn(rootPinId, 't1', claim.pinId, S, { height: 190_310, pinId: 'challengedsub0i0' });
  const claimR = claimOn(rootPinId, 'r1', S, { height: 190_315 });
  const subR = submitOn(rootPinId, 'r1', claimR.pinId, S, { height: 190_316, childIds: ['challengedsub0i0'] });
  const base = [
    tree,
    task,
    claim,
    sub,
    voteOn('challengedsub0i0', 'pass', R1, { height: 190_320 }),
    claimR,
    subR,
    voteOn(subR.pinId, 'pass', R2, { height: 190_321 }),
  ];
  const challenge = ev(
    'challenge',
    { targetid: 'challengedsub0i0', category: 'correctness', reason: 'lemma gap', evidence: 'metafile://abc' },
    { author: C, height: 190_330, timestampMs: 1_790_000_000_000 }
  );

  const held = replayMetaTask([...base, challenge], { rootPinId, hAct2: 190_200 });
  assert.equal(held.taskComplete, true);
  assert.equal(held.nodeStates.t1.disputed, true);
  assert.equal(held.settlement, null, 'open challenge blocks finalization');

  const withdrawn = ev(
    'challenge',
    { targetid: 'challengedsub0i0', category: 'correctness', reason: 'withdraw', evidence: 'metafile://abc', withdraw: true },
    { author: C, height: 190_340 }
  );
  const lifted = replayMetaTask([...base, challenge, withdrawn], { rootPinId, hAct2: 190_200 });
  assert.ok(lifted.settlement, 'withdrawn challenge lifts the holdout');

  const nowPast = 1_790_000_000_000 + 15 * 86_400_000; // > default 14d TTL
  const expired = replayMetaTask([...base, challenge], { rootPinId, hAct2: 190_200, now: nowPast });
  assert.ok(expired.settlement, 'expired challenge equals withdrawal');
});

// ── eventSetHash determinism ─────────────────────────────────────────────────

test('eventSetHash: order-independent input, deterministic output', () => {
  const { events, rootPinId } = settledTwoNodeTask();
  const forward = replayMetaTask(events, { rootPinId });
  const shuffled = [...events].reverse();
  const backward = replayMetaTask(shuffled, { rootPinId });
  assert.equal(forward.freshness.eventSetHash, backward.freshness.eventSetHash);
  assert.equal(forward.freshness.boundaryBlock, 190_151);
  assert.match(forward.freshness.eventSetHash, /^[0-9a-f]{64}$/);
});

// ── v1.2.1: aggregation precondition (registration paths.aggregationPrecondition) ──

const buildAggregationTask = (over = {}) => {
  const nodes = [
    { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
    { id: 't1', parent: 'r1', title: 'a', kind: 'proof', specid: null, params: {}, deps: [], weight: 3500 },
    { id: 't2', parent: 'r1', title: 'b', kind: 'proof', specid: null, params: {}, deps: [], weight: 3500 },
  ];
  return buildTask({ nodes, quorum: 1, ...over });
};

const aggEvents = ({ base, t2Verified, childIds }) => {
  const { tree, task, rootPinId } = buildAggregationTask();
  const c1 = claimOn(rootPinId, 't1', S, { height: base + 10 });
  const s1 = submitOn(rootPinId, 't1', c1.pinId, S, { height: base + 11, pinId: 'aggt1sub00000000000000000000000000i0' });
  const v1 = voteOn('aggt1sub00000000000000000000000000i0', 'pass', R1, { height: base + 12 });
  const events = [tree, task, c1, s1, v1];
  if (t2Verified) {
    const c2 = claimOn(rootPinId, 't2', S, { height: base + 13 });
    const s2 = submitOn(rootPinId, 't2', c2.pinId, S, { height: base + 14, pinId: 'aggt2sub00000000000000000000000000i0' });
    const v2 = voteOn('aggt2sub00000000000000000000000000i0', 'pass', R2, { height: base + 15 });
    events.push(c2, s2, v2);
  } else {
    events.push(claimOn(rootPinId, 't2', R2, { height: base + 13 }));
  }
  const cr = claimOn(rootPinId, 'r1', S, { height: base + 20 });
  const sr = submitOn(rootPinId, 'r1', cr.pinId, S, { height: base + 21, childIds });
  const vr = voteOn(sr.pinId, 'pass', R1, { height: base + 22 });
  events.push(cr, sr, vr);
  return { events, rootPinId };
};

test('v1.2.1 aggregation precondition: unverified child blocks the parent (H_ACT2 era)', () => {
  const { events, rootPinId } = aggEvents({ base: 191_600, t2Verified: false, childIds: ['aggt1sub00000000000000000000000000i0'] });
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t2.status, 'claimed');
  // Parent passed its own quorum but the precondition demotes it: not verified.
  assert.equal(projection.nodeStates.r1.status, 'claimed');
  assert.equal(projection.taskComplete, false);
  assert.equal(projection.settlement, null);
});

test('v1.2.1 aggregation precondition: pre-H_ACT2 parent grandfathered (pilot #01 pattern)', () => {
  const { events, rootPinId } = aggEvents({ base: 189_600, t2Verified: false, childIds: ['aggt1sub00000000000000000000000000i0'] });
  const projection = replayMetaTask(events, { rootPinId });
  // Grandfathered: the parent keeps its recorded vote-level verified state.
  assert.equal(projection.nodeStates.r1.status, 'verified');
  assert.equal(projection.taskComplete, true); // root verified, even though t2 is not
  assert.equal(projection.progress.verified, 2); // r1 + t1 only
});

test('v1.2.1 aggregation precondition: all children verified + childids match -> parent verified + settlement', () => {
  const { events, rootPinId } = aggEvents({
    base: 191_600,
    t2Verified: true,
    childIds: ['aggt1sub00000000000000000000000000i0', 'aggt2sub00000000000000000000000000i0'],
  });
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.nodeStates.r1.status, 'verified');
  assert.equal(projection.taskComplete, true);
  assert.ok(projection.settlement);
  const total = projection.settlement.shares.reduce((sum, s) => sum + s.shareBP, 0);
  assert.equal(total, 10000);
});

test('v1.2.1 aggregation precondition: childids mismatch blocks the parent', () => {
  const { events, rootPinId } = aggEvents({
    base: 191_600,
    t2Verified: true,
    childIds: ['aggt1sub00000000000000000000000000i0', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefi0'],
  });
  const projection = replayMetaTask(events, { rootPinId });
  assert.equal(projection.nodeStates.t1.status, 'verified');
  assert.equal(projection.nodeStates.t2.status, 'verified');
  assert.equal(projection.nodeStates.r1.status, 'claimed'); // listed set != children's verified pins
  assert.equal(projection.taskComplete, false);
});

test('v1.2.1 amend: conflict on shared bases, stale on foreign bases', () => {
  const { tree, task, rootPinId, treePinId } = buildTask();
  const first = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [{ op: 'retitle', node: 't1', title: 'renamed once' }] },
    { author: P, height: 191_610 }
  );
  const conflicting = ev(
    'amend',
    { taskid: rootPinId, bases: treePinId, ops: [{ op: 'retitle', node: 't1', title: 'renamed twice' }] },
    { author: P, height: 191_620 }
  );
  const stale = ev(
    'amend',
    { taskid: rootPinId, bases: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0', ops: [{ op: 'retitle', node: 't1', title: 'x' }] },
    { author: P, height: 191_630 }
  );
  const projection = replayMetaTask([tree, task, first, conflicting, stale], { rootPinId });
  assert.equal(projection.nodes.find((node) => node.id === 't1').title, 'renamed once');
  const reasons = Object.fromEntries(projection.ignoredEvents.map((e) => [e.pinId, e.reason]));
  assert.equal(reasons[conflicting.pinId], 'amend_conflict');
  assert.equal(reasons[stale.pinId], 'amend_stale');
});
