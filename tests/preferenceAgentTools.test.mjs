import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { B1, B2, B3, CANDIDATES, H2, gid, pid, roundBody } from './fixtures/preference/scenarios.mjs';

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
