# Preference Loop P2 — Chain I/O, Ballot Store, Auto-Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the P1 engine to the chain: collect the four preference pools, cache events, keep sealed ballots (with salts) durably, publish round / commit / reveal / lesson pins as a MetaBot or as the local human identity, and auto-reveal every local ballot after the commit window closes.

**Architecture:** `collector.ts` walks the pools with the existing `fetchProtocolPinsFromIndexer` and reuses the MetaTask collector's truncated-body recovery. `PreferenceStore` owns three tables (event cache, sealed ballots, compare telemetry). `PreferenceService` is the single façade the agent tools (P3) and IPC (P4) call; it tallies on read with the P1 engine and depends only on injected `collect` / `resolveWriter` functions, so it is fully testable with fakes. `main.ts` injects the real writers and registers a heartbeat job.

**Tech Stack:** TypeScript main process, `SqliteDatabase` (`src/main/sqliteTypes.ts`), `node:test` with `SqliteStore.create(tmpdir)`.

**Index / acceptance gate:** `docs/superpowers/plans/2026-10-14-preference-loop-00-overview.md` (P2 gate). **Normative spec:** `docs/metaid_protocols/09-preference.md`. **Prerequisite:** P1 merged into `main`.

## Global Constraints

- `docs/metaid_protocols/09-preference.md` (v1.0.0) is normative. On any conflict, stop and report it to the planner.
- Node `>=24 <25`; pnpm only; never `npm install` / `npm ci`; run scripts as `pnpm run <script>`.
- Branch `feat/preference-p2-chain-io`, worktree `.worktrees/preference-p2-chain-io`, created from `main`. Never push, never merge.
- `tests/` is gitignored: stage test files with `git add -f`.
- Strong typing, no `any`; 2-space indent, single quotes, semicolons; English comments only where the code cannot show a constraint.
- New tables only, created with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` on every start. `preference_ballots` holds user data (salts): never delete rows from it, never reset it.
- Salts never leave the main process before reveal: no IPC or tool view type may contain `salt`.
- Modules imported by tests must not import `electron` at runtime. `metaidCore.ts` and `feeRateStore.ts` do, so `userWriter.ts` imports them as types only and receives functions by injection.
- One commit per task, `<type>: <short description>`. Before each commit: the task's tests, `pnpm run compile:electron` (0 errors), `pnpm run lint` (0 errors/warnings). After each commit: an English dev-journal buzz with Codex's `metabot-post-buzz` skill.
- Phase handoff: `pnpm run compile:electron`, `pnpm run build:skills`, `pnpm run lint`, `node --test tests/*.test.mjs`, `pnpm run test:preference`, `pnpm run test:metatask` all green.

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/services/metatask/collector.ts` | Modify: export `contentRecoveryUrl` and `recoverTruncatedBodies` (widened parameter type, no behavior change) |
| `src/main/services/preference/collector.ts` | `collectPreferenceEvents()` over the four pools with one retry per pool and body recovery |
| `src/main/services/preference/store.ts` | `PreferenceStore`: tables, event cache, ballot lifecycle, telemetry, salt-free views |
| `src/main/services/preference/service.ts` | `PreferenceService`: refresh, list/status/canonical/search, open/commit/lesson writes, auto-reveal |
| `src/main/services/preference/userWriter.ts` | `createUserPreferenceWriter()`: human identity writer, serialized, UTXO threading, subsidy gate |
| `src/main/main.ts` | Getters, bot writer, heartbeat `preference.reveal` |
| `tests/preferenceCollector.test.mjs` | Collector tests with a fake indexer |
| `tests/preferenceStore.test.mjs` | Store tests |
| `tests/preferenceService.test.mjs` | Service tests (read, write, reveal) |
| `tests/preferenceUserWriter.test.mjs` | Human writer tests |
| `package.json` | Append the four test files to `test:preference` |

---

### Task 0: Worktree

- [ ] **Step 1: Create the worktree from `main`**

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots
git worktree add .worktrees/preference-p2-chain-io -b feat/preference-p2-chain-io main
git config extensions.worktreeConfig true
git -C .worktrees/preference-p2-chain-io config --worktree core.filemode false
cd .worktrees/preference-p2-chain-io
pnpm install
test -f src/main/services/preference/engine.ts && echo "P1 present"
```

Expected: `P1 present`. Otherwise stop: P1 is not merged yet.

---

### Task 1: Collector

**Files:**
- Modify: `src/main/services/metatask/collector.ts:108` and `:152`
- Create: `src/main/services/preference/collector.ts`
- Test: `tests/preferenceCollector.test.mjs`

**Interfaces:**
- Consumes: `fetchProtocolPinsFromIndexer`, `ProtocolPinRecord` (`src/main/services/protocolPinFetch.ts`); `normalizeChainEvent` (`src/main/services/metatask/collector.ts`); `PREFERENCE_SEGMENTS`, `preferencePoolPath`, `PreferenceSegment`, `PreferenceChainEvent` (P1).
- Produces:
  - `interface CollectPreferenceEventsOptions { fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>; pageSize?: number; maxPages?: number; timeoutMs?: number }`
  - `interface CollectPreferenceEventsResult { events: PreferenceChainEvent[]; perPath: { segment: PreferenceSegment; count: number; error?: string }[] }`
  - `collectPreferenceEvents(options?: CollectPreferenceEventsOptions): Promise<CollectPreferenceEventsResult>`

- [ ] **Step 1: Export the two recovery helpers from the MetaTask collector**

In `src/main/services/metatask/collector.ts`, change line 108 from `const contentRecoveryUrl = (` to:

```ts
export const contentRecoveryUrl = (
```

and replace lines 152–155:

```ts
const recoverTruncatedBodies = async (
  pending: { event: MetaTaskChainEvent; url: string }[],
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
): Promise<void> => {
```

with:

```ts
export const recoverTruncatedBodies = async (
  pending: { event: { body: Record<string, unknown> }; url: string }[],
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
): Promise<void> => {
```

Run: `pnpm run test:metatask`
Expected: PASS, unchanged (the parameter type only widened structurally).

- [ ] **Step 2: Write the failing collector test**

Create `tests/preferenceCollector.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { H1, pid } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { collectPreferenceEvents } = require('../dist-electron/main/services/preference/collector.js');

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const row = (id, segment, body, over = {}) => ({
  id,
  path: `/protocols/preference/${segment}`,
  globalMetaId: H1,
  genesisHeight: 200_500,
  txIndex: 0,
  timestamp: 1_792_000_100,
  contentBody: b64(body),
  ...over,
});
const FULL_REVEAL = { round: pid(1), commit: pid(2), salt: 'b'.repeat(64), ballot: { pairs: [] } };

const fakeIndexer = (pools, failing = new Set()) => (url) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/pin/path/list')) {
    const poolPath = parsed.searchParams.get('path');
    if (failing.has(poolPath)) return Promise.resolve(new Response('boom', { status: 500 }));
    const list = pools[poolPath] ?? [];
    const first = !parsed.searchParams.get('cursor');
    return Promise.resolve(new Response(JSON.stringify({ data: { list: first ? list : [], nextCursor: '', total: list.length } })));
  }
  if (parsed.pathname === `/content/${pid(3)}`) return Promise.resolve(new Response(JSON.stringify(FULL_REVEAL)));
  return Promise.resolve(new Response('not found', { status: 404 }));
};

const POOLS = {
  '/protocols/preference/round': [
    row(pid(1), 'round', { title: 'r' }),
    row(pid(9), 'round', { title: 'modified' }, { path: `@${pid(1)}` }),
  ],
  '/protocols/preference/commit': [row(pid(2), 'commit', { round: pid(1), hash: 'a'.repeat(64) })],
  '/protocols/preference/reveal': [
    row(pid(3), 'reveal', {}, {
      contentBody: '',
      contentSummary: '{"round":"',
      content: `https://manapi.metaid.io/content/${pid(3)}`,
      contentLength: '5000',
    }),
  ],
  '/protocols/preference/lesson': [],
};

test('collects the four pools, normalizes rows, and recovers truncated bodies', async () => {
  const result = await collectPreferenceEvents({ fetchImpl: fakeIndexer(POOLS), timeoutMs: 1000 });
  assert.deepEqual(result.perPath.map((entry) => [entry.segment, entry.count]), [
    ['round', 1],
    ['commit', 1],
    ['reveal', 1],
    ['lesson', 0],
  ]);
  assert.deepEqual(result.events.map((event) => event.path), ['round', 'commit', 'reveal']);
  const reveal = result.events.find((event) => event.path === 'reveal');
  assert.deepEqual(reveal.body, FULL_REVEAL);
  assert.equal(reveal.author, H1);
  assert.equal(reveal.height, 200_500);
  assert.equal(reveal.timestampMs, 1_792_000_100_000);
});

test('a failing pool is reported and does not sink the other pools', async () => {
  const failing = new Set(['/protocols/preference/lesson']);
  const result = await collectPreferenceEvents({ fetchImpl: fakeIndexer(POOLS, failing), timeoutMs: 1000 });
  assert.equal(result.events.length, 3);
  const lesson = result.perPath.find((entry) => entry.segment === 'lesson');
  assert.equal(typeof lesson.error, 'string');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/preferenceCollector.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/collector.js'`.

- [ ] **Step 4: Write `src/main/services/preference/collector.ts`**

```ts
import { contentRecoveryUrl, normalizeChainEvent, recoverTruncatedBodies } from '../metatask/collector';
import { fetchProtocolPinsFromIndexer, type ProtocolPinRecord } from '../protocolPinFetch';
import { PREFERENCE_SEGMENTS, preferencePoolPath, type PreferenceSegment } from './constants';
import type { PreferenceChainEvent } from './types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CollectPreferenceEventsOptions {
  fetchImpl?: FetchLike;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
}

export interface CollectPreferenceEventsResult {
  events: PreferenceChainEvent[];
  perPath: { segment: PreferenceSegment; count: number; error?: string }[];
}

const keepRaw = (item: Record<string, unknown>): unknown => item;

async function walkPool(
  segment: PreferenceSegment,
  options: CollectPreferenceEventsOptions,
): Promise<{ pins: ProtocolPinRecord[]; error?: string }> {
  let error: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let failed = false;
    try {
      const pins = await fetchProtocolPinsFromIndexer(preferencePoolPath(segment), {
        pageSize: options.pageSize ?? 100,
        maxPages: options.maxPages ?? 1000,
        timeoutMs: options.timeoutMs ?? 8_000,
        fetchImpl: options.fetchImpl,
        selectContent: keepRaw,
        onTruncated: (info) => {
          if (info.reason === 'fetch-error') failed = true;
        },
      });
      if (!failed) return { pins };
      error = 'page walk aborted mid-pool (fetch error)';
      if (attempt === 1) return { pins, error };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return { pins: [], error };
}

export async function collectPreferenceEvents(
  options: CollectPreferenceEventsOptions = {},
): Promise<CollectPreferenceEventsResult> {
  const events: PreferenceChainEvent[] = [];
  const perPath: CollectPreferenceEventsResult['perPath'] = [];
  const pending: { event: PreferenceChainEvent; url: string }[] = [];
  for (const segment of PREFERENCE_SEGMENTS) {
    const { pins, error } = await walkPool(segment, options);
    let count = 0;
    for (const pin of pins) {
      const rawItem = (pin.content && typeof pin.content === 'object' ? pin.content : {}) as Record<string, unknown>;
      const normalized = normalizeChainEvent(pin.pinId, rawItem, pin.timestampMs ?? null);
      if (!normalized || String(normalized.path) !== segment) continue;
      const event: PreferenceChainEvent = { ...normalized, path: segment };
      events.push(event);
      const url = contentRecoveryUrl(rawItem, event.body);
      if (url) pending.push({ event, url });
      count += 1;
    }
    perPath.push({ segment, count, ...(error ? { error } : {}) });
  }
  await recoverTruncatedBodies(pending, options.fetchImpl);
  return { events, perPath };
}
```

`normalizeChainEvent` keeps only the last path segment, so `modify` pins (path `@<pinId>`) never match a segment and are dropped, as protocol §0 requires.

- [ ] **Step 5: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceCollector.test.mjs && pnpm run test:metatask`
Expected: PASS (2 tests) and the MetaTask suite unchanged.

- [ ] **Step 6: Lint and commit**

```bash
pnpm run lint
git add src/main/services/metatask/collector.ts src/main/services/preference/collector.ts
git add -f tests/preferenceCollector.test.mjs
git commit -m "feat: add preference pool collector"
```

---

### Task 2: Store

**Files:**
- Create: `src/main/services/preference/store.ts`
- Test: `tests/preferenceStore.test.mjs`

**Interfaces:**
- Consumes: `SqliteDatabase` (`src/main/sqliteTypes.ts`); `PREFERENCE_SEGMENTS`, `PreferenceSegment`, `Ballot`, `PreferenceChainEvent` (P1).
- Produces:
  - `type PreferenceBallotStatus = 'committing' | 'committed' | 'commit_failed' | 'superseded' | 'revealed' | 'reveal_failed' | 'expired'`
  - `const MAX_REVEAL_ATTEMPTS = 5`
  - `interface PreferenceBallotRow { id; roundPinId; signerType: 'user' | 'metabot'; metabotId: number | null; judgeGlobalMetaId; ballot: Ballot; salt; commitHash; commitPinId: string | null; revealPinId: string | null; status: PreferenceBallotStatus; lastError: string | null; revealAttempts: number; commitCloseAt: number; revealCloseAt: number; createdAtMs: number; updatedAtMs: number }`
  - `type PreferenceBallotView = Omit<PreferenceBallotRow, 'salt'>` and `toBallotView(row): PreferenceBallotView`
  - `interface NewBallotInput { roundPinId; signerType; metabotId: number | null; judgeGlobalMetaId; ballot: Ballot; salt; commitHash; commitCloseAt; revealCloseAt; nowMs }`
  - `class PreferenceStore(db, saveDb)` with `upsertEvents(events, nowMs)`, `loadEvents()`, `insertBallot(input)`, `getBallot(id)`, `listBallots(filter?: { roundPinId?: string; statuses?: PreferenceBallotStatus[] })`, `markCommitted(id, commitPinId, nowMs)`, `markCommitFailed(id, error, nowMs)`, `markRevealed(id, revealPinId, nowMs)`, `markRevealRetry(id, nowMs)`, `markRevealFailed(id, error, nowMs): PreferenceBallotStatus`, `expireStale(nowSec, nowMs): number`, `countActive(nowSec): number`, `recordTelemetry(roundPinId, pairKey, seconds, nowMs)`, `telemetryForRound(roundPinId): { pairKey: string; seconds: number }[]`.

The tables carry no `CHECK` constraints on `status`, so later phases can add a status without rebuilding the table.

- [ ] **Step 1: Write the failing store test**

Create `tests/preferenceStore.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/preferenceStore.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/store.js'`.

- [ ] **Step 3: Write `src/main/services/preference/store.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { SqliteDatabase as Database } from '../../sqliteTypes';
import { PREFERENCE_SEGMENTS, type PreferenceSegment } from './constants';
import type { Ballot, PreferenceChainEvent } from './types';

interface Row {
  [column: string]: unknown;
}

export type PreferenceBallotStatus =
  | 'committing'
  | 'committed'
  | 'commit_failed'
  | 'superseded'
  | 'revealed'
  | 'reveal_failed'
  | 'expired';

export const MAX_REVEAL_ATTEMPTS = 5;

export interface PreferenceBallotRow {
  id: string;
  roundPinId: string;
  signerType: 'user' | 'metabot';
  metabotId: number | null;
  judgeGlobalMetaId: string;
  ballot: Ballot;
  salt: string;
  commitHash: string;
  commitPinId: string | null;
  revealPinId: string | null;
  status: PreferenceBallotStatus;
  lastError: string | null;
  revealAttempts: number;
  commitCloseAt: number;
  revealCloseAt: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type PreferenceBallotView = Omit<PreferenceBallotRow, 'salt'>;

export interface NewBallotInput {
  roundPinId: string;
  signerType: 'user' | 'metabot';
  metabotId: number | null;
  judgeGlobalMetaId: string;
  ballot: Ballot;
  salt: string;
  commitHash: string;
  commitCloseAt: number;
  revealCloseAt: number;
  nowMs: number;
}

export const toBallotView = (row: PreferenceBallotRow): PreferenceBallotView => ({
  id: row.id,
  roundPinId: row.roundPinId,
  signerType: row.signerType,
  metabotId: row.metabotId,
  judgeGlobalMetaId: row.judgeGlobalMetaId,
  ballot: row.ballot,
  commitHash: row.commitHash,
  commitPinId: row.commitPinId,
  revealPinId: row.revealPinId,
  status: row.status,
  lastError: row.lastError,
  revealAttempts: row.revealAttempts,
  commitCloseAt: row.commitCloseAt,
  revealCloseAt: row.revealCloseAt,
  createdAtMs: row.createdAtMs,
  updatedAtMs: row.updatedAtMs,
});

const parseObject = (raw: unknown): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const nullableString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const BALLOT_COLUMNS = `id, round_pin_id, signer_type, metabot_id, judge_global_metaid, ballot_json, salt, commit_hash,
  commit_pin_id, reveal_pin_id, status, last_error, reveal_attempts, commit_close_at, reveal_close_at, created_at, updated_at`;

const toBallotRow = (row: Row): PreferenceBallotRow => ({
  id: String(row.id),
  roundPinId: String(row.round_pin_id),
  signerType: row.signer_type === 'metabot' ? 'metabot' : 'user',
  metabotId: row.metabot_id === null || row.metabot_id === undefined ? null : Number(row.metabot_id),
  judgeGlobalMetaId: String(row.judge_global_metaid),
  ballot: parseObject(row.ballot_json) as unknown as Ballot,
  salt: String(row.salt),
  commitHash: String(row.commit_hash),
  commitPinId: nullableString(row.commit_pin_id),
  revealPinId: nullableString(row.reveal_pin_id),
  status: String(row.status) as PreferenceBallotStatus,
  lastError: nullableString(row.last_error),
  revealAttempts: Number(row.reveal_attempts),
  commitCloseAt: Number(row.commit_close_at),
  revealCloseAt: Number(row.reveal_close_at),
  createdAtMs: Number(row.created_at),
  updatedAtMs: Number(row.updated_at),
});

export class PreferenceStore {
  private readonly db: Database;
  private readonly saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS preference_events (
        pin_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        author TEXT NOT NULL,
        height INTEGER NOT NULL,
        tx_index INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_preference_events_path ON preference_events(path);');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS preference_ballots (
        id TEXT PRIMARY KEY,
        round_pin_id TEXT NOT NULL,
        signer_type TEXT NOT NULL,
        metabot_id INTEGER,
        judge_global_metaid TEXT NOT NULL,
        ballot_json TEXT NOT NULL,
        salt TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        commit_pin_id TEXT,
        reveal_pin_id TEXT,
        status TEXT NOT NULL,
        last_error TEXT,
        reveal_attempts INTEGER NOT NULL DEFAULT 0,
        commit_close_at INTEGER NOT NULL,
        reveal_close_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_preference_ballots_round ON preference_ballots(round_pin_id, judge_global_metaid);');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_preference_ballots_status ON preference_ballots(status);');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS preference_compare_telemetry (
        round_pin_id TEXT NOT NULL,
        pair_key TEXT NOT NULL,
        seconds INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (round_pin_id, pair_key)
      );
    `);
  }

  private all(sql: string, params: unknown[] = []): Row[] {
    const [first] = this.db.exec(sql, params);
    if (!first) return [];
    return first.values.map((values) => {
      const row: Row = {};
      first.columns.forEach((column, index) => {
        row[column] = values[index];
      });
      return row;
    });
  }

  private write(sql: string, params: unknown[]): void {
    this.db.run(sql, params);
    this.saveDb();
  }

  upsertEvents(events: readonly PreferenceChainEvent[], nowMs: number): void {
    if (events.length === 0) return;
    this.db.run('BEGIN TRANSACTION;');
    try {
      for (const event of events) {
        this.db.run(
          `INSERT INTO preference_events (pin_id, path, author, height, tx_index, timestamp_ms, body_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pin_id) DO UPDATE SET
             path = excluded.path,
             author = excluded.author,
             height = excluded.height,
             tx_index = excluded.tx_index,
             timestamp_ms = excluded.timestamp_ms,
             body_json = CASE WHEN excluded.body_json = '{}' THEN preference_events.body_json ELSE excluded.body_json END,
             updated_at = excluded.updated_at;`,
          [event.pinId, event.path, event.author, event.height, event.txIndex, event.timestampMs, JSON.stringify(event.body), nowMs],
        );
      }
      this.db.run('COMMIT;');
    } catch (error) {
      try {
        this.db.run('ROLLBACK;');
      } catch {
        // keep the original failure
      }
      throw error;
    }
    this.saveDb();
  }

  loadEvents(): PreferenceChainEvent[] {
    const segments: readonly string[] = PREFERENCE_SEGMENTS;
    return this.all('SELECT pin_id, path, author, height, tx_index, timestamp_ms, body_json FROM preference_events;').flatMap(
      (row) => {
        const path = String(row.path);
        if (!segments.includes(path)) return [];
        return [{
          pinId: String(row.pin_id),
          path: path as PreferenceSegment,
          author: String(row.author),
          height: Number(row.height),
          txIndex: Number(row.tx_index),
          timestampMs: Number(row.timestamp_ms),
          body: parseObject(row.body_json),
        }];
      },
    );
  }

  insertBallot(input: NewBallotInput): PreferenceBallotRow {
    const id = randomUUID();
    this.write(
      `INSERT INTO preference_ballots (id, round_pin_id, signer_type, metabot_id, judge_global_metaid, ballot_json, salt,
         commit_hash, status, reveal_attempts, commit_close_at, reveal_close_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committing', 0, ?, ?, ?, ?);`,
      [
        id,
        input.roundPinId,
        input.signerType,
        input.metabotId,
        input.judgeGlobalMetaId,
        JSON.stringify(input.ballot),
        input.salt,
        input.commitHash,
        input.commitCloseAt,
        input.revealCloseAt,
        input.nowMs,
        input.nowMs,
      ],
    );
    const row = this.getBallot(id);
    if (!row) throw new Error('preference ballot insert failed');
    return row;
  }

  getBallot(id: string): PreferenceBallotRow | null {
    const [row] = this.all(`SELECT ${BALLOT_COLUMNS} FROM preference_ballots WHERE id = ?;`, [id]);
    return row ? toBallotRow(row) : null;
  }

  listBallots(filter: { roundPinId?: string; statuses?: PreferenceBallotStatus[] } = {}): PreferenceBallotRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.roundPinId) {
      clauses.push('round_pin_id = ?');
      params.push(filter.roundPinId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.all(`SELECT ${BALLOT_COLUMNS} FROM preference_ballots ${where} ORDER BY created_at ASC, rowid ASC;`, params).map(toBallotRow);
  }

  markCommitted(id: string, commitPinId: string, nowMs: number): void {
    const row = this.getBallot(id);
    if (!row) return;
    this.db.run(
      `UPDATE preference_ballots SET status = 'superseded', updated_at = ?
       WHERE round_pin_id = ? AND judge_global_metaid = ? AND id <> ? AND status IN ('committing', 'committed');`,
      [nowMs, row.roundPinId, row.judgeGlobalMetaId, id],
    );
    this.write(
      `UPDATE preference_ballots SET status = 'committed', commit_pin_id = ?, last_error = NULL, updated_at = ? WHERE id = ?;`,
      [commitPinId, nowMs, id],
    );
  }

  markCommitFailed(id: string, error: string, nowMs: number): void {
    this.write(`UPDATE preference_ballots SET status = 'commit_failed', last_error = ?, updated_at = ? WHERE id = ?;`, [error, nowMs, id]);
  }

  markRevealed(id: string, revealPinId: string, nowMs: number): void {
    this.write(
      `UPDATE preference_ballots SET status = 'revealed', reveal_pin_id = ?, last_error = NULL, updated_at = ? WHERE id = ?;`,
      [revealPinId, nowMs, id],
    );
  }

  markRevealRetry(id: string, nowMs: number): void {
    this.write(`UPDATE preference_ballots SET status = 'committed', reveal_pin_id = NULL, updated_at = ? WHERE id = ?;`, [nowMs, id]);
  }

  markRevealFailed(id: string, error: string, nowMs: number): PreferenceBallotStatus {
    const row = this.getBallot(id);
    if (!row) return 'reveal_failed';
    const attempts = row.revealAttempts + 1;
    const status: PreferenceBallotStatus = attempts >= MAX_REVEAL_ATTEMPTS ? 'reveal_failed' : 'committed';
    this.write(
      `UPDATE preference_ballots SET status = ?, reveal_attempts = ?, last_error = ?, updated_at = ? WHERE id = ?;`,
      [status, attempts, error, nowMs, id],
    );
    return status;
  }

  expireStale(nowSec: number, nowMs: number): number {
    const stale = this.all(
      `SELECT id FROM preference_ballots WHERE status IN ('committing', 'committed') AND reveal_close_at < ?;`,
      [nowSec],
    );
    if (stale.length === 0) return 0;
    this.write(
      `UPDATE preference_ballots SET status = 'expired', updated_at = ? WHERE status IN ('committing', 'committed') AND reveal_close_at < ?;`,
      [nowMs, nowSec],
    );
    return stale.length;
  }

  countActive(nowSec: number): number {
    const [row] = this.all(
      `SELECT COUNT(*) AS n FROM preference_ballots WHERE status IN ('committing', 'committed', 'revealed') AND reveal_close_at >= ?;`,
      [nowSec],
    );
    return row ? Number(row.n) : 0;
  }

  recordTelemetry(roundPinId: string, pairKey: string, seconds: number, nowMs: number): void {
    this.write(
      `INSERT INTO preference_compare_telemetry (round_pin_id, pair_key, seconds, recorded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(round_pin_id, pair_key) DO UPDATE SET seconds = preference_compare_telemetry.seconds + excluded.seconds,
         recorded_at = excluded.recorded_at;`,
      [roundPinId, pairKey, seconds, nowMs],
    );
  }

  telemetryForRound(roundPinId: string): { pairKey: string; seconds: number }[] {
    return this.all(
      'SELECT pair_key, seconds FROM preference_compare_telemetry WHERE round_pin_id = ? ORDER BY pair_key ASC;',
      [roundPinId],
    ).map((row) => ({ pairKey: String(row.pair_key), seconds: Number(row.seconds) }));
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceStore.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/store.ts
git add -f tests/preferenceStore.test.mjs
git commit -m "feat: add preference event cache and sealed ballot store"
```

---

### Task 3: Service — read side

**Files:**
- Create: `src/main/services/preference/service.ts`
- Test: `tests/preferenceService.test.mjs`

**Interfaces:**
- Consumes: `PreferenceStore`, `toBallotView`, `PreferenceBallotView` (Task 2); `CollectPreferenceEventsResult` (Task 1); `tallyRound`, `compareOrderKey` (P1 engine); `canonicalRoundForSubject`, `checkLesson`, `verifyLessonPin`, `CanonicalRoundResolution` (P1 lesson); `parseRound` (P1 schemas).
- Produces (all exported from `service.ts`):
  - `type PreferenceSigner = { type: 'user' } | { type: 'metabot'; metabotId: number }`
  - `interface PreferencePinWriteResult { pinId: string; txids: string[] }`
  - `interface PreferenceWriter { globalMetaId: string; write(segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult> }`
  - `type PreferenceWriterResolution = PreferenceWriter | { error: string }`
  - `interface PreferenceServiceDeps { store; collect: () => Promise<CollectPreferenceEventsResult>; resolveWriter: (signer: PreferenceSigner) => PreferenceWriterResolution; nowMs?: () => number; onUpdate?: (reason: string) => void }`
  - `interface PreferenceRoundSummary { pinId; author; confirmed: boolean; title; category: string[]; subject: { taskid: string; node: string } | null; candidateCount: number; judges: RoundJudge[]; commitCloseAt: number; revealCloseAt: number; status: TallyStatus | 'pending'; winner: string | null }`
  - `interface PreferenceRoundView { pinId; author; confirmed: boolean; round: RoundBody; tally: TallyResult | null; tallyError: string | null; localBallots: PreferenceBallotView[]; lesson: { pinId: string; valid: boolean; reason: string | null } | null }`
  - `interface PreferenceLessonView { pinId; author; timestampMs: number; roundPinId; roundTitle; category: string[]; summary; principles: LessonPrinciple[]; preferred: RoundCandidate; rejected: RoundCandidate[]; decidingBallots: number }`
  - `class PreferenceService` with `refresh`, `events`, `listRounds`, `roundStatus`, `canonicalRound`, `searchLessons` (this task), plus the write and reveal methods of Tasks 4–5.
  - Category matching: a query tag matches a lesson tag when equal, or when the lesson tag starts with `<query>:` (query `ui` matches `ui:qa-community`).

- [ ] **Step 1: Write the failing read-side tests**

Create `tests/preferenceService.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/preferenceService.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/service.js'`.

- [ ] **Step 3: Write `src/main/services/preference/service.ts` (read side)**

```ts
import type { CollectPreferenceEventsResult } from './collector';
import type { PreferenceSegment } from './constants';
import { compareOrderKey, tallyRound } from './engine';
import { canonicalRoundForSubject, checkLesson, verifyLessonPin, type CanonicalRoundResolution } from './lesson';
import { parseRound } from './schemas';
import { toBallotView, type PreferenceBallotView, type PreferenceStore } from './store';
import type {
  LessonPrinciple,
  PreferenceChainEvent,
  RoundBody,
  RoundCandidate,
  RoundJudge,
  TallyResult,
  TallyStatus,
} from './types';

export type PreferenceSigner = { type: 'user' } | { type: 'metabot'; metabotId: number };

export interface PreferencePinWriteResult {
  pinId: string;
  txids: string[];
}

export interface PreferenceWriter {
  globalMetaId: string;
  write(segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult>;
}

export type PreferenceWriterResolution = PreferenceWriter | { error: string };

export interface PreferenceServiceDeps {
  store: PreferenceStore;
  collect: () => Promise<CollectPreferenceEventsResult>;
  resolveWriter: (signer: PreferenceSigner) => PreferenceWriterResolution;
  nowMs?: () => number;
  onUpdate?: (reason: string) => void;
}

export interface PreferenceRoundSummary {
  pinId: string;
  author: string;
  confirmed: boolean;
  title: string;
  category: string[];
  subject: { taskid: string; node: string } | null;
  candidateCount: number;
  judges: RoundJudge[];
  commitCloseAt: number;
  revealCloseAt: number;
  status: TallyStatus | 'pending';
  winner: string | null;
}

export interface PreferenceRoundView {
  pinId: string;
  author: string;
  confirmed: boolean;
  round: RoundBody;
  tally: TallyResult | null;
  tallyError: string | null;
  localBallots: PreferenceBallotView[];
  lesson: { pinId: string; valid: boolean; reason: string | null } | null;
}

export interface PreferenceLessonView {
  pinId: string;
  author: string;
  timestampMs: number;
  roundPinId: string;
  roundTitle: string;
  category: string[];
  summary: string;
  principles: LessonPrinciple[];
  preferred: RoundCandidate;
  rejected: RoundCandidate[];
  decidingBallots: number;
}

export interface PreferenceRefreshResult {
  ok: boolean;
  eventCount: number;
  error: string | null;
}

type ErrorResult = { error: string };

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const tagMatches = (query: string, tag: string): boolean => tag === query || tag.startsWith(`${query}:`);

export class PreferenceService {
  private readonly deps: PreferenceServiceDeps;
  private refreshing: Promise<PreferenceRefreshResult> | null = null;

  constructor(deps: PreferenceServiceDeps) {
    this.deps = deps;
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  refresh(reason: string): Promise<PreferenceRefreshResult> {
    if (!this.refreshing) {
      this.refreshing = this.runRefresh(reason).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async runRefresh(reason: string): Promise<PreferenceRefreshResult> {
    try {
      const result = await this.deps.collect();
      this.deps.store.upsertEvents(result.events, this.nowMs());
      const errors = result.perPath.filter((entry) => entry.error).map((entry) => `${entry.segment}: ${entry.error}`);
      this.deps.onUpdate?.(reason);
      return { ok: errors.length === 0, eventCount: result.events.length, error: errors.length > 0 ? errors.join('; ') : null };
    } catch (error) {
      return { ok: false, eventCount: 0, error: errorOf(error) };
    }
  }

  events(): PreferenceChainEvent[] {
    return this.deps.store.loadEvents();
  }

  /** Finds a round in the cache, confirmed or not, and validates it against its own timestamp. */
  private locateRound(
    events: readonly PreferenceChainEvent[],
    roundPinId: string,
  ): { event: PreferenceChainEvent; round: RoundBody } | ErrorResult {
    const event = events.find((candidate) => candidate.path === 'round' && candidate.pinId === roundPinId);
    if (!event) return { error: 'round:not-found' };
    const parsed = parseRound(event.body, Math.floor(event.timestampMs / 1000));
    return parsed.ok === true ? { event, round: parsed.value } : { error: parsed.reason };
  }

  listRounds(filter: { judge?: string; taskid?: string } = {}): PreferenceRoundSummary[] {
    const events = this.events();
    const nowSec = this.nowSec();
    const rounds = events.filter((event) => event.path === 'round').sort((a, b) => b.timestampMs - a.timestampMs);
    const out: PreferenceRoundSummary[] = [];
    for (const event of rounds) {
      const located = this.locateRound(events, event.pinId);
      if ('error' in located) continue;
      const { round } = located;
      if (filter.judge && !round.judges.some((judge) => judge.id === filter.judge)) continue;
      if (filter.taskid && round.subject?.taskid !== filter.taskid) continue;
      const confirmed = event.height >= 0;
      const tally = confirmed ? tallyRound(events, event.pinId, { nowSec }) : null;
      out.push({
        pinId: event.pinId,
        author: event.author,
        confirmed,
        title: round.title,
        category: round.category,
        subject: round.subject ?? null,
        candidateCount: round.candidates.length,
        judges: round.judges,
        commitCloseAt: round.commitCloseAt,
        revealCloseAt: round.revealCloseAt,
        status: tally && tally.ok === true ? tally.result.output.status : 'pending',
        winner: tally && tally.ok === true ? tally.result.output.winner : null,
      });
    }
    return out;
  }

  roundStatus(roundPinId: string, options: { lessonPinId?: string } = {}): PreferenceRoundView | ErrorResult {
    const events = this.events();
    const located = this.locateRound(events, roundPinId);
    if ('error' in located) return located;
    const nowSec = this.nowSec();
    const tally = tallyRound(events, roundPinId, { nowSec });
    let lesson: PreferenceRoundView['lesson'] = null;
    if (options.lessonPinId) {
      const lessonEvent = events.find((event) => event.path === 'lesson' && event.pinId === options.lessonPinId);
      const verdict = verifyLessonPin(events, options.lessonPinId, nowSec);
      const sameRound = lessonEvent?.body.round === roundPinId;
      lesson = {
        pinId: options.lessonPinId,
        valid: verdict.ok && sameRound,
        reason: verdict.ok === true ? (sameRound ? null : 'lesson:round-mismatch') : verdict.reason,
      };
    }
    return {
      pinId: roundPinId,
      author: located.event.author,
      confirmed: located.event.height >= 0,
      round: located.round,
      tally: tally.ok === true ? tally.result : null,
      tallyError: tally.ok === true ? null : tally.reason,
      localBallots: this.deps.store.listBallots({ roundPinId }).map(toBallotView),
      lesson,
    };
  }

  canonicalRound(subject: { taskid: string; node: string; rootAuthor: string }): CanonicalRoundResolution {
    return canonicalRoundForSubject(this.events(), subject, this.nowSec());
  }

  searchLessons(query: { category?: string[]; limit?: number } = {}): PreferenceLessonView[] {
    const events = this.events();
    const nowSec = this.nowSec();
    const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
    const tallies = new Map<string, TallyResult | null>();
    const out: PreferenceLessonView[] = [];
    const lessons = events
      .filter((event) => event.path === 'lesson' && event.height >= 0)
      .sort((a, b) => compareOrderKey(b, a));
    for (const event of lessons) {
      const roundPinId = typeof event.body.round === 'string' ? event.body.round : '';
      if (!tallies.has(roundPinId)) {
        const tally = tallyRound(events, roundPinId, { nowSec });
        tallies.set(roundPinId, tally.ok === true ? tally.result : null);
      }
      const tally = tallies.get(roundPinId);
      if (!tally) continue;
      const verdict = checkLesson(event.body, tally);
      if (verdict.ok === false) continue;
      const { lesson } = verdict;
      const wanted = query.category ?? [];
      if (wanted.length > 0 && !wanted.some((tag) => lesson.category.some((own) => tagMatches(tag, own)))) continue;
      const located = this.locateRound(events, roundPinId);
      if ('error' in located) continue;
      const byId = new Map(located.round.candidates.map((candidate) => [candidate.id, candidate] as const));
      const preferred = byId.get(lesson.exemplars.preferred);
      if (!preferred) continue;
      out.push({
        pinId: event.pinId,
        author: event.author,
        timestampMs: event.timestampMs,
        roundPinId,
        roundTitle: located.round.title,
        category: lesson.category,
        summary: lesson.summary,
        principles: lesson.principles,
        preferred,
        rejected: lesson.exemplars.rejected.flatMap((id) => {
          const candidate = byId.get(id);
          return candidate ? [candidate] : [];
        }),
        decidingBallots: tally.output.ballots.deciding,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceService.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/service.ts
git add -f tests/preferenceService.test.mjs
git commit -m "feat: add preference service read side"
```

---

### Task 4: Service — writes

**Files:**
- Modify: `src/main/services/preference/service.ts`
- Test: `tests/preferenceService.test.mjs` (append)

**Interfaces:**
- Consumes: `checkBallot`, `parseLesson`, `parseRound` (P1); `ballotCommitHash`, `newBallotSalt` (P1); `COMMIT_CUTOFF_SEC` (P1); store methods from Task 2.
- Produces (methods on `PreferenceService`):
  - `openRound(signer, body: unknown): Promise<{ pinId: string } | { error: string }>` — validates with `parseRound(body, nowSec + COMMIT_CUTOFF_SEC)` (so a round confirmed up to 30 min late still satisfies the window rule), writes `round`, caches the pin as unconfirmed.
  - `commitBallot(signer, roundPinId, ballot: unknown): Promise<{ pinId: string; ballotId: string } | { error: string }>` — refreshes once if the round is not cached; refuses with `preference:commit-window-closing` when `now > commitCloseAt - COMMIT_CUTOFF_SEC`; validates with `checkBallot`; refuses `preference:own-candidate-in-ballot`; stores the row (status `committing`) BEFORE broadcasting; marks `committed` or `commit_failed`.
  - `publishLesson(signer, body: unknown): Promise<{ pinId: string } | { error: string }>` — validates with `checkLesson` against the current tally before any write.
  - `recordTelemetry(roundPinId: string, pairKey: string, seconds: number): void` — ignores non-integer or out-of-range (`0..3600`) seconds.

- [ ] **Step 1: Append the failing write tests to `tests/preferenceService.test.mjs`**

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run compile:electron && node --test tests/preferenceService.test.mjs`
Expected: the 6 new tests FAIL with `service.commitBallot is not a function` (and similar); the 4 read tests still pass.

- [ ] **Step 3: Add the write methods**

In `service.ts`, extend the imports:

```ts
import { COMMIT_CUTOFF_SEC, type PreferenceSegment } from './constants';
import { checkBallot, parseLesson, parseRound } from './schemas';
import { ballotCommitHash, newBallotSalt } from './sealing';
```

(replace the earlier `import type { PreferenceSegment } from './constants';` and `import { parseRound } from './schemas';` lines). Then add these members inside `class PreferenceService`, after `searchLessons`:

```ts
  private cacheOwnPin(pinId: string, segment: PreferenceSegment, author: string, payload: object): void {
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    this.deps.store.upsertEvents(
      [{ pinId, path: segment, author, height: -1, txIndex: 0, timestampMs: this.nowMs(), body }],
      this.nowMs(),
    );
    this.deps.onUpdate?.(`local-${segment}`);
  }

  async openRound(signer: PreferenceSigner, body: unknown): Promise<{ pinId: string } | ErrorResult> {
    const parsed = parseRound(body, this.nowSec() + COMMIT_CUTOFF_SEC);
    if (parsed.ok === false) return { error: parsed.reason };
    const writer = this.deps.resolveWriter(signer);
    if ('error' in writer) return writer;
    try {
      const written = await writer.write('round', parsed.value);
      this.cacheOwnPin(written.pinId, 'round', writer.globalMetaId, parsed.value);
      return { pinId: written.pinId };
    } catch (error) {
      return { error: errorOf(error) };
    }
  }

  async commitBallot(
    signer: PreferenceSigner,
    roundPinId: string,
    rawBallot: unknown,
  ): Promise<{ pinId: string; ballotId: string } | ErrorResult> {
    let located = this.locateRound(this.events(), roundPinId);
    if ('error' in located && located.error === 'round:not-found') {
      await this.refresh('commit-lookup');
      located = this.locateRound(this.events(), roundPinId);
    }
    if ('error' in located) return located;
    const { round } = located;
    if (this.nowSec() > round.commitCloseAt - COMMIT_CUTOFF_SEC) return { error: 'preference:commit-window-closing' };
    const checked = checkBallot(rawBallot, round);
    if (checked.ok === false) return { error: checked.reason };
    const writer = this.deps.resolveWriter(signer);
    if ('error' in writer) return writer;
    const ownIds = new Set(round.candidates.filter((candidate) => candidate.author === writer.globalMetaId).map((candidate) => candidate.id));
    if (checked.value.pairs.some((pair) => ownIds.has(pair.a) || ownIds.has(pair.b))) {
      return { error: 'preference:own-candidate-in-ballot' };
    }
    const salt = newBallotSalt();
    const commitHash = ballotCommitHash({ round: roundPinId, judge: writer.globalMetaId, salt, ballot: checked.value });
    const row = this.deps.store.insertBallot({
      roundPinId,
      signerType: signer.type,
      metabotId: signer.type === 'metabot' ? signer.metabotId : null,
      judgeGlobalMetaId: writer.globalMetaId,
      ballot: checked.value,
      salt,
      commitHash,
      commitCloseAt: round.commitCloseAt,
      revealCloseAt: round.revealCloseAt,
      nowMs: this.nowMs(),
    });
    try {
      const payload = { round: roundPinId, hash: commitHash };
      const written = await writer.write('commit', payload);
      this.deps.store.markCommitted(row.id, written.pinId, this.nowMs());
      this.cacheOwnPin(written.pinId, 'commit', writer.globalMetaId, payload);
      return { pinId: written.pinId, ballotId: row.id };
    } catch (error) {
      this.deps.store.markCommitFailed(row.id, errorOf(error), this.nowMs());
      return { error: errorOf(error) };
    }
  }

  async publishLesson(signer: PreferenceSigner, body: unknown): Promise<{ pinId: string } | ErrorResult> {
    const parsed = parseLesson(body);
    if (parsed.ok === false) return { error: parsed.reason };
    const tally = tallyRound(this.events(), parsed.value.round, { nowSec: this.nowSec() });
    if (tally.ok === false) return { error: tally.reason };
    const verdict = checkLesson(parsed.value, tally.result);
    if (verdict.ok === false) return { error: verdict.reason };
    const writer = this.deps.resolveWriter(signer);
    if ('error' in writer) return writer;
    try {
      const written = await writer.write('lesson', verdict.lesson);
      this.cacheOwnPin(written.pinId, 'lesson', writer.globalMetaId, verdict.lesson);
      return { pinId: written.pinId };
    } catch (error) {
      return { error: errorOf(error) };
    }
  }

  recordTelemetry(roundPinId: string, pairKey: string, seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) return;
    this.deps.store.recordTelemetry(roundPinId, pairKey, seconds, this.nowMs());
  }
```

The salt is stored before the broadcast on purpose: if the app dies after the commit pin is broadcast, the ballot is still revealable (Task 5 reconciles the row).

- [ ] **Step 4: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceService.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/service.ts
git add -f tests/preferenceService.test.mjs
git commit -m "feat: add preference round, commit, and lesson writes"
```

---

### Task 5: Service — auto-reveal

**Files:**
- Modify: `src/main/services/preference/service.ts`
- Test: `tests/preferenceService.test.mjs` (append)

**Interfaces:**
- Consumes: `REVEAL_DELAY_SEC` (P1); store methods `expireStale`, `listBallots`, `markRevealed`, `markRevealFailed`, `markRevealRetry`, `markCommitted`, `countActive`.
- Produces:
  - `revealDue(): Promise<{ attempted: number; revealed: number; failed: number; expired: number }>`: (1) expire unrevealed rows past `revealCloseAt`; (2) reconcile — a `committing` row older than 2 min whose commit is on chain becomes `committed`; a `revealed` row whose reveal confirmed at block time `≤ commitCloseAt` goes back to `committed`; (3) publish a reveal for every `committed` row with `commitCloseAt + REVEAL_DELAY_SEC ≤ now ≤ revealCloseAt`, re-checking that the signer still resolves to the stored judge identity.
  - `hasActiveBallots(): boolean`.
  - Callers must `refresh()` before `revealDue()` so reconciliation sees fresh chain state (the heartbeat in Task 7 does).

- [ ] **Step 1: Append the failing reveal tests**

```js
const commitAsUser = async (nowSec = COMMIT_CLOSE - 7_200) => {
  const { c, round } = openChain();
  const h = await harness({ nowSec, events: c.events });
  await h.service.refresh('seed');
  await h.service.commitBallot({ type: 'user' }, round, C3_BEST);
  confirm(h.state, h.state.writes[0], nowSec + 200);
  await h.service.refresh('confirm-commit');
  return { ...h, round };
};

test('reveals only after commitCloseAt + delay, once, and the engine counts it', async () => {
  const { service, state, store, round } = await commitAsUser();
  state.nowSec = COMMIT_CLOSE + 100;
  assert.equal((await service.revealDue()).attempted, 0);
  state.nowSec = COMMIT_CLOSE + 1_800;
  assert.deepEqual(await service.revealDue(), { attempted: 1, revealed: 1, failed: 0, expired: 0 });
  const [row] = store.listBallots({ roundPinId: round });
  assert.equal(row.status, 'revealed');
  assert.deepEqual(state.writes[1].payload, { round, commit: row.commitPinId, salt: row.salt, ballot: C3_BEST });
  assert.equal((await service.revealDue()).attempted, 0);

  confirm(state, state.writes[1], COMMIT_CLOSE + 1_900);
  state.nowSec = FINAL_NOW;
  await service.refresh('confirm-reveal');
  const judge = service.roundStatus(round).tally.output.judges.find((entry) => entry.id === H1);
  assert.equal(judge.class, 'deciding');
  assert.equal(judge.pairs, 3);
});

test('reveal retries up to five times, then gives up', async () => {
  const { service, state, store } = await commitAsUser();
  state.nowSec = COMMIT_CLOSE + 1_800;
  state.failNext = 5;
  for (let attempt = 1; attempt <= 5; attempt += 1) await service.revealDue();
  const [row] = store.listBallots();
  assert.equal(row.status, 'reveal_failed');
  assert.equal(row.revealAttempts, 5);
  assert.equal((await service.revealDue()).attempted, 0);
});

test('a reveal mined at or before commitCloseAt is published again', async () => {
  const { service, state, store } = await commitAsUser();
  state.nowSec = COMMIT_CLOSE + 1_800;
  await service.revealDue();
  confirm(state, state.writes[1], COMMIT_CLOSE);
  await service.refresh('lagging-block-time');
  const again = await service.revealDue();
  assert.equal(again.revealed, 1);
  assert.deepEqual(state.writes.map((write) => write.segment), ['commit', 'reveal', 'reveal']);
  assert.equal(store.listBallots()[0].revealPinId, state.writes[2].pinId);
});

test('unrevealed ballots expire after revealCloseAt', async () => {
  const { service, state, store } = await commitAsUser();
  assert.equal(service.hasActiveBallots(), true);
  state.nowSec = REVEAL_CLOSE + 1;
  assert.deepEqual(await service.revealDue(), { attempted: 0, revealed: 0, failed: 0, expired: 1 });
  assert.equal(store.listBallots()[0].status, 'expired');
  assert.equal(service.hasActiveBallots(), false);
});

test('a commit broadcast whose bookkeeping was lost is reconciled from chain', async () => {
  const { c, round } = openChain();
  const nowSec = COMMIT_CLOSE - 7_200;
  const { service, state, store } = await harness({ nowSec, events: c.events });
  const salt = 'a1'.repeat(32);
  const commitHash = ballotCommitHash({ round, judge: H1, salt, ballot: C3_BEST });
  const row = store.insertBallot({
    roundPinId: round,
    signerType: 'user',
    metabotId: null,
    judgeGlobalMetaId: H1,
    ballot: C3_BEST,
    salt,
    commitHash,
    commitCloseAt: COMMIT_CLOSE,
    revealCloseAt: REVEAL_CLOSE,
    nowMs: nowSec * 1000,
  });
  confirm(state, { pinId: pid(8888), segment: 'commit', author: H1, payload: { round, hash: commitHash } }, nowSec + 60);
  state.nowSec = nowSec + 300;
  await service.refresh('recover');
  await service.revealDue();
  const recovered = store.getBallot(row.id);
  assert.equal(recovered.status, 'committed');
  assert.equal(recovered.commitPinId, pid(8888));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run compile:electron && node --test tests/preferenceService.test.mjs`
Expected: the 5 new tests FAIL with `service.revealDue is not a function`.

- [ ] **Step 3: Add the reveal methods**

Extend the constants import to `import { COMMIT_CUTOFF_SEC, REVEAL_DELAY_SEC, type PreferenceSegment } from './constants';`, add a module constant under `tagMatches`:

```ts
const STALE_COMMITTING_MS = 120_000;
```

and add inside the class:

```ts
  hasActiveBallots(): boolean {
    return this.deps.store.countActive(this.nowSec()) > 0;
  }

  async revealDue(): Promise<{ attempted: number; revealed: number; failed: number; expired: number }> {
    const nowSec = this.nowSec();
    const expired = this.deps.store.expireStale(nowSec, this.nowMs());
    this.reconcile(this.events(), nowSec);
    const counts = { attempted: 0, revealed: 0, failed: 0, expired };
    for (const row of this.deps.store.listBallots({ statuses: ['committed'] })) {
      if (!row.commitPinId || nowSec < row.commitCloseAt + REVEAL_DELAY_SEC || nowSec > row.revealCloseAt) continue;
      counts.attempted += 1;
      const signer: PreferenceSigner = row.signerType === 'user'
        ? { type: 'user' }
        : { type: 'metabot', metabotId: row.metabotId ?? -1 };
      const writer = this.deps.resolveWriter(signer);
      if ('error' in writer || writer.globalMetaId !== row.judgeGlobalMetaId) {
        this.deps.store.markRevealFailed(row.id, 'error' in writer ? writer.error : 'preference:signer-changed', this.nowMs());
        counts.failed += 1;
        continue;
      }
      const payload = { round: row.roundPinId, commit: row.commitPinId, salt: row.salt, ballot: row.ballot };
      try {
        const written = await writer.write('reveal', payload);
        this.deps.store.markRevealed(row.id, written.pinId, this.nowMs());
        this.cacheOwnPin(written.pinId, 'reveal', writer.globalMetaId, payload);
        counts.revealed += 1;
      } catch (error) {
        this.deps.store.markRevealFailed(row.id, errorOf(error), this.nowMs());
        counts.failed += 1;
      }
    }
    if (counts.revealed > 0 || counts.expired > 0) this.deps.onUpdate?.('preference-reveal');
    return counts;
  }

  private reconcile(events: readonly PreferenceChainEvent[], nowSec: number): void {
    const nowMs = this.nowMs();
    for (const row of this.deps.store.listBallots({ statuses: ['committing', 'revealed'] })) {
      if (row.status === 'committing') {
        if (nowMs - row.createdAtMs < STALE_COMMITTING_MS) continue;
        const onChain = events.find(
          (event) => event.path === 'commit'
            && event.author === row.judgeGlobalMetaId
            && event.body.round === row.roundPinId
            && event.body.hash === row.commitHash,
        );
        if (onChain) this.deps.store.markCommitted(row.id, onChain.pinId, nowMs);
        continue;
      }
      if (!row.revealPinId || nowSec > row.revealCloseAt) continue;
      const reveal = events.find((event) => event.pinId === row.revealPinId);
      if (reveal && reveal.height >= 0 && Math.floor(reveal.timestampMs / 1000) <= row.commitCloseAt) {
        this.deps.store.markRevealRetry(row.id, nowMs);
      }
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceService.test.mjs`
Expected: PASS (15 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/service.ts
git add -f tests/preferenceService.test.mjs
git commit -m "feat: add preference auto-reveal with reconciliation"
```

---

### Task 6: Human identity writer

**Files:**
- Create: `src/main/services/preference/userWriter.ts`
- Test: `tests/preferenceUserWriter.test.mjs`

**Interfaces:**
- Consumes: types only — `UserIdentityStore` (`src/main/userIdentityStore.ts`), `CreatePinWorkerSuccess`, `MetaidDataPayload`, `MvcCreatePinSessionSnapshot` (`src/main/services/metaidCore.ts`); `preferencePoolPath`, `PREFERENCE_PIN_VERSION` (P1); `PreferenceWriterResolution` (Task 3).
- Produces:
  - `type IdentityCreatePin = (params: { mnemonic: string; path?: string; metaidData: MetaidDataPayload; options?: { feeRate?: number }; sessionSnapshot?: MvcCreatePinSessionSnapshot }) => Promise<CreatePinWorkerSuccess>`
  - `createUserPreferenceWriter(userStore: Pick<UserIdentityStore, 'get'>, deps: { createPin: IdentityCreatePin; feeRate: () => number }): () => PreferenceWriterResolution`
  - Errors: `USER_IDENTITY_MISSING` (no identity or no globalmetaid), `SUBSIDY_NOT_CLAIMED` (same rule as `updateUserIdentityName` in `userIdentityService.ts:551-556`).
  - All writes of the returned writers share one queue (strictly sequential) and one session snapshot, threading `spentOutpoints` and `changeUtxo` exactly like `syncUserIdentityToChain` (`userIdentityService.ts:213-218`).

- [ ] **Step 1: Write the failing test**

Create `tests/preferenceUserWriter.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { H1, pid } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { createUserPreferenceWriter } = require('../dist-electron/main/services/preference/userWriter.js');

const IDENTITY = {
  mnemonic: 'word '.repeat(12).trim(),
  path: "m/44'/10001'/0'/0/0",
  globalmetaid: H1,
  subsidy_state: 'claimed',
  chat_public_key_pin_id: pid(1),
};

const fakeCreatePin = () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const createPin = async (params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({ ...params, excludeAtCall: [...params.sessionSnapshot.excludeOutpoints] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const n = calls.length;
    return {
      txids: [`${String(n).padStart(64, '0')}`],
      pinId: pid(700 + n),
      totalCost: 1,
      spentOutpoints: [`out${n}:0`],
      changeUtxo: { txId: `change${n}`, outputIndex: 1, satoshis: 1000 },
    };
  };
  return { calls, createPin, maxActive: () => maxActive };
};

test('writes are serialized and thread spent outpoints between pins', async () => {
  const fake = fakeCreatePin();
  const resolve = createUserPreferenceWriter({ get: () => IDENTITY }, { createPin: fake.createPin, feeRate: () => 2 });
  const writer = resolve();
  assert.equal(writer.globalMetaId, H1);
  const [first, second] = await Promise.all([
    writer.write('commit', { round: pid(1), hash: 'a'.repeat(64) }),
    resolve().write('reveal', { round: pid(1) }),
  ]);
  assert.equal(first.pinId, pid(701));
  assert.equal(second.pinId, pid(702));
  assert.equal(fake.maxActive(), 1);
  assert.deepEqual(fake.calls[1].excludeAtCall, ['out1:0']);
  assert.deepEqual(fake.calls[0].metaidData, {
    operation: 'create',
    path: '/protocols/preference/commit',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify({ round: pid(1), hash: 'a'.repeat(64) }),
  });
  assert.deepEqual(fake.calls[0].options, { feeRate: 2 });
  assert.equal(fake.calls[0].mnemonic, IDENTITY.mnemonic);
});

test('a failed write does not block the queue', async () => {
  let calls = 0;
  const createPin = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Not enough balance');
    return { txids: ['t'], pinId: pid(900), totalCost: 1 };
  };
  const resolve = createUserPreferenceWriter({ get: () => IDENTITY }, { createPin, feeRate: () => 1 });
  await assert.rejects(resolve().write('commit', {}), /Not enough balance/);
  assert.equal((await resolve().write('commit', {})).pinId, pid(900));
});

test('identity and subsidy gates', () => {
  const deps = { createPin: async () => ({ txids: [], pinId: '', totalCost: 0 }), feeRate: () => 1 };
  assert.deepEqual(createUserPreferenceWriter({ get: () => null }, deps)(), { error: 'USER_IDENTITY_MISSING' });
  assert.deepEqual(createUserPreferenceWriter({ get: () => ({ ...IDENTITY, globalmetaid: null }) }, deps)(), {
    error: 'USER_IDENTITY_MISSING',
  });
  assert.deepEqual(createUserPreferenceWriter({ get: () => ({ ...IDENTITY, subsidy_state: 'failed' }) }, deps)(), {
    error: 'SUBSIDY_NOT_CLAIMED',
  });
  assert.deepEqual(
    createUserPreferenceWriter({ get: () => ({ ...IDENTITY, subsidy_state: null, chat_public_key_pin_id: null }) }, deps)(),
    { error: 'SUBSIDY_NOT_CLAIMED' },
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/preferenceUserWriter.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/userWriter.js'`.

- [ ] **Step 3: Write `src/main/services/preference/userWriter.ts`**

```ts
import type { CreatePinWorkerSuccess, MetaidDataPayload, MvcCreatePinSessionSnapshot } from '../metaidCore';
import type { UserIdentityStore } from '../../userIdentityStore';
import { PREFERENCE_PIN_VERSION, preferencePoolPath, type PreferenceSegment } from './constants';
import type { PreferencePinWriteResult, PreferenceWriterResolution } from './service';

export type IdentityCreatePin = (params: {
  mnemonic: string;
  path?: string;
  metaidData: MetaidDataPayload;
  options?: { feeRate?: number };
  sessionSnapshot?: MvcCreatePinSessionSnapshot;
}) => Promise<CreatePinWorkerSuccess>;

export interface UserPreferenceWriterDeps {
  createPin: IdentityCreatePin;
  feeRate: () => number;
}

/**
 * createPinForIdentity bypasses the per-MetaBot spend coordinator, so this
 * writer owns serialization for the human wallet: one queue, one snapshot.
 */
export function createUserPreferenceWriter(
  userStore: Pick<UserIdentityStore, 'get'>,
  deps: UserPreferenceWriterDeps,
): () => PreferenceWriterResolution {
  let queue: Promise<unknown> = Promise.resolve();
  const sessionSnapshot: MvcCreatePinSessionSnapshot = { excludeOutpoints: [], preferredFundingUtxos: [] };

  return () => {
    const identity = userStore.get();
    if (!identity || !identity.globalmetaid) return { error: 'USER_IDENTITY_MISSING' };
    if (identity.subsidy_state === 'failed' || (!identity.subsidy_state && !identity.chat_public_key_pin_id)) {
      return { error: 'SUBSIDY_NOT_CLAIMED' };
    }
    const write = (segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult> => {
      const run = async (): Promise<PreferencePinWriteResult> => {
        const current = userStore.get() ?? identity;
        const result = await deps.createPin({
          mnemonic: current.mnemonic,
          path: current.path,
          metaidData: {
            operation: 'create',
            path: preferencePoolPath(segment),
            encryption: '0',
            version: PREFERENCE_PIN_VERSION,
            contentType: 'application/json',
            payload: JSON.stringify(payload),
          },
          options: { feeRate: deps.feeRate() },
          sessionSnapshot,
        });
        if (Array.isArray(result.spentOutpoints) && result.spentOutpoints.length > 0) {
          sessionSnapshot.excludeOutpoints.push(...result.spentOutpoints);
        }
        sessionSnapshot.preferredFundingUtxos = result.changeUtxo ? [result.changeUtxo] : [];
        const txid = result.txids[0] ?? '';
        return { pinId: result.pinId || `${txid}i0`, txids: result.txids };
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    };
    return { globalMetaId: identity.globalmetaid, write };
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceUserWriter.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/userWriter.ts
git add -f tests/preferenceUserWriter.test.mjs
git commit -m "feat: add human identity writer for preference pins"
```

---

### Task 7: Main-process wiring and heartbeat

**Files:**
- Modify: `src/main/main.ts` (imports at the top; getters next to `getMetaTaskProjectionStore` around line 7593; heartbeat registration directly after the `metatask.watch` handler around line 3562)
- Modify: `package.json` (`test:preference`)

**Interfaces:**
- Consumes: `PreferenceStore` (Task 2), `PreferenceService` + `PreferenceSigner` + `PreferenceWriterResolution` (Tasks 3–5), `collectPreferenceEvents` (Task 1), `createUserPreferenceWriter` (Task 6); existing `createPin`, `createPinForIdentity` (`./services/metaidCore`), `resolveCreatePinFeeRate`, `getGlobalFeeRate` or the module's existing fee-rate import, `getStore`, `getMetabotStore`, `getUserIdentityStore`, `getHeartbeatService`.
- Produces: `getPreferenceService(): PreferenceService` (module-level in `main.ts`, used by P3 tool wiring and P4 IPC); `broadcastPreferenceUpdate(reason: string): void` sending `preference:update` `{ seq, reason }` to every window; heartbeat handler `preference.reveal`.

- [ ] **Step 1: Add the imports**

Next to the other `./services/metatask/...` imports in `src/main/main.ts`, add:

```ts
import { collectPreferenceEvents } from './services/preference/collector';
import { PREFERENCE_PIN_VERSION, preferencePoolPath } from './services/preference/constants';
import { PreferenceService, type PreferenceSigner, type PreferenceWriterResolution } from './services/preference/service';
import { PreferenceStore } from './services/preference/store';
import { createUserPreferenceWriter } from './services/preference/userWriter';
```

Check how `main.ts` already imports `createPin`, `createPinForIdentity` and the fee-rate getter (`rg -n "createPinForIdentity|getRate as|resolveCreatePinFeeRate" src/main/main.ts`). Reuse those bindings; add `createPinForIdentity` to the existing `./services/metaidCore` import if it is missing, and `import { getRate as getGlobalFeeRate } from './services/feeRateStore';` only if no fee-rate getter for identity pins is already imported.

- [ ] **Step 2: Add the getters after `getMetaTaskProjectionStore`**

```ts
let preferenceStore: PreferenceStore | null = null;
let preferenceService: PreferenceService | null = null;
let preferenceUpdateSeq = 0;

const getPreferenceStore = (): PreferenceStore => {
  if (!preferenceStore) {
    const sqliteStore = getStore();
    preferenceStore = new PreferenceStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  }
  return preferenceStore;
};

const broadcastPreferenceUpdate = (reason: string): void => {
  preferenceUpdateSeq += 1;
  const payload = { seq: preferenceUpdateSeq, reason };
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('preference:update', payload);
      } catch { /* ignore */ }
    }
  });
};

const preferenceBotWriter = (metabotId: number): PreferenceWriterResolution => {
  const globalMetaId = getMetabotStore().getMetabotById(metabotId)?.globalmetaid;
  if (!globalMetaId) return { error: 'METABOT_IDENTITY_MISSING' };
  return {
    globalMetaId,
    write: async (segment, payload) => {
      const result = await createPin(
        getMetabotStore(),
        metabotId,
        {
          operation: 'create',
          path: preferencePoolPath(segment),
          encryption: '0',
          version: PREFERENCE_PIN_VERSION,
          contentType: 'application/json',
          payload: JSON.stringify(payload),
        },
        { feeRate: resolveCreatePinFeeRate('mvc'), origin: 'tool:preference' },
      );
      return { pinId: result.pinId || `${result.txids[0] ?? ''}i0`, txids: result.txids };
    },
  };
};

const getPreferenceService = (): PreferenceService => {
  if (!preferenceService) {
    const userWriter = createUserPreferenceWriter(getUserIdentityStore(), {
      createPin: createPinForIdentity,
      feeRate: () => getGlobalFeeRate('mvc'),
    });
    preferenceService = new PreferenceService({
      store: getPreferenceStore(),
      collect: () => collectPreferenceEvents(),
      resolveWriter: (signer: PreferenceSigner) =>
        signer.type === 'user' ? userWriter() : preferenceBotWriter(signer.metabotId),
      onUpdate: broadcastPreferenceUpdate,
    });
  }
  return preferenceService;
};
```

`resolveCreatePinFeeRate` and `getGlobalFeeRate` are only called inside `write()` / `feeRate()`, long after module initialization, so their declaration order in `main.ts` does not matter.

- [ ] **Step 3: Register the heartbeat handler after `metatask.watch`**

```ts
  // Preference rounds: auto-reveal sealed local ballots after the commit
  // window closes. No network work unless a local ballot is still active.
  getHeartbeatService().registerHandler({
    name: 'preference.reveal',
    intervalMs: 10 * 60_000,
    jitterMs: 60_000,
    run: async () => {
      const service = getPreferenceService();
      if (!service.hasActiveBallots()) return;
      await service.refresh('heartbeat-reveal');
      const result = await service.revealDue();
      if (result.attempted > 0 || result.expired > 0) console.log('[preference] reveal sweep', result);
    },
  });
```

A handler whose `lastRunAtMs` is `null` runs on the heartbeat's first tick (`heartbeatService.ts:99`), so pending reveals go out right after app start too.

- [ ] **Step 4: Append the P2 tests to `test:preference` in `package.json`**

Replace the `test:preference` value with:

```json
    "test:preference": "pnpm run compile:electron && node --test tests/preferenceSchemas.test.mjs tests/preferenceSealing.test.mjs tests/preferenceEngine.test.mjs tests/preferenceLesson.test.mjs tests/preferenceCollector.test.mjs tests/preferenceStore.test.mjs tests/preferenceService.test.mjs tests/preferenceUserWriter.test.mjs && node scripts/preference-vectors.mjs",
```

- [ ] **Step 5: Verify compile, wiring, and a dev start**

```bash
pnpm run compile:electron
rg -n "preference.reveal|getPreferenceService|broadcastPreferenceUpdate" src/main/main.ts
pnpm run test:preference
```

Expected: compile clean; the grep shows the handler, the getter, and the broadcaster; tests green. Then run `pnpm run electron:dev` once (make sure nothing else holds port 5175), open the app, quit it, and confirm the user database now contains the three `preference_*` tables:

```bash
sqlite3 "$HOME/Library/Application Support/IDBots/idbots.sqlite" ".tables" | tr ' ' '\n' | rg '^preference_'
```

If the database path differs on this machine, locate it with `rg -n "idbots.sqlite" src/main/sqliteStore.ts` and report the path in the handoff. Do not modify the user database by hand.

- [ ] **Step 6: Phase verification**

```bash
pnpm run compile:electron
pnpm run build:skills
pnpm run lint
node --test tests/*.test.mjs
pnpm run test:preference
pnpm run test:metatask
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/main/main.ts package.json
git commit -m "feat: wire preference service and auto-reveal heartbeat"
```

Then write the handoff note described in the overview.
