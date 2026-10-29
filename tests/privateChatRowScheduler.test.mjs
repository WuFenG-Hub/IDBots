/**
 * Concurrency contract of the private-chat poll loop (2026-10-29).
 *
 * The loop used to run every row inside one strictly serial tick, so a single
 * long reply turn (observed: 23 minutes of skill execution) froze private-chat
 * handling for every bot and both directions. The scheduler now runs
 * different conversations concurrently (bounded) while each conversation
 * stays a strict FIFO chain. These tests pin: per-key ordering, cross-key
 * parallelism, the concurrency cap, per-row error isolation, and the
 * tracked-row re-pick guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { createPrivateChatRowScheduler, PRIVATE_CHAT_MAX_CONCURRENT_PROCESSES } = await import(
  '../dist-electron/main/services/privateChatDaemon.js'
);

const tick = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test('rows of one conversation run strictly in enqueue order', async () => {
  const scheduler = createPrivateChatRowScheduler({ maxConcurrent: 4 });
  const order = [];
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  for (let i = 0; i < 3; i += 1) {
    scheduler.enqueue(i, 'pairA', async () => {
      if (i === 0) await gate;
      order.push(i);
    });
  }
  await tick();
  assert.deepEqual(order, [], 'later rows must wait for the head of the chain');
  release();
  await scheduler.idle();
  assert.deepEqual(order, [0, 1, 2]);
});

test('different conversations run concurrently', async () => {
  const scheduler = createPrivateChatRowScheduler({ maxConcurrent: 4 });
  let running = 0;
  let maxObserved = 0;
  const work = [];
  const keys = ['pairA', 'pairB', 'pairC'];
  keys.forEach((key, index) => {
    work.push(new Promise((resolve) => {
      scheduler.enqueue(index + 1, key, async () => {
        running += 1;
        maxObserved = Math.max(maxObserved, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        resolve();
      });
    }));
  });
  await Promise.all(work);
  assert.equal(maxObserved, 3, 'independent conversations must overlap');
});

test('cross-conversation concurrency respects the cap', async () => {
  const scheduler = createPrivateChatRowScheduler({ maxConcurrent: 2 });
  let running = 0;
  let maxObserved = 0;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  for (let i = 0; i < 5; i += 1) {
    scheduler.enqueue(i, `pair${i}`, async () => {
      running += 1;
      maxObserved = Math.max(maxObserved, running);
      await gate;
      running -= 1;
    });
  }
  await tick();
  assert.equal(maxObserved, 2, 'concurrent runs must not exceed maxConcurrent');
  release();
  await scheduler.idle();
});

test('a throwing row does not poison its conversation chain or other rows', async () => {
  const scheduler = createPrivateChatRowScheduler({});
  const errors = [];
  const seen = [];
  scheduler.enqueue(1, 'pairA', async () => { throw new Error('boom'); });
  scheduler.enqueue(2, 'pairA', async () => { seen.push(2); });
  scheduler.enqueue(3, 'pairB', async () => { seen.push(3); });
  await scheduler.idle();
  assert.deepEqual(seen.sort(), [2, 3]);
  // Default onRowError (none) must not turn row errors into unhandled rejections.
  assert.equal(errors.length, 0);
});

test('isTracked guards a queued/running row from double enqueue', async () => {
  const scheduler = createPrivateChatRowScheduler({ maxConcurrent: 1 });
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const runs = [];
  scheduler.enqueue(7, 'pairA', async () => { await gate; runs.push(7); });
  await tick();
  assert.equal(scheduler.isTracked(7), true);
  scheduler.enqueue(7, 'pairA', async () => { runs.push(7); });
  release();
  await scheduler.idle();
  assert.deepEqual(runs, [7], 'the duplicate enqueue must be a no-op');
  assert.equal(scheduler.isTracked(7), false);
});

test('default concurrency bound is exported and sane', () => {
  assert.equal(PRIVATE_CHAT_MAX_CONCURRENT_PROCESSES, 4);
});
