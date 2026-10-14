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
