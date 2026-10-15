import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  B1,
  B2,
  B3,
  CANDIDATES,
  COMMIT_CLOSE,
  H1,
  H2,
  ballot,
  chain,
  pair,
  pid,
} from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { PreferenceStore } = require('../dist-electron/main/services/preference/store.js');
const { PreferenceService } = require('../dist-electron/main/services/preference/service.js');
const { createPreferenceIpcHandlers } = require('../dist-electron/main/services/preference/ipc.js');

/** The user identity is H1 unless `user` overrides it; MetaBot 7 is H2. */
async function ipcHarness({ nowSec = COMMIT_CLOSE - 7_200, events = [], user = H1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-preference-ipc-'));
  const sqlite = await SqliteStore.create(dir);
  const store = new PreferenceStore(sqlite.getDatabase(), sqlite.getSaveFunction());
  const state = { nowSec, chainEvents: [...events], writes: [], user };
  let serial = 8000;
  const writerFor = (globalMetaId) => ({
    globalMetaId,
    write: async (segment, payload) => {
      serial += 1;
      const pinId = pid(serial);
      state.writes.push({ segment, payload: JSON.parse(JSON.stringify(payload)), author: globalMetaId, pinId });
      return { pinId, txids: [pinId.slice(0, 64)] };
    },
  });
  const service = new PreferenceService({
    store,
    collect: async () => ({ events: state.chainEvents.map((event) => ({ ...event })), perPath: [] }),
    resolveWriter: (signer) => {
      if (signer.type === 'user') return writerFor(H1);
      return signer.metabotId === 7 ? writerFor(H2) : { error: 'METABOT_IDENTITY_MISSING' };
    },
    nowMs: () => state.nowSec * 1000,
  });
  const ipc = createPreferenceIpcHandlers({ service: () => service, userGlobalMetaId: () => state.user });
  return { ipc, service, store, state };
}

/** c1 is the user's own build; H1 decides as a human, H2 is a shadow AI judge. */
const mixedRound = (over = {}) => {
  const c = chain();
  const round = c.openRound({
    candidates: [{ ...CANDIDATES[0], author: H1 }, CANDIDATES[1], CANDIDATES[2]],
    judges: [
      { id: H1, kind: 'human' },
      { id: H2, kind: 'ai' },
    ],
    decision: { kinds: ['human'], minBallots: 1 },
    ...over,
  });
  return { c, round };
};

test('roundStatus hides authors and bot ballots, and keeps the user ballot without salt', async () => {
  const { c, round } = mixedRound();
  const h = await ipcHarness({ events: c.events });
  await h.service.refresh('test');
  const bot = await h.service.commitBallot(
    { type: 'metabot', metabotId: 7 },
    round,
    ballot(pair('c1', 'c3', 'a', { reason: 'BOT-SECRET-REASON' })),
  );
  assert.equal(typeof bot.pinId, 'string');
  const mine = await h.ipc.commit({ roundPinId: round, ballot: ballot(pair('c2', 'c3', 'b', { reason: 'c3 is denser' })) });
  assert.equal(mine.success, true, mine.error);

  const result = await h.ipc.roundStatus({ roundPinId: round });
  assert.equal(result.success, true, result.error);
  const { view } = result;
  assert.deepEqual(
    view.candidates.map((candidate) => [candidate.id, candidate.own, Object.keys(candidate).sort().join(',')]),
    [
      ['c1', true, 'artifact,id,own'],
      ['c2', false, 'artifact,id,own'],
      ['c3', false, 'artifact,id,own'],
    ],
  );
  assert.deepEqual(view.me, { globalMetaId: H1, listed: true, kind: 'human', class: 'deciding' });
  assert.equal(view.myBallots.length, 1);
  assert.equal(view.myBallots[0].ballot.pairs[0].reason, 'c3 is denser');
  assert.equal(view.commitCutoffAt, COMMIT_CLOSE - 1800);
  assert.equal(view.revealsFrom, COMMIT_CLOSE + 1800);
  const text = JSON.stringify(result);
  assert.equal(text.includes('BOT-SECRET-REASON'), false);
  assert.equal(text.includes('"salt"'), false);
  for (const builder of [B1, B2, B3]) assert.equal(text.includes(builder), false);
});

test('listRounds filters by the user identity and by task', async () => {
  const { c, round } = mixedRound({ subject: { taskid: pid(500), node: 'UI' } });
  const h = await ipcHarness({ events: c.events });
  await h.service.refresh('test');
  await h.ipc.commit({ roundPinId: round, ballot: ballot(pair('c2', 'c3', 'b')) });

  const mine = await h.ipc.listRounds({ mine: true });
  assert.equal(mine.success, true);
  assert.equal(mine.userGlobalMetaId, H1);
  assert.deepEqual(
    mine.rounds.map((entry) => [entry.pinId, entry.status, entry.myKind, entry.myBallotStatus]),
    [[round, 'collecting', 'human', 'committed']],
  );
  assert.equal(mine.rounds[0].commitCutoffAt, COMMIT_CLOSE - 1800);
  assert.equal((await h.ipc.listRounds({ taskid: pid(500) })).rounds.length, 1);
  assert.equal((await h.ipc.listRounds({ taskid: pid(501) })).rounds.length, 0);
  h.state.user = null;
  assert.deepEqual(await h.ipc.listRounds({ mine: true }), { success: true, rounds: [], userGlobalMetaId: null });
});

test('commit validates input, identity, and judge listing before any write', async () => {
  const { c, round } = mixedRound();
  const unlisted = c.openRound({ judges: [{ id: H2, kind: 'human' }], decision: { kinds: ['human'], minBallots: 1 } });
  const h = await ipcHarness({ events: c.events });
  const good = ballot(pair('c2', 'c3', 'b'));
  assert.deepEqual(await h.ipc.commit({ roundPinId: 'nope', ballot: good }), { success: false, error: 'preference:invalid-round' });
  assert.deepEqual(await h.ipc.commit({ roundPinId: unlisted, ballot: good }), {
    success: false,
    error: 'preference:not-a-listed-judge',
  });
  const own = await h.ipc.commit({ roundPinId: round, ballot: ballot(pair('c1', 'c2', 'a')) });
  assert.deepEqual(own, { success: false, error: 'preference:own-candidate-in-ballot' });
  h.state.user = null;
  assert.deepEqual(await h.ipc.commit({ roundPinId: round, ballot: good }), { success: false, error: 'USER_IDENTITY_MISSING' });
  assert.equal(h.state.writes.length, 0);

  h.state.user = H1;
  const ok = await h.ipc.commit({ roundPinId: round, ballot: good });
  assert.equal(ok.success, true);
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.state.writes[0].author, H1);
  assert.equal(h.state.writes[0].segment, 'commit');
});

test('telemetry accepts valid pair keys and bounded integer seconds only', async () => {
  const { c, round } = mixedRound();
  const h = await ipcHarness({ events: c.events });
  assert.deepEqual(h.ipc.telemetry({ roundPinId: round, pairKey: 'c2|c3', seconds: 42 }), { success: true });
  assert.deepEqual(h.ipc.telemetry({ roundPinId: round, pairKey: 'c2|c3', seconds: 4000 }), { success: true });
  assert.deepEqual(h.ipc.telemetry({ roundPinId: round, pairKey: 'DROP TABLE', seconds: 5 }), {
    success: false,
    error: 'preference:invalid-telemetry',
  });
  assert.deepEqual(h.store.telemetryForRound(round), [{ pairKey: 'c2|c3', seconds: 42 }]);
});

test('roundStatus refreshes once for an unknown round and reports invalid ids', async () => {
  const { c, round } = mixedRound();
  const h = await ipcHarness({ events: c.events });
  const found = await h.ipc.roundStatus({ roundPinId: round });
  assert.equal(found.success, true);
  assert.deepEqual(await h.ipc.roundStatus({ roundPinId: 42 }), { success: false, error: 'preference:invalid-round' });
  assert.deepEqual(await h.ipc.roundStatus({ roundPinId: pid(9999) }), { success: false, error: 'round:not-found' });
});

test('refresh reports the collected event count', async () => {
  const { c, round } = mixedRound();
  const h = await ipcHarness({ events: c.events });
  assert.deepEqual(await h.ipc.refresh(), { success: true, eventCount: c.events.length });
  h.state.chainEvents.push({
    pinId: pid(9500),
    path: 'commit',
    author: H2,
    height: 200_000,
    txIndex: 0,
    timestampMs: (COMMIT_CLOSE - 7_000) * 1000,
    body: { round },
  });
  assert.deepEqual(await h.ipc.refresh(), { success: true, eventCount: c.events.length + 1 });
});
