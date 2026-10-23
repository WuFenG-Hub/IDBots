// Exhaustive unit tests for the pure wrap-up timer state machine
// (src/main/libs/skillTurnWrapUpState.ts). Every timer transition of the
// ACTIVE Twin→Worker wrap-up mechanism must be covered here — the bridge only
// maps machine effects to real side effects, all decisions live in the module
// under test. Includes the 45-min daemon-cap sequence invariant across a
// config grid.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SKILL_TURN_DAEMON_WATCHDOG_CAP_MS,
  DEFAULT_WRAP_UP_GRACE_MS,
  DEFAULT_WRAP_UP_EXTENSION_RATIO,
  EXTENSION_REQUEST_MARKER,
  WRAP_UP_MARKER,
  initialWrapUpMachineState,
  resolveWrapUpRuntimeConfig,
  parseWrapUpReplyMarker,
  computeExtensionBudgetMs,
  advanceWrapUpMachine,
  buildWrapUpMessage,
  buildExtensionGrantedMessage,
} = require('../dist-electron/main/libs/skillTurnWrapUpState.js');

const MIN = 60_000;
const CAP = 45 * MIN;
const budget = (ms) => resolveWrapUpRuntimeConfig({}, ms);
const defaultConfig = () => resolveWrapUpRuntimeConfig({}, 30 * MIN);

test('constants pin the documented defaults and the 45-min daemon cap', () => {
  assert.equal(SKILL_TURN_DAEMON_WATCHDOG_CAP_MS, 45 * MIN);
  assert.equal(DEFAULT_WRAP_UP_GRACE_MS, 5 * MIN);
  assert.equal(DEFAULT_WRAP_UP_EXTENSION_RATIO, 0.5);
  assert.equal(EXTENSION_REQUEST_MARKER, 'EXTENSION_REQUEST:');
  assert.equal(WRAP_UP_MARKER, 'WRAP_UP:');
});

test('resolveWrapUpRuntimeConfig applies defaults, clamps, and the cap invariant', () => {
  assert.deepEqual(budget(30 * MIN), {
    originalBudgetMs: 30 * MIN,
    graceMs: 5 * MIN,
    extensionRatio: 0.5,
    daemonWatchdogCapMs: CAP,
  });

  const custom = resolveWrapUpRuntimeConfig({ graceMs: 2 * MIN, extensionRatio: 0.25 }, 10 * MIN);
  assert.equal(custom.graceMs, 2 * MIN);
  assert.equal(custom.extensionRatio, 0.25);

  // Grace is clamped so budget + grace can NEVER exceed the cap, whatever the
  // caller asked for (a 44-min budget leaves only 1 min of grace).
  const clamped = resolveWrapUpRuntimeConfig({ graceMs: 10 * MIN }, 44 * MIN);
  assert.equal(clamped.graceMs, 1 * MIN);

  // Ratio clamps into [0, 1]; non-finite values fall back to the defaults.
  assert.equal(resolveWrapUpRuntimeConfig({ extensionRatio: 7 }, 30 * MIN).extensionRatio, 1);
  assert.equal(resolveWrapUpRuntimeConfig({ extensionRatio: -1 }, 30 * MIN).extensionRatio, 0);
  assert.equal(resolveWrapUpRuntimeConfig({ graceMs: Number.NaN }, 30 * MIN).graceMs, 5 * MIN);

  // Budget at/over the cap leaves zero grace — the wrap-up settles at once.
  assert.equal(resolveWrapUpRuntimeConfig({}, 45 * MIN).graceMs, 0);
  assert.equal(resolveWrapUpRuntimeConfig({ graceMs: 5 * MIN }, 50 * MIN).graceMs, 0);
});

test('parseWrapUpReplyMarker: first non-empty line, case-sensitive prefix match', () => {
  assert.deepEqual(
    parseWrapUpReplyMarker('EXTENSION_REQUEST: tests still running\n\nhandoff follows'),
    { marker: 'extension-request', reason: 'tests still running' },
  );
  // Leading blank lines are tolerated; the marker must still be first.
  assert.deepEqual(
    parseWrapUpReplyMarker('\n   \nEXTENSION_REQUEST:  one more minute \nWRAP_UP:'),
    { marker: 'extension-request', reason: 'one more minute' },
  );
  assert.deepEqual(parseWrapUpReplyMarker('WRAP_UP: done'), { marker: 'wrap-up' });
  assert.deepEqual(parseWrapUpReplyMarker('WRAP_UP'), { marker: 'wrap-up' });
  assert.deepEqual(parseWrapUpReplyMarker(''), { marker: 'none' });
  assert.deepEqual(parseWrapUpReplyMarker('\n \n'), { marker: 'none' });
  // Wrong case / mid-text markers do NOT count.
  assert.deepEqual(parseWrapUpReplyMarker('extension_request: nope'), { marker: 'none' });
  assert.deepEqual(parseWrapUpReplyMarker('handoff text\nEXTENSION_REQUEST: too late'), { marker: 'none' });
  assert.deepEqual(parseWrapUpReplyMarker('I request EXTENSION_REQUEST: inline'), { marker: 'none' });
});

test('computeExtensionBudgetMs: the documented 30+10+5=45 arithmetic and its clamps', () => {
  // Twin defaults, request lands immediately at budget exhaustion:
  // min(0.5 × 30, 45 − 30 − 5) = min(15, 10) = 10 → 30 + 10 + 5 = 45.
  assert.equal(
    computeExtensionBudgetMs({
      originalBudgetMs: 30 * MIN,
      extensionRatio: 0.5,
      daemonWatchdogCapMs: CAP,
      finalGraceMs: 5 * MIN,
      elapsedMs: 30 * MIN,
    }),
    10 * MIN,
  );

  // A request landing late inside the grace window gets a smaller extension so
  // the sequence still lands exactly at the cap: 33 + 7 + 5 = 45.
  assert.equal(
    computeExtensionBudgetMs({
      originalBudgetMs: 30 * MIN,
      extensionRatio: 0.5,
      daemonWatchdogCapMs: CAP,
      finalGraceMs: 5 * MIN,
      elapsedMs: 33 * MIN,
    }),
    7 * MIN,
  );

  // The ratio wins when it is the smaller operand (0.2 × 30 = 6 < 10).
  assert.equal(
    computeExtensionBudgetMs({
      originalBudgetMs: 30 * MIN,
      extensionRatio: 0.2,
      daemonWatchdogCapMs: CAP,
      finalGraceMs: 5 * MIN,
      elapsedMs: 30 * MIN,
    }),
    6 * MIN,
  );

  // No headroom left (elapsed + finalGrace already at the cap) → not grantable.
  assert.ok(
    computeExtensionBudgetMs({
      originalBudgetMs: 30 * MIN,
      extensionRatio: 0.5,
      daemonWatchdogCapMs: CAP,
      finalGraceMs: 5 * MIN,
      elapsedMs: 40 * MIN,
    }) <= 0,
  );

  // Zero ratio means zero extension (never grantable).
  assert.equal(
    computeExtensionBudgetMs({
      originalBudgetMs: 30 * MIN,
      extensionRatio: 0,
      daemonWatchdogCapMs: CAP,
      finalGraceMs: 5 * MIN,
      elapsedMs: 30 * MIN,
    }),
    0,
  );
});

test('transition: running + budget-exhausted injects the wrap-up signal with the grace window', () => {
  const result = advanceWrapUpMachine(
    initialWrapUpMachineState(),
    { type: 'budget-exhausted', elapsedMs: 30 * MIN },
    defaultConfig(),
  );
  assert.equal(result.state.phase, 'wrap');
  assert.equal(result.state.extensionUsed, false);
  assert.deepEqual(result.effect, { kind: 'inject-wrap-up', graceMs: 5 * MIN });
});

test('running phase ignores completions and window expiries', () => {
  for (const event of [
    { type: 'turn-completed', replyText: 'WRAP_UP: early', elapsedMs: 1000 },
    { type: 'window-expired', elapsedMs: 1000 },
  ]) {
    const result = advanceWrapUpMachine(initialWrapUpMachineState(), event, defaultConfig());
    assert.equal(result.state.phase, 'running');
    assert.equal(result.effect.kind, 'none');
  }
});

test('transition: wrap + WRAP_UP (or any non-extension reply) resolves with the reply', () => {
  for (const replyText of ['WRAP_UP: done\n- summary', 'plain handoff without marker', '']) {
    const afterBudget = advanceWrapUpMachine(
      initialWrapUpMachineState(),
      { type: 'budget-exhausted', elapsedMs: 30 * MIN },
      defaultConfig(),
    );
    const result = advanceWrapUpMachine(
      afterBudget.state,
      { type: 'turn-completed', replyText, elapsedMs: 31 * MIN },
      defaultConfig(),
    );
    assert.equal(result.state.phase, 'settled');
    assert.equal(result.state.settledAs, 'resolved');
    assert.deepEqual(result.effect, { kind: 'resolve', replyText });
  }
});

test('transition: wrap + first EXTENSION_REQUEST with headroom grants the one extension', () => {
  const afterBudget = advanceWrapUpMachine(
    initialWrapUpMachineState(),
    { type: 'budget-exhausted', elapsedMs: 30 * MIN },
    defaultConfig(),
  );
  const result = advanceWrapUpMachine(
    afterBudget.state,
    { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: mid-run tests', elapsedMs: 30 * MIN + 30_000 },
    defaultConfig(),
  );
  assert.equal(result.state.phase, 'extension');
  assert.equal(result.state.extensionUsed, true);
  // min(15, 45 − 30.5 − 5) = 9.5 min at 30.5 min elapsed.
  assert.deepEqual(result.effect, { kind: 'grant-extension', extensionMs: Math.trunc(9.5 * MIN) });
});

test('transition: wrap + EXTENSION_REQUEST without headroom is denied into the final wrap-up', () => {
  const afterBudget = advanceWrapUpMachine(
    initialWrapUpMachineState(),
    { type: 'budget-exhausted', elapsedMs: 30 * MIN },
    defaultConfig(),
  );
  // Request lands at 42 min: 45 − 42 = 3 min headroom, grace clamps to 3.
  const result = advanceWrapUpMachine(
    afterBudget.state,
    { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: please', elapsedMs: 42 * MIN },
    defaultConfig(),
  );
  assert.equal(result.state.phase, 'final-wrap');
  assert.equal(result.state.extensionUsed, false);
  assert.deepEqual(result.effect, { kind: 'deny-extension', graceMs: 3 * MIN });
});

test('transition: deny with zero remaining headroom settles as timeout immediately', () => {
  const afterBudget = advanceWrapUpMachine(
    initialWrapUpMachineState(),
    { type: 'budget-exhausted', elapsedMs: 30 * MIN },
    defaultConfig(),
  );
  const atCap = advanceWrapUpMachine(
    afterBudget.state,
    { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: too late', elapsedMs: 45 * MIN },
    defaultConfig(),
  );
  assert.equal(atCap.state.phase, 'settled');
  assert.equal(atCap.state.settledAs, 'timeout');
  assert.deepEqual(atCap.effect, { kind: 'timeout' });
});

test('transition: wrap + window-expired settles as timeout', () => {
  const afterBudget = advanceWrapUpMachine(
    initialWrapUpMachineState(),
    { type: 'budget-exhausted', elapsedMs: 30 * MIN },
    defaultConfig(),
  );
  const result = advanceWrapUpMachine(
    afterBudget.state,
    { type: 'window-expired', elapsedMs: 35 * MIN },
    defaultConfig(),
  );
  assert.equal(result.state.phase, 'settled');
  assert.equal(result.state.settledAs, 'timeout');
  assert.deepEqual(result.effect, { kind: 'timeout' });
});

test('transition: extension + any completion resolves — a SECOND extension request is ignored', () => {
  const afterGrant = advanceWrapUpMachine(
    advanceWrapUpMachine(
      initialWrapUpMachineState(),
      { type: 'budget-exhausted', elapsedMs: 30 * MIN },
      defaultConfig(),
    ).state,
    { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: first', elapsedMs: 30 * MIN },
    defaultConfig(),
  );
  assert.equal(afterGrant.state.phase, 'extension');

  const second = advanceWrapUpMachine(
    afterGrant.state,
    { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: second', elapsedMs: 33 * MIN },
    defaultConfig(),
  );
  // Not honored: no new grant, no deny — the reply resolves the turn as-is.
  assert.equal(second.state.phase, 'settled');
  assert.equal(second.state.settledAs, 'resolved');
  assert.equal(second.state.extensionUsed, true);
  assert.deepEqual(second.effect, { kind: 'resolve', replyText: 'EXTENSION_REQUEST: second' });
});

test('transition: extension + window-expired injects the final wrap-up with clamped grace', () => {
  const afterGrant = advanceWrapUpMachine(
    advanceWrapUpMachine(
      initialWrapUpMachineState(),
      { type: 'budget-exhausted', elapsedMs: 30 * MIN },
      defaultConfig(),
    ).state,
    { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: first', elapsedMs: 30 * MIN },
    defaultConfig(),
  );
  // Extension granted: 10 min from 30 → expires at 40; remaining grace
  // min(5, 45−40) = 5 → total 45 exactly.
  const result = advanceWrapUpMachine(
    afterGrant.state,
    { type: 'window-expired', elapsedMs: 40 * MIN },
    defaultConfig(),
  );
  assert.equal(result.state.phase, 'final-wrap');
  assert.deepEqual(result.effect, { kind: 'inject-final-wrap-up', graceMs: 5 * MIN });

  // Late-firing timers shrink the final grace so the cap still holds.
  const lateGrant = advanceWrapUpMachine(
    advanceWrapUpMachine(
      initialWrapUpMachineState(),
      { type: 'budget-exhausted', elapsedMs: 30 * MIN },
      defaultConfig(),
    ).state,
    { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: late ask', elapsedMs: 34 * MIN },
    defaultConfig(),
  );
  // Grant at 34: min(15, 45−34−5=6) → 6 min; expiry event fires late at 43:
  // remaining = min(5, 45−43) = 2.
  const lateExpiry = advanceWrapUpMachine(
    lateGrant.state,
    { type: 'window-expired', elapsedMs: 43 * MIN },
    defaultConfig(),
  );
  assert.deepEqual(lateExpiry.effect, { kind: 'inject-final-wrap-up', graceMs: 2 * MIN });
});

test('transition: final-wrap + any completion resolves, extension requests included (ignored)', () => {
  const intoFinal = advanceWrapUpMachine(
    advanceWrapUpMachine(
      advanceWrapUpMachine(
        initialWrapUpMachineState(),
        { type: 'budget-exhausted', elapsedMs: 30 * MIN },
        defaultConfig(),
      ).state,
      { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: first', elapsedMs: 30 * MIN },
      defaultConfig(),
    ).state,
    { type: 'window-expired', elapsedMs: 40 * MIN },
    defaultConfig(),
  );
  assert.equal(intoFinal.state.phase, 'final-wrap');

  const result = advanceWrapUpMachine(
    intoFinal.state,
    { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: ignored now\nWRAP_UP: handoff', elapsedMs: 42 * MIN },
    defaultConfig(),
  );
  assert.equal(result.state.phase, 'settled');
  assert.equal(result.state.settledAs, 'resolved');
  assert.deepEqual(result.effect, {
    kind: 'resolve',
    replyText: 'EXTENSION_REQUEST: ignored now\nWRAP_UP: handoff',
  });
});

test('transition: final-wrap + window-expired settles as timeout; settled ignores everything', () => {
  const intoFinal = advanceWrapUpMachine(
    advanceWrapUpMachine(
      advanceWrapUpMachine(
        initialWrapUpMachineState(),
        { type: 'budget-exhausted', elapsedMs: 30 * MIN },
        defaultConfig(),
      ).state,
      { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: first', elapsedMs: 30 * MIN },
      defaultConfig(),
    ).state,
    { type: 'window-expired', elapsedMs: 40 * MIN },
    defaultConfig(),
  );
  const settled = advanceWrapUpMachine(
    intoFinal.state,
    { type: 'window-expired', elapsedMs: 45 * MIN },
    defaultConfig(),
  );
  assert.equal(settled.state.phase, 'settled');
  assert.equal(settled.state.settledAs, 'timeout');
  assert.deepEqual(settled.effect, { kind: 'timeout' });

  // Everything after settlement is a no-op with an unchanged state.
  for (const event of [
    { type: 'turn-completed', replyText: 'WRAP_UP: zombie', elapsedMs: 46 * MIN },
    { type: 'window-expired', elapsedMs: 47 * MIN },
    { type: 'budget-exhausted', elapsedMs: 48 * MIN },
  ]) {
    const after = advanceWrapUpMachine(settled.state, event, defaultConfig());
    assert.equal(after.state.phase, 'settled');
    assert.equal(after.effect.kind, 'none');
  }
});

test('sequence invariant: no timer sequence exceeds the 45-min cap across a config grid', () => {
  const budgets = [5 * MIN, 15 * MIN, 30 * MIN, 40 * MIN, 44 * MIN, 45 * MIN];
  const graces = [0, MIN, 5 * MIN, 10 * MIN];
  const ratios = [0, 0.25, 0.5, 1];
  const step = 30_000; // sample the grant time every 30 s inside the grace window

  for (const budgetMs of budgets) {
    for (const graceRequested of graces) {
      for (const ratio of ratios) {
        const config = resolveWrapUpRuntimeConfig(
          { graceMs: graceRequested, extensionRatio: ratio },
          budgetMs,
        );

        // Path A — no extension: budget + grace must land inside the cap.
        const afterBudget = advanceWrapUpMachine(
          initialWrapUpMachineState(),
          { type: 'budget-exhausted', elapsedMs: budgetMs },
          config,
        );
        assert.equal(afterBudget.effect.kind, 'inject-wrap-up');
        const pathAExpiry = advanceWrapUpMachine(
          afterBudget.state,
          { type: 'window-expired', elapsedMs: budgetMs + config.graceMs },
          config,
        );
        assert.equal(pathAExpiry.effect.kind, 'timeout');
        assert.ok(budgetMs + config.graceMs <= CAP, `path A breaches cap: ${budgetMs}+${config.graceMs}`);

        // Path B — extension granted at various points inside the grace
        // window: (grantElapsed + extension) + finalGrace must land ≤ cap.
        const grantWindowEnd = budgetMs + config.graceMs;
        for (let grantElapsed = budgetMs; grantElapsed <= grantWindowEnd; grantElapsed += step) {
          const granted = advanceWrapUpMachine(
            afterBudget.state,
            { type: 'turn-completed', replyText: 'EXTENSION_REQUEST: grid probe', elapsedMs: grantElapsed },
            config,
          );
          if (granted.effect.kind === 'resolve') continue; // not reachable for a marker reply, kept for safety
          if (granted.effect.kind === 'deny-extension') {
            // Denied for lack of headroom: the final grace is clamped so even
            // the deny path settles inside the cap.
            assert.ok(grantElapsed + granted.effect.graceMs <= CAP,
              `deny path breaches cap: ${grantElapsed}+${granted.effect.graceMs}`);
            const deniedSettle = advanceWrapUpMachine(
              granted.state,
              { type: 'window-expired', elapsedMs: grantElapsed + granted.effect.graceMs },
              config,
            );
            assert.equal(deniedSettle.effect.kind, 'timeout');
            continue;
          }
          if (granted.effect.kind === 'timeout') {
            assert.ok(grantElapsed <= CAP);
            continue;
          }
          assert.equal(granted.effect.kind, 'grant-extension');
          const extensionMs = granted.effect.extensionMs;
          assert.ok(extensionMs > 0);
          const extensionEnd = grantElapsed + extensionMs;
          const finalSignal = advanceWrapUpMachine(
            granted.state,
            { type: 'window-expired', elapsedMs: extensionEnd },
            config,
          );
          if (finalSignal.effect.kind === 'timeout') {
            assert.ok(extensionEnd <= CAP, 'extension-only expiry must be inside the cap');
            continue;
          }
          assert.equal(finalSignal.effect.kind, 'inject-final-wrap-up');
          const finalGraceMs = finalSignal.effect.graceMs;
          assert.ok(extensionEnd + finalGraceMs <= CAP,
            `path B breaches cap: ${grantElapsed}+${extensionMs}+${finalGraceMs} (budget ${budgetMs}, ratio ${ratio})`);
          // And the final window expiring settles at/inside the cap.
          const finalSettle = advanceWrapUpMachine(
            finalSignal.state,
            { type: 'window-expired', elapsedMs: extensionEnd + finalGraceMs },
            config,
          );
          assert.equal(finalSettle.effect.kind, 'timeout');
          assert.ok(extensionEnd + finalGraceMs <= CAP);
        }
      }
    }
  }
});

test('message builders carry the exact protocol wording', () => {
  const withOffer = buildWrapUpMessage({ budgetMinutes: 30, offerExtension: true });
  assert.ok(withOffer.includes('[ORCH-WRAP-UP]'));
  assert.ok(withOffer.includes('(30 min) is exhausted'));
  assert.ok(withOffer.includes('Stop all new exploration and tool work NOW'));
  assert.ok(withOffer.includes('handoff_contract'));
  assert.ok(withOffer.includes('EXTENSION_REQUEST: <one-line reason>'));
  assert.ok(withOffer.includes('WRAP_UP:'));

  const final = buildWrapUpMessage({ budgetMinutes: 30, offerExtension: false });
  assert.ok(final.includes('[ORCH-WRAP-UP]'));
  assert.ok(final.includes('No further extension is available'));
  assert.ok(!final.includes('EXTENSION_REQUEST: <one-line reason>'));

  const granted = buildExtensionGrantedMessage({ extensionMs: 10 * MIN });
  assert.ok(granted.includes('[ORCH-EXTENSION-GRANTED]'));
  assert.ok(granted.includes('10 additional minutes'));
  assert.ok(granted.includes('the only one'));
});
