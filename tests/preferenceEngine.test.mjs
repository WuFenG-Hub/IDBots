import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  C3_BEST,
  COMMIT_CLOSE,
  FINAL_NOW,
  H1,
  H2,
  P1,
  ROUND_AT,
  SCENARIOS,
  chain,
  checkScenario,
} from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { tallyRound } = require('../dist-electron/main/services/preference/engine.js');
const { canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');

for (const scenario of SCENARIOS) {
  test(`scenario ${scenario.id}`, () => {
    const { round, events } = scenario.build();
    const tally = tallyRound(events, round, { nowSec: scenario.nowSec });
    assert.equal(tally.ok, true, tally.reason);
    assert.deepEqual(checkScenario(tally.result, scenario.expect), []);
  });
}

test('tallyHash is sha256(canonJ(output)) and spam pins cannot change it', () => {
  const c = chain();
  const round = c.openRound();
  c.vote(round, H1, C3_BEST);
  c.vote(round, H2, C3_BEST);
  const clean = tallyRound(c.events, round, { nowSec: FINAL_NOW });
  c.add('commit', { round, hash: 'not-hex' }, P1, COMMIT_CLOSE - 100);
  c.add('reveal', { round, commit: 'x', salt: 'y', ballot: {} }, P1, COMMIT_CLOSE + 100);
  const spammed = tallyRound(c.events, round, { nowSec: FINAL_NOW });
  assert.equal(clean.result.tallyHash, sha256Hex(canonJ(clean.result.output)));
  assert.equal(spammed.result.tallyHash, clean.result.tallyHash);
  assert.deepEqual(spammed.result.diagnostics.ignored.map((item) => item.reason).sort(), ['commit:shape', 'reveal:shape']);
});

test('input order does not change the tally', () => {
  const { round, events } = SCENARIOS.find((scenario) => scenario.id === 'agreement').build();
  const forward = tallyRound(events, round, { nowSec: FINAL_NOW });
  const backward = tallyRound([...events].reverse(), round, { nowSec: FINAL_NOW });
  assert.equal(backward.result.tallyHash, forward.result.tallyHash);
});

test('invalid or unconfirmed rounds are reported, not tallied', () => {
  const invalid = chain();
  const badRound = invalid.openRound({ commitCloseAt: ROUND_AT + 60 });
  assert.deepEqual(tallyRound(invalid.events, badRound, { nowSec: FINAL_NOW }), { ok: false, reason: 'round:windows' });
  const pending = chain();
  const pendingRound = pending.openRound();
  pending.events[0].height = -1;
  assert.deepEqual(tallyRound(pending.events, pendingRound, { nowSec: FINAL_NOW }), { ok: false, reason: 'round:unconfirmed' });
  assert.deepEqual(tallyRound([], 'missing', { nowSec: FINAL_NOW }), { ok: false, reason: 'round:not-found' });
});
