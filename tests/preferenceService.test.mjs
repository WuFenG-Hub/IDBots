import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  C3_BEST,
  CANDIDATES,
  COMMIT_CLOSE,
  FINAL_NOW,
  H1,
  H2,
  REVEAL_CLOSE,
  ROUND_AT,
  TWIN,
  chain,
  pair,
  ballot,
  pid,
  roundBody,
} from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { PreferenceStore } = require('../dist-electron/main/services/preference/store.js');
const { PreferenceService } = require('../dist-electron/main/services/preference/service.js');
const { ballotCommitHash } = require('../dist-electron/main/services/preference/sealing.js');

/** The user signer is H1; MetaBot 7 is H2; any other MetaBot id has no identity. */
async function harness({ nowSec = ROUND_AT + 1000, events = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-preference-service-'));
  const sqlite = await SqliteStore.create(dir);
  const store = new PreferenceStore(sqlite.getDatabase(), sqlite.getSaveFunction());
  const state = { nowSec, chainEvents: [...events], writes: [], failNext: 0, updates: [], collectThrows: false };
  let serial = 9000;
  const writerFor = (globalMetaId) => ({
    globalMetaId,
    write: async (segment, payload) => {
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new Error('broadcast failed');
      }
      serial += 1;
      const pinId = pid(serial);
      state.writes.push({ segment, payload: JSON.parse(JSON.stringify(payload)), author: globalMetaId, pinId });
      return { pinId, txids: [pinId.slice(0, 64)] };
    },
  });
  const service = new PreferenceService({
    store,
    collect: async () => {
      if (state.collectThrows) throw new Error('indexer down');
      return { events: state.chainEvents.map((event) => ({ ...event })), perPath: [] };
    },
    resolveWriter: (signer) => {
      if (signer.type === 'user') return writerFor(H1);
      return signer.metabotId === 7 ? writerFor(H2) : { error: 'METABOT_IDENTITY_MISSING' };
    },
    nowMs: () => state.nowSec * 1000,
    onUpdate: (reason) => state.updates.push(reason),
  });
  return { sqlite, store, service, state };
}

let confirmHeight = 300_000;
/** Simulates a write getting mined at block time `atSec`. */
const confirm = (state, write, atSec) => {
  confirmHeight += 1;
  state.chainEvents.push({
    pinId: write.pinId,
    path: write.segment,
    author: write.author,
    height: confirmHeight,
    txIndex: 0,
    timestampMs: atSec * 1000,
    body: write.payload,
  });
};

const SUBJECT = { taskid: pid(500), node: 'UI' };

const decidedChain = () => {
  const c = chain();
  const round = c.openRound({ subject: SUBJECT });
  const h1 = c.vote(round, H1, C3_BEST);
  c.vote(round, H2, C3_BEST);
  return { c, round, h1 };
};

const lessonFor = (round, tallyHash, evidence) => ({
  round,
  category: ['ui:qa-community'],
  summary: 'Judges preferred the denser feed.',
  principles: [{ text: 'Show five or more questions per screen.', conditions: 'Desktop readers.', uncertainty: '', evidence }],
  exemplars: { preferred: 'c3', rejected: ['c1'] },
  tallyHash,
});

test('refresh caches events; listRounds filters by judge and task', async () => {
  const { c, round } = decidedChain();
  const { service, state } = await harness({ nowSec: FINAL_NOW, events: c.events });
  const refreshed = await service.refresh('test');
  assert.deepEqual(refreshed, { ok: true, eventCount: c.events.length, error: null });
  assert.deepEqual(state.updates, ['test']);
  const mine = service.listRounds({ judge: H1 });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].pinId, round);
  assert.equal(mine[0].status, 'decided');
  assert.equal(mine[0].winner, 'c3');
  assert.equal(service.listRounds({ judge: TWIN }).length, 0);
  assert.equal(service.listRounds({ taskid: SUBJECT.taskid }).length, 1);
  assert.equal(service.listRounds({ taskid: pid(501) }).length, 0);
});

test('refresh failure keeps the cache and reports the error', async () => {
  const { c } = decidedChain();
  const { service, state } = await harness({ nowSec: FINAL_NOW, events: c.events });
  await service.refresh('first');
  state.collectThrows = true;
  const failed = await service.refresh('second');
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'indexer down');
  assert.equal(service.events().length, c.events.length);
});

test('roundStatus returns the tally and a lesson verdict', async () => {
  const { c, round, h1 } = decidedChain();
  const { service } = await harness({ nowSec: FINAL_NOW, events: c.events });
  await service.refresh('seed');
  const first = service.roundStatus(round);
  const lesson = c.add('lesson', lessonFor(round, first.tally.tallyHash, [h1.reveal.pinId]), H1, REVEAL_CLOSE + 9_000);
  const { service: fresh } = await harness({ nowSec: FINAL_NOW, events: c.events });
  await fresh.refresh('seed');
  const view = fresh.roundStatus(round, { lessonPinId: lesson.pinId });
  assert.equal(view.tally.output.winner, 'c3');
  assert.deepEqual(view.lesson, { pinId: lesson.pinId, valid: true, reason: null });
  assert.deepEqual(view.localBallots, []);
  assert.deepEqual(fresh.roundStatus(pid(777)), { error: 'round:not-found' });
});

test('canonicalRound and searchLessons', async () => {
  const { c, round, h1 } = decidedChain();
  const seed = await harness({ nowSec: FINAL_NOW, events: c.events });
  await seed.service.refresh('seed');
  const tallyHash = seed.service.roundStatus(round).tally.tallyHash;
  c.add('lesson', lessonFor(round, tallyHash, [h1.reveal.pinId]), H1, REVEAL_CLOSE + 9_000);
  c.add('lesson', { ...lessonFor(round, tallyHash, [h1.reveal.pinId]), exemplars: { preferred: 'c1', rejected: [] } }, H1, REVEAL_CLOSE + 9_100);
  const { service } = await harness({ nowSec: FINAL_NOW, events: c.events });
  await service.refresh('seed');
  const canonical = service.canonicalRound({ ...SUBJECT, rootAuthor: TWIN });
  assert.equal(canonical.state, 'decided');
  assert.equal(canonical.roundPinId, round);
  const found = service.searchLessons({ category: ['ui'] });
  assert.equal(found.length, 1);
  assert.equal(found[0].preferred.artifact, CANDIDATES[2].artifact);
  assert.deepEqual(found[0].rejected.map((candidate) => candidate.id), ['c1']);
  assert.equal(found[0].decidingBallots, 2);
  assert.equal(service.searchLessons({ category: ['wiki'] }).length, 0);
});

const openChain = (over = {}) => {
  const c = chain();
  const round = c.openRound(over);
  return { c, round };
};

test('commitBallot seals the ballot, stores the salt, and publishes only the hash', async () => {
  const { c, round } = openChain();
  const { service, state, store } = await harness({ nowSec: COMMIT_CLOSE - 7_200, events: c.events });
  await service.refresh('seed');
  const result = await service.commitBallot({ type: 'user' }, round, C3_BEST);
  assert.equal(typeof result.pinId, 'string');
  const [row] = store.listBallots({ roundPinId: round });
  assert.equal(row.status, 'committed');
  assert.equal(row.commitPinId, result.pinId);
  assert.deepEqual(state.writes.map((write) => write.segment), ['commit']);
  assert.deepEqual(state.writes[0].payload, {
    round,
    hash: ballotCommitHash({ round, judge: H1, salt: row.salt, ballot: C3_BEST }),
  });
  assert.equal(JSON.stringify(state.writes[0].payload).includes(row.salt), false);
  assert.equal('salt' in service.roundStatus(round).localBallots[0], false);
});

test('commitBallot refusals happen before any write', async () => {
  const own = openChain({ candidates: [{ ...CANDIDATES[0], author: H1 }, CANDIDATES[1], CANDIDATES[2]] });
  const ownHarness = await harness({ nowSec: COMMIT_CLOSE - 7_200, events: own.c.events });
  await ownHarness.service.refresh('seed');
  assert.deepEqual(await ownHarness.service.commitBallot({ type: 'user' }, own.round, C3_BEST), {
    error: 'preference:own-candidate-in-ballot',
  });
  assert.deepEqual(await ownHarness.service.commitBallot({ type: 'user' }, own.round, ballot(pair('c1', 'c9', 'a'))), {
    error: 'ballot:pair-candidates',
  });
  assert.deepEqual(await ownHarness.service.commitBallot({ type: 'metabot', metabotId: 9 }, own.round, ballot(pair('c2', 'c3', 'a'))), {
    error: 'METABOT_IDENTITY_MISSING',
  });
  assert.equal(ownHarness.state.writes.length, 0);

  const late = openChain();
  const lateHarness = await harness({ nowSec: COMMIT_CLOSE - 1_000, events: late.c.events });
  await lateHarness.service.refresh('seed');
  assert.deepEqual(await lateHarness.service.commitBallot({ type: 'user' }, late.round, C3_BEST), {
    error: 'preference:commit-window-closing',
  });
  assert.equal(lateHarness.store.listBallots().length, 0);
});

test('a failed broadcast leaves a commit_failed record; a re-commit supersedes the earlier one', async () => {
  const { c, round } = openChain();
  const { service, state, store } = await harness({ nowSec: COMMIT_CLOSE - 7_200, events: c.events });
  await service.refresh('seed');
  state.failNext = 1;
  assert.deepEqual(await service.commitBallot({ type: 'user' }, round, C3_BEST), { error: 'broadcast failed' });
  assert.equal(store.listBallots()[0].status, 'commit_failed');
  await service.commitBallot({ type: 'user' }, round, C3_BEST);
  await service.commitBallot({ type: 'user' }, round, ballot(pair('c1', 'c2', 'a')));
  assert.deepEqual(store.listBallots().map((row) => row.status), ['commit_failed', 'superseded', 'committed']);
});

test('openRound validates with a confirmation margin and shows the round as pending', async () => {
  const nowSec = ROUND_AT + 1000;
  const { service, state } = await harness({ nowSec });
  assert.deepEqual(
    await service.openRound({ type: 'metabot', metabotId: 7 }, roundBody({ commitCloseAt: nowSec + 3_600, revealCloseAt: nowSec + 7_200 })),
    { error: 'round:windows' },
  );
  const opened = await service.openRound({ type: 'metabot', metabotId: 7 }, roundBody());
  assert.equal(state.writes[0].segment, 'round');
  const [summary] = service.listRounds();
  assert.equal(summary.pinId, opened.pinId);
  assert.equal(summary.confirmed, false);
  assert.equal(summary.status, 'pending');
});

test('publishLesson checks the final tally before writing', async () => {
  const { c, round, h1 } = decidedChain();
  const { service, state } = await harness({ nowSec: FINAL_NOW, events: c.events });
  await service.refresh('seed');
  const tallyHash = service.roundStatus(round).tally.tallyHash;
  const wrong = { ...lessonFor(round, tallyHash, [h1.reveal.pinId]), exemplars: { preferred: 'c2', rejected: [] } };
  assert.deepEqual(await service.publishLesson({ type: 'user' }, wrong), { error: 'lesson:preferred-not-winner' });
  assert.equal(state.writes.length, 0);
  const ok = await service.publishLesson({ type: 'user' }, lessonFor(round, tallyHash, [h1.reveal.pinId]));
  assert.equal(typeof ok.pinId, 'string');
  assert.equal(state.writes[0].segment, 'lesson');
});

test('telemetry ignores out-of-range values', async () => {
  const { service, store } = await harness();
  service.recordTelemetry(pid(1), 'c1|c2', 30);
  service.recordTelemetry(pid(1), 'c1|c2', -5);
  service.recordTelemetry(pid(1), 'c1|c2', 4_000);
  service.recordTelemetry(pid(1), 'c1|c2', 1.5);
  assert.deepEqual(store.telemetryForRound(pid(1)), [{ pairKey: 'c1|c2', seconds: 30 }]);
});
