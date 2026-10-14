import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { C3_BEST, H1, pid } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { PreferenceStore, toBallotView } = require('../dist-electron/main/services/preference/store.js');

const open = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-preference-store-'));
  const sqlite = await SqliteStore.create(dir);
  return { sqlite, store: new PreferenceStore(sqlite.getDatabase(), sqlite.getSaveFunction()) };
};

const event = (n, over = {}) => ({
  pinId: pid(n),
  path: 'commit',
  author: H1,
  height: 200_000 + n,
  txIndex: 0,
  timestampMs: 1_792_000_000_000,
  body: { round: pid(1), hash: 'a'.repeat(64) },
  ...over,
});

const newBallot = (over = {}) => ({
  roundPinId: pid(1),
  signerType: 'user',
  metabotId: null,
  judgeGlobalMetaId: H1,
  ballot: C3_BEST,
  salt: 'd'.repeat(64),
  commitHash: 'e'.repeat(64),
  commitCloseAt: 1_792_086_400,
  revealCloseAt: 1_792_172_800,
  nowMs: 1_792_000_000_000,
  ...over,
});

test('tables are created idempotently and survive a new store instance', async () => {
  const { sqlite, store } = await open();
  store.upsertEvents([event(5)], 1);
  const again = new PreferenceStore(sqlite.getDatabase(), sqlite.getSaveFunction());
  assert.equal(again.loadEvents().length, 1);
  const tables = sqlite.getDatabase().exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'preference_%' ORDER BY name;");
  assert.deepEqual(tables[0].values.map((value) => value[0]), ['preference_ballots', 'preference_compare_telemetry', 'preference_events']);
});

test('event upsert updates confirmation but never clobbers a body with an empty one', async () => {
  const { store } = await open();
  store.upsertEvents([event(5, { height: -1 })], 1);
  store.upsertEvents([event(5, { height: 200_777, body: {} })], 2);
  const [stored] = store.loadEvents();
  assert.equal(stored.height, 200_777);
  assert.deepEqual(stored.body, { round: pid(1), hash: 'a'.repeat(64) });
});

test('ballot lifecycle', async () => {
  const { store } = await open();
  const first = store.insertBallot(newBallot());
  assert.equal(first.status, 'committing');
  store.markCommitted(first.id, pid(20), 2);
  const second = store.insertBallot(newBallot({ salt: 'f'.repeat(64) }));
  store.markCommitted(second.id, pid(21), 3);
  assert.equal(store.getBallot(first.id).status, 'superseded');
  assert.equal(store.getBallot(second.id).commitPinId, pid(21));
  assert.deepEqual(store.getBallot(second.id).ballot, C3_BEST);

  for (let attempt = 1; attempt < 5; attempt += 1) assert.equal(store.markRevealFailed(second.id, 'x', 4), 'committed');
  assert.equal(store.markRevealFailed(second.id, 'x', 5), 'reveal_failed');
  assert.equal(store.getBallot(second.id).revealAttempts, 5);

  const third = store.insertBallot(newBallot({ roundPinId: pid(2) }));
  store.markCommitted(third.id, pid(22), 6);
  store.markRevealed(third.id, pid(23), 7);
  assert.equal(store.getBallot(third.id).status, 'revealed');
  store.markRevealRetry(third.id, 8);
  assert.equal(store.getBallot(third.id).status, 'committed');
  assert.equal(store.getBallot(third.id).revealPinId, null);
});

test('expiry and active counts', async () => {
  const { store } = await open();
  const row = store.insertBallot(newBallot());
  store.markCommitted(row.id, pid(20), 2);
  assert.equal(store.countActive(1_792_100_000), 1);
  assert.equal(store.expireStale(1_792_172_801, 3), 1);
  assert.equal(store.getBallot(row.id).status, 'expired');
  assert.equal(store.countActive(1_792_172_801), 0);
});

test('views never carry the salt', async () => {
  const { store } = await open();
  const row = store.insertBallot(newBallot());
  const view = toBallotView(row);
  assert.equal('salt' in view, false);
  assert.equal(view.commitHash, 'e'.repeat(64));
});

test('telemetry accumulates per pair', async () => {
  const { store } = await open();
  store.recordTelemetry(pid(1), 'c1|c2', 40, 1);
  store.recordTelemetry(pid(1), 'c1|c2', 25, 2);
  store.recordTelemetry(pid(1), 'c1|c3', 10, 3);
  assert.deepEqual(store.telemetryForRound(pid(1)), [
    { pairKey: 'c1|c2', seconds: 65 },
    { pairKey: 'c1|c3', seconds: 10 },
  ]);
});
