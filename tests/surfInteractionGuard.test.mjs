import test from 'node:test';
import assert from 'node:assert/strict';

const { createSurfCreatePinGuard, surfReceiptSeenActions, foldSurfReceiptsIntoSeenActions, recordSurfDeepRead, surfDeepReadReceiptSeenActions, surfSessionPartialStats, surfReceiptsFromChainWriteRecord } = await import('../dist-electron/main/libs/surfInteractionGuard.js');

const METABOT_ID = 7;

const likeData = (pinId) => ({
  operation: 'create',
  path: '/protocols/paylike',
  payload: JSON.stringify({ isLike: '1', likeTo: pinId }),
});

const commentData = (pinId) => ({
  operation: 'create',
  path: '/protocols/paycomment',
  payload: JSON.stringify({ commentTo: pinId, content: 'nice', contentType: 'text/markdown' }),
});

const answerData = (pinId) => ({
  operation: 'create',
  path: '/protocols/simpleanswer',
  payload: JSON.stringify({ answerTo: pinId, content: 'answer' }),
});

const challengeData = (pinId) => ({
  operation: 'create',
  path: '/protocols/agentpedia/challenge',
  payload: JSON.stringify({ targetRev: pinId, reason: 'factual', detail: 'wrong fact here' }),
});

const buzzData = () => ({
  operation: 'create',
  path: '/protocols/simplebuzz',
  payload: JSON.stringify({ content: 'original post' }),
});

const okCreatePin = () => {
  const calls = [];
  const createPin = async (metabotId, metaidData, options) => {
    calls.push({ metabotId, metaidData, options });
    return { txids: ['tx'], pinId: 'new-pin', totalCost: 100 };
  };
  return { createPin, calls };
};

const state = (budget) => ({ interactionBudget: budget, kbBudget: 40 });

test('counts every write and rejects once the budget is spent', async () => {
  const { createPin, calls } = okCreatePin();
  const guard = createSurfCreatePinGuard({ createPin, state: state(2) });
  await guard(METABOT_ID, buzzData(), {});
  await guard(METABOT_ID, likeData('pin-a'), {});
  await assert.rejects(() => guard(METABOT_ID, likeData('pin-b'), {}), /budget exhausted/);
  assert.equal(calls.length, 2, 'the third write never reached the wallet');
});

test('budget 0 refuses every chain write', async () => {
  const { createPin, calls } = okCreatePin();
  const guard = createSurfCreatePinGuard({ createPin, state: state(0) });
  await assert.rejects(() => guard(METABOT_ID, buzzData(), {}), /budget exhausted/);
  assert.equal(calls.length, 0);
});

test('counters live on the shared state: a rebuilt guard keeps the count (P2.1)', async () => {
  const { createPin, calls } = okCreatePin();
  const shared = state(2);
  const guardTurn1 = createSurfCreatePinGuard({ createPin, state: shared });
  await guardTurn1(METABOT_ID, buzzData(), {});
  await guardTurn1(METABOT_ID, likeData('pin-a'), {});
  // The DSH tool surface is rebuilt every turn: a fresh guard instance over
  // the SAME session marker must not reset the budget counter.
  const guardTurn2 = createSurfCreatePinGuard({ createPin, state: shared });
  await assert.rejects(() => guardTurn2(METABOT_ID, buzzData(), {}), /budget exhausted/);
  assert.equal(calls.length, 2);
  assert.equal(shared.writesUsed, 2);
});

test('duplicate interaction with the same pin is rejected without spending budget (P2.3)', async () => {
  const { createPin, calls } = okCreatePin();
  const shared = state(5);
  const guard = createSurfCreatePinGuard({ createPin, state: shared });
  await guard(METABOT_ID, likeData('pin-a'), {});
  await assert.rejects(() => guard(METABOT_ID, likeData('pin-a'), {}), /Already interacted/);
  assert.equal(shared.writesUsed, 1, 'the duplicate did not consume budget');
  assert.equal(calls.length, 1);
  // A stronger action on the same target is still allowed (comment after like).
  await guard(METABOT_ID, commentData('pin-a'), {});
  // …but not a weaker/equal one afterwards (like after comment).
  await assert.rejects(() => guard(METABOT_ID, likeData('pin-a'), {}), /Already interacted/);
  assert.equal(shared.writesUsed, 2);
});

test('the seen ledger blocks cross-run duplicates; read/save never blocks', async () => {
  const { createPin } = okCreatePin();
  const ledger = new Map([['pin-liked', 'liked'], ['pin-saved', 'saved'], ['pin-read', 'read']]);
  const getSeenAction = (_metabotId, pinId) => ledger.get(pinId) ?? null;
  const guard = createSurfCreatePinGuard({ createPin, state: state(5), getSeenAction });

  await assert.rejects(() => guard(METABOT_ID, likeData('pin-liked'), {}), /Already interacted/);
  // saved/read are below interaction rank — engaging with them is fine.
  await guard(METABOT_ID, likeData('pin-saved'), {});
  await guard(METABOT_ID, commentData('pin-read'), {});
});

test('answer and challenge targets are extracted for the dup guard', async () => {
  const { createPin } = okCreatePin();
  const shared = state(9);
  const guard = createSurfCreatePinGuard({ createPin, state: shared });
  await guard(METABOT_ID, answerData('q-1'), {});
  await assert.rejects(() => guard(METABOT_ID, answerData('q-1'), {}), /Already interacted/);
  await guard(METABOT_ID, challengeData('rev-1'), {});
  await assert.rejects(() => guard(METABOT_ID, challengeData('rev-1'), {}), /Already interacted/);
});

test('a sick ledger never blocks writes (in-run record still holds)', async () => {
  const { createPin, calls } = okCreatePin();
  const shared = state(3);
  const guard = createSurfCreatePinGuard({
    createPin,
    state: shared,
    getSeenAction: () => { throw new Error('sqlite down'); },
  });
  await guard(METABOT_ID, likeData('pin-a'), {});
  await assert.rejects(() => guard(METABOT_ID, likeData('pin-a'), {}), /Already interacted/);
  assert.equal(calls.length, 1);
});

test('original posts skip the dup check but still count against the budget', async () => {
  const { createPin, calls } = okCreatePin();
  const shared = state(2);
  const guard = createSurfCreatePinGuard({ createPin, state: shared });
  await guard(METABOT_ID, buzzData(), {});
  await guard(METABOT_ID, buzzData(), {});
  await assert.rejects(() => guard(METABOT_ID, buzzData(), {}), /budget exhausted/);
  assert.equal(calls.length, 2);
  assert.deepEqual(shared.interactions, undefined, 'no targets were recorded for original posts');
});

test('a failed chain write consumes budget but stays re-interactable', async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('insufficient funds');
    return { txids: ['tx'], pinId: 'p', totalCost: 1 };
  };
  const shared = state(2);
  const guard = createSurfCreatePinGuard({ createPin: flaky, state: shared });
  await assert.rejects(() => guard(METABOT_ID, likeData('pin-a'), {}), /insufficient funds/);
  assert.equal(shared.writesUsed, 1, 'failed attempts count against the budget');
  assert.equal(shared.interactions, undefined, 'failed like was not recorded as an interaction');
  await guard(METABOT_ID, likeData('pin-a'), {}, 'retry after a failure is allowed');
  assert.equal(shared.interactions['pin-a'] > 0, true);
});

test('self-interactions are blocked for free — like/answer/challenge on own pins (review 2, item 5)', async () => {
  const { createPin, calls } = okCreatePin();
  const own = new Set(['own-post', 'own-question', 'own-rev']);
  const shared = state(9);
  const guard = createSurfCreatePinGuard({
    createPin,
    state: shared,
    isOwnPin: (_metabotId, pinId) => own.has(pinId),
  });
  await assert.rejects(() => guard(METABOT_ID, likeData('own-post'), {}), /YOUR OWN pin/);
  await assert.rejects(() => guard(METABOT_ID, answerData('own-question'), {}), /YOUR OWN pin/);
  await assert.rejects(() => guard(METABOT_ID, challengeData('own-rev'), {}), /YOUR OWN pin/);
  assert.equal(shared.writesUsed, undefined, 'self-interactions never spend budget');
  assert.equal(calls.length, 0, 'self-interactions never reach the wallet');
  // Replying in your OWN thread is the inbox flow — comments stay allowed.
  await guard(METABOT_ID, commentData('own-post'), {});
  assert.equal(shared.writesUsed, 1);
  // …and other people's pins are unaffected.
  await guard(METABOT_ID, likeData('pin-a'), {});
  assert.equal(shared.writesUsed, 2);
});

test('a sick own-pin ledger never blocks writes', async () => {
  const { createPin, calls } = okCreatePin();
  const guard = createSurfCreatePinGuard({
    createPin,
    state: state(3),
    isOwnPin: () => { throw new Error('sqlite down'); },
  });
  await guard(METABOT_ID, likeData('pin-a'), {});
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// On-chain receipts → seen-ledger folding (review 2, item 6)
// ---------------------------------------------------------------------------

test('a successful original post records a posted receipt', async () => {
  const { createPin } = okCreatePin();
  const shared = state(5);
  const guard = createSurfCreatePinGuard({ createPin, state: shared });
  await guard(METABOT_ID, buzzData(), {});
  assert.deepEqual(shared.postedPinIds, ['new-pin']);
  const receipts = surfReceiptSeenActions(shared);
  assert.deepEqual(receipts, [{ pinId: 'new-pin', action: 'posted' }]);
});

test('surfReceiptSeenActions maps interaction ranks back to actions', async () => {
  const { createPin } = okCreatePin();
  const shared = state(9);
  const guard = createSurfCreatePinGuard({ createPin, state: shared });
  await guard(METABOT_ID, likeData('pin-a'), {});
  await guard(METABOT_ID, commentData('pin-a'), {});
  await guard(METABOT_ID, answerData('q-1'), {});
  await guard(METABOT_ID, challengeData('rev-1'), {});
  const receipts = surfReceiptSeenActions(shared);
  assert.deepEqual(
    receipts.map((entry) => `${entry.pinId}:${entry.action}`).sort(),
    ['pin-a:commented', 'q-1:answered', 'rev-1:challenged'].sort(),
    'strongest action per target wins (like+comment → commented)',
  );
});

test('fold replaces self-reported chain-write classes with ground-truth receipts', () => {
  const selfReported = [
    { pinId: 'pin-read', action: 'read' },
    { pinId: 'pin-saved', action: 'saved' },
    { pinId: 'pin-hallucinated-like', action: 'liked' },
    { pinId: 'pin-hallucinated-answer', action: 'answered' },
  ];
  const folded = foldSurfReceiptsIntoSeenActions(selfReported, {
    interactionBudget: 20,
    kbBudget: 40,
    interactions: { 'pin-real-like': 4 },
    postedPinIds: ['pin-real-post'],
  });
  assert.deepEqual(
    folded.map((entry) => `${entry.pinId}:${entry.action}`).sort(),
    [
      'pin-read:read',
      'pin-saved:saved',
      'pin-real-like:liked',
      'pin-real-post:posted',
    ].sort(),
    'hallucinated interactions dropped, actual receipts banked, read/saved untouched',
  );
});

test('fold with zero receipts strips ALL self-reported chain-write classes', () => {
  const folded = foldSurfReceiptsIntoSeenActions(
    [
      { pinId: 'pin-read', action: 'read' },
      { pinId: 'pin-claimed-like', action: 'liked' },
      { pinId: 'pin-claimed-post', action: 'posted' },
    ],
    { interactionBudget: 20, kbBudget: 40 },
  );
  assert.deepEqual(folded, [{ pinId: 'pin-read', action: 'read' }]);
});

test('recordSurfDeepRead dedupes and ignores blanks (round 3)', () => {
  const state = { interactionBudget: 20, kbBudget: 40 };
  recordSurfDeepRead(state, 'pin-a');
  recordSurfDeepRead(state, 'pin-a');
  recordSurfDeepRead(state, '  pin-b  ');
  recordSurfDeepRead(state, '');
  assert.deepEqual(state.readPinIds, ['pin-a', 'pin-b']);
  assert.deepEqual(
    surfDeepReadReceiptSeenActions(state),
    [{ pinId: 'pin-a', action: 'read' }, { pinId: 'pin-b', action: 'read' }],
  );
});

test('fold unions tracked deep reads over the self-report (round 3)', () => {
  const folded = foldSurfReceiptsIntoSeenActions(
    [{ pinId: 'pin-selfread', action: 'read' }, { pinId: 'pin-claimed-like', action: 'liked' }],
    {
      interactionBudget: 20,
      kbBudget: 40,
      interactions: { 'pin-real-like': 4 },
      readPinIds: ['pin-trackedread', 'pin-selfread'],
    },
  );
  assert.deepEqual(
    [...new Set(folded.map((entry) => `${entry.pinId}:${entry.action}`))].sort(),
    ['pin-selfread:read', 'pin-trackedread:read', 'pin-real-like:liked'].sort(),
    'a tracked read the model forgot to report is banked; the batch store collapses the duplicate read entries',
  );
});

test('surfSessionPartialStats counts only what the host can vouch for (round 3)', () => {
  assert.deepEqual(
    surfSessionPartialStats({ interactionBudget: 20, kbBudget: 40 }),
    {},
    'empty marker -> empty stats (the failed run falls back to fetched-only)',
  );
  const stats = surfSessionPartialStats({
    interactionBudget: 20,
    kbBudget: 40,
    interactions: { 'pin-a': 4, 'pin-b': 5, 'pin-c': 6 },
    postedPinIds: ['pin-post'],
    kbAddsUsed: 3,
    readPinIds: ['pin-r1', 'pin-r2'],
    tasksScheduled: 2,
  });
  assert.deepEqual(stats, {
    liked: 1, commented: 1, answered: 1, challenged: 0, posted: 1,
    savedToKb: 3, deepRead: 2, tasksScheduled: 2,
  });
});

test('surfReceiptsFromChainWriteRecord re-derives posted + interaction receipts (round 3 reconciliation)', () => {
  const like = surfReceiptsFromChainWriteRecord({
    pinId: 'reaction-pin',
    path: '/protocols/paylike',
    contentText: JSON.stringify({ isLike: 1, likeTo: 'target-a' }),
  });
  assert.deepEqual(like, [
    { pinId: 'reaction-pin', action: 'posted' },
    { pinId: 'target-a', action: 'liked' },
  ]);
  const answer = surfReceiptsFromChainWriteRecord({
    pinId: 'answer-pin',
    path: '/protocols/simpleanswer',
    contentText: JSON.stringify({ answerTo: 'q-1', content: 'a' }),
  });
  assert.deepEqual(answer, [
    { pinId: 'answer-pin', action: 'posted' },
    { pinId: 'q-1', action: 'answered' },
  ]);
  // An original post has no target: posted receipt only.
  assert.deepEqual(
    surfReceiptsFromChainWriteRecord({ pinId: 'buzz-pin', path: '/protocols/simplebuzz', contentText: '{"content":"hi"}' }),
    [{ pinId: 'buzz-pin', action: 'posted' }],
  );
  // Unparsable payload never blocks the own-pin receipt.
  assert.deepEqual(
    surfReceiptsFromChainWriteRecord({ pinId: 'odd-pin', path: '/protocols/paylike', contentText: 'not json' }),
    [{ pinId: 'odd-pin', action: 'posted' }],
  );
});
