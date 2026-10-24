import assert from 'node:assert/strict';
import test from 'node:test';

import { createBoundedPinPathResolver } from '../src/main/services/pinPathResolver.ts';

const FEEDBACK_PIN = 'f'.repeat(64) + 'i0';
const BUZZ_PIN = 'b'.repeat(64) + 'i0';
const FEEDBACK_PATH = '/protocols/preference/feedback';

function manualClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; return now; } };
}

test('resolved paths are cached and pins are immutable-once-confirmed', async () => {
  let lookups = 0;
  const clock = manualClock();
  const resolve = createBoundedPinPathResolver(async (pinId) => {
    lookups += 1;
    return { found: true, path: pinId === FEEDBACK_PIN ? FEEDBACK_PATH : '/protocols/simplebuzz' };
  }, { now: clock.now });

  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'resolved', path: FEEDBACK_PATH });
  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'resolved', path: FEEDBACK_PATH });
  assert.equal(lookups, 1);
  // Resolved entries persist past any TTL (pin paths never change).
  clock.advance(60 * 60_000);
  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'resolved', path: FEEDBACK_PATH });
  assert.equal(lookups, 1);
});

test('not-found entries expire after the negative TTL so indexer lag heals', async () => {
  let indexed = false;
  let lookups = 0;
  const clock = manualClock();
  const resolve = createBoundedPinPathResolver(async () => {
    lookups += 1;
    if (!indexed) return { found: false };
    return { found: true, path: FEEDBACK_PATH };
  }, { negativeTtlMs: 5 * 60_000, now: clock.now });

  // Indexer has not synced the pin yet → not-found, cached briefly.
  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'not-found' });
  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'not-found' });
  assert.equal(lookups, 1);

  // After the TTL the entry is gone and the (now indexed) pin resolves.
  indexed = true;
  clock.advance(5 * 60_000 + 1);
  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'resolved', path: FEEDBACK_PATH });
  assert.equal(lookups, 2);
});

test('transport failures resolve unknown and are never cached', async () => {
  let fail = true;
  let lookups = 0;
  const resolve = createBoundedPinPathResolver(async () => {
    lookups += 1;
    if (fail) throw new Error('indexer unreachable');
    return { found: true, path: '' };
  });

  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'unknown' });
  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'unknown' });
  assert.equal(lookups, 2);
  fail = false;
  assert.deepEqual(await resolve(FEEDBACK_PIN), { status: 'resolved', path: '' });
});

test('the cache is bounded with FIFO eviction', async () => {
  let lookups = 0;
  const resolve = createBoundedPinPathResolver(async (pinId) => {
    lookups += 1;
    return { found: true, path: `/p/${pinId}` };
  }, { maxCacheEntries: 2 });

  await resolve('1'.repeat(64) + 'i0');
  await resolve('2'.repeat(64) + 'i0');
  await resolve('3'.repeat(64) + 'i0'); // evicts pin 1
  await resolve('1'.repeat(64) + 'i0'); // re-queried after eviction
  assert.equal(lookups, 4);
});

test('per-key rate limiting caps lookups and answers unknown over the limit', async () => {
  let lookups = 0;
  const clock = manualClock();
  const resolve = createBoundedPinPathResolver(async (pinId) => {
    lookups += 1;
    return { found: true, path: `/p/${pinId}` };
  }, { maxLookupsPerMinute: 3, now: clock.now });

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await resolve(`${String(i).repeat(64)}i0`, 'resource-a')).status, 'resolved');
  }
  assert.deepEqual(await resolve('9'.repeat(64) + 'i0', 'resource-a'), { status: 'unknown' });
  assert.equal(lookups, 3);
  // Another key is unaffected; the window slides after a minute.
  assert.equal((await resolve('9'.repeat(64) + 'i0', 'resource-b')).status, 'resolved');
  clock.advance(60_001);
  assert.equal((await resolve('8'.repeat(64) + 'i0', 'resource-a')).status, 'resolved');
  assert.equal(lookups, 5);
});

test('a pin found with an empty path is resolved-with-empty, not unknown', async () => {
  const resolve = createBoundedPinPathResolver(async () => ({ found: true, path: '   ' }));
  assert.deepEqual(await resolve(BUZZ_PIN), { status: 'resolved', path: '' });
  // Empty-string blank input never reaches the network.
  assert.deepEqual(await resolve('  '), { status: 'unknown' });
});
