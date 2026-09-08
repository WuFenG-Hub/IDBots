import test from 'node:test';
import assert from 'node:assert/strict';

const {
  isSponsorBroadcastFailureError,
  isSponsorCircuitOpen,
  recordSponsorBroadcastFailure,
  recordSponsorSuccess,
  resetSponsorCircuitBreakerForTests,
  sponsorCircuitRecentFailures,
  sponsorCircuitRetryAfterMs,
  SPONSOR_BREAKER_COOLDOWN_MS,
  SPONSOR_BREAKER_FAILURE_WINDOW_MS,
  SPONSOR_BREAKER_TRIP_THRESHOLD,
} = await import('../dist-electron/main/services/mvcSponsorCircuitBreaker.js');

const ADDRESS = '1BreakerTestAddressXXXXXXXXXXX';

test('breaker trips on the third broadcast failure inside the window and recovers after cooldown', () => {
  resetSponsorCircuitBreakerForTests();
  const t0 = 1_000_000;

  assert.equal(isSponsorCircuitOpen(ADDRESS, t0), false);
  assert.deepEqual(recordSponsorBroadcastFailure(ADDRESS, t0), { failures: 1, tripped: false });
  assert.deepEqual(recordSponsorBroadcastFailure(ADDRESS, t0 + 1_000), { failures: 2, tripped: false });
  assert.deepEqual(recordSponsorBroadcastFailure(ADDRESS, t0 + 2_000), { failures: 3, tripped: true });

  assert.equal(isSponsorCircuitOpen(ADDRESS, t0 + 3_000), true);
  assert.ok(sponsorCircuitRetryAfterMs(ADDRESS, t0 + 3_000) <= SPONSOR_BREAKER_COOLDOWN_MS);
  assert.equal(sponsorCircuitRecentFailures(ADDRESS, t0 + 3_000), 3);

  // Cooldown expiry re-closes the breaker (half-open probe allowed).
  assert.equal(isSponsorCircuitOpen(ADDRESS, t0 + 2_000 + SPONSOR_BREAKER_COOLDOWN_MS + 1), false);
  // State per address: a different address is unaffected.
  assert.equal(isSponsorCircuitOpen('1OtherAddressXXXXXXXXXXXXXXXXXX', t0 + 3_000), false);
});

test('failures older than the window do not accumulate toward the trip', () => {
  resetSponsorCircuitBreakerForTests();
  const t0 = 5_000_000;

  recordSponsorBroadcastFailure(ADDRESS, t0);
  recordSponsorBroadcastFailure(ADDRESS, t0 + SPONSOR_BREAKER_FAILURE_WINDOW_MS - 1_000);
  // First failure has aged out; only one counts now.
  const { failures, tripped } = recordSponsorBroadcastFailure(ADDRESS, t0 + SPONSOR_BREAKER_FAILURE_WINDOW_MS + 1_000);
  assert.equal(failures, 2);
  assert.equal(tripped, false);
  assert.equal(isSponsorCircuitOpen(ADDRESS, t0 + SPONSOR_BREAKER_FAILURE_WINDOW_MS + 2_000), false);
});

test('a sponsored success closes the breaker immediately', () => {
  resetSponsorCircuitBreakerForTests();
  const t0 = 9_000_000;
  for (let i = 0; i < SPONSOR_BREAKER_TRIP_THRESHOLD; i += 1) {
    recordSponsorBroadcastFailure(ADDRESS, t0 + i);
  }
  assert.equal(isSponsorCircuitOpen(ADDRESS, t0 + 10), true);

  recordSponsorSuccess(ADDRESS);
  assert.equal(isSponsorCircuitOpen(ADDRESS, t0 + 11), false);
  assert.equal(sponsorCircuitRecentFailures(ADDRESS, t0 + 11), 0);
});

test('only sponsor broadcast-failure fingerprints are counted', () => {
  resetSponsorCircuitBreakerForTests();
  assert.equal(isSponsorBroadcastFailureError(new Error('SPONSOR_BROADCAST_PENDING: broadcast reconciliation in progress')), true);
  assert.equal(isSponsorBroadcastFailureError(new Error('broadcast failed: rpc error: [-25]Missing inputs; transaction not seen')), true);
  assert.equal(isSponsorBroadcastFailureError(new Error('[-26]258: txn-mempool-conflict; transaction not seen')), true);
  assert.equal(isSponsorBroadcastFailureError(new Error('commit rejected')), false);
  assert.equal(isSponsorBroadcastFailureError(new Error('available amount not enough')), false);
  assert.equal(isSponsorBroadcastFailureError(null), false);
});
