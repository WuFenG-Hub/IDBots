# Preference Loop P4 — Compare Review UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the local human judge a preference round inside IDBots: a blind side-by-side compare panel (Left / Right, randomized per judge), one reason per pair, a React confirmation modal, a sealed commit signed by the user identity, and a status view that follows the round through reveal to the final tally. Entry points: a "Preference rounds" section on the MetaTask board and a button on MetaTask detail pages.

**Architecture:** Main process: `src/main/services/preference/ipc.ts` turns `PreferenceService` (P2) into IPC handlers with a human-safe view (no candidate authors, no salts, no other judges' sealed ballots); `main.ts` registers five channels and P2 already pushes `preference:update`. Renderer: a thin service over `window.electron.preference`, pure helpers in `preferencePairs.js` (node-testable like `groupTaskUtils.js`), and four components. Candidates render in iframes from the Bot Browser local preview URL (`botBrowser.resolveMetaAppPin` → `runUrl`, allowed by CSP `frame-src http://127.0.0.1:*`).

**Tech Stack:** Electron IPC + contextBridge, React 18 function components, Tailwind with theme CSS variables, `node:test`.

**Read first:** overview (global constraints), design §5.6 and §5.9, protocol §3–§5.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/main/services/preference/ipc.ts` | Create | `createPreferenceIpcHandlers`, `toHumanRoundView`, human view types |
| `src/main/main.ts` | Modify | register `preference:*` IPC channels |
| `src/main/preload.ts` | Modify | `window.electron.preference` |
| `src/renderer/types/preference.ts` | Create | renderer mirror types |
| `src/renderer/types/electron.d.ts` | Modify | `preference` API typing |
| `src/renderer/services/preference.ts` | Create | IPC wrapper, update subscription, preview resolution |
| `src/renderer/components/preference/preferencePairs.js` | Create | pair schedule, ballot mapping, progress, time parts |
| `src/renderer/components/preference/PreferenceSealConfirmModal.tsx` | Create | React confirmation modal |
| `src/renderer/components/preference/PreferenceComparePanel.tsx` | Create | full-screen compare panel + status view |
| `src/renderer/components/preference/PreferenceRoundsSection.tsx` | Create | board section + per-task round buttons |
| `src/renderer/components/metatask/MetaTaskBoard.tsx` | Modify | mount the rounds section |
| `src/renderer/components/metatask/MetaTaskDetail.tsx` | Modify | mount per-task round buttons |
| `src/renderer/services/i18n.ts` | Modify | `preference.*` keys, zh + en |
| `tests/preferenceIpc.test.mjs` | Create | IPC handler behavior and privacy |
| `tests/preferencePairs.test.mjs` | Create | helper behavior |
| `tests/preferenceUiStatic.test.mjs` | Create | i18n coverage, theme and privacy lints on the new components |
| `package.json` | Modify | append the three test files to `test:preference` |

---

### Task 0: Worktree

- [ ] **Step 1: Create the worktree from `main` (P2 must already be merged)**

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots
git fetch --all --prune
git log --oneline -1 main -- src/main/services/preference/service.ts   # must print a commit; otherwise stop
git worktree add .worktrees/preference-p4-ui -b feat/preference-p4-ui main
git config extensions.worktreeConfig true
git -C .worktrees/preference-p4-ui config --worktree core.filemode false
cd .worktrees/preference-p4-ui
pnpm install
pnpm run test:preference
```

---

### Task 1: IPC handlers with a human-safe view

**Files:**
- Create: `src/main/services/preference/ipc.ts`
- Create: `tests/preferenceIpc.test.mjs`

**Interfaces:**
- Consumes: `PreferenceService` (`refresh`, `listRounds`, `roundStatus`, `commitBallot`, `recordTelemetry`), `PreferenceRoundView`, `PreferenceBallotStatus` (P2); `COMMIT_CUTOFF_SEC`, `REVEAL_DELAY_SEC`, `PIN_ID_RE`, `CANDIDATE_ID_RE` (P1).
- Produces:
  - `interface PreferenceIpcDeps { service: () => PreferenceService; userGlobalMetaId: () => string | null }`
  - `toHumanRoundView(view: PreferenceRoundView, me: string | null): PreferenceHumanRoundView`
  - `createPreferenceIpcHandlers(deps)` → `{ listRounds(input), roundStatus(input), commit(input), telemetry(input), refresh() }`; every result is `{ success: true, … } | { success: false, error: string }`; inputs are `unknown` and validated.
- Privacy rules (tested):
  - candidates are `{ id, artifact, own }` — no `author`;
  - `myBallots` holds only `signerType === 'user'` rows of the current user identity, newest first, salt stripped (P2 `toBallotView` already omits it);
  - MetaBot-signed sealed ballots never appear in any human view.
- Error codes: `preference:invalid-round`, `USER_IDENTITY_MISSING`, `preference:not-a-listed-judge`, `preference:invalid-telemetry`; service codes pass through.

- [ ] **Step 1: Write the failing tests `tests/preferenceIpc.test.mjs`**

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm run compile:electron && node --test tests/preferenceIpc.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/ipc.js'`.

- [ ] **Step 3: Write `src/main/services/preference/ipc.ts`**

```ts
import { CANDIDATE_ID_RE, COMMIT_CUTOFF_SEC, PIN_ID_RE, REVEAL_DELAY_SEC } from './constants';
import type { PreferenceRoundView, PreferenceService } from './service';
import type { PreferenceBallotStatus } from './store';
import type { Ballot, JudgeClass, JudgeKind, RoundDimension, TallyStatus } from './types';

export interface PreferenceUserRoundSummary {
  pinId: string;
  title: string;
  status: TallyStatus | 'pending';
  winner: string | null;
  confirmed: boolean;
  category: string[];
  subject: { taskid: string; node: string } | null;
  candidateCount: number;
  commitCloseAt: number;
  commitCutoffAt: number;
  revealCloseAt: number;
  myKind: JudgeKind | null;
  myBallotStatus: PreferenceBallotStatus | null;
}

export interface PreferenceHumanBallot {
  id: string;
  status: PreferenceBallotStatus;
  commitPinId: string | null;
  revealPinId: string | null;
  lastError: string | null;
  ballot: Ballot;
  updatedAtMs: number;
}

export interface PreferenceHumanRoundView {
  pinId: string;
  confirmed: boolean;
  title: string;
  brief: string;
  category: string[];
  subject: { taskid: string; node: string } | null;
  commitCloseAt: number;
  commitCutoffAt: number;
  revealsFrom: number;
  revealCloseAt: number;
  dimensions: RoundDimension[];
  tasks: string[];
  candidates: { id: string; artifact: string; own: boolean }[];
  me: { globalMetaId: string | null; listed: boolean; kind: JudgeKind | null; class: JudgeClass };
  myBallots: PreferenceHumanBallot[];
  status: TallyStatus | 'pending';
  tallyError: string | null;
  winner: string | null;
  winnerArtifact: string | null;
  tallyHash: string | null;
  ranking: { id: string; copeland: number; points: number; wins: number; losses: number; ties: number }[];
  ballots: { deciding: number; shadow: number; public: number } | null;
}

export interface PreferenceIpcDeps {
  service: () => PreferenceService;
  userGlobalMetaId: () => string | null;
}

type Fail = { success: false; error: string };

const fail = (error: unknown): Fail => ({ success: false, error: error instanceof Error ? error.message : String(error) });

const asRecord = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

const isPinId = (value: unknown): value is string => typeof value === 'string' && PIN_ID_RE.test(value);

const isPairKey = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parts = value.split('|');
  return parts.length === 2 && parts.every((part) => CANDIDATE_ID_RE.test(part));
};

const userBallotsOf = (view: PreferenceRoundView, me: string | null): PreferenceHumanBallot[] =>
  me === null
    ? []
    : view.localBallots
        .filter((row) => row.signerType === 'user' && row.judgeGlobalMetaId === me)
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
        .map((row) => ({
          id: row.id,
          status: row.status,
          commitPinId: row.commitPinId,
          revealPinId: row.revealPinId,
          lastError: row.lastError,
          ballot: row.ballot,
          updatedAtMs: row.updatedAtMs,
        }));

export function toHumanRoundView(view: PreferenceRoundView, me: string | null): PreferenceHumanRoundView {
  const output = view.tally?.output ?? null;
  const winner = output?.winner ?? null;
  const listed = me === null ? undefined : view.round.judges.find((judge) => judge.id === me);
  const judgeClass: JudgeClass = !listed
    ? 'public'
    : view.round.decision.kinds.includes(listed.kind)
      ? 'deciding'
      : 'shadow';
  return {
    pinId: view.pinId,
    confirmed: view.confirmed,
    title: view.round.title,
    brief: view.round.brief ?? '',
    category: view.round.category,
    subject: view.round.subject ?? null,
    commitCloseAt: view.round.commitCloseAt,
    commitCutoffAt: view.round.commitCloseAt - COMMIT_CUTOFF_SEC,
    revealsFrom: view.round.commitCloseAt + REVEAL_DELAY_SEC,
    revealCloseAt: view.round.revealCloseAt,
    dimensions: view.round.dimensions,
    tasks: view.round.tasks,
    candidates: view.round.candidates.map((candidate) => ({
      id: candidate.id,
      artifact: candidate.artifact,
      own: me !== null && candidate.author === me,
    })),
    me: { globalMetaId: me, listed: Boolean(listed), kind: listed?.kind ?? null, class: judgeClass },
    myBallots: userBallotsOf(view, me),
    status: output?.status ?? 'pending',
    tallyError: view.tallyError,
    winner,
    winnerArtifact: winner ? view.round.candidates.find((candidate) => candidate.id === winner)?.artifact ?? null : null,
    tallyHash: view.tally?.tallyHash ?? null,
    ranking: (output?.ranking ?? []).map(({ id, copeland, points, wins, losses, ties }) => ({
      id,
      copeland,
      points,
      wins,
      losses,
      ties,
    })),
    ballots: output?.ballots ?? null,
  };
}

export function createPreferenceIpcHandlers(deps: PreferenceIpcDeps) {
  const locate = async (roundPinId: string): Promise<PreferenceRoundView | { error: string }> => {
    const service = deps.service();
    const first = service.roundStatus(roundPinId);
    if (!('error' in first) || first.error !== 'round:not-found') return first;
    await service.refresh('ipc:round');
    return service.roundStatus(roundPinId);
  };

  return {
    async listRounds(
      input: unknown,
    ): Promise<{ success: true; rounds: PreferenceUserRoundSummary[]; userGlobalMetaId: string | null } | Fail> {
      try {
        const args = asRecord(input);
        const me = deps.userGlobalMetaId();
        if (args.mine === true && !me) return { success: true, rounds: [], userGlobalMetaId: null };
        if (args.taskid !== undefined && !isPinId(args.taskid)) return { success: true, rounds: [], userGlobalMetaId: me };
        const service = deps.service();
        const summaries = service.listRounds({
          judge: args.mine === true && me ? me : undefined,
          taskid: isPinId(args.taskid) ? args.taskid : undefined,
        });
        const rounds = summaries.map((summary): PreferenceUserRoundSummary => {
          const view = service.roundStatus(summary.pinId);
          const mine = 'error' in view ? [] : userBallotsOf(view, me);
          return {
            pinId: summary.pinId,
            title: summary.title,
            status: summary.status,
            winner: summary.winner,
            confirmed: summary.confirmed,
            category: summary.category,
            subject: summary.subject,
            candidateCount: summary.candidateCount,
            commitCloseAt: summary.commitCloseAt,
            commitCutoffAt: summary.commitCloseAt - COMMIT_CUTOFF_SEC,
            revealCloseAt: summary.revealCloseAt,
            myKind: me ? summary.judges.find((judge) => judge.id === me)?.kind ?? null : null,
            myBallotStatus: mine[0]?.status ?? null,
          };
        });
        return { success: true, rounds, userGlobalMetaId: me };
      } catch (error) {
        return fail(error);
      }
    },

    async roundStatus(input: unknown): Promise<{ success: true; view: PreferenceHumanRoundView } | Fail> {
      try {
        const roundPinId = asRecord(input).roundPinId;
        if (!isPinId(roundPinId)) return { success: false, error: 'preference:invalid-round' };
        const view = await locate(roundPinId);
        if ('error' in view) return { success: false, error: view.error };
        return { success: true, view: toHumanRoundView(view, deps.userGlobalMetaId()) };
      } catch (error) {
        return fail(error);
      }
    },

    async commit(input: unknown): Promise<{ success: true; pinId: string; ballotId: string } | Fail> {
      try {
        const args = asRecord(input);
        if (!isPinId(args.roundPinId)) return { success: false, error: 'preference:invalid-round' };
        const roundPinId = args.roundPinId;
        const me = deps.userGlobalMetaId();
        if (!me) return { success: false, error: 'USER_IDENTITY_MISSING' };
        const view = await locate(roundPinId);
        if ('error' in view) return { success: false, error: view.error };
        if (!view.round.judges.some((judge) => judge.id === me)) {
          return { success: false, error: 'preference:not-a-listed-judge' };
        }
        const result = await deps.service().commitBallot({ type: 'user' }, roundPinId, args.ballot);
        if ('error' in result) return { success: false, error: result.error };
        return { success: true, pinId: result.pinId, ballotId: result.ballotId };
      } catch (error) {
        return fail(error);
      }
    },

    telemetry(input: unknown): { success: true } | Fail {
      try {
        const args = asRecord(input);
        if (!isPinId(args.roundPinId) || !isPairKey(args.pairKey) || typeof args.seconds !== 'number') {
          return { success: false, error: 'preference:invalid-telemetry' };
        }
        deps.service().recordTelemetry(args.roundPinId, args.pairKey, args.seconds);
        return { success: true };
      } catch (error) {
        return fail(error);
      }
    },

    async refresh(): Promise<{ success: true; eventCount: number } | Fail> {
      try {
        const result = await deps.service().refresh('ipc:manual');
        return result.ok ? { success: true, eventCount: result.eventCount } : { success: false, error: result.error ?? 'preference:refresh-failed' };
      } catch (error) {
        return fail(error);
      }
    },
  };
}
```

An invalid `taskid` returns an empty list instead of silently listing every round.

- [ ] **Step 4: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceIpc.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/ipc.ts
git add -f tests/preferenceIpc.test.mjs
git commit -m "feat: add preference IPC handlers with a human-safe view"
```

---

### Task 2: Main registration, preload, typings, renderer types and service

**Files:**
- Modify: `src/main/main.ts`, `src/main/preload.ts`, `src/renderer/types/electron.d.ts`
- Create: `src/renderer/types/preference.ts`, `src/renderer/services/preference.ts`

**Interfaces:**
- Channels: `preference:listRounds`, `preference:roundStatus`, `preference:commit`, `preference:telemetry`, `preference:refresh` (invoke); `preference:update` (push, `{ seq: number; reason: string }`, already sent by P2's `broadcastPreferenceUpdate`).
- `window.electron.preference` = `{ listRounds, roundStatus, commit, telemetry, refresh, onUpdate }`.
- Renderer service `preferenceService`: `available()`, `listRounds(filter)`, `roundStatus(roundPinId)`, `commit(roundPinId, ballot)`, `recordPairTime(roundPinId, pairKey, seconds)`, `refresh()`, `subscribe(callback): () => void` (per-subscription seq filter), `resolvePreview(artifact)`, `previewIsFresh(preview)`.

- [ ] **Step 1: `main.ts` — register the channels**

Add to the imports near the other preference imports from P2:

```ts
import { createPreferenceIpcHandlers } from './services/preference/ipc';
```

Directly after the `ipcMain.handle('metatask:refresh', …)` block (~13547–13555), add:

```ts
  // ==================== Preference IPC (compare review panel) ====================
  // Human-signed ballots only; the view strips candidate authors, salts, and
  // every MetaBot-signed sealed ballot (judge independence).
  const preferenceIpc = createPreferenceIpcHandlers({
    service: () => getPreferenceService(),
    userGlobalMetaId: () => getUserIdentityStore().get()?.globalmetaid ?? null,
  });
  ipcMain.handle('preference:listRounds', (_event, input: unknown) => preferenceIpc.listRounds(input));
  ipcMain.handle('preference:roundStatus', (_event, input: unknown) => preferenceIpc.roundStatus(input));
  ipcMain.handle('preference:commit', (_event, input: unknown) => preferenceIpc.commit(input));
  ipcMain.handle('preference:telemetry', (_event, input: unknown) => preferenceIpc.telemetry(input));
  ipcMain.handle('preference:refresh', () => preferenceIpc.refresh());
```

- [ ] **Step 2: `preload.ts` — expose the API**

Directly after the `metatask: { … },` block (~932–943):

```ts
  preference: {
    // Preference rounds (/protocols/preference): human judging over IPC.
    listRounds: (input?: { mine?: boolean; taskid?: string }) => ipcRenderer.invoke('preference:listRounds', input ?? {}),
    roundStatus: (input: { roundPinId: string }) => ipcRenderer.invoke('preference:roundStatus', input),
    commit: (input: { roundPinId: string; ballot: unknown }) => ipcRenderer.invoke('preference:commit', input),
    telemetry: (input: { roundPinId: string; pairKey: string; seconds: number }) =>
      ipcRenderer.invoke('preference:telemetry', input),
    refresh: () => ipcRenderer.invoke('preference:refresh'),
    onUpdate: (callback: (data: { seq: number; reason: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { seq: number; reason: string }) => callback(data);
      ipcRenderer.on('preference:update', handler);
      return () => ipcRenderer.removeListener('preference:update', handler);
    },
  },
```

- [ ] **Step 3: Create `src/renderer/types/preference.ts`**

```ts
export type PreferenceTallyStatus = 'collecting' | 'revealing' | 'settling' | 'decided' | 'no_decision' | 'pending';
export type PreferenceBallotStatus =
  | 'committing'
  | 'committed'
  | 'commit_failed'
  | 'superseded'
  | 'revealed'
  | 'reveal_failed'
  | 'expired';
export type PreferenceJudgeKind = 'human' | 'ai';
export type PreferenceJudgeClass = 'deciding' | 'shadow' | 'public';
export type PreferencePick = 'a' | 'b' | 'tie';
export type PreferenceChoice = 'left' | 'right' | 'tie';

export interface PreferenceBallotPair {
  a: string;
  b: string;
  pick: PreferencePick;
  reason: string;
  dims?: Record<string, PreferencePick>;
}

export interface PreferenceBallot {
  pairs: PreferenceBallotPair[];
  note?: string;
}

export interface PreferenceUserRoundSummary {
  pinId: string;
  title: string;
  status: PreferenceTallyStatus;
  winner: string | null;
  confirmed: boolean;
  category: string[];
  subject: { taskid: string; node: string } | null;
  candidateCount: number;
  commitCloseAt: number;
  commitCutoffAt: number;
  revealCloseAt: number;
  myKind: PreferenceJudgeKind | null;
  myBallotStatus: PreferenceBallotStatus | null;
}

export interface PreferenceHumanBallot {
  id: string;
  status: PreferenceBallotStatus;
  commitPinId: string | null;
  revealPinId: string | null;
  lastError: string | null;
  ballot: PreferenceBallot;
  updatedAtMs: number;
}

export interface PreferenceCandidateView {
  id: string;
  artifact: string;
  own: boolean;
}

export interface PreferenceHumanRoundView {
  pinId: string;
  confirmed: boolean;
  title: string;
  brief: string;
  category: string[];
  subject: { taskid: string; node: string } | null;
  commitCloseAt: number;
  commitCutoffAt: number;
  revealsFrom: number;
  revealCloseAt: number;
  dimensions: { id: string; label: string }[];
  tasks: string[];
  candidates: PreferenceCandidateView[];
  me: { globalMetaId: string | null; listed: boolean; kind: PreferenceJudgeKind | null; class: PreferenceJudgeClass };
  myBallots: PreferenceHumanBallot[];
  status: PreferenceTallyStatus;
  tallyError: string | null;
  winner: string | null;
  winnerArtifact: string | null;
  tallyHash: string | null;
  ranking: { id: string; copeland: number; points: number; wins: number; losses: number; ties: number }[];
  ballots: { deciding: number; shadow: number; public: number } | null;
}

export interface PreferencePairSlot {
  key: string;
  left: string;
  right: string;
}

export interface PreferencePairAnswer {
  choice: PreferenceChoice | null;
  reason: string;
  dims: Record<string, PreferenceChoice>;
}

export type PreferenceAnswers = Record<string, PreferencePairAnswer>;
```

- [ ] **Step 4: `electron.d.ts` — type the API**

Directly after the `metatask: { … };` block (~1509–1519):

```ts
  /**
   * Preference rounds (/protocols/preference): blind human judging.
   * Main-process implementation: src/main/services/preference/ipc.ts.
   */
  preference: {
    listRounds: (input?: { mine?: boolean; taskid?: string }) => Promise<{
      success: boolean;
      rounds?: import('./preference').PreferenceUserRoundSummary[];
      userGlobalMetaId?: string | null;
      error?: string;
    }>;
    roundStatus: (input: { roundPinId: string }) => Promise<{
      success: boolean;
      view?: import('./preference').PreferenceHumanRoundView;
      error?: string;
    }>;
    commit: (input: { roundPinId: string; ballot: import('./preference').PreferenceBallot }) => Promise<{
      success: boolean;
      pinId?: string;
      ballotId?: string;
      error?: string;
    }>;
    telemetry: (input: { roundPinId: string; pairKey: string; seconds: number }) => Promise<{ success: boolean; error?: string }>;
    refresh: () => Promise<{ success: boolean; eventCount?: number; error?: string }>;
    /** seq is monotonic per process: drop frames with seq <= lastSeenSeq and refetch. */
    onUpdate: (callback: (data: { seq: number; reason: string }) => void) => () => void;
  };
```

- [ ] **Step 5: Create `src/renderer/services/preference.ts`**

```ts
import type {
  PreferenceBallot,
  PreferenceHumanRoundView,
  PreferenceUserRoundSummary,
} from '../types/preference';

const METAAPP_PREFIX = 'metaapp://';
/** Bot Browser preview URLs expire after 30 min; re-resolve well before that. */
const PREVIEW_MAX_AGE_MS = 20 * 60 * 1000;

export type PreferencePreview = { url: string; resolvedAtMs: number } | { error: string };

/**
 * Preference rounds — renderer service: thin IPC wrapper. Components keep
 * their own state; every write and every derivation lives in the main process.
 */
class PreferenceRendererService {
  private api() {
    return window.electron?.preference ?? null;
  }

  available(): boolean {
    return this.api() !== null;
  }

  async listRounds(
    filter: { mine?: boolean; taskid?: string } = {},
  ): Promise<{ rounds: PreferenceUserRoundSummary[]; userGlobalMetaId: string | null }> {
    const api = this.api();
    if (!api) return { rounds: [], userGlobalMetaId: null };
    const result = await api.listRounds(filter);
    if (!result.success) throw new Error(result.error ?? 'preference:list-failed');
    return { rounds: result.rounds ?? [], userGlobalMetaId: result.userGlobalMetaId ?? null };
  }

  async roundStatus(roundPinId: string): Promise<PreferenceHumanRoundView> {
    const api = this.api();
    if (!api) throw new Error('preference:bridge-missing');
    const result = await api.roundStatus({ roundPinId });
    if (!result.success || !result.view) throw new Error(result.error ?? 'preference:status-failed');
    return result.view;
  }

  async commit(roundPinId: string, ballot: PreferenceBallot): Promise<{ pinId: string; ballotId: string }> {
    const api = this.api();
    if (!api) throw new Error('preference:bridge-missing');
    const result = await api.commit({ roundPinId, ballot });
    if (!result.success || !result.pinId || !result.ballotId) throw new Error(result.error ?? 'preference:commit-failed');
    return { pinId: result.pinId, ballotId: result.ballotId };
  }

  recordPairTime(roundPinId: string, pairKey: string, seconds: number): void {
    const api = this.api();
    if (!api || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) return;
    void api.telemetry({ roundPinId, pairKey, seconds });
  }

  async refresh(): Promise<void> {
    const api = this.api();
    if (!api) return;
    const result = await api.refresh();
    if (!result.success) throw new Error(result.error ?? 'preference:refresh-failed');
  }

  subscribe(callback: (reason: string) => void): () => void {
    const api = this.api();
    if (!api || typeof api.onUpdate !== 'function') return () => undefined;
    let lastSeq = 0;
    return api.onUpdate((data) => {
      if (data.seq <= lastSeq) return;
      lastSeq = data.seq;
      callback(data.reason);
    });
  }

  async resolvePreview(artifact: string): Promise<PreferencePreview> {
    if (!artifact.startsWith(METAAPP_PREFIX)) return { error: 'unsupported' };
    const pinId = artifact.slice(METAAPP_PREFIX.length).split(/[/?#]/)[0];
    const browser = window.electron?.botBrowser;
    if (!browser?.resolveMetaAppPin) return { error: 'bot-browser-unavailable' };
    try {
      const result = await browser.resolveMetaAppPin({ pinId });
      if (!result.ok) return { error: result.message || result.code };
      if (!result.data.runUrl) return { error: 'no-run-url' };
      return { url: result.data.runUrl, resolvedAtMs: Date.now() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  previewIsFresh(preview: PreferencePreview | undefined): boolean {
    return Boolean(preview && 'url' in preview && Date.now() - preview.resolvedAtMs < PREVIEW_MAX_AGE_MS);
  }
}

export const preferenceService = new PreferenceRendererService();
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm run compile:electron && pnpm run build && pnpm run lint && node --test tests/preferenceIpc.test.mjs`
Expected: 0 errors everywhere (`pnpm run build` runs the renderer `tsc` with `noUnusedLocals`).

```bash
git add src/main/main.ts src/main/preload.ts src/renderer/types/electron.d.ts src/renderer/types/preference.ts src/renderer/services/preference.ts
git commit -m "feat: expose preference rounds to the renderer"
```

---

### Task 3: Pure helpers `preferencePairs.js`

**Files:**
- Create: `src/renderer/components/preference/preferencePairs.js`
- Create: `tests/preferencePairs.test.mjs`

**Interfaces:**
- `pairKey(x, y)` — `"<smaller>|<larger>"`.
- `buildPairSchedule(judgeId, roundPinId, candidates)` → `PreferencePairSlot[]`: all unordered pairs of non-`own` candidates, order and left/right from an FNV-1a hash of `(roundPinId, judgeId, key)` — stable for one judge, different across judges.
- `answersToBallot(schedule, answers, note)` → `PreferenceBallot` (Left → `a`, Right → `b`; skips unanswered pairs; trims reasons and note).
- `ballotToAnswers(schedule, ballot)` → answers, correcting for a ballot whose `a`/`b` orientation differs from the schedule.
- `pairAnswerError(answer)` → `null | 'missing-choice' | 'missing-reason' | 'reason-too-long'` (code-point length ≤ 1000, like the protocol).
- `scheduleProgress(schedule, answers)` → `{ done, total, complete }`.
- `remainingParts(seconds)` → `{ kind: 'now' | 'm' | 'hm' | 'dh', d, h, m }`.

- [ ] **Step 1: Write the failing tests `tests/preferencePairs.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answersToBallot,
  ballotToAnswers,
  buildPairSchedule,
  pairAnswerError,
  pairKey,
  remainingParts,
  scheduleProgress,
} from '../src/renderer/components/preference/preferencePairs.js';

const ROUND = `${'ab'.repeat(32)}i0`;
const candidates = ['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, artifact: `metaapp://${id}`, own: false }));

test('buildPairSchedule covers each pair once, skips own candidates, and is stable', () => {
  const schedule = buildPairSchedule('idq1judgea', ROUND, candidates);
  assert.deepEqual(schedule.map((slot) => slot.key).sort(), ['c1|c2', 'c1|c3', 'c1|c4', 'c2|c3', 'c2|c4', 'c3|c4']);
  for (const slot of schedule) assert.equal(pairKey(slot.left, slot.right), slot.key);
  assert.deepEqual(buildPairSchedule('idq1judgea', ROUND, candidates), schedule);
  const withOwn = buildPairSchedule('idq1judgea', ROUND, candidates.map((c) => (c.id === 'c2' ? { ...c, own: true } : c)));
  assert.deepEqual(withOwn.map((slot) => slot.key).sort(), ['c1|c3', 'c1|c4', 'c3|c4']);
});

test('left/right order differs between judges for the same round', () => {
  const layouts = new Set();
  for (let n = 0; n < 12; n += 1) {
    layouts.add(
      buildPairSchedule(`idq1judge${n}`, ROUND, candidates)
        .map((slot) => `${slot.left}>${slot.right}`)
        .join(','),
    );
  }
  assert.ok(layouts.size > 1);
});

test('answers map to a ballot and back, whatever the orientation', () => {
  const schedule = [
    { key: 'c1|c2', left: 'c2', right: 'c1' },
    { key: 'c1|c3', left: 'c1', right: 'c3' },
  ];
  const answers = {
    'c1|c2': { choice: 'left', reason: '  c2 shows more  ', dims: { visual: 'right' } },
    'c1|c3': { choice: 'tie', reason: 'same', dims: {} },
  };
  const ballot = answersToBallot(schedule, answers, '  overall  ');
  assert.deepEqual(ballot, {
    pairs: [
      { a: 'c2', b: 'c1', pick: 'a', reason: 'c2 shows more', dims: { visual: 'b' } },
      { a: 'c1', b: 'c3', pick: 'tie', reason: 'same' },
    ],
    note: 'overall',
  });
  assert.deepEqual(ballotToAnswers(schedule, ballot), {
    'c1|c2': { choice: 'left', reason: 'c2 shows more', dims: { visual: 'right' } },
    'c1|c3': { choice: 'tie', reason: 'same', dims: {} },
  });
  const flipped = { pairs: [{ a: 'c1', b: 'c2', pick: 'a', reason: 'c1 wins', dims: { visual: 'b' } }] };
  assert.deepEqual(ballotToAnswers(schedule, flipped)['c1|c2'], {
    choice: 'right',
    reason: 'c1 wins',
    dims: { visual: 'left' },
  });
  assert.deepEqual(answersToBallot(schedule, {}, ''), { pairs: [] });
});

test('progress requires a choice and a 1..1000 code-point reason for every pair', () => {
  const schedule = [
    { key: 'c1|c2', left: 'c1', right: 'c2' },
    { key: 'c1|c3', left: 'c1', right: 'c3' },
  ];
  assert.equal(pairAnswerError(undefined), 'missing-choice');
  assert.equal(pairAnswerError({ choice: 'left', reason: '   ', dims: {} }), 'missing-reason');
  assert.equal(pairAnswerError({ choice: 'left', reason: '字'.repeat(1000), dims: {} }), null);
  assert.equal(pairAnswerError({ choice: 'left', reason: '字'.repeat(1001), dims: {} }), 'reason-too-long');
  const partial = { 'c1|c2': { choice: 'right', reason: 'x', dims: {} } };
  assert.deepEqual(scheduleProgress(schedule, partial), { done: 1, total: 2, complete: false });
  const full = { ...partial, 'c1|c3': { choice: 'tie', reason: 'y', dims: {} } };
  assert.deepEqual(scheduleProgress(schedule, full), { done: 2, total: 2, complete: true });
  assert.deepEqual(scheduleProgress([], {}), { done: 0, total: 0, complete: false });
});

test('remainingParts buckets durations', () => {
  assert.deepEqual(remainingParts(-5), { kind: 'now', d: 0, h: 0, m: 0 });
  assert.deepEqual(remainingParts(59), { kind: 'now', d: 0, h: 0, m: 0 });
  assert.deepEqual(remainingParts(25 * 60), { kind: 'm', d: 0, h: 0, m: 25 });
  assert.deepEqual(remainingParts(3 * 3600 + 12 * 60), { kind: 'hm', d: 0, h: 3, m: 12 });
  assert.deepEqual(remainingParts(2 * 86400 + 5 * 3600 + 59), { kind: 'dh', d: 2, h: 5, m: 0 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/preferencePairs.test.mjs`
Expected: FAIL with `Cannot find module …/preferencePairs.js`.

- [ ] **Step 3: Write `src/renderer/components/preference/preferencePairs.js`**

```js
/**
 * Pure helpers for the preference compare panel. Plain JS (like
 * groupTaskUtils.js) so node --test can import it directly.
 */

export const MAX_REASON_CHARS = 1000;

const fnv1a = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

export function buildPairSchedule(judgeId, roundPinId, candidates) {
  const ids = candidates
    .filter((candidate) => !candidate.own)
    .map((candidate) => candidate.id)
    .sort();
  const slots = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = pairKey(ids[i], ids[j]);
      const seed = fnv1a(`${roundPinId}|${judgeId}|${key}`);
      const swap = (seed & 1) === 1;
      slots.push({ key, left: swap ? ids[j] : ids[i], right: swap ? ids[i] : ids[j], seed });
    }
  }
  return slots
    .sort((x, y) => x.seed - y.seed || (x.key < y.key ? -1 : 1))
    .map(({ key, left, right }) => ({ key, left, right }));
}

const CHOICE_TO_PICK = { left: 'a', right: 'b', tie: 'tie' };
const PICK_TO_CHOICE = { a: 'left', b: 'right', tie: 'tie' };

export function answersToBallot(schedule, answers, note) {
  const pairs = schedule.flatMap((slot) => {
    const answer = answers[slot.key];
    if (!answer || !CHOICE_TO_PICK[answer.choice]) return [];
    const dims = Object.fromEntries(
      Object.entries(answer.dims ?? {})
        .filter(([, choice]) => CHOICE_TO_PICK[choice])
        .map(([dimension, choice]) => [dimension, CHOICE_TO_PICK[choice]]),
    );
    return [
      {
        a: slot.left,
        b: slot.right,
        pick: CHOICE_TO_PICK[answer.choice],
        reason: String(answer.reason ?? '').trim(),
        ...(Object.keys(dims).length > 0 ? { dims } : {}),
      },
    ];
  });
  const trimmedNote = String(note ?? '').trim();
  return trimmedNote ? { pairs, note: trimmedNote } : { pairs };
}

export function ballotToAnswers(schedule, ballot) {
  const out = {};
  for (const pair of ballot?.pairs ?? []) {
    const slot = schedule.find((entry) => entry.key === pairKey(pair.a, pair.b));
    if (!slot) continue;
    const flipped = slot.left !== pair.a;
    const toChoice = (pick) => {
      const choice = PICK_TO_CHOICE[pick];
      if (!flipped || choice === 'tie') return choice;
      return choice === 'left' ? 'right' : 'left';
    };
    out[slot.key] = {
      choice: toChoice(pair.pick),
      reason: pair.reason,
      dims: Object.fromEntries(Object.entries(pair.dims ?? {}).map(([dimension, pick]) => [dimension, toChoice(pick)])),
    };
  }
  return out;
}

export function pairAnswerError(answer) {
  if (!answer || !CHOICE_TO_PICK[answer.choice]) return 'missing-choice';
  const length = [...String(answer.reason ?? '').trim()].length;
  if (length === 0) return 'missing-reason';
  if (length > MAX_REASON_CHARS) return 'reason-too-long';
  return null;
}

export function scheduleProgress(schedule, answers) {
  const done = schedule.filter((slot) => pairAnswerError(answers[slot.key]) === null).length;
  return { done, total: schedule.length, complete: schedule.length > 0 && done === schedule.length };
}

export function remainingParts(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (total < 60) return { kind: 'now', d: 0, h: 0, m: 0 };
  if (d > 0) return { kind: 'dh', d, h, m: 0 };
  if (h > 0) return { kind: 'hm', d: 0, h, m };
  return { kind: 'm', d: 0, h: 0, m };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/preferencePairs.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/preference/preferencePairs.js
git add -f tests/preferencePairs.test.mjs
git commit -m "feat: add preference pair schedule and ballot helpers"
```

---

### Task 4: i18n keys

**Files:**
- Modify: `src/renderer/services/i18n.ts` (the `zh` block ends before `en: {` at ~line 2978; add the zh keys at the end of the `zh` block and the en keys at the end of the `en` block)

- [ ] **Step 1: Add the zh keys (end of the `zh` object)**

```ts
    'preference.rounds.title': '偏好评审轮次',
    'preference.rounds.subtitle': '你被列为评审的盲评轮次。逐组比较两个版本，写下理由并封存选票。',
    'preference.rounds.judge': '去评审',
    'preference.rounds.view': '查看',
    'preference.rounds.closesAt': '{time} 截止投票',
    'preference.rounds.myBallot': '我的选票：{status}',
    'preference.status.collecting': '收票中',
    'preference.status.revealing': '揭示中',
    'preference.status.settling': '结果确认中',
    'preference.status.decided': '已出结果',
    'preference.status.no_decision': '未达成结果',
    'preference.status.pending': '链上确认中',
    'preference.ballotStatus.committing': '封存中…',
    'preference.ballotStatus.committed': '已封存',
    'preference.ballotStatus.commit_failed': '封存失败',
    'preference.ballotStatus.superseded': '已被替换',
    'preference.ballotStatus.revealed': '已揭示',
    'preference.ballotStatus.reveal_failed': '揭示失败',
    'preference.ballotStatus.expired': '已过期',
    'preference.panel.loading': '正在加载…',
    'preference.panel.close': '关闭',
    'preference.panel.pairProgress': '第 {index} / {total} 组',
    'preference.panel.commitClosesIn': '{time} 后截止投票',
    'preference.panel.left': '左',
    'preference.panel.right': '右',
    'preference.panel.tieShort': '持平',
    'preference.panel.pickLeft': '左边更好',
    'preference.panel.pickRight': '右边更好',
    'preference.panel.pickTie': '没有明显差别',
    'preference.panel.reasonLabel': '理由：写出你看到的具体差别（必填）',
    'preference.panel.reasonPlaceholder': '例如：左边一屏能看到六个问题和回答摘要，右边只有两个。',
    'preference.panel.reasonTooLong': '请控制在 1000 字以内。',
    'preference.panel.dimensions': '分维度（可选）',
    'preference.panel.prev': '上一组',
    'preference.panel.next': '下一组',
    'preference.panel.review': '检查并封存选票',
    'preference.panel.note': '总体备注（可选）',
    'preference.panel.desktop': '桌面',
    'preference.panel.mobile': '手机 390px',
    'preference.panel.reload': '重新加载',
    'preference.panel.previewFailed': '无法加载这个候选：{error}',
    'preference.panel.unsupportedArtifact': '这个候选不是 MetaApp，无法在这里预览：{artifact}',
    'preference.panel.brief': '评审说明',
    'preference.panel.tasks': '在两个应用里都试试这些',
    'preference.panel.blindNote': '构建者身份已隐藏，只按你看到的内容评判。',
    'preference.panel.notJudge': '你不在本轮的评审名单里。',
    'preference.panel.noIdentity': '先在设置里创建或导入你的用户身份，才能评审。',
    'preference.panel.closed': '投票已截止。',
    'preference.panel.notConfirmed': '轮次还在链上确认，稍后再来。',
    'preference.panel.nothingToJudge': '没有可评的组合：每一组都包含你自己的候选。',
    'preference.panel.alreadySealed': '选票已封存（{pin}）。{time} 前可以修改后重新封存。',
    'preference.panel.windows': '投票截止 {commit} · 揭示截止 {reveal}',
    'preference.panel.ranking': '排名',
    'preference.panel.winner': '胜出：{id}',
    'preference.panel.tallyHash': '计票哈希',
    'preference.panel.myBallots': '我的选票',
    'preference.panel.revealHint': '投票截止后 IDBots 会自动揭示你的选票；请在 {time} 前保持 IDBots 运行或重新打开。',
    'preference.confirm.title': '封存选票？',
    'preference.confirm.body': '你的 {count} 组选择会以封存形式上链，投票截止（{commit}）前任何人都看不到。截止后 IDBots 自动揭示——请保持 IDBots 运行，或在 {reveal} 前重新打开。封存会从你的身份地址扣一笔很小的链上手续费。',
    'preference.confirm.confirm': '封存',
    'preference.confirm.cancel': '取消',
    'preference.confirm.sealing': '封存中…',
    'preference.confirm.sealed': '选票已封存：{pin}',
    'preference.detail.judgeRound': '评审偏好轮次',
    'preference.detail.viewRound': '偏好轮次：{status}',
    'preference.time.now': '马上',
    'preference.time.minutes': '{m} 分钟',
    'preference.time.hoursMinutes': '{h} 小时 {m} 分',
    'preference.time.daysHours': '{d} 天 {h} 小时',
    'preference.error.generic': '出错了：{error}',
```

- [ ] **Step 2: Add the en keys (end of the `en` object)**

```ts
    'preference.rounds.title': 'Preference rounds',
    'preference.rounds.subtitle': 'Blind rounds that list you as a judge. Compare two builds at a time, give a reason, and seal your ballot.',
    'preference.rounds.judge': 'Judge',
    'preference.rounds.view': 'View',
    'preference.rounds.closesAt': 'Ballots close {time}',
    'preference.rounds.myBallot': 'My ballot: {status}',
    'preference.status.collecting': 'Collecting ballots',
    'preference.status.revealing': 'Revealing',
    'preference.status.settling': 'Settling',
    'preference.status.decided': 'Decided',
    'preference.status.no_decision': 'No decision',
    'preference.status.pending': 'Confirming on chain',
    'preference.ballotStatus.committing': 'Sealing…',
    'preference.ballotStatus.committed': 'Sealed',
    'preference.ballotStatus.commit_failed': 'Seal failed',
    'preference.ballotStatus.superseded': 'Replaced',
    'preference.ballotStatus.revealed': 'Revealed',
    'preference.ballotStatus.reveal_failed': 'Reveal failed',
    'preference.ballotStatus.expired': 'Expired',
    'preference.panel.loading': 'Loading…',
    'preference.panel.close': 'Close',
    'preference.panel.pairProgress': 'Pair {index} of {total}',
    'preference.panel.commitClosesIn': 'Ballots close in {time}',
    'preference.panel.left': 'Left',
    'preference.panel.right': 'Right',
    'preference.panel.tieShort': 'Tie',
    'preference.panel.pickLeft': 'Left is better',
    'preference.panel.pickRight': 'Right is better',
    'preference.panel.pickTie': 'No clear difference',
    'preference.panel.reasonLabel': 'Why? Name the difference you saw (required)',
    'preference.panel.reasonPlaceholder': 'e.g. Left shows six questions with answer previews per screen; right shows two.',
    'preference.panel.reasonTooLong': 'Keep it under 1000 characters.',
    'preference.panel.dimensions': 'Per dimension (optional)',
    'preference.panel.prev': 'Previous',
    'preference.panel.next': 'Next',
    'preference.panel.review': 'Review and seal ballot',
    'preference.panel.note': 'Overall remark (optional)',
    'preference.panel.desktop': 'Desktop',
    'preference.panel.mobile': 'Mobile 390px',
    'preference.panel.reload': 'Reload',
    'preference.panel.previewFailed': 'Could not load this candidate: {error}',
    'preference.panel.unsupportedArtifact': 'This candidate is not a MetaApp and cannot be previewed here: {artifact}',
    'preference.panel.brief': 'What to judge',
    'preference.panel.tasks': 'Try these in both apps',
    'preference.panel.blindNote': 'Builders are hidden. Judge only what you see.',
    'preference.panel.notJudge': 'You are not a listed judge for this round.',
    'preference.panel.noIdentity': 'Create or import your user identity in Settings to judge.',
    'preference.panel.closed': 'Ballots are closed.',
    'preference.panel.notConfirmed': 'The round is still confirming on chain. Check back shortly.',
    'preference.panel.nothingToJudge': 'Nothing to judge: every pair includes your own candidate.',
    'preference.panel.alreadySealed': 'Ballot sealed ({pin}). You can change it and seal again until {time}.',
    'preference.panel.windows': 'Ballots close {commit} · Reveals close {reveal}',
    'preference.panel.ranking': 'Ranking',
    'preference.panel.winner': 'Winner: {id}',
    'preference.panel.tallyHash': 'Tally hash',
    'preference.panel.myBallots': 'My ballots',
    'preference.panel.revealHint': 'IDBots reveals your ballot automatically after ballots close; keep IDBots running or reopen it before {time}.',
    'preference.confirm.title': 'Seal your ballot?',
    'preference.confirm.body': 'Your {count} picks go on-chain sealed; nobody can read them before ballots close ({commit}). IDBots then reveals them automatically — keep IDBots running, or reopen it before {reveal}. Sealing spends a small chain fee from your identity.',
    'preference.confirm.confirm': 'Seal ballot',
    'preference.confirm.cancel': 'Cancel',
    'preference.confirm.sealing': 'Sealing…',
    'preference.confirm.sealed': 'Ballot sealed: {pin}',
    'preference.detail.judgeRound': 'Judge preference round',
    'preference.detail.viewRound': 'Preference round: {status}',
    'preference.time.now': 'now',
    'preference.time.minutes': '{m}m',
    'preference.time.hoursMinutes': '{h}h {m}m',
    'preference.time.daysHours': '{d}d {h}h',
    'preference.error.generic': 'Something went wrong: {error}',
```

- [ ] **Step 3: Verify and commit**

Run: `pnpm run build && pnpm run lint`
Expected: 0 errors.

```bash
git add src/renderer/services/i18n.ts
git commit -m "feat: add preference panel strings in English and Chinese"
```

---

### Task 5: Confirmation modal and compare panel

**Files:**
- Create: `src/renderer/components/preference/PreferenceSealConfirmModal.tsx`
- Create: `src/renderer/components/preference/PreferenceComparePanel.tsx`

**Behavior contract:**
- The panel is a full-screen overlay (`fixed inset-0`, `z-[9000]`; the modal sits above at `z-[9999]`).
- Judging mode iff: the user is a listed judge, status is `collecting`, and now < `commitCutoffAt`. Otherwise the status view.
- One pair at a time: Left and Right iframes (`sandbox="allow-scripts allow-same-origin allow-forms"`, no popups, no top navigation), a Desktop / Mobile 390px width toggle, Reload per side. Builder identity is never rendered; the artifact URI is shown only when it cannot be previewed.
- Previews come from `preferenceService.resolvePreview` and re-resolve after 20 min.
- Answers persist in component state while the panel is open; a previously sealed ballot is restored once per ballot id.
- The "Review and seal" button is enabled only when every pair has a choice and a valid reason; it opens the modal, which commits on confirm.
- Telemetry: seconds a pair stays on screen, sent when the pair changes or the panel closes.
- Status view: why judging is unavailable, the user's ballots with status, reveal hint, windows, and (once there are reveals) ranking, winner, and tally hash.

- [ ] **Step 1: Write `PreferenceSealConfirmModal.tsx`**

```tsx
import React from 'react';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface PreferenceSealConfirmModalProps {
  pairCount: number;
  commitCloseAt: number;
  revealCloseAt: number;
  sealing: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const formatAt = (sec: number): string => new Date(sec * 1000).toLocaleString();

const PreferenceSealConfirmModal: React.FC<PreferenceSealConfirmModalProps> = ({
  pairCount,
  commitCloseAt,
  revealCloseAt,
  sealing,
  error,
  onConfirm,
  onCancel,
}) => (
  <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={sealing ? undefined : onCancel}>
    <div className="absolute inset-0 bg-black/50" />
    <div
      role="dialog"
      aria-modal="true"
      className="relative w-[26rem] rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-5 text-[var(--text-primary)] shadow-2xl"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-accent)]">
          <LockClosedIcon className="h-5 w-5 text-[var(--color-accent)]" />
        </div>
        <h3 className="mb-2 text-sm font-semibold">{i18nService.t('preference.confirm.title')}</h3>
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          {i18nService
            .t('preference.confirm.body')
            .replace('{count}', String(pairCount))
            .replace('{commit}', formatAt(commitCloseAt))
            .replace('{reveal}', formatAt(revealCloseAt))}
        </p>
        {error && (
          <p className="mb-3 w-full rounded-lg border border-red-500/40 px-3 py-2 text-left text-xs text-red-500">
            {i18nService.t('preference.error.generic').replace('{error}', error)}
          </p>
        )}
        <div className="flex w-full gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={sealing}
            className="flex-1 rounded-lg border border-[var(--border-color)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {i18nService.t('preference.confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={sealing}
            className="btn-idchat-primary-filled flex-1 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {sealing ? i18nService.t('preference.confirm.sealing') : i18nService.t('preference.confirm.confirm')}
          </button>
        </div>
      </div>
    </div>
  </div>
);

export default PreferenceSealConfirmModal;
```

- [ ] **Step 2: Write `PreferenceComparePanel.tsx`**

```tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { preferenceService, type PreferencePreview } from '../../services/preference';
import type {
  PreferenceAnswers,
  PreferenceChoice,
  PreferenceHumanRoundView,
  PreferencePairAnswer,
} from '../../types/preference';
import PreferenceSealConfirmModal from './PreferenceSealConfirmModal';
import {
  MAX_REASON_CHARS,
  answersToBallot,
  ballotToAnswers,
  buildPairSchedule,
  pairAnswerError,
  remainingParts,
  scheduleProgress,
} from './preferencePairs.js';

type Viewport = 'desktop' | 'mobile';

const t = (key: string): string => i18nService.t(key);

const formatAt = (sec: number): string => new Date(sec * 1000).toLocaleString();

const formatRemaining = (seconds: number): string => {
  const parts = remainingParts(seconds);
  if (parts.kind === 'now') return t('preference.time.now');
  if (parts.kind === 'm') return t('preference.time.minutes').replace('{m}', String(parts.m));
  if (parts.kind === 'hm') {
    return t('preference.time.hoursMinutes').replace('{h}', String(parts.h)).replace('{m}', String(parts.m));
  }
  return t('preference.time.daysHours').replace('{d}', String(parts.d)).replace('{h}', String(parts.h));
};

const EMPTY_ANSWER: PreferencePairAnswer = { choice: null, reason: '', dims: {} };

const CHOICES: { choice: PreferenceChoice; label: string; short: string }[] = [
  { choice: 'left', label: 'preference.panel.pickLeft', short: 'preference.panel.left' },
  { choice: 'tie', label: 'preference.panel.pickTie', short: 'preference.panel.tieShort' },
  { choice: 'right', label: 'preference.panel.pickRight', short: 'preference.panel.right' },
];

const choiceClass = (active: boolean): string =>
  active
    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
    : 'border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]';

const CandidateFrame: React.FC<{
  label: string;
  artifact: string;
  preview: PreferencePreview | undefined;
  viewport: Viewport;
  onReload: () => void;
}> = ({ label, artifact, preview, viewport, onReload }) => (
  <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)]">
    <div className="flex items-center justify-between border-b border-[var(--border-color)] px-3 py-1.5 text-xs">
      <span className="font-semibold text-[var(--text-primary)]">{label}</span>
      <button
        type="button"
        onClick={onReload}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
      >
        <ArrowPathIcon className="h-3.5 w-3.5" />
        {t('preference.panel.reload')}
      </button>
    </div>
    <div className="flex min-h-0 flex-1 justify-center overflow-auto">
      {!preview && <div className="m-auto text-xs text-[var(--text-secondary)]">{t('preference.panel.loading')}</div>}
      {preview && 'error' in preview && (
        <div className="m-auto max-w-sm px-4 text-center text-xs text-[var(--text-secondary)]">
          {preview.error === 'unsupported'
            ? t('preference.panel.unsupportedArtifact').replace('{artifact}', artifact)
            : t('preference.panel.previewFailed').replace('{error}', preview.error)}
        </div>
      )}
      {preview && 'url' in preview && (
        <iframe
          key={preview.url}
          src={preview.url}
          title={label}
          sandbox="allow-scripts allow-same-origin allow-forms"
          className="h-full shrink-0 border-0"
          style={{ width: viewport === 'mobile' ? 390 : '100%' }}
        />
      )}
    </div>
  </section>
);

const RoundStatusView: React.FC<{ view: PreferenceHumanRoundView; nowSec: number }> = ({ view, nowSec }) => {
  const reason = !view.me.globalMetaId
    ? t('preference.panel.noIdentity')
    : !view.me.listed
      ? t('preference.panel.notJudge')
      : view.status === 'pending'
        ? t('preference.panel.notConfirmed')
        : view.status === 'collecting' && nowSec >= view.commitCutoffAt
          ? t('preference.panel.closed')
          : t(`preference.status.${view.status}`);
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">
      <div className="mx-auto max-w-2xl space-y-4">
        <p className="text-[var(--text-primary)]">{reason}</p>
        <p className="text-xs text-[var(--text-secondary)]">
          {t('preference.panel.windows')
            .replace('{commit}', formatAt(view.commitCloseAt))
            .replace('{reveal}', formatAt(view.revealCloseAt))}
        </p>
        {view.myBallots.length > 0 && (
          <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2">
            <div className="mb-1 text-xs font-medium">{t('preference.panel.myBallots')}</div>
            <ul className="space-y-1 text-xs text-[var(--text-secondary)]">
              {view.myBallots.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-[var(--text-primary)]">
                    {t(`preference.ballotStatus.${row.status}`)}
                  </span>
                  {row.commitPinId && <span className="select-all font-mono">{row.commitPinId}</span>}
                  {row.lastError && <span className="text-red-500">{row.lastError}</span>}
                </li>
              ))}
            </ul>
            {view.myBallots.some((row) => row.status === 'committed') && (
              <p className="mt-2 text-xs text-[var(--text-secondary)]">
                {t('preference.panel.revealHint').replace('{time}', formatAt(view.revealCloseAt))}
              </p>
            )}
          </section>
        )}
        {view.ranking.length > 0 && (
          <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-xs font-medium">
              <span>{t('preference.panel.ranking')}</span>
              {view.winner && (
                <span className="text-[var(--color-accent)]">{t('preference.panel.winner').replace('{id}', view.winner)}</span>
              )}
            </div>
            <ol className="space-y-0.5 text-xs text-[var(--text-secondary)]">
              {view.ranking.map((entry, position) => (
                <li key={entry.id} className="flex gap-3 font-mono">
                  <span className="w-5 text-right">{position + 1}</span>
                  <span className="w-10 text-[var(--text-primary)]">{entry.id}</span>
                  <span>
                    {entry.wins}-{entry.losses}-{entry.ties}
                  </span>
                  <span>C{entry.copeland}</span>
                  <span>P{entry.points}</span>
                </li>
              ))}
            </ol>
            {view.tallyHash && (
              <p className="mt-2 break-all font-mono text-[11px] text-[var(--text-secondary)]">
                {t('preference.panel.tallyHash')}: <span className="select-all">{view.tallyHash}</span>
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
};

interface PreferenceComparePanelProps {
  roundPinId: string;
  onClose: () => void;
}

const PreferenceComparePanel: React.FC<PreferenceComparePanelProps> = ({ roundPinId, onClose }) => {
  const [view, setView] = useState<PreferenceHumanRoundView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<PreferenceAnswers>({});
  const [note, setNote] = useState('');
  const [index, setIndex] = useState(0);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [previews, setPreviews] = useState<Record<string, PreferencePreview>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const restoredBallotId = useRef<string | null>(null);
  const previewsRef = useRef(previews);
  previewsRef.current = previews;

  const load = useCallback(async () => {
    try {
      setView(await preferenceService.roundStatus(roundPinId));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [roundPinId]);

  useEffect(() => {
    void load();
    const unsubscribe = preferenceService.subscribe(() => void load());
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [load]);

  const schedule = useMemo(
    () => (view ? buildPairSchedule(view.me.globalMetaId ?? '', view.pinId, view.candidates) : []),
    [view],
  );

  const latestBallot = view?.myBallots.find((row) => row.status !== 'commit_failed' && row.status !== 'superseded') ?? null;

  useEffect(() => {
    if (!latestBallot || schedule.length === 0 || restoredBallotId.current === latestBallot.id) return;
    restoredBallotId.current = latestBallot.id;
    setAnswers(ballotToAnswers(schedule, latestBallot.ballot));
    setNote(latestBallot.ballot.note ?? '');
  }, [latestBallot, schedule]);

  const judging = Boolean(view && view.me.listed && view.status === 'collecting' && nowSec < view.commitCutoffAt);
  const current = schedule.length > 0 ? schedule[Math.min(index, schedule.length - 1)] : null;
  const currentKey = current?.key ?? null;
  const currentLeft = current?.left ?? null;
  const currentRight = current?.right ?? null;

  const artifactOf = useCallback(
    (id: string): string => view?.candidates.find((candidate) => candidate.id === id)?.artifact ?? '',
    [view],
  );

  const ensurePreview = useCallback(
    async (id: string, force = false) => {
      const artifact = artifactOf(id);
      if (!artifact) return;
      if (!force && preferenceService.previewIsFresh(previewsRef.current[id])) return;
      const preview = await preferenceService.resolvePreview(artifact);
      setPreviews((prev) => ({ ...prev, [id]: preview }));
    },
    [artifactOf],
  );

  useEffect(() => {
    if (!judging || !currentLeft || !currentRight) return;
    void ensurePreview(currentLeft);
    void ensurePreview(currentRight);
  }, [judging, currentLeft, currentRight, ensurePreview]);

  useEffect(() => {
    if (!judging || !currentKey) return;
    const startedAt = Date.now();
    return () => {
      const seconds = Math.min(3600, Math.round((Date.now() - startedAt) / 1000));
      preferenceService.recordPairTime(roundPinId, currentKey, seconds);
    };
  }, [judging, roundPinId, currentKey]);

  const answer = currentKey ? answers[currentKey] ?? EMPTY_ANSWER : EMPTY_ANSWER;
  const answerError = pairAnswerError(answer);
  const progress = scheduleProgress(schedule, answers);

  const updateAnswer = (patch: Partial<PreferencePairAnswer>) => {
    if (!currentKey) return;
    setAnswers((prev) => ({ ...prev, [currentKey]: { ...(prev[currentKey] ?? EMPTY_ANSWER), ...patch } }));
  };

  const seal = async () => {
    if (!view) return;
    setSealing(true);
    setSealError(null);
    try {
      await preferenceService.commit(view.pinId, answersToBallot(schedule, answers, note));
      setConfirmOpen(false);
      await load();
    } catch (error) {
      setSealError(error instanceof Error ? error.message : String(error));
    } finally {
      setSealing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9000] flex flex-col bg-[var(--bg-main)] text-[var(--text-primary)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border-color)] px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{view?.title ?? t('preference.panel.loading')}</div>
          {view && (
            <div className="text-xs text-[var(--text-secondary)]">
              {t(`preference.status.${view.status}`)}
              {judging && ` · ${t('preference.panel.commitClosesIn').replace('{time}', formatRemaining(view.commitCutoffAt - nowSec))}`}
              {judging &&
                current &&
                ` · ${t('preference.panel.pairProgress')
                  .replace('{index}', String(Math.min(index, schedule.length - 1) + 1))
                  .replace('{total}', String(schedule.length))}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {judging && (
            <div className="flex overflow-hidden rounded-lg border border-[var(--border-color)] text-xs">
              {(['desktop', 'mobile'] as Viewport[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setViewport(option)}
                  className={`px-2.5 py-1 ${viewport === option ? 'bg-[var(--bg-hover)] text-[var(--color-accent)]' : 'text-[var(--text-secondary)]'}`}
                >
                  {t(`preference.panel.${option}`)}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('preference.panel.close')}
            className="rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
      </header>

      {loadError && (
        <div className="mx-4 mt-3 rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-500">
          {t('preference.error.generic').replace('{error}', loadError)}
        </div>
      )}

      {view && !judging && <RoundStatusView view={view} nowSec={nowSec} />}

      {view && judging && schedule.length === 0 && (
        <p className="px-4 py-6 text-sm text-[var(--text-secondary)]">{t('preference.panel.nothingToJudge')}</p>
      )}

      {view && judging && current && (
        <>
          <details className="mx-4 mt-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium">{t('preference.panel.brief')}</summary>
            {view.brief && <p className="mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{view.brief}</p>}
            {view.tasks.length > 0 && (
              <>
                <div className="mt-2 font-medium">{t('preference.panel.tasks')}</div>
                <ul className="mt-1 list-disc pl-4 text-[var(--text-secondary)]">
                  {view.tasks.map((task) => (
                    <li key={task}>{task}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-2 text-[var(--text-secondary)]">{t('preference.panel.blindNote')}</p>
          </details>

          {latestBallot?.commitPinId && (
            <p className="mx-4 mt-2 text-xs text-[var(--text-secondary)]">
              {t('preference.panel.alreadySealed')
                .replace('{pin}', latestBallot.commitPinId)
                .replace('{time}', formatAt(view.commitCutoffAt))}
            </p>
          )}

          <div className="flex min-h-0 flex-1 gap-3 px-4 py-3">
            <CandidateFrame
              label={t('preference.panel.left')}
              artifact={artifactOf(current.left)}
              preview={previews[current.left]}
              viewport={viewport}
              onReload={() => void ensurePreview(current.left, true)}
            />
            <CandidateFrame
              label={t('preference.panel.right')}
              artifact={artifactOf(current.right)}
              preview={previews[current.right]}
              viewport={viewport}
              onReload={() => void ensurePreview(current.right, true)}
            />
          </div>

          <footer className="space-y-2 border-t border-[var(--border-color)] px-4 py-3">
            <div className="flex flex-wrap gap-2">
              {CHOICES.map((entry) => (
                <button
                  key={entry.choice}
                  type="button"
                  onClick={() => updateAnswer({ choice: entry.choice })}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${choiceClass(answer.choice === entry.choice)}`}
                >
                  {t(entry.label)}
                </button>
              ))}
            </div>
            <label className="block text-xs text-[var(--text-secondary)]">
              {t('preference.panel.reasonLabel')}
              <textarea
                value={answer.reason}
                maxLength={MAX_REASON_CHARS * 2}
                rows={2}
                onChange={(event) => updateAnswer({ reason: event.target.value })}
                placeholder={t('preference.panel.reasonPlaceholder')}
                className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-panel)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
              />
            </label>
            {answerError === 'reason-too-long' && (
              <p className="text-xs text-red-500">{t('preference.panel.reasonTooLong')}</p>
            )}
            {view.dimensions.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs text-[var(--text-secondary)]">{t('preference.panel.dimensions')}</div>
                {view.dimensions.map((dimension) => (
                  <div key={dimension.id} className="flex items-center gap-2 text-xs">
                    <span className="w-40 truncate">{dimension.label}</span>
                    {CHOICES.map((entry) => (
                      <button
                        key={entry.choice}
                        type="button"
                        onClick={() => updateAnswer({ dims: { ...answer.dims, [dimension.id]: entry.choice } })}
                        className={`rounded border px-2 py-0.5 ${choiceClass(answer.dims[dimension.id] === entry.choice)}`}
                      >
                        {t(entry.short)}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {progress.complete && (
              <label className="block text-xs text-[var(--text-secondary)]">
                {t('preference.panel.note')}
                <textarea
                  value={note}
                  maxLength={2000}
                  rows={1}
                  onChange={(event) => setNote(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-panel)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
                />
              </label>
            )}
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => setIndex((value) => Math.max(0, value - 1))}
                  className="rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  {t('preference.panel.prev')}
                </button>
                <button
                  type="button"
                  disabled={index >= schedule.length - 1}
                  onClick={() => setIndex((value) => Math.min(schedule.length - 1, value + 1))}
                  className="rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  {t('preference.panel.next')}
                </button>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-secondary)]">
                  {progress.done}/{progress.total}
                </span>
                <button
                  type="button"
                  disabled={!progress.complete}
                  onClick={() => {
                    setSealError(null);
                    setConfirmOpen(true);
                  }}
                  className="btn-idchat-primary-filled rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                >
                  {t('preference.panel.review')}
                </button>
              </div>
            </div>
          </footer>
        </>
      )}

      {confirmOpen && view && (
        <PreferenceSealConfirmModal
          pairCount={progress.total}
          commitCloseAt={view.commitCloseAt}
          revealCloseAt={view.revealCloseAt}
          sealing={sealing}
          error={sealError}
          onConfirm={() => void seal()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
};

export default PreferenceComparePanel;
```

(`maxLength` on the reason box is a UTF-16 guard only; the 1000 code-point rule is enforced by `pairAnswerError`, the progress gate, and again by the main-process `checkBallot`.)

- [ ] **Step 3: Verify and commit**

Run: `pnpm run build && pnpm run lint`
Expected: 0 errors.

```bash
git add src/renderer/components/preference/PreferenceSealConfirmModal.tsx src/renderer/components/preference/PreferenceComparePanel.tsx
git commit -m "feat: add blind preference compare panel"
```

---

### Task 6: Entry points — board section and task buttons

**Files:**
- Create: `src/renderer/components/preference/PreferenceRoundsSection.tsx`
- Modify: `src/renderer/components/metatask/MetaTaskBoard.tsx`, `src/renderer/components/metatask/MetaTaskDetail.tsx`

- [ ] **Step 1: Write `PreferenceRoundsSection.tsx`**

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { ScaleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { preferenceService } from '../../services/preference';
import type { PreferenceUserRoundSummary } from '../../types/preference';
import PreferenceComparePanel from './PreferenceComparePanel';

const t = (key: string): string => i18nService.t(key);

const formatAt = (sec: number): string => new Date(sec * 1000).toLocaleString();

const canJudge = (round: PreferenceUserRoundSummary, nowSec: number): boolean =>
  round.myKind !== null && round.status === 'collecting' && nowSec < round.commitCutoffAt;

const useRounds = (filter: { mine?: boolean; taskid?: string }) => {
  const [rounds, setRounds] = useState<PreferenceUserRoundSummary[]>([]);
  const { mine, taskid } = filter;
  const load = useCallback(async () => {
    try {
      setRounds((await preferenceService.listRounds({ mine, taskid })).rounds);
    } catch (error) {
      console.warn('[preference] listRounds failed', error);
      setRounds([]);
    }
  }, [mine, taskid]);
  useEffect(() => {
    void load();
    return preferenceService.subscribe(() => void load());
  }, [load]);
  return rounds;
};

/** "Preference rounds" on the MetaTask board: rounds that list the user as a judge. */
const PreferenceRoundsSection: React.FC = () => {
  const rounds = useRounds({ mine: true });
  const [openRound, setOpenRound] = useState<string | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);
  return (
    <>
      {rounds.length > 0 && (
        <section className="mb-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
            <ScaleIcon className="h-4 w-4 text-[var(--color-accent)]" />
            {t('preference.rounds.title')}
          </div>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{t('preference.rounds.subtitle')}</p>
          <ul className="mt-2 space-y-1.5">
            {rounds.map((round) => (
              <li key={round.pinId} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm text-[var(--text-primary)]">{round.title}</div>
                  <div className="text-xs text-[var(--text-secondary)]">
                    {t(`preference.status.${round.status}`)}
                    {round.status === 'collecting' &&
                      ` · ${t('preference.rounds.closesAt').replace('{time}', formatAt(round.commitCutoffAt))}`}
                    {round.myBallotStatus &&
                      ` · ${t('preference.rounds.myBallot').replace('{status}', t(`preference.ballotStatus.${round.myBallotStatus}`))}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenRound(round.pinId)}
                  className={
                    canJudge(round, nowSec)
                      ? 'btn-idchat-primary-filled shrink-0 rounded-lg px-3 py-1 text-xs font-medium'
                      : 'shrink-0 rounded-lg border border-[var(--border-color)] px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }
                >
                  {canJudge(round, nowSec) ? t('preference.rounds.judge') : t('preference.rounds.view')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {openRound && <PreferenceComparePanel roundPinId={openRound} onClose={() => setOpenRound(null)} />}
    </>
  );
};

/** Round buttons on a MetaTask detail page (rounds whose subject is this task). */
export const PreferenceTaskRoundButtons: React.FC<{ rootPinId: string }> = ({ rootPinId }) => {
  const rounds = useRounds({ taskid: rootPinId });
  const [openRound, setOpenRound] = useState<string | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);
  if (rounds.length === 0) return null;
  return (
    <>
      {rounds.slice(0, 2).map((round) => (
        <button
          key={round.pinId}
          type="button"
          onClick={() => setOpenRound(round.pinId)}
          className={
            canJudge(round, nowSec)
              ? 'btn-idchat-primary-filled inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium'
              : 'inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }
        >
          <ScaleIcon className="h-4 w-4" />
          {canJudge(round, nowSec)
            ? t('preference.detail.judgeRound')
            : t('preference.detail.viewRound').replace('{status}', t(`preference.status.${round.status}`))}
        </button>
      ))}
      {openRound && <PreferenceComparePanel roundPinId={openRound} onClose={() => setOpenRound(null)} />}
    </>
  );
};

export default PreferenceRoundsSection;
```

- [ ] **Step 2: Mount on the board**

In `MetaTaskBoard.tsx` add the import:

```tsx
import PreferenceRoundsSection from '../preference/PreferenceRoundsSection';
```

and make it the first child of the task-card scroll container (`<div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">`, ~line 217):

```tsx
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <PreferenceRoundsSection />
        {loading && !board ? (
```

- [ ] **Step 3: Mount on the detail page**

In `MetaTaskDetail.tsx` add the import:

```tsx
import { PreferenceTaskRoundButtons } from '../preference/PreferenceRoundsSection';
```

Wrap the existing participate button (the `{!detail.taskComplete && ( <button … participateNow … ) }` block, ~line 353) together with the new buttons:

```tsx
          <div className="flex shrink-0 items-center gap-2">
            <PreferenceTaskRoundButtons rootPinId={detail.rootPinId} />
            {!detail.taskComplete && (
              <button
                type="button"
                onClick={() => participateDraft(detail.title, detail.rootPinId, openNodes[0]?.id ?? null, isCompetitive)}
                className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg btn-idchat-primary-filled"
              >
                <BoltIcon className="h-4 w-4" />
                {i18nService.t('metatask.participateNow')}
              </button>
            )}
          </div>
```

(The rounds stay reachable after the task completes, so the buttons sit outside the `taskComplete` guard.)

- [ ] **Step 4: Verify and commit**

Run: `pnpm run build && pnpm run lint`
Expected: 0 errors.

```bash
git add src/renderer/components/preference/PreferenceRoundsSection.tsx src/renderer/components/metatask/MetaTaskBoard.tsx src/renderer/components/metatask/MetaTaskDetail.tsx
git commit -m "feat: add preference round entry points to the MetaTask tab"
```

---

### Task 7: Static UI checks and the test script

**Files:**
- Create: `tests/preferenceUiStatic.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write `tests/preferenceUiStatic.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const componentDir = path.join(repoRoot, 'src/renderer/components/preference');
const components = fs
  .readdirSync(componentDir)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(componentDir, name), 'utf8') }));

const i18n = fs.readFileSync(path.join(repoRoot, 'src/renderer/services/i18n.ts'), 'utf8');
const enStart = i18n.indexOf('\n  en: {');
const zhBlock = i18n.slice(0, enStart);
const enBlock = i18n.slice(enStart);

const STATUS_KEYS = ['collecting', 'revealing', 'settling', 'decided', 'no_decision', 'pending'].map(
  (status) => `preference.status.${status}`,
);
const BALLOT_KEYS = ['committing', 'committed', 'commit_failed', 'superseded', 'revealed', 'reveal_failed', 'expired'].map(
  (status) => `preference.ballotStatus.${status}`,
);

test('every preference key used by the components exists in zh and en', () => {
  const used = new Set([...STATUS_KEYS, ...BALLOT_KEYS, 'preference.panel.desktop', 'preference.panel.mobile']);
  for (const { text } of components) {
    for (const match of text.matchAll(/'(preference\.[a-zA-Z_.]+)'/g)) used.add(match[1]);
  }
  assert.ok(used.size > 40);
  for (const key of used) {
    assert.ok(zhBlock.includes(`'${key}':`), `zh missing ${key}`);
    assert.ok(enBlock.includes(`'${key}':`), `en missing ${key}`);
  }
});

test('preference components follow the theme and privacy rules', () => {
  assert.ok(components.length >= 3);
  for (const { name, text } of components) {
    assert.equal(/\bdark:/.test(text), false, `${name} uses dark: utilities`);
    assert.equal(/window\.(confirm|alert)\(/.test(text), false, `${name} uses window.confirm/alert`);
    assert.equal(/\.author\b|ownerGlobalMetaId/.test(text), false, `${name} renders builder identity`);
    assert.equal(/allow-popups|allow-top-navigation/.test(text), false, `${name} loosens the iframe sandbox`);
  }
});
```

- [ ] **Step 2: Run it**

Run: `node --test tests/preferenceUiStatic.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 3: Append the three test files to `test:preference`**

Add `tests/preferenceIpc.test.mjs tests/preferencePairs.test.mjs tests/preferenceUiStatic.test.mjs` to the `node --test` file list of `test:preference` (keep any files P3 added if it merged first).

Run: `pnpm run test:preference`
Expected: all green, then `ALL VECTORS PASS`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git add -f tests/preferenceUiStatic.test.mjs
git commit -m "chore: add preference UI tests to test:preference"
```

---

### Task 8: Manual verification and the second mainnet round

This task spends real fees and takes about 7 hours of wall time. It changes no code unless it finds a bug; a bug fix gets its own `fix:` commit with a regression test.

**Setup:** the local user identity exists and has a small MVC balance (subsidy claimed); two existing MetaApp pins NOT authored by the user identity; `pnpm run electron:dev` running from this worktree for the whole task.

- [ ] **Step 1: Open the round**

This step needs P3's `preference_round_open`. If P3 is not merged yet, hand back after Task 7 with Task 8 marked pending; after P3 merges, rebase this branch onto `main` and run Task 8.

Ask any local bot to call `preference_round_open` with explicit candidates (the two apps), `judges: [{ globalMetaId: "<user globalMetaId>", kind: "human" }]`, `decisionKinds: ["human"]`, `minBallots: 1`, `category: ["test:preference-smoke"]`, `tasks: ["Find the newest item and open it."]`, `dimensions: [{ id: "visual", label: "Visual quality" }]`, `commitHours: 2`, `revealHours: 2`.

- [ ] **Step 2: Judge in the panel**

MetaTask tab → "Preference rounds" shows the round after confirmation. Click Judge. Check:
- both candidates load side by side; Desktop / Mobile 390px changes the frame width; Reload works;
- no builder identity anywhere in the panel;
- "Review and seal" stays disabled until the pair has a choice and a reason;
- the modal shows both times; Cancel closes it without a write; Seal shows the commit pinId banner;
- closing and reopening the panel restores your answers.

- [ ] **Step 3: Themes and languages**

Screenshot the panel and the modal in light and dark theme, and in English and Chinese. Attach the four screenshots to the handoff.

- [ ] **Step 4: Reveal and tally**

Keep the app running. After commit close + 30 min + one heartbeat + confirmation, the panel's status view shows your ballot as Revealed. After `revealCloseAt + 7200` s it shows Decided, the ranking, the winner, and the tally hash.

- [ ] **Step 5: Record**

Put in the handoff: round pinId, commit and reveal pinIds, tally hash, timestamps, screenshots, and anything that looked wrong.

---

## Phase handoff checklist

- [ ] `pnpm run compile:electron` — 0 errors
- [ ] `pnpm run build` — 0 errors (renderer type check)
- [ ] `pnpm run build:skills` — 0 errors
- [ ] `pnpm run lint` — 0 errors / warnings
- [ ] `node --test tests/*.test.mjs` — all pass
- [ ] `pnpm run test:preference` — all pass, `ALL VECTORS PASS`
- [ ] Task 8 pinIds and screenshots recorded
- [ ] Handoff note per the overview format; do not merge, push, or remove the worktree
