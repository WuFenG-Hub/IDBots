import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ballotCommitHash, newBallotSalt } = require('../dist-electron/main/services/preference/sealing.js');

const INPUT = {
  round: `${'0'.repeat(63)}1i0`,
  judge: `idq1human1${'0'.repeat(32)}`,
  salt: 'ab'.repeat(32),
  ballot: { pairs: [{ a: 'c1', b: 'c2', pick: 'a', reason: '左侧更清晰 clearer hierarchy' }] },
};

test('commit hash matches the cross-language vector', () => {
  assert.equal(ballotCommitHash(INPUT), 'abd17de74b2571515363d839b7b8e6a447ee9c3703b6ec674bc343c145f28484');
});

test('commit hash ignores key order and binds the judge', () => {
  const reordered = { ballot: { pairs: [{ reason: INPUT.ballot.pairs[0].reason, pick: 'a', b: 'c2', a: 'c1' }] } };
  assert.equal(ballotCommitHash({ ...INPUT, ...reordered }), ballotCommitHash(INPUT));
  assert.notEqual(ballotCommitHash({ ...INPUT, judge: `idq1human2${'0'.repeat(32)}` }), ballotCommitHash(INPUT));
});

test('salts are 32 random bytes in lowercase hex', () => {
  const a = newBallotSalt();
  const b = newBallotSalt();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
