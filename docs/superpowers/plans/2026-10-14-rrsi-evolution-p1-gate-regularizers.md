# RRSI Evolution P1 — Gate Regularizers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the capability gate from validating a lesson against the diary it came from, measure the gate's own noise with a second panel, remember falsified hypotheses so they are not re-proposed, and make all of it visible in a report.

**Architecture:** A pure module `capabilityGateRegularizers.ts` holds every rule (citations, prospective check, panel combination, hypothesis keys). `CoworkStore` gains a falsified-hypothesis ledger and a checked draft insert. `DreamService` runs each gate pass twice (panel B sees the drafts in reverse order), applies the prospective rule per panel, combines by agreement, writes the ledger on agreed demotions, and records telemetry. The dream prompt lists recent falsified hypotheses (`DREAM_VERSION` 17). `scripts/rrsi-evolution-report.mjs` reads the telemetry.

**Tech Stack:** TypeScript main process, sql.js stores, `node:test` against `dist-electron/`, Node 24 `node:sqlite` (report script only).

**Index / acceptance gate:** `docs/superpowers/plans/2026-10-14-rrsi-evolution-00-overview.md` (P1 gate). **Design:** `docs/superpowers/specs/2026-10-14-rrsi-regularized-dream-evolution-design.md` §6.1. **Prerequisite:** P0 merged (this plan exists on `main`).

## Global Constraints

All constraints in the overview apply. The ones that bite most in this phase:

- Branch `feat/rrsi-p1-gate`, worktree `.worktrees/rrsi-p1-gate`, from `main`. Never push, never merge.
- New libs are pure (no `Date.now()`, no I/O). `DreamService` passes `Date.now()` or `this.now().getTime()` in (its `this.now()` returns a `Date`).
- The ledger is written only on **agreed** demotions in the fresh gate and the re-review. Never from `updateCapabilityDraftValidation`, the prompt-layer rollback, the disputed-timeout sweep, or reconciliation merges.
- Prompt text is Simplified Chinese; copy the exact lines given below.
- Every new pass branch is wrapped so that a failure never fails the dream run.
- One commit per task + English dev-journal buzz after each commit.

---

## File structure

| File | Responsibility |
|---|---|
| `tests/fixtures/rrsiDreamHarness.mjs` | Create: shared DreamService test harness (electron patch, stores, chat router, seeding helpers) |
| `src/main/libs/capabilityGateRegularizers.ts` | Create: gate config, citation helpers, prospective rule, panel combination, hypothesis keys and similarity |
| `src/main/sqliteStore.ts` | Modify: create `capability_falsified_hypotheses` next to `capability_drafts` (~line 675) |
| `src/main/coworkStore.ts` | Modify: ledger types + 4 methods, `insertCapabilityDraftsChecked` (next to `insertCapabilityDrafts`, ~line 7260) |
| `src/main/libs/capabilityValidationPrompt.ts` | Modify: `prospective` rule lines, per-draft `similarFalsified` line |
| `src/main/services/dreamService.ts` | Modify: `capabilityGate` dep, fresh gate (~1380–1551), re-review (~1569–1666), `writeDreamResults` draft insert (~2903), dream prompt extras (~945–1042, ~1186), telemetry (~1148, ~1218) |
| `src/main/libs/dreamPrompt.ts` | Modify: `falsifiedHypotheses` input + section, `DREAM_VERSION` 17 |
| `src/main/services/memoryHygieneService.ts` | Modify: `capability-falsified` retention step after `capability-drafts` (~line 255) |
| `scripts/rrsi-evolution-report.mjs` | Create: read-only report (gate section) with exported `buildRrsiReport` / `formatRrsiReport` |
| `tests/capabilityGateRegularizers.test.mjs` | Create: pure vectors |
| `tests/capabilityFalsifiedLedger.test.mjs` | Create: schema, ledger, checked insert |
| `tests/capabilityProspectiveGate.test.mjs` | Create: prompt lines + multi-night DreamService flows |
| `tests/rrsiEvolutionReport.test.mjs` | Create: report over a fixture database |
| Existing dream tests | Modify only where the new gate semantics break them (Task 5 Step 6 rules) |
| `package.json` | Add `test:rrsi` |
| `.gitignore` | Allowlist the four new test files after `!tests/promptLayerRollback.test.mjs` (~line 433) |

---

### Task 0: Worktree and baseline

- [ ] **Step 1: Create the worktree from `main`**

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots
git worktree add .worktrees/rrsi-p1-gate -b feat/rrsi-p1-gate main
cd .worktrees/rrsi-p1-gate
pnpm install
test -f docs/superpowers/specs/2026-10-14-rrsi-regularized-dream-evolution-design.md && echo "design present"
```

Expected: `design present`. Otherwise stop: P0 is not merged.

- [ ] **Step 2: Record the baseline**

```bash
mkdir -p localdocs
pnpm run compile:electron
node --test tests/*.test.mjs 2>&1 | tail -60 > localdocs/rrsi-p1-baseline.txt
grep -E "^not ok|# fail" localdocs/rrsi-p1-baseline.txt
```

Also record which of these currently pass (they are the files this phase is most likely to disturb): `capabilityValidation`, `capabilityReconciliation`, `chainEvidenceValidation`, `promptLayerRollback`, `dreamCapabilityLearnings`, `dreamService`, `dreamTelemetryWeekly`, `counterfactualReplay`, `dreamPracticePipeline`, `dreamPrompt`, `memoryHygieneService`:

```bash
for f in capabilityValidation capabilityReconciliation chainEvidenceValidation promptLayerRollback dreamCapabilityLearnings dreamService dreamTelemetryWeekly counterfactualReplay dreamPracticePipeline dreamPrompt memoryHygieneService; do
  node --test tests/$f.test.mjs >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"
done | tee -a localdocs/rrsi-p1-baseline.txt
```

No commit for this task.

---

### Task 1: Shared DreamService test harness and `test:rrsi`

**Files:**
- Create: `tests/fixtures/rrsiDreamHarness.mjs`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Consumes: `createCoworkStore`, `createSqliteStore` (`tests/memoryTestUtils.mjs`); compiled `DreamService`, `DreamStore`, `MetaIDKnowledgeStore`.
- Produces (all exported from the fixture; later phases reuse them):
  - `BOT_ID = 5`, `LONG_IDENTITY` (same string as `tests/capabilityValidation.test.mjs`)
  - `MARKERS = { validation: '能力验证', reconciliation: '记忆核对' }` (P3 adds `usageAudit`)
  - `loadDreamServiceModule()` — the `Module._load` electron patch from `capabilityValidation.test.mjs:19-38`, requiring `../../dist-electron/main/services/dreamService.js`
  - `dayStartMs(dateKey: string): number` — local midnight of `YYYY-MM-DD`
  - `metabotStoreStub()` — one bot `{ id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true }`
  - `seedSession(coworkStore, db, dateKey, turns, options?)` — creates a session for bot 5 and inserts `turns` (`[{ type: 'user' | 'assistant', content }]`) into `cowork_messages` at `dayStartMs(dateKey) + 1000 * (i + 1)`; returns the session. Message ids must be unique across calls (use `${dateKey}-${sessionIndex}-${i}`).
  - `dreamJson(overrides?)` — a valid dream output string: `daily_summary` default `'今天交付了视频。'`, `sections: {}`, empty arrays for `work_reviews`, `important_memories`, `value_lessons`, `self_identity: LONG_IDENTITY`, `capability_learnings` / `practice_proposals` from overrides (snake_case keys accepted as given).
  - `createChatRouter()` → `{ performChat, calls, on(marker, responder), setFallback(responder) }`. `performChat(system, user)` appends `{ system, user }` to `calls`, finds the first registered marker contained in `system`, and calls `responder({ system, user, nth })` where `nth` is the 1-based count of calls for that marker **within the current dream run** (reset by `router.resetRun()`); objects are `JSON.stringify`'d, strings returned as-is. No marker → fallback (default `dreamJson()`).
  - `validationVerdicts(user, decide)` — parses every `### 草案 #<id>(…)` header and its following `标题:<title>` line from a validation prompt and returns `{ verdicts: drafts.map((d) => ({ id: d.id, ...decide(d) })) }`; `decide({ id, title, index })` returns `{ verdict, score, rationale }` or `null` (omit that draft).
  - `createDreamHarness(options?)` → `{ db, coworkStore, dreamStore, knowledgeStore, router, service, setNow(date), runNight(dateKey), telemetry(dateKey), cleanup }`. `options.capabilityGate` is passed to `DreamService` verbatim (omitted by default). The service uses `llmTimeoutMs: 5000`, `transientRetryDelaysMs: []`, `now: () => currentNow`, `metaidKnowledgeStore: new MetaIDKnowledgeStore(db, () => {}, () => currentNow.getTime())`. `runNight(dateKey)` calls `router.resetRun()`, sets `now` to 03:00 of the day after `dateKey`, and awaits `service.runNow(5, dateKey)`. `telemetry(dateKey)` returns `dreamStore.getRun(5, dateKey)?.telemetry ?? null`.

- [ ] **Step 1: Write the fixture** following the interface list above. Keep it framework-free (no `node:test` imports).

- [ ] **Step 2: Smoke-test the fixture inline**

Create a temporary file `tests/rrsiHarnessSmoke.tmp.mjs` (do not commit):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDreamHarness, seedSession, dreamJson } from './fixtures/rrsiDreamHarness.mjs';

test('harness runs one dream night', async () => {
  const h = await createDreamHarness();
  try {
    seedSession(h.coworkStore, h.db, '2026-08-02', [{ type: 'user', content: '视频好了吗' }, { type: 'assistant', content: '好了' }]);
    h.router.setFallback(() => dreamJson());
    await h.runNight('2026-08-02');
    assert.equal(h.dreamStore.getDailySummary(5, '2026-08-02')?.summaryText, '今天交付了视频。');
    assert.equal(h.telemetry('2026-08-02')?.emptyDay, false);
  } finally {
    h.cleanup();
  }
});
```

Run: `pnpm run compile:electron && node --test tests/rrsiHarnessSmoke.tmp.mjs` → PASS. Delete the temp file.

- [ ] **Step 3: Add `test:rrsi`** to `package.json` `scripts`, right after `test:dream-retry`:

```json
"test:rrsi": "pnpm run compile:electron && node --test tests/capabilityGateRegularizers.test.mjs tests/capabilityFalsifiedLedger.test.mjs tests/capabilityProspectiveGate.test.mjs tests/rrsiEvolutionReport.test.mjs tests/capabilityValidation.test.mjs tests/capabilityReconciliation.test.mjs tests/chainEvidenceValidation.test.mjs tests/promptLayerRollback.test.mjs tests/dreamCapabilityLearnings.test.mjs tests/dreamPrompt.test.mjs tests/memoryHygieneService.test.mjs",
```

(The new files do not exist yet; the script is run from Task 2 on.)

- [ ] **Step 4: Allowlist the new test files** in `.gitignore` directly after `!tests/promptLayerRollback.test.mjs`:

```
!tests/capabilityGateRegularizers.test.mjs
!tests/capabilityFalsifiedLedger.test.mjs
!tests/capabilityProspectiveGate.test.mjs
!tests/rrsiEvolutionReport.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore
git add -f tests/fixtures/rrsiDreamHarness.mjs
git commit -m "chore: add rrsi dream test harness and test:rrsi script"
```

---

### Task 2: Pure gate regularizers

**Files:**
- Create: `src/main/libs/capabilityGateRegularizers.ts`
- Test: `tests/capabilityGateRegularizers.test.mjs`

**Interfaces:**
- Consumes: `tokenizeKnowledgeBaseText` (`src/main/libs/knowledgeBaseText.ts`).
- Produces: exactly the P1 block of the overview's cross-phase contracts.

**Behavior (normative):**

- `CAPABILITY_GATE_DEFAULTS = { panels: 2, prospective: true }`. `resolveCapabilityGateConfig(input)` returns the defaults overridden by valid fields only: `panels` must be literally `1` or `2`; `prospective` must be a boolean. Anything else falls back to the default for that field.
- `citedDiaryDates(rationale)` returns the distinct `YYYY-MM-DD` substrings (regex `/\d{4}-\d{2}-\d{2}/g`) in first-occurrence order.
- `hasPostOriginCitation({ rationale, draftDreamDate, evidenceDates })` is true iff some cited date `d` satisfies `d > draftDreamDate` (string comparison of ISO dates) and `evidenceDates.has(d)`.
- `combinePanelOutcomes(a, b)`: if `a === null || b === null` → `{ outcome: 'hold', agreement: 'incomplete' }`; if `a === b` → `{ outcome: a, agreement: 'agreed' }`; else → `{ outcome: 'hold', agreement: 'disagreed' }`.
- `joinPanelRationales(a, b, maxChars = 600)` → `` `A: ${a.trim()} | B: ${b.trim()}` `` truncated to `maxChars` UTF-16 units (append `…` when cut). When `a.trim() === b.trim()`, return just `a.trim()` (truncated the same way).
- `hypothesisTitleKey(title)`: `title.normalize('NFKC').toLowerCase()`, then remove every char matching `/[\s\p{P}\p{S}]/gu`.
- `hypothesisTokens(text)`: `tokenizeKnowledgeBaseText(text)` filtered to tokens of length ≥ 2, de-duplicated, order preserved.
- `hypothesisSimilarity(a, b)`: let `A`, `B` be the token sets of `a` and `b`. If `min(|A|, |B|) < 2` return `0`. Else return `|A ∩ B| / min(|A|, |B|)` (overlap coefficient), rounded to 4 decimals.
- `findSimilarFalsified(title, ledger, minSimilarity = FALSIFIED_SIMILARITY_MIN)`: first entry whose `titleKey === hypothesisTitleKey(title)`; otherwise the entry with the highest `hypothesisSimilarity(title, entry.title)` that is `>= minSimilarity` (ties: earliest in input order); otherwise `null`.

- [ ] **Step 1: Write the failing test** `tests/capabilityGateRegularizers.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../dist-electron/main/libs/capabilityGateRegularizers.js');

test('gate config resolves defaults and rejects invalid overrides', () => {
  assert.deepEqual(R.resolveCapabilityGateConfig(), { panels: 2, prospective: true });
  assert.deepEqual(R.resolveCapabilityGateConfig({ panels: 1 }), { panels: 1, prospective: true });
  assert.deepEqual(R.resolveCapabilityGateConfig({ panels: 3, prospective: 'no' }), { panels: 2, prospective: true });
  assert.deepEqual(R.resolveCapabilityGateConfig({ prospective: false }), { panels: 2, prospective: false });
});

test('cited dates are distinct and ordered', () => {
  assert.deepEqual(R.citedDiaryDates('2026-08-03 好评;2026-08-02 来源;再看 2026-08-03'), ['2026-08-03', '2026-08-02']);
  assert.deepEqual(R.citedDiaryDates('没有日期'), []);
});

test('post-origin citation requires a later, provided diary date', () => {
  const evidenceDates = new Set(['2026-08-02', '2026-08-03']);
  const check = (rationale) => R.hasPostOriginCitation({ rationale, draftDreamDate: '2026-08-02', evidenceDates });
  assert.equal(check('2026-08-03 日记显示交付获赞'), true);
  assert.equal(check('2026-08-02 当天就成功了'), false);
  assert.equal(check('2026-08-05 之后也成功'), false);
  assert.equal(check('一直都很好'), false);
});

test('panel outcomes combine by agreement', () => {
  const c = R.combinePanelOutcomes;
  assert.deepEqual(c('promote', 'promote'), { outcome: 'promote', agreement: 'agreed' });
  assert.deepEqual(c('demote', 'demote'), { outcome: 'demote', agreement: 'agreed' });
  assert.deepEqual(c('hold', 'hold'), { outcome: 'hold', agreement: 'agreed' });
  assert.deepEqual(c('promote', 'hold'), { outcome: 'hold', agreement: 'disagreed' });
  assert.deepEqual(c('promote', 'demote'), { outcome: 'hold', agreement: 'disagreed' });
  assert.deepEqual(c('promote', null), { outcome: 'hold', agreement: 'incomplete' });
  assert.deepEqual(c(null, null), { outcome: 'hold', agreement: 'incomplete' });
});

test('panel rationales join and collapse when identical', () => {
  assert.equal(R.joinPanelRationales('甲', '乙'), 'A: 甲 | B: 乙');
  assert.equal(R.joinPanelRationales(' 同 ', '同'), '同');
  assert.equal(R.joinPanelRationales('x'.repeat(700), 'y').length, 600);
});

test('hypothesis keys ignore whitespace, punctuation and case', () => {
  assert.equal(R.hypothesisTitleKey('  先验证、再交付！ '), '先验证再交付');
  assert.equal(R.hypothesisTitleKey('Verify  Before Delivery.'), 'verifybeforedelivery');
});

test('hypothesis similarity is the token overlap coefficient', () => {
  assert.equal(R.hypothesisSimilarity('先验证再交付', '交付前先验证一遍'), 0.6);
  assert.equal(R.hypothesisSimilarity('先验证再交付', '深夜连环追问'), 0);
  assert.equal(R.hypothesisSimilarity('回复', '回复用户'), 0);
});

test('similar falsified lookup prefers exact key, then best overlap', () => {
  const ledger = [
    { id: 1, title: '深夜连环追问', titleKey: R.hypothesisTitleKey('深夜连环追问') },
    { id: 2, title: '交付前先验证一遍', titleKey: R.hypothesisTitleKey('交付前先验证一遍') },
    { id: 3, title: '先验证、再交付', titleKey: R.hypothesisTitleKey('先验证、再交付') },
  ];
  assert.equal(R.findSimilarFalsified('先验证再交付', ledger)?.id, 3);
  assert.equal(R.findSimilarFalsified('先验证再交付视频', ledger.slice(0, 2))?.id, 2);
  assert.equal(R.findSimilarFalsified('完全无关的标题', ledger), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/capabilityGateRegularizers.test.mjs`
Expected: FAIL (`Cannot find module …capabilityGateRegularizers.js`).

- [ ] **Step 3: Implement** `src/main/libs/capabilityGateRegularizers.ts` per the behavior list. Export the constants from the overview contract block. Add a short file header comment stating the module is pure and naming design §6.1.

- [ ] **Step 4: Run to verify it passes** (same command). Expected: PASS, 8 tests.

Note on the `0.6` vector: tokens of `先验证再交付` are {先验, 验证, 证再, 再交, 交付} (5); tokens of `交付前先验证一遍` are {交付, 付前, 前先, 先验, 验证, 证一, 一遍} (7); intersection {先验, 验证, 交付} = 3; 3 / 5 = 0.6.

- [ ] **Step 5: Commit**

```bash
git add src/main/libs/capabilityGateRegularizers.ts
git add -f tests/capabilityGateRegularizers.test.mjs
git commit -m "feat: add pure capability gate regularizers"
```

---

### Task 3: Falsified-hypothesis ledger and checked draft insert

**Files:**
- Modify: `src/main/sqliteStore.ts` (after the `capability_drafts` migration block, before `dream_practice_proposals`, ~line 675)
- Modify: `src/main/coworkStore.ts` (types near `CapabilityDraft` ~line 902; methods after `insertCapabilityDrafts` ~line 7290)
- Test: `tests/capabilityFalsifiedLedger.test.mjs`

**Interfaces:**
- Consumes: `hypothesisTitleKey`, `FALSIFIED_BLOCK_DAYS` (Task 2).
- Produces: the P1 `CoworkStore` block of the overview contracts.

**Schema (exact):**

```sql
CREATE TABLE IF NOT EXISTS capability_falsified_hypotheses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metabot_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('validation', 're_review')),
  source_draft_id INTEGER,
  falsified_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  UNIQUE (metabot_id, title_key)
);
CREATE INDEX IF NOT EXISTS idx_capability_falsified_metabot_time
  ON capability_falsified_hypotheses(metabot_id, falsified_at DESC);
```

Precede it with a 3–4 line comment: dream bookkeeping (not user memory), written only on agreed panel demotions, retention 180 days / 200 rows per bot.

**Method behavior:**

- `recordFalsifiedHypothesis(input)`: trims title (required, else `null`), computes `title_key` (empty key → `null`), truncates `description` to 600 and `reason` to 300 chars. `INSERT … ON CONFLICT(metabot_id, title_key) DO UPDATE SET title, description, reason, source, source_draft_id, falsified_at = excluded.*` (keeps `hit_count`). Saves the DB. Returns the row.
- `listFalsifiedHypotheses(metabotId, { sinceMs, limit })`: rows of the bot with `falsified_at >= sinceMs` (when given), `ORDER BY falsified_at DESC, id DESC`, `LIMIT` (default 200, clamp 1–500).
- `markFalsifiedHypothesisHit(id, atMs = Date.now())`: `hit_count = hit_count + 1, last_hit_at = atMs`. Returns whether a row changed.
- `purgeFalsifiedHypotheses({ cutoffMs, maxPerBot, excludeMetabotIds })`: delete rows with `falsified_at < cutoffMs`, then per bot delete all but the newest `maxPerBot` (by `falsified_at DESC, id DESC`); skip bots in `excludeMetabotIds`. Returns the total deleted. Saves only when > 0.
- `insertCapabilityDraftsChecked(metabotId, dreamDate, learnings, { nowMs = Date.now() })`:
  1. Validate entries exactly like `insertCapabilityDrafts` (trimmed non-empty title and description, default type `'skill'`).
  2. Load the bot's live drafts (`status IN ('draft', 'validated', 'disputed')`) and build a set of their title keys.
  3. Load ledger rows with `falsified_at >= nowMs - FALSIFIED_BLOCK_DAYS * 86_400_000` into a map key → row.
  4. For each entry in order: key in the live set → `skippedDuplicate += 1`; key in the ledger map → `markFalsifiedHypothesisHit(row.id, nowMs)`, `skippedFalsified += 1`; else INSERT (same SQL as `insertCapabilityDrafts`), push the new id (`SELECT last_insert_rowid()`), and add the key to the live set (so a batch cannot insert the same key twice).
  5. Save once if anything changed. Return `{ inserted, insertedIds, skippedDuplicate, skippedFalsified }`.
- Leave `insertCapabilityDrafts` unchanged (other callers and tests use it).

- [ ] **Step 1: Write the failing test** `tests/capabilityFalsifiedLedger.test.mjs`. Use `createSqliteStore` / `createCoworkStore` / `getColumns` from `./memoryTestUtils.mjs`. Cases:

  1. *Schema is idempotent:* after `createSqliteStore()`, `getColumns(db, 'capability_falsified_hypotheses')` includes all 11 columns; calling `store.initializeTables(userDataPath)` a second time does not throw and keeps existing rows.
  2. *Record upserts by title key:* recording `'先验证再交付'` then `' 先验证、再交付 '` with a different reason leaves one row whose `reason` is the second one and `hitCount === 0`.
  3. *Source CHECK:* a raw `INSERT` with `source = 'rollback'` throws.
  4. *List order and window:* three rows at `falsifiedAt` 1000, 3000, 2000 list as 3000, 2000, 1000; `sinceMs: 2000` returns two.
  5. *Purge:* with rows at 1000 and 5000 and `cutoffMs: 2000` one is deleted; with 5 rows and `maxPerBot: 3` the two oldest go; a bot in `excludeMetabotIds` is untouched.
  6. *Checked insert, duplicates:* an existing `draft` titled `先验证再交付` → inserting `['先验证再交付', '新技巧', '新技巧']` returns `{ inserted: 1, skippedDuplicate: 2, skippedFalsified: 0 }` and `insertedIds.length === 1`.
  7. *Checked insert, falsified block:* a ledger row falsified 10 days before `nowMs` blocks the same title (`skippedFalsified: 1`, ledger `hitCount === 1`, `lastHitAt === nowMs`); a row falsified 31 days before does not block (`inserted: 1`).
  8. *Rejected drafts are not live:* an existing `rejected` draft with the same title does not block insertion.

- [ ] **Step 2: Run to verify it fails.** `pnpm run compile:electron && node --test tests/capabilityFalsifiedLedger.test.mjs` → FAIL.

- [ ] **Step 3: Implement** the DDL and methods. Export the new types from `coworkStore.ts`.

- [ ] **Step 4: Run to verify it passes.** Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/sqliteStore.ts src/main/coworkStore.ts
git add -f tests/capabilityFalsifiedLedger.test.mjs
git commit -m "feat: add falsified capability hypothesis ledger and checked draft insert"
```

---

### Task 4: Validation prompt — prospective rule and similar-falsified line

**Files:**
- Modify: `src/main/libs/capabilityValidationPrompt.ts`
- Test: `tests/capabilityProspectiveGate.test.mjs` (prompt section; flows are added in Task 5)

**Interfaces:**
- `CapabilityValidationDraftInput` gains `similarFalsified?: { title: string; reason: string; falsifiedDate: string } | null`.
- `buildCapabilityValidationPrompt` input gains `prospective?: boolean` (default `false`, so existing callers and tests see the unchanged prompt).

**Exact text:**

- When `prospective === true`, append to the system lines (after the last existing line):
  `'独立证据规则:草案提炼当天的日记是它的来源,不算独立证据。判 validated 时,rationale 必须至少引用一篇日期晚于该草案提炼日期、且出现在下方日记列表中的日记;做不到就判 keep_draft。'`
- When `prospective === true`, append to the output contract, after `'每条草案都必须有且仅有一条 verdict;id 必须来自上方草案列表。'`:
  `'validated 的 rationale 里必须写出那篇较晚日记的日期(YYYY-MM-DD)。'`
- Per draft, when `similarFalsified` is set, add after the `描述:` line:
  `` `曾被证伪的相似做法:「${title}」(${falsifiedDate} 否决:${truncate(reason, 120)})` ``
- When at least one draft has `similarFalsified`, append to the user prompt, right before `## 输出契约`:
  `'标注了「曾被证伪的相似做法」的草案:除非日记里出现了那次否决日期之后的新证据,否则不得判 validated。'` followed by an empty line.

- [ ] **Step 1: Write the failing prompt tests** in a new `tests/capabilityProspectiveGate.test.mjs` (keep the file; Task 5 appends flows):
  - `prospective: true` → `system` contains `独立证据规则` and `user` contains `较晚日记的日期`; `prospective` omitted → neither appears (regression guard for old callers).
  - A draft with `similarFalsified: { title: '先验证再交付', reason: '照做后被差评', falsifiedDate: '2026-07-20' }` renders `曾被证伪的相似做法:「先验证再交付」(2026-07-20 否决:照做后被差评)` and the rule line; a prompt without such drafts has neither.

- [ ] **Step 2: Run to verify it fails.** `pnpm run compile:electron && node --test tests/capabilityProspectiveGate.test.mjs` → FAIL.

- [ ] **Step 3: Implement.** Keep all existing lines byte-identical.

- [ ] **Step 4: Run** the new file and `tests/capabilityValidation.test.mjs` → both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/libs/capabilityValidationPrompt.ts
git add -f tests/capabilityProspectiveGate.test.mjs
git commit -m "feat: add prospective and falsified-history rules to the validation prompt"
```

---

### Task 5: Fresh-draft gate — prospective, dual panel, ledger, telemetry

**Files:**
- Modify: `src/main/services/dreamService.ts` (`DreamServiceDeps` ~287; constructor ~411; `validateCapabilityDraftsAfterDream` ~1380–1551)
- Test: `tests/capabilityProspectiveGate.test.mjs` (append flows); existing dream tests per Step 6

**Interfaces:**
- Consumes: Task 2 helpers, Task 3 ledger methods, Task 4 prompt inputs.
- Produces: `DreamServiceDeps.capabilityGate?: Partial<CapabilityGateConfig>`; the `validation` telemetry object gains `deferredSameNight: number`, `prospectiveDowngraded: number`, `panels: { agreed: number; disagreed: number; incomplete: number }` (existing keys `checked`, `validated`, `rejected`, `validatedIds`, `chainEvidence` keep their meaning: `validated` / `rejected` now count **agreed** outcomes).

**Algorithm (replaces the body after the disputed-timeout sweep; the sweep is unchanged):**

1. `const gate = resolveCapabilityGateConfig(this.deps.capabilityGate)` — resolve once in the constructor and store as `this.capabilityGate`.
2. `disputed = listCapabilityDrafts(status 'disputed')`; `freshAll = listCapabilityDrafts(status 'draft')`.
   `fresh = gate.prospective ? freshAll.filter((d) => d.dreamDate < date) : freshAll`; `deferredSameNight = freshAll.length - fresh.length`.
   `pending = [...disputed, ...fresh].slice(0, CAPABILITY_VALIDATION_MAX_DRAFTS)`.
   If `pending` is empty, return the zero result **with** `deferredSameNight` set.
3. `recentSummaries` as today. `evidenceDates = new Set(recentSummaries.map((s) => s.summaryDate))` — the bare `date` is no longer added.
4. Chain digest exactly as today.
5. Falsified context: `ledger = coworkStore.listFalsifiedHypotheses(metabot.id, { sinceMs: Date.now() - FALSIFIED_RETENTION_DAYS * 86_400_000 })`; per pending draft `similar = findSimilarFalsified(draft.title, ledger)`; pass `similarFalsified: similar ? { title, reason, falsifiedDate: formatBotWorkspaceDate(new Date(similar.falsifiedAt)) } : null`.
6. Build `promptA` with drafts in `pending` order and `prospective: gate.prospective`. Call the LLM (`callDreamLlm(…, 4096)`), parse. On parse failure return `{ ...zero, checked: pending.length, deferredSameNight, chainEvidence, panels: { agreed: 0, disagreed: 0, incomplete: pending.length } }` without calling panel B.
7. If `gate.panels === 2`: build `promptB` with the same inputs but `drafts` reversed; call, parse. A panel-B call that throws or fails to parse yields an empty verdict list (every draft becomes `incomplete`). If `gate.panels === 1`, panel B is panel A.
8. For each panel separately, apply the existing date-grounding filter (against the new `evidenceDates`) and the chain-grounding filter, then — when `gate.prospective` — for every remaining `validated` verdict, if `!hasPostOriginCitation({ rationale, draftDreamDate: draft.dreamDate, evidenceDates })` replace it with `{ ...verdict, verdict: 'keep_draft' }` and remember the draft id in a `downgradedIds` set.
9. Classify each panel's verdict for each pending draft: none → `null`; `validated && score >= CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE` → `'promote'`; `rejected` → `'demote'`; otherwise `'hold'`.
10. `combinePanelOutcomes(a, b)` per draft; count `agreed` / `disagreed` / `incomplete`.
11. Apply outcomes:
    - `promote`: `updateCapabilityDraftValidation({ status: 'validated', validationScore: min(scoreA, scoreB), validationNotes: joinPanelRationales(ratA, ratB) })`; push to `validatedIds`.
    - `demote`: same call with `status: 'rejected'`, then `recordFalsifiedHypothesis({ metabotId, title: draft.title, description: draft.description, reason: truncate(ratA, 300), source: 'validation', sourceDraftId: draft.id })` inside its own `try/catch` (a ledger failure never undoes the verdict).
    - `hold`: no write.
12. Return `{ checked: pending.length, validated, rejected, validatedIds, chainEvidence, deferredSameNight, prospectiveDowngraded: downgradedIds.size, panels }`.
13. Update the zero object and the return type accordingly (`deferredSameNight: 0, prospectiveDowngraded: 0, panels: { agreed: 0, disagreed: 0, incomplete: 0 }`). Update the existing log line to include `agreed/disagreed/incomplete`.

- [ ] **Step 1: Write the failing flow tests** (append to `tests/capabilityProspectiveGate.test.mjs`, using the harness). Use `D1 = '2026-08-02'`, `D2 = '2026-08-03'`, `D3 = '2026-08-04'`. In each scenario, seed a session on every dreamed date (otherwise the empty-day path runs).
  1. *Same-night deferral:* night D1 dream output has `capability_learnings: [{ title: '先验证再交付', description: '交付前自检一遍', capabilityType: 'workflow' }]`. After `runNight(D1)`: no call contains `能力验证` (`router.calls.filter((c) => c.system.includes('能力验证')).length === 0`); the draft is `draft`; `telemetry(D1).validation.deferredSameNight === 1`.
  2. *Next-night validation with a later citation:* night D1 distills two learnings (`先验证再交付`, `交付前列清单`); continue to night D2 (fallback dream JSON `daily_summary: '交付后用户点赞。'`, no learnings). Both panels answer `validated`, score 0.9, rationale `'2026-08-03 日记显示照做后获赞'` for both drafts; reconciliation answers `keep` with conditions `'交付前'`. Expect: exactly 2 validation calls on D2; the draft ids appear in opposite order in the two prompts; both drafts are `validated` with `validationScore === 0.9` and `validationNotes === '2026-08-03 日记显示照做后获赞'` (identical rationales collapse); `telemetry(D2).validation.panels` deep-equals `{ agreed: 2, disagreed: 0, incomplete: 0 }`.
  3. *Own-date citation is downgraded:* same as 2 but rationale `'2026-08-02 当天就做成了'` → draft stays `draft`; `prospectiveDowngraded === 1`; `panels.agreed === 1` (both panels hold).
  4. *Disagreement holds:* panel A validated (later citation), panel B `keep_draft` → stays `draft`; `panels.disagreed === 1`.
  5. *Panel-B failure is incomplete:* panel B returns `'not json'` → stays `draft`; `panels.incomplete === 1`; the dream run still completes (`dreamStore.getRun(5, D2).status === 'completed'`).
  6. *Agreed rejection writes the ledger:* night D2 both panels `rejected`, score 0.8, rationale `'2026-08-03 照做后被差评'` → status `rejected`; `listFalsifiedHypotheses(5)` has one row with `source === 'validation'` and `sourceDraftId` equal to the draft id.
  6b. *Re-proposal is skipped* (separate test declared with `{ todo: 'enabled in Task 7' }` so it does not fail yet): continue scenario 6 to night D3 whose dream output re-proposes the same title → `telemetry(D3).capabilityDraftInsert.skippedFalsified === 1`, ledger `hitCount === 1`, and no new `draft` row with that title.
  7. *Disputed timeout writes no ledger:* seed a `disputed` draft whose `created_at`/`validated_at` are older than `DISPUTED_AUTO_REJECT_DAYS` (use the same seeding approach as the existing disputed tests in `tests/capabilityReconciliation.test.mjs`); after a night it is `rejected` and the ledger is empty.
  8. *Legacy configuration:* `createDreamHarness({ capabilityGate: { panels: 1, prospective: false } })`, night D1 with one learning and a validator answering `validated` 0.9 → validated the same night with exactly one validation call (the pre-P1 behavior).

- [ ] **Step 2: Run to verify they fail.** `pnpm run compile:electron && node --test tests/capabilityProspectiveGate.test.mjs` → the flow tests FAIL.

- [ ] **Step 3: Implement** the algorithm above.

- [ ] **Step 4: Run the new file** → PASS (scenario 6b is reported as `todo`).

- [ ] **Step 5: Run the disturbed existing tests**

```bash
for f in capabilityValidation capabilityReconciliation chainEvidenceValidation promptLayerRollback dreamCapabilityLearnings dreamService dreamTelemetryWeekly counterfactualReplay dreamPracticePipeline; do
  node --test tests/$f.test.mjs >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"
done
```

- [ ] **Step 6: Repair existing tests by these rules (no other edits):**
  - **Gate-subject tests move to the new semantics.** `tests/capabilityValidation.test.mjs` scenario `dream run validates pending capability drafts against recorded history` becomes a two-night flow (drafts distilled on night 1, validated on night 2 with a later citation) and its call-count assertion counts both panels. Replace the assertion "embeds tonight's freshly written diary as history" with: the night-1 run makes no validation call, and the night-2 validation prompt contains night 2's diary.
  - **Tests whose subject is downstream of the gate pin only the dimension that is not their subject**, via the harness option or by adding `capabilityGate: { … }` to their `new DreamService({ … })`: reconciliation, rollback, practice, telemetry, counterfactual tests may use `{ panels: 1, prospective: false }`; `chainEvidenceValidation.test.mjs` keeps `panels: 2` where its fake LLM answers both panels identically and pins `prospective: false` for same-night scenarios.
  - **Do not weaken an assertion** (no deleted asserts, no widened tolerances). If a test cannot be repaired by these rules, stop and report it.
  - Record every changed assertion (file, test name, old → new, reason) in `localdocs/rrsi-p1-test-changes.md` for the handoff note.

- [ ] **Step 7: Run** `pnpm run test:rrsi` (new files that do not exist yet may be removed from the command temporarily — restore before committing) and the Step 5 loop → all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/services/dreamService.ts
git add -f tests/capabilityProspectiveGate.test.mjs tests/capabilityValidation.test.mjs tests/capabilityReconciliation.test.mjs tests/chainEvidenceValidation.test.mjs tests/promptLayerRollback.test.mjs tests/dreamCapabilityLearnings.test.mjs tests/dreamService.test.mjs tests/dreamTelemetryWeekly.test.mjs tests/counterfactualReplay.test.mjs tests/dreamPracticePipeline.test.mjs
git commit -m "feat: gate capability drafts on prospective, dual-panel agreement"
```

(Stage only the existing test files you actually changed.)

---

### Task 6: Re-review — dual panel and ledger

**Files:**
- Modify: `src/main/services/dreamService.ts` (`reReviewValidatedCapabilityDrafts` ~1569–1666; telemetry blocks)
- Test: `tests/capabilityProspectiveGate.test.mjs` (append)

**Interfaces:**
- Produces: the method returns `{ reReviewed, demoted, panels }`; the run telemetry gains `reReviewPanels` (same shape as `validation.panels`). `reReviewed` and `demoted` stay top-level telemetry keys as today.

**Algorithm:**

1. Unchanged selection (`listReReviewableCapabilityDrafts`) and summaries; `evidenceDates` = summary dates only.
2. Panel A as today plus `prospective: gate.prospective`; panel B with drafts reversed when `gate.panels === 2` (same failure handling as Task 5).
3. Per panel: date grounding, then the prospective downgrade of `validated` verdicts (same helper as Task 5).
4. Classify per panel: none → `null`; `validated` → `'promote'`; `rejected && score < CAPABILITY_PROMOTION_MIN_SCORE` → `'demote'`; otherwise `'hold'`.
5. Combine and apply:
   - `demote` (agreed): existing demotion code (status `rejected`, score `min`, notes joined, archive the promoted procedure), then `recordFalsifiedHypothesis({ …, source: 're_review' })` in its own `try/catch`;
   - `promote` (agreed): `markCapabilityDraftReviewed({ validationScore: min(scoreA, scoreB), validationNotes: joined })`;
   - `hold` with agreement `agreed`: `markCapabilityDraftReviewed({ validationScore: null, validationNotes: joined })`;
   - `hold` with agreement `disagreed`: `markCapabilityDraftReviewed({ validationScore: null, validationNotes: `panels disagreed — ${joined}` })`;
   - `incomplete`: no write (the draft is retried next night).
6. Return `{ reReviewed: pending.length, demoted, panels }`; add `reReviewPanels: reReview.panels` to the non-empty-night telemetry object (the empty-day path does not run the re-review; leave it untouched).

- [ ] **Step 1: Write the failing tests** (append). Seed one `validated` draft (insert, then `updateCapabilityDraftValidation` to `validated` with score 0.9, then raw SQL `UPDATE capability_drafts SET validated_at = ?, last_reviewed_at = NULL, dream_date = '2026-06-01'` with `Date.now() - 40 * 86_400_000`). Seed a D1 diary and a D2 session, then run night D2. No fresh draft is pending, so the fresh gate makes no LLM call and the re-review panels are the 1st (A) and 2nd (B) `能力验证` calls of the night (both prompts contain the seeded draft id). Then:
  1. *Agreed demotion:* both panels answer `rejected` score 0.5 with rationale `'2026-08-03 照做后被差评'` → status `rejected`; ledger row `source === 're_review'`; `telemetry(D2).demoted === 1`, `telemetry(D2).reReviewPanels.agreed === 1`.
  2. *Disagreement refreshes the review clock:* A `rejected` 0.5, B `validated` 0.9 → still `validated`; `lastReviewedAt` not null; notes start with `panels disagreed`.
  3. *Incomplete does not:* B returns `'not json'` → `lastReviewedAt` stays null.

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file + `tests/capabilityValidation.test.mjs` (its re-review tests) → PASS; repair existing re-review assertions with the Task 5 Step 6 rules and log them.
- [ ] **Step 5: Commit**

```bash
git add src/main/services/dreamService.ts
git add -f tests/capabilityProspectiveGate.test.mjs
git commit -m "feat: require panel agreement for capability re-review demotions"
```

---

### Task 7: Checked draft insert and the falsified section in the dream prompt

**Files:**
- Modify: `src/main/services/dreamService.ts` (`writeDreamResults` ~2903–2922 and its return type; `prepareDreamPromptAndOutput` `dreamExtras` ~945–1042; `runDream` ~1186 and telemetry ~1218)
- Modify: `src/main/libs/dreamPrompt.ts` (`buildDreamPrompt` input ~463–483; sections ~610–620; `DREAM_VERSION` ~48–54)
- Test: `tests/capabilityProspectiveGate.test.mjs` (enable scenario 6's `todo`), `tests/dreamPrompt.test.mjs` (append)

**Interfaces:**
- `buildDreamPrompt` input gains `falsifiedHypotheses?: Array<{ title: string; reason: string }>`.
- `dreamExtras` gains `falsifiedHypotheses?: Array<{ title: string; reason: string }>`; every `buildDreamPrompt` call that receives `rollbackNotice` also receives `falsifiedHypotheses`.
- `writeDreamResults` returns `{ dedupMerged, capabilityDraftInsert: { inserted: number; skippedDuplicate: number; skippedFalsified: number } }` (zeros when there were no learnings or the insert threw).
- Telemetry: `capabilityDraftInsert` on non-empty nights.

**Exact prompt text** (in `buildDreamPrompt`, right after the rollback-notice section, only when `sourceMode !== 'fragment'` and the list is non-empty; at most `FALSIFIED_PROMPT_MAX_ITEMS` entries, reason truncated to 120 chars with the file's `truncateText`):

```
## 已被证伪的做法(过去的能力验证已否决;除非今天的记录里出现了新的反证,不要再以相同或换个说法的形式写进 capability_learnings)
- 「<title>」:<reason>
```

**`DREAM_VERSION`:** set to `17` (or current `main` + 1) and add this line to the doc comment: ` * v17: RRSI P1 — falsified-hypothesis section rides the prompt; capability drafts insert with duplicate / falsified checks.`

- [ ] **Step 1: Write the failing tests:**
  - `tests/dreamPrompt.test.mjs`: `buildDreamPrompt` with two falsified items renders the header and both `- 「…」:…` lines; with `sourceMode: 'fragment'` or an empty list it renders neither.
  - Remove the `todo` option from scenario 6b in `tests/capabilityProspectiveGate.test.mjs`, and add: the D3 dream call's `user` contains `已被证伪的做法` and the falsified title; a fresh harness night with an empty ledger has no such section.
  - In `tests/capabilityProspectiveGate.test.mjs`, a version-repair style duplicate: run night D1 twice with the same learning (call `runNight(D1)` again after bumping nothing — use `service.runNow(5, D1)` directly) → only one draft row exists (`skippedDuplicate === 1` in the second run's telemetry).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** In `runDream`, build the list once per run: `listFalsifiedHypotheses(metabotId, { sinceMs: Date.now() - FALSIFIED_RETENTION_DAYS * 86_400_000, limit: FALSIFIED_PROMPT_MAX_ITEMS }).map(({ title, reason }) => ({ title, reason }))` inside `try/catch` (failure → `[]`).
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS (`dreamPrompt.test.mjs` included).
- [ ] **Step 5: Commit**

```bash
git add src/main/services/dreamService.ts src/main/libs/dreamPrompt.ts
git add -f tests/capabilityProspectiveGate.test.mjs tests/dreamPrompt.test.mjs
git commit -m "feat: show falsified hypotheses to the dream and dedupe draft inserts"
```

---

### Task 8: Ledger retention step

**Files:**
- Modify: `src/main/services/memoryHygieneService.ts` (new step right after `capability-drafts`, ~line 264)
- Test: `tests/memoryHygieneService.test.mjs` (append)

**Behavior:** step name `capability-falsified`; runs `context.coworkStore.purgeFalsifiedHypotheses({ cutoffMs: context.nowMs - FALSIFIED_RETENTION_DAYS * 86_400_000, maxPerBot: FALSIFIED_MAX_PER_BOT, excludeMetabotIds: context.disabledMetabotIds })`; returns `{ capabilityFalsifiedPurged: n }`. No new config field (the retention is a constant, not a user setting).

- [ ] **Step 1: Write the failing test:** a manual hygiene pass deletes a ledger row falsified 181 days ago, keeps one from 179 days ago, and reports `capabilityFalsifiedPurged: 1`. If an existing test asserts the exact list of step names or counters, extend it with the new step (log the change).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/memoryHygieneService.test.mjs` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/services/memoryHygieneService.ts
git add -f tests/memoryHygieneService.test.mjs
git commit -m "feat: add retention for the falsified hypothesis ledger"
```

---

### Task 9: Read-only evolution report

**Files:**
- Create: `scripts/rrsi-evolution-report.mjs`
- Test: `tests/rrsiEvolutionReport.test.mjs`

**Interfaces:**
- CLI: `node scripts/rrsi-evolution-report.mjs [--db <path>] [--days <n=30>] [--bot <id>] [--today <YYYY-MM-DD>] [--json]`.
- Default DB path: macOS `~/Library/Application Support/IDBots/idbots.sqlite`; Windows `%APPDATA%\IDBots\idbots.sqlite`; Linux `~/.config/IDBots/idbots.sqlite`.
- Opens `new DatabaseSync(dbPath, { readOnly: true })` from `node:sqlite`. Never writes.
- Exports `buildRrsiReport(db, { days, botId, today })` (pure over the handle) and `formatRrsiReport(report)` (text). Runs the CLI only when invoked directly (`import.meta.url === pathToFileURL(process.argv[1]).href`).
- Exit code 0 on success, 1 on failure (message on stderr).

**Report shape (P1):**

```js
{
  generatedAt: '<ISO>',
  window: { days: 30, fromDate: 'YYYY-MM-DD', toDate: 'YYYY-MM-DD' },
  missing: ['capability_falsified_hypotheses'],          // tables absent in this DB
  bots: [{
    metabotId: 5, name: '小火',
    nights: { total: 12, nonEmpty: 9 },
    gate: {
      nightsWithPanels: 3,                                // nights whose telemetry has validation.panels
      checked: 0, validated: 0, rejected: 0,
      deferredSameNight: 0, prospectiveDowngraded: 0,
      panels: { agreed: 0, disagreed: 0, incomplete: 0 },
      disagreementRate: null,                             // disagreed / (agreed + disagreed), 4 decimals; null when 0/0
      reReviewed: 0, demoted: 0,
      reReviewPanels: { agreed: 0, disagreed: 0, incomplete: 0 },
      draftInsert: { inserted: 0, skippedDuplicate: 0, skippedFalsified: 0 },
      promoted: 0,
    },
    falsifiedLedger: { size: 0, hitsInWindow: 0, newestTitles: [] } | null,   // null when the table is missing
  }],
}
```

Data sources: `metabots(id, name)`; `metabot_dream_telemetry_daily` rows with `dream_date` in `[fromDate, toDate]` (`extra_json` parsed; missing keys count as 0; `nights.total` = rows, `nights.nonEmpty` = rows with `empty_day = 0`; `checked/validated/rejected/promoted/reReviewed/demoted` from the flat columns); `capability_falsified_hypotheses` (`size` = rows of the bot, `hitsInWindow` = rows with `last_hit_at` inside the window, `newestTitles` = 5 newest titles). `fromDate = today - (days - 1)`; `today` defaults to the local date.

Text format: one block per bot, e.g.

```
Bot 5 小火 — 30d window 2026-07-06..2026-08-04 (12 nights, 9 non-empty)
  gate: checked 14, validated 2, rejected 3, deferred 5, downgraded 1
  panels: agreed 11, disagreed 2, incomplete 1 → disagreement 15.38%
  re-review: 4 reviewed, 1 demoted (panels 3/1/0)
  drafts: inserted 9, dup-skipped 2, falsified-skipped 1; promoted 2
  falsified ledger: 4 rows, 1 hit in window; newest: 先验证再交付, …
```

- [ ] **Step 1: Write the failing test** `tests/rrsiEvolutionReport.test.mjs`:
  - Build a DB with `createSqliteStore()` (+ `new DreamStore(db, () => {})` so its tables exist). Insert `metabots` row id 5 if absent. For three dates call `dreamStore.beginRun(5, date, null, 17)` then `dreamStore.updateRunTelemetry(5, date, telemetry)` with hand-written telemetry objects containing the P1 keys (one night with `emptyDay: true`). Record two ledger rows (one with a hit inside the window).
  - Export: `fs.writeFileSync(file, Buffer.from(db.export()))`; open with `new DatabaseSync(file, { readOnly: true })`; `import { buildRrsiReport, formatRrsiReport } from '../scripts/rrsi-evolution-report.mjs'`.
  - Assert the summed counters, `disagreementRate` (e.g. agreed 3 + disagreed 1 → `0.25`), `nights.nonEmpty === 2`, `falsifiedLedger.size === 2`, `hitsInWindow === 1`.
  - Drop the ledger table in a second exported copy → `missing` includes it and `falsifiedLedger === null`.
  - `formatRrsiReport(report)` contains `disagreement 25.00%`.
  - CLI smoke: `spawnSync(process.execPath, ['scripts/rrsi-evolution-report.mjs', '--db', file, '--json', '--today', '<last date>'])` exits 0 and prints JSON whose `bots[0].metabotId === 5`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Guard every table/column read with `SELECT name FROM sqlite_master WHERE type='table' AND name=?` and `PRAGMA table_info`.
- [ ] **Step 4: Run** `node --test tests/rrsiEvolutionReport.test.mjs` → PASS. Also run it once against a copy of the real database if one exists locally (`cp ~/Library/Application\ Support/IDBots/idbots.sqlite /tmp/idbots-copy.sqlite`) and paste the text output into the handoff note as the pre-P1 baseline (do not commit the copy).
- [ ] **Step 5: Commit**

```bash
git add scripts/rrsi-evolution-report.mjs
git add -f tests/rrsiEvolutionReport.test.mjs
git commit -m "feat: add read-only RRSI evolution report script"
```

---

### Task 10: Phase verification and handoff

- [ ] **Step 1: Full verification**

```bash
pnpm run compile:electron 2>&1 | tail -5
pnpm run build:skills 2>&1 | tail -5
pnpm run lint 2>&1 | tail -5
pnpm run test:rrsi 2>&1 | tail -15
node --test tests/*.test.mjs 2>&1 | tail -40
grep -nE "Date\.now|Math\.random" src/main/libs/capabilityGateRegularizers.ts   # expect no output
```

Compare the failing-file list with `localdocs/rrsi-p1-baseline.txt`: no new failing file.

- [ ] **Step 2: Self-check against the P1 acceptance gate** in the overview; fix anything unchecked.
- [ ] **Step 3: Write the handoff note** (overview format) including `localdocs/rrsi-p1-test-changes.md` and the baseline report output. Do not merge, push, or delete the worktree.
