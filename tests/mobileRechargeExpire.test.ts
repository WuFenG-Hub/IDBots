import assert from 'node:assert/strict';
import test from 'node:test';
import { isOrderExpired } from '../src/mobile/app/hooks/useRecharge.ts';

/**
 * REQ-E-15 recharge expiry unit guard (negative control for the "order expires
 * instantly" bug): contract 01 §C4 (docs/cloud-mobile/01-interface-contracts.md
 * line 497) returns `expiresAt` as Unix SECONDS (example 1760000000), while
 * Date.now() is milliseconds. The comparison must convert seconds to ms, or
 * every freshly created order is judged expired on the first poll.
 */

test('fresh order (expiresAt = now+24h in SECONDS) is NOT expired 1 second later', () => {
  const nowMs = Date.now();
  const expiresAtSeconds = Math.floor(nowMs / 1000) + 24 * 3600;
  assert.equal(
    isOrderExpired(expiresAtSeconds, nowMs + 1_000),
    false,
    'a 24h-fresh order must survive polling at least 1 second in',
  );
});

test('stale order (expiresAt = now-1s in SECONDS) IS expired', () => {
  const nowMs = Date.now();
  const expiresAtSeconds = Math.floor(nowMs / 1000) - 1;
  assert.equal(
    isOrderExpired(expiresAtSeconds, nowMs),
    true,
    'an order whose seconds deadline is in the past must be judged expired',
  );
});

test('contract example expiresAt=1760000000 is read as seconds, not ms', () => {
  // 1760000000 s = 2025-10-09 UTC; by 2026 it is long past, and reading it as
  // ms (1970-01-21) would invert the verdict on real contract payloads.
  assert.equal(isOrderExpired(1_760_000_000, Date.now()), true);
});
