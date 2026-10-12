// Fresh-install deferral for background LLM automation (2026-10-12): tests for
// libs/installAgeGate.ts.
//
// Contract under test:
//   a. a fresh install (anchor seconds/minutes old) defers background work;
//   b. an install older than the window is not deferred, and exactly 24h
//      counts as elapsed;
//   c. a legacy/upgraded install whose anchor cannot be read but which already
//      holds bots is NOT deferred (fail-open — an upgrade must never lose its
//      nightly work);
//   d. an anchor-less machine with no bots is deferred (nothing to act on);
//   e. the anchor itself prefers the user identity's createdAt and falls back
//      to the oldest bot row.
//
// Imports target the dist-electron build (compiled by the pnpm test step),
// matching tests/dreamRetryPolicy.test.mjs convention.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BACKGROUND_AUTOMATION_DEFERRAL_MS,
  evaluateInstallAgeGate,
  pickInstallAnchorMs,
} = require('../dist-electron/main/libs/installAgeGate.js');

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

test('fresh install (anchor a few minutes old) defers background automation', () => {
  const state = evaluateInstallAgeGate({
    anchorMs: NOW - 5 * 60 * 1000,
    hasExistingBots: true,
    nowMs: NOW,
  });
  assert.equal(state.deferred, true);
  assert.match(state.reason, /fresh-install window|24h/);
  assert.ok(state.remainingMs > 23 * HOUR_MS, 'nearly the whole window is left');
});

test('an install 25 hours old is allowed', () => {
  const state = evaluateInstallAgeGate({
    anchorMs: NOW - 25 * HOUR_MS,
    hasExistingBots: true,
    nowMs: NOW,
  });
  assert.equal(state.deferred, false);
  assert.equal(state.reason, '');
  assert.equal(state.remainingMs, 0);
});

test('the boundary at exactly 24 hours counts as elapsed', () => {
  const atBoundary = evaluateInstallAgeGate({
    anchorMs: NOW - BACKGROUND_AUTOMATION_DEFERRAL_MS,
    hasExistingBots: true,
    nowMs: NOW,
  });
  assert.equal(atBoundary.deferred, false, 'exactly 24h is not deferred');

  const oneMsInside = evaluateInstallAgeGate({
    anchorMs: NOW - BACKGROUND_AUTOMATION_DEFERRAL_MS + 1,
    hasExistingBots: true,
    nowMs: NOW,
  });
  assert.equal(oneMsInside.deferred, true, 'one millisecond short is still deferred');
});

test('legacy install without a readable anchor but with bots stays allowed (fail-open)', () => {
  const state = evaluateInstallAgeGate({
    anchorMs: null,
    hasExistingBots: true,
    nowMs: NOW,
  });
  assert.equal(state.deferred, false, 'an upgrade must never be deferred');
  assert.equal(state.reason, '');
});

test('no anchor and no bots: deferred (no daemon has anything to act on)', () => {
  const state = evaluateInstallAgeGate({ anchorMs: null, hasExistingBots: false, nowMs: NOW });
  assert.equal(state.deferred, true);
});

test('degenerate inputs never throw and default the window to 24h', () => {
  // Invalid anchor values are treated as "no anchor" (fail-open with bots).
  for (const bad of [Number.NaN, 0, -1, undefined, null]) {
    const state = evaluateInstallAgeGate({ anchorMs: bad, hasExistingBots: true, nowMs: NOW });
    assert.equal(state.deferred, false, `anchor ${String(bad)} must fail open with bots present`);
  }
  // An unknown nowMs falls back to the wall clock, keeping the module testable
  // without freezing time.
  const state = evaluateInstallAgeGate({ anchorMs: Date.now() - 60_000, hasExistingBots: true });
  assert.equal(state.deferred, true);
  assert.equal(BACKGROUND_AUTOMATION_DEFERRAL_MS, 24 * HOUR_MS);
});

test('anchor resolution prefers the identity and falls back to the oldest bot', () => {
  const identityMs = NOW - 100 * HOUR_MS;
  assert.equal(
    pickInstallAnchorMs({ identityCreatedAtMs: identityMs, metabotCreatedAtMs: [NOW - 2 * HOUR_MS] }),
    identityMs,
    'the identity createdAt wins when present',
  );
  assert.equal(
    pickInstallAnchorMs({
      identityCreatedAtMs: null,
      metabotCreatedAtMs: [NOW - 2 * HOUR_MS, NOW - 30 * HOUR_MS, Number.NaN, null],
    }),
    NOW - 30 * HOUR_MS,
    'without an identity the OLDEST bot row is the install signal',
  );
  assert.equal(pickInstallAnchorMs({ identityCreatedAtMs: null, metabotCreatedAtMs: [] }), null);
  assert.equal(pickInstallAnchorMs({}), null);
});

test('an upgraded install (old identity, old bots) is never deferred', () => {
  const anchorMs = pickInstallAnchorMs({
    identityCreatedAtMs: NOW - 60 * 24 * HOUR_MS,
    metabotCreatedAtMs: [NOW - 59 * 24 * HOUR_MS],
  });
  const state = evaluateInstallAgeGate({ anchorMs, hasExistingBots: true, nowMs: NOW });
  assert.equal(state.deferred, false);
});

test('the reason line names the age and the remaining window', () => {
  const state = evaluateInstallAgeGate({
    anchorMs: NOW - 2 * HOUR_MS,
    hasExistingBots: true,
    nowMs: NOW,
  });
  assert.equal(state.deferred, true);
  assert.match(state.reason, /2h old/);
  assert.match(state.reason, /22h0m left/);
});
