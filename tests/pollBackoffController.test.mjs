import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PollBackoffController } = require('../dist-electron/main/services/pollBackoffController.js');

/**
 * PollBackoffController (issue #24): the shared retry-hygiene core for the
 * background pollers. All tests use injected clock/random seams — no real
 * timers, fully deterministic.
 */

const T0 = 1_790_000_000_000;

const makeController = (overrides = {}) => {
  const clock = { value: T0 };
  const logs = [];
  const controller = new PollBackoffController({
    name: 'unit',
    baseMs: 15_000,
    now: () => clock.value,
    // random 0.5 → jitter multiplier exactly 1 (no deviation from the ladder)
    random: () => 0.5,
    emitLog: (line) => logs.push(line),
    ...overrides,
  });
  return { controller, clock, logs };
};

test('healthy state: ready() is true and nextDelayMs() is the base cadence', () => {
  const { controller } = makeController();
  assert.equal(controller.ready(), true);
  assert.equal(controller.nextDelayMs(), 15_000);
  assert.equal(controller.getState().circuit, 'closed');
  assert.equal(controller.getState().consecutiveFailures, 0);
});

test('ladder: consecutive failures grow the delay across >= 3 tiers, strictly increasing', () => {
  const { controller, clock, logs } = makeController();
  const delays = [];
  for (let i = 1; i <= 4; i += 1) {
    controller.recordFailure();
    delays.push(controller.nextDelayMs());
    // advance the clock to the allowed instant so ready() is true again
    clock.value += controller.nextDelayMs() + 1;
    assert.equal(controller.ready(), true, `ready after tier ${i}`);
  }
  // base 15s, factor 2: 30s, 60s, 120s, 240s (16x cap)
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000]);
  const distinct = new Set(delays);
  assert.ok(distinct.size >= 3, `expected >= 3 distinct tiers, got ${delays.join(', ')}`);
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] > delays[i - 1], `tier ${i + 1} must grow: ${delays.join(', ')}`);
  }
  // every tier emitted a grep-able backing-off line
  const backingOff = logs.filter((line) => line.includes('[PollBackoff:unit]') && line.includes('backing off after failure #'));
  assert.equal(backingOff.length, 4);
  assert.ok(backingOff[0].includes('~30s'), backingOff[0]);
  assert.ok(backingOff[3].includes('~4m'), backingOff[3]);
});

test('ladder caps at maxTierMs', () => {
  const { controller } = makeController({ maxTierMs: 45_000 });
  controller.recordFailure();
  assert.equal(controller.nextDelayMs(), 30_000);
  controller.getState(); // no clock advance needed: nextDelayMs uses now
  const { controller: c2 } = makeController({ maxTierMs: 45_000 });
  for (let i = 0; i < 4; i += 1) c2.recordFailure();
  // tier 2 already hits the 45s cap
  assert.equal(c2.nextDelayMs(), 45_000);
});

test('jitter stays within +/- jitterRatio of the raw tier delay', () => {
  const lo = makeController({ random: () => 0 });
  lo.controller.recordFailure();
  assert.equal(lo.controller.nextDelayMs(), Math.round(30_000 * 0.8));
  const hi = makeController({ random: () => 1 });
  hi.controller.recordFailure();
  assert.equal(hi.controller.nextDelayMs(), Math.round(30_000 * 1.2));
  const mid = makeController({ random: () => 0.5, jitterRatio: 0.5 });
  mid.controller.recordFailure();
  assert.equal(mid.controller.nextDelayMs(), 30_000);
});

test('circuit breaker: opens at the threshold, blocks attempts for the cooldown, then allows one half-open probe', () => {
  const { controller, clock, logs } = makeController({ openAfterFailures: 5, cooldownMs: 600_000 });
  for (let i = 0; i < 4; i += 1) {
    controller.recordFailure();
    clock.value += controller.nextDelayMs() + 1;
  }
  assert.equal(controller.getState().circuit, 'closed');
  // 5th consecutive failure opens the circuit
  controller.recordFailure();
  assert.equal(controller.getState().circuit, 'open');
  assert.equal(controller.getState().consecutiveFailures, 5);
  const openLog = logs.find((line) => line.includes('circuit OPEN'));
  assert.ok(openLog, 'circuit OPEN line emitted');
  assert.ok(openLog.includes('[PollBackoff:unit]'), openLog);
  assert.ok(openLog.includes('5 consecutive failures'), openLog);
  // during the cooldown no attempt is allowed and the delay is the remaining cooldown
  clock.value += 1;
  assert.equal(controller.ready(), false);
  assert.equal(controller.nextDelayMs(), 600_000 - 1);
  // past the cooldown: one half-open probe is allowed (and logged)
  clock.value += 600_000;
  assert.equal(controller.ready(), true);
  assert.equal(controller.getState().circuit, 'half-open');
  assert.ok(logs.some((line) => line.includes('half-open probe after cooldown')), 'half-open line emitted');
  // a failed probe re-opens for another cooldown
  controller.recordFailure();
  assert.equal(controller.getState().circuit, 'open');
  assert.ok(logs.filter((line) => line.includes('circuit OPEN')).length >= 2, 're-open logged');
});

test('half-open probe success closes the circuit and announces recovery', () => {
  const { controller, clock, logs } = makeController({ openAfterFailures: 2, cooldownMs: 300_000 });
  controller.recordFailure();
  controller.recordFailure();
  assert.equal(controller.getState().circuit, 'open');
  clock.value += 300_000;
  assert.equal(controller.ready(), true);
  assert.equal(controller.getState().circuit, 'half-open');
  controller.recordSuccess();
  const state = controller.getState();
  assert.equal(state.circuit, 'closed');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.openedAtMs, null);
  assert.ok(logs.some((line) => line.includes('recovered — resuming normal cadence')), 'recovery line emitted');
  assert.equal(controller.nextDelayMs(), 15_000);
});

test('recordSuccess from a healthy state is silent (no spurious logs)', () => {
  const { controller, logs } = makeController();
  controller.recordSuccess();
  controller.recordSuccess();
  assert.equal(logs.length, 0);
  assert.equal(controller.getState().consecutiveFailures, 0);
});

test('a failure while the circuit is open extends the cooldown from now', () => {
  const { controller, clock } = makeController({ openAfterFailures: 1, cooldownMs: 600_000 });
  controller.recordFailure(); // opens immediately
  assert.equal(controller.getState().circuit, 'open');
  clock.value += 300_000;
  controller.recordFailure(); // external demand-driven attempt failed
  assert.equal(controller.getState().circuit, 'open');
  // cooldown restarted from the SECOND failure: full 600s remain
  clock.value += 1;
  assert.equal(controller.nextDelayMs(), 600_000 - 1);
});

test('ladder resets after a success between failures', () => {
  const { controller, clock } = makeController();
  controller.recordFailure();
  clock.value += 1;
  controller.recordSuccess();
  clock.value += 1;
  controller.recordFailure();
  // back to tier 1 (30s), not tier 2 (60s)
  assert.equal(controller.nextDelayMs(), 30_000);
  assert.equal(controller.getState().consecutiveFailures, 1);
});
