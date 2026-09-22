import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HeartbeatService } = require('../dist-electron/main/services/heartbeatService.js');

/**
 * HeartbeatService (P1): the first-class periodic dispatcher. Tests use the
 * synchronous runDueHandlers seam plus fake clocks — no real timers.
 */

test('due gating: a handler runs on registration, then only when its interval elapsed', async () => {
  const calls = [];
  const hb = new HeartbeatService({ emitLog: () => {} });
  hb.registerHandler({ name: 'a', intervalMs: 1000, run: (nowMs) => { calls.push(nowMs); } });
  assert.deepEqual(hb.runDueHandlers(0), ['a'], 'first run is always due');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hb.runDueHandlers(500), [], 'inside the interval — skipped');
  assert.deepEqual(hb.runDueHandlers(1000), ['a'], 'interval elapsed — due again');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [0, 1000], `calls: ${JSON.stringify(calls)}`);
});

test('no overlap: a handler still in flight is skipped, never double-run', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const hb = new HeartbeatService({ emitLog: () => {} });
  hb.registerHandler({ name: 'slow', intervalMs: 0, run: () => { calls.push(1); return gate; } });
  assert.deepEqual(hb.runDueHandlers(0), ['slow']);
  assert.deepEqual(hb.runDueHandlers(5000), [], 'still running — skipped');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hb.runDueHandlers(6000), ['slow'], 'finished — due again');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
});

test('a throwing handler is logged and isolated; peers and later runs unaffected', async () => {
  const logs = [];
  const calls = [];
  const hb = new HeartbeatService({ emitLog: (line) => logs.push(line) });
  hb.registerHandler({ name: 'bad', intervalMs: 0, run: () => { throw new Error('boom'); } });
  hb.registerHandler({ name: 'good', intervalMs: 0, run: () => { calls.push(1); } });
  assert.deepEqual(hb.runDueHandlers(0).sort(), ['bad', 'good']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((line) => line.includes('"bad"') && line.includes('boom')), 'failure logged');
  assert.deepEqual(hb.runDueHandlers(10), ['bad', 'good'].filter((n) => n === 'bad' || n === 'good').sort(), 'both due again');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
});

test('registerHandler replaces by name (daemon-restart idempotency)', async () => {
  const calls = [];
  const hb = new HeartbeatService({ emitLog: () => {} });
  hb.registerHandler({ name: 'x', intervalMs: 0, run: () => calls.push('old') });
  hb.registerHandler({ name: 'x', intervalMs: 0, run: () => calls.push('new') });
  hb.runDueHandlers(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['new']);
  assert.deepEqual(hb.handlerNames(), ['x']);
});

test('start/stop are idempotent', () => {
  const hb = new HeartbeatService({ emitLog: () => {} });
  assert.equal(hb.isRunning(), false);
  hb.start();
  assert.equal(hb.isRunning(), true);
  hb.start(); // second start must not throw or double-schedule
  assert.equal(hb.isRunning(), true);
  hb.stop();
  assert.equal(hb.isRunning(), false);
  hb.stop();
  assert.equal(hb.isRunning(), false);
});
