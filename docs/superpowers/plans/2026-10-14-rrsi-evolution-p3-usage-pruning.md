# RRSI Evolution P3 — Usage Evidence and L1 Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn from evidence which hot-layer items the bot actually applies, order the two hot rosters by that evidence (with one slot kept for a newcomer), and move items that keep being shown but never used out of the hot layer without deleting anything.

**Architecture:** After promotion on a non-empty night, one bounded LLM pass ("使用核查") compares the day's exposed items with sampled assistant replies and writes `applied` / `evidence` into the P2 `hot_layer_usage` rows. A shared SQL helper aggregates audited nights per item. Pure functions rank the rosters, pick demotions (max 2 per night), and pick re-entries. Techniques demote to the new draft status `dormant`; procedures become recall-only with `hot_reason = 'unused'` and re-enter when applied again.

**Tech Stack:** TypeScript main process, sql.js stores, `node:test` against `dist-electron/`.

**Index / acceptance gate:** `docs/superpowers/plans/2026-10-14-rrsi-evolution-00-overview.md` (P3 gate). **Design:** spec §6.3. **Prerequisite:** P2 merged into `main`.

## Global Constraints

All constraints in the overview apply. Phase-specific:

- Branch `feat/rrsi-p3-usage`, worktree `.worktrees/rrsi-p3-usage`, from `main`. Never push, never merge.
- **Nothing is deleted.** Demotion changes a status or an eligibility flag only; the row counts of `capability_drafts` and `metaid_knowledge_procedures` must not change because of this phase.
- The dream prompt and its parser are not touched: **no `DREAM_VERSION` change**.
- Only audited rows count as evidence. An exposure that was never audited (audit skipped, parse failure, item missing from the verdict list) neither earns nor loses standing.
- The audit pass and the pruning pass are best-effort: each is wrapped in `try/catch` and returns zero telemetry on failure; they never fail the dream run.
- The usage-audit system prompt contains the marker `使用核查` and must not contain `能力验证` or `记忆核对` (the shared harness routes calls by marker).
- Clocks: in `DreamService`, `this.now()` returns a `Date` (use `this.now().getTime()` for ms); in `MetaIDKnowledgeStore`, `this.now()` returns ms.
- One commit per task + English dev-journal buzz after each commit.

## Constants (exact)

| Name | Value | Where |
|---|---|---|
| `USAGE_AUDIT_MAX_ITEMS` | 12 | `hotLayerUsageAudit.ts` |
| `USAGE_AUDIT_MAX_EXCERPTS` | 40 | `hotLayerUsageAudit.ts` |
| `USAGE_AUDIT_EXCERPT_CHARS` | 280 | `hotLayerUsageAudit.ts` |
| `USAGE_AUDIT_ITEM_GIST_CHARS` | 160 | `hotLayerUsageAudit.ts` |
| `HOT_LAYER_UTILITY_WINDOW_DAYS` | 30 | `hotLayerPruning.ts` |
| `HOT_LAYER_GRACE_DAYS` | 14 | `hotLayerPruning.ts` |
| `HOT_LAYER_FRESH_SLOTS` | 1 | `hotLayerPruning.ts` |
| `HOT_LAYER_PRUNE_MIN_EXPOSED_NIGHTS` | 5 | `hotLayerPruning.ts` |
| `HOT_LAYER_PRUNE_MAX_PER_NIGHT` | 2 | `hotLayerPruning.ts` |
| `HOT_LAYER_REENTRY_WINDOW_DAYS` | 14 | `hotLayerPruning.ts` |
| `HOT_LAYER_REENTRY_MIN_APPLIED_NIGHTS` | 2 | `hotLayerPruning.ts` |

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/libs/hotLayerUsageQueries.ts` | Create: `queryHotLayerUsageStats(db, …)` shared by three stores |
| `src/main/libs/hotLayerPruning.ts` | Create: constants, `HotLayerCandidate`, `rankHotLayerItems`, `selectHotLayerDemotions`, `selectHotLayerReentries` |
| `src/main/libs/hotLayerUsageAudit.ts` | Create: excerpt sampling, item selection, prompt builder, parser |
| `src/main/libs/predictionLedger.ts` | Add the `export` keyword to the existing `shiftDateKey` (no other change) |
| `src/main/sqliteStore.ts` | `capability_drafts.dormant_at` column |
| `src/main/coworkStore.ts` | `getCapabilityDraft`; `CapabilityDraft.dormantAt`; `markCapabilityDraftDormant`; ranked `listInjectableTechniques` |
| `src/main/metaidKnowledgeStore.ts` | Ranked `listHotProcedures`; `listUnusedProcedures` |
| `src/main/dreamStore.ts` | `listHotLayerExposures`, `recordHotLayerUsageVerdicts`, `listHotLayerUsageStats` |
| `src/main/services/dreamService.ts` | `runHotLayerUsageAudit`, `pruneHotLayerAfterDream`; telemetry `usageAudit`, `hotLayerPruning` |
| `scripts/rrsi-evolution-report.mjs` | `usage` section |
| `tests/fixtures/rrsiDreamHarness.mjs` | Add `MARKERS.usageAudit = '使用核查'` |
| `tests/hotLayerPruning.test.mjs` | Create |
| `tests/hotLayerUsageAudit.test.mjs` | Create |
| `tests/rrsiEvolutionReport.test.mjs`, `tests/hotLayerExposure.test.mjs` | Append |
| `package.json`, `.gitignore` | Append / allowlist the new test files |

---

### Task 0: Worktree and baseline

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots
git worktree add .worktrees/rrsi-p3-usage -b feat/rrsi-p3-usage main
git config extensions.worktreeConfig true
git -C .worktrees/rrsi-p3-usage config --worktree core.filemode false
cd .worktrees/rrsi-p3-usage
pnpm install
test -f src/main/libs/promotionBudget.ts && grep -q "hot_layer_usage" src/main/sqliteStore.ts && echo "P2 present"
```

Expected: `P2 present`. Otherwise stop.

- [ ] **Step 2: Baseline** — same commands as P1 Task 0 Step 2, writing `localdocs/rrsi-p3-baseline.txt`.

---

### Task 1: Usage storage — stats query, DreamStore reads/writes, draft fields

**Files:**
- Create: `src/main/libs/hotLayerUsageQueries.ts`
- Modify: `src/main/libs/predictionLedger.ts` (`export const shiftDateKey`)
- Modify: `src/main/sqliteStore.ts` (capability-drafts guarded block: `dormant_at INTEGER`)
- Modify: `src/main/coworkStore.ts` (column list + mapper: `dormantAt`; `getCapabilityDraft`)
- Modify: `src/main/dreamStore.ts` (three methods next to `listActivePromotedProcedureIds`)
- Test: `tests/hotLayerUsageAudit.test.mjs` (storage section)

**Interfaces:**

```ts
// src/main/libs/hotLayerUsageQueries.ts
import type { Database } from 'sql.js';
export interface HotLayerUsageStats { itemId: string; appliedNights: number; exposedNights: number; auditedNights: number }
export function queryHotLayerUsageStats(
  db: Database,
  input: { metabotId: number; kind: 'technique' | 'procedure'; sinceDate: string; untilDate: string; itemIds?: readonly string[] },
): Map<string, HotLayerUsageStats>;

// src/main/dreamStore.ts
export interface HotLayerExposureRow { kind: 'technique' | 'procedure'; itemId: string; exposure: 'hot' | 'recall'; exposureCount: number; applied: boolean | null; auditedAt: number | null }
DreamStore.listHotLayerExposures(metabotId: number, usageDate: string): HotLayerExposureRow[];
DreamStore.recordHotLayerUsageVerdicts(metabotId: number, usageDate: string, verdicts: Array<{ kind: 'technique' | 'procedure'; itemId: string; applied: boolean; evidence: { labels: string[]; channels: Array<'owner' | 'external'> } }>, atMs: number): number;
DreamStore.listHotLayerUsageStats(metabotId: number, input: { kind: 'technique' | 'procedure'; sinceDate: string; untilDate: string; itemIds?: readonly string[] }): Map<string, HotLayerUsageStats>;

// src/main/coworkStore.ts
CapabilityDraft.dormantAt: number | null;
CoworkStore.getCapabilityDraft(metabotId: number, id: number): CapabilityDraft | null;
```

**Behavior:**

- Stats SQL (exact semantics):

```sql
SELECT item_id,
       SUM(CASE WHEN applied = 1 THEN 1 ELSE 0 END) AS applied_nights,
       SUM(CASE WHEN audited_at IS NOT NULL AND exposure = 'hot' THEN 1 ELSE 0 END) AS exposed_nights,
       SUM(CASE WHEN audited_at IS NOT NULL THEN 1 ELSE 0 END) AS audited_nights
FROM hot_layer_usage
WHERE metabot_id = ? AND item_kind = ? AND usage_date >= ? AND usage_date <= ?
  [AND item_id IN (…)]
GROUP BY item_id
```

  `appliedNights` counts hot and recall nights (re-entry needs recall evidence); `exposedNights` counts audited **hot** nights only (pruning). An empty `itemIds` array returns an empty map without querying. If the table does not exist (`no such table`), return an empty map — stores built by unit tests without `SqliteStore` must keep working; rethrow any other error.
- `listHotLayerExposures`: rows for the bot and date, ordered `exposure = 'hot' DESC, exposure_count DESC, item_kind ASC, item_id ASC`.
- `recordHotLayerUsageVerdicts`: per verdict `UPDATE hot_layer_usage SET applied = ?, evidence = ?, audited_at = ? WHERE metabot_id = ? AND usage_date = ? AND item_kind = ? AND item_id = ?`; `evidence` is `JSON.stringify({ labels, channels })`. Re-auditing the same date overwrites (a version-repair re-run is idempotent). Saves once; returns rows changed.
- `getCapabilityDraft`: one row via the shared column list and mapper; `null` when not the bot's.
- `export const shiftDateKey` in `predictionLedger.ts` — only the keyword changes (P4 makes the identical change; identical edits merge cleanly).

- [ ] **Step 1: Write the failing tests:** seed `hot_layer_usage` rows by raw SQL for bot 5 across 6 dates (mix of hot / recall, audited / unaudited, applied 1 / 0 / NULL) and assert exact `appliedNights` / `exposedNights` / `auditedNights` for two items; date bounds are inclusive; `itemIds` filter works; a DB without the table returns an empty map; `recordHotLayerUsageVerdicts` writes `evidence` JSON and a second call overwrites; `getCapabilityDraft` returns `dormantAt: null` for an old row.
- [ ] **Step 2: Run to verify they fail.** `pnpm run compile:electron && node --test tests/hotLayerUsageAudit.test.mjs`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm run test:rrsi` → PASS.
- [ ] **Step 5:** Append `tests/hotLayerUsageAudit.test.mjs` to `test:rrsi`; allowlist it.
- [ ] **Step 6: Commit**

```bash
git add src/main/libs/hotLayerUsageQueries.ts src/main/libs/predictionLedger.ts src/main/sqliteStore.ts src/main/coworkStore.ts src/main/dreamStore.ts package.json .gitignore
git add -f tests/hotLayerUsageAudit.test.mjs
git commit -m "feat: add hot-layer usage stats and audit verdict storage"
```

---

### Task 2: Pure ranking, demotion, and re-entry selection

**Files:**
- Create: `src/main/libs/hotLayerPruning.ts`
- Test: `tests/hotLayerPruning.test.mjs`

**Interfaces:** the overview contract plus:

```ts
export function selectHotLayerDemotions<T extends HotLayerCandidate>(
  items: readonly T[],
  options: { nowMs: number; graceDays?: number; minExposedNights?: number; maxPerNight?: number },
): T[];
export function selectHotLayerReentries<T extends HotLayerCandidate>(
  items: readonly T[],
  options?: { minAppliedNights?: number },
): T[];
```

`HotLayerCandidate.appliedNights` / `exposedNights` mean the `HotLayerUsageStats` fields over the window the caller chose. `hotSinceMs` is when the item entered the hot layer.

**Behavior (exact):**

- `isFresh(item) = nowMs - item.hotSinceMs < graceDays * 86_400_000` (default `graceDays = 14`).
- **`rankHotLayerItems(items, { cap, nowMs, freshSlots = 1, graceDays = 14 })`:**
  1. `cap <= 0` → `[]`.
  2. `sorted` = items ordered by `appliedNights` DESC, then `hotSinceMs` DESC, then `key` ASC (string compare).
  3. `selected` = first `max(0, cap - freshSlots)` of `sorted`.
  4. Repeat `freshSlots` times while `selected.length < cap`: add the fresh item with the largest `hotSinceMs` (ties → smaller `key`) that is not yet selected; if none, add the next item of `sorted` not yet selected.
  5. Fill from `sorted` (skipping selected) until `selected.length === cap` or items run out.
  6. Return the selected items **in `sorted` order**.
- **`selectHotLayerDemotions`:** keep items with `!isFresh(item) && item.exposedNights >= minExposedNights (5) && item.appliedNights === 0`; order by `exposedNights` DESC, then `hotSinceMs` ASC, then `key` ASC; return the first `maxPerNight` (2).
- **`selectHotLayerReentries`:** keep items with `appliedNights >= minAppliedNights (2)`; order by `appliedNights` DESC, then `key` ASC. No cap (the ranked roster still caps injection).

- [ ] **Step 1: Write the failing test** with `const DAY = 86_400_000; const NOW = Date.UTC(2026, 7, 31);` and helper `c(key, appliedNights, ageDays, exposedNights = 0)` → `{ key, kind: 'technique', hotSinceMs: NOW - ageDays * DAY, appliedNights, exposedNights }`. Vectors (`cap: 5`, `nowMs: NOW`):
  1. No fresh items: `[c('a',3,40), c('b',0,30), c('c',2,50), c('d',0,20), c('e',1,60), c('f',0,90), c('g',0,25)]` → keys `['a','c','e','d','g']` (applied 3,2,1, then the two most recent of the zero-applied: `d` 20 days, `g` 25 days).
  2. Fresh slot honored: `[c('a',3,40), c('b',2,40), c('c',2,41), c('d',1,40), c('e',1,41), c('n',0,3)]` → `['a','b','c','d','n']` (`e` loses to the newcomer).
  3. Only the newest fresh item gets the slot: add `c('m',0,5)` to vector 2 → `['a','b','c','d','n']`.
  4. A fresh item that also ranks on merit does not consume a second slot: `[c('n',4,2), c('a',3,40), c('b',2,40), c('c',1,40), c('d',1,41), c('e',0,40)]` → `['n','a','b','c','d']`.
  5. Ties: `[c('b',1,10), c('a',1,10)]`, `cap: 1`, `freshSlots: 0` → `['a']`.
  6. `cap` larger than input → all items in sorted order; `cap: 0` → `[]`.
  Demotions (`nowMs: NOW`):
  7. `c('x',0,30,5)` → demoted; `c('y',0,30,4)` → not; `c('z',0,10,9)` (inside grace) → not; `c('w',1,30,9)` → not.
  8. Four eligible items with exposed nights 9, 7, 7, 6 and ages 30, 50, 40, 30 → returns exactly two: exposed 9, then the exposed-7 item aged 50 days.
  Re-entries:
  9. applied nights `[2, 1, 3]` → keys of 3 then 2.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** No `Date.now()` in this module.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** Append `tests/hotLayerPruning.test.mjs` to `test:rrsi`; allowlist it.
- [ ] **Step 6: Commit**

```bash
git add src/main/libs/hotLayerPruning.ts package.json .gitignore
git add -f tests/hotLayerPruning.test.mjs
git commit -m "feat: add hot-layer ranking, demotion and re-entry selection"
```

---

### Task 3: Usage audit pass

**Files:**
- Create: `src/main/libs/hotLayerUsageAudit.ts`
- Modify: `src/main/services/dreamService.ts` (new private `runHotLayerUsageAudit`; call site in the post-dream sequence ~1212, right after `promoteCapabilityDraftsToProcedures`; telemetry key `usageAudit` on the non-empty path only)
- Modify: `tests/fixtures/rrsiDreamHarness.mjs` (`MARKERS.usageAudit`)
- Test: `tests/hotLayerUsageAudit.test.mjs` (append)

**Interfaces:**

```ts
export interface UsageAuditExcerpt { label: string; channel: 'owner' | 'external'; text: string }
export interface UsageAuditItem { ref: string; kind: 'technique' | 'procedure'; itemId: string; title: string; gist: string }
export function sampleUsageAuditExcerpts(sessions: ReadonlyArray<{ sessionType: string; isOrder: boolean; messages: ReadonlyArray<{ type: 'user' | 'assistant'; content: string }> }>, maxExcerpts?: number, maxChars?: number): UsageAuditExcerpt[];
export function selectUsageAuditItems<T extends { kind: 'technique' | 'procedure'; itemId: string }>(exposures: readonly T[], maxItems?: number): T[];
export function buildHotLayerUsageAuditPrompt(input: { date: string; items: readonly UsageAuditItem[]; excerpts: readonly UsageAuditExcerpt[] }): { system: string; user: string };
export type UsageAuditParseResult =
  | { ok: true; verdicts: Array<{ ref: string; applied: boolean; labels: string[] }> }
  | { ok: false; error: string };
export function parseHotLayerUsageAuditOutput(raw: string, validRefs: ReadonlySet<string>, validLabels: ReadonlySet<string>): UsageAuditParseResult;
```

**Behavior:**

- **Excerpts:** walk `sessions` in order (index `n`, 1-based) and each session's `messages` (index `k`, 1-based over **all** messages, so labels point at the real position); keep `type === 'assistant'` with non-empty trimmed content; label `S{n}.M{k}`; channel `external` when `session.isOrder || session.sessionType === 'a2a'`, else `owner`; text = content with whitespace runs collapsed to one space, cut to 280 UTF-16 units (`truncateUtf16Units`). If more than 40 remain, keep indices `Math.floor(i * total / 40)` for `i = 0…39` (even sampling, deterministic).
- **Items:** `selectUsageAuditItems` keeps the input order (already `hot` first, then `exposure_count` DESC from `listHotLayerExposures`) and takes the first 12. Refs are `technique:<id>` and `procedure:<id>`.
- **Gists:** technique → `getCapabilityDraft(metabotId, Number(id))`, gist = description; procedure → `metaidKnowledgeStore.getProcedure(id)`, gist = `${triggerText};${steps[0] ?? ''}`; both cut to 160 chars. Items whose source row is missing are dropped from the audit (they stay unaudited).
- **Prompt (exact system text):**

```
你在做使用核查:判断这个 MetaBot 在 {date} 的回复里,是否真的用上了它记忆中的某条做法。
只依据下面给出的回复摘录判断,不要猜测摘录之外的内容。
"用上"指回复中的做法、步骤或检查明显体现了这条记忆;只是话题相关、或只是提到了名字,都不算。
输出 JSON:{"items":[{"ref":"<条目编号>","applied":true 或 false,"evidence":["S1.M2"]}]}
applied 为 true 时,evidence 必须列出能体现它的摘录编号;没有摘录能证明就写 false。
每个条目都给出结论,只输出 JSON。
```

  User text: `日期:{date}`, blank line, `## 记忆条目`, one line per item `- {ref}「{title}」:{gist}`, blank line, `## 回复摘录`, one line per excerpt `[{label}]({channel}) {text}`.
- **Parser:** same JSON extraction as `parseCapabilityValidationOutput` (strip fences, first `{` to last `}`); missing `items` array → `{ ok: false }`. Per element: drop if `ref` is not in `validRefs` or already seen; `labels` = `evidence` filtered to strings in `validLabels` (deduplicated, input order); `applied = element.applied === true && labels.length > 0`. Unknown keys are ignored.
- **Pass (`runHotLayerUsageAudit(metabot, brain, date, activity)`):**
  1. `exposures = dreamStore.listHotLayerExposures(metabot.id, date)`; none → `{ ran: false, items: 0, applied: 0, excerpts: 0, parseFailed: false }`.
  2. `excerpts = sampleUsageAuditExcerpts(activity.sessions)`; none → same zero result (nothing to judge against).
  3. Build items (drop missing sources); none → zero result.
  4. `raw = await this.callDreamLlm(prompt.system, prompt.user, brain, 2048)`; parse with the item refs and excerpt labels.
  5. Parse failure → `{ ran: true, items, applied: 0, excerpts, parseFailed: true }`, nothing written.
  6. Map each verdict to `{ kind, itemId, applied, evidence: { labels, channels } }` where `channels` = distinct channels of the cited labels; `recordHotLayerUsageVerdicts(metabot.id, date, mapped, this.now().getTime())`.
  7. Return `{ ran: true, items, applied: <true verdicts>, excerpts, parseFailed: false }`.
- The pass runs on the non-empty path only; the empty-day path writes no `usageAudit` key.

- [ ] **Step 1: Write the failing tests** (append):
  1. *Sampling:* 2 sessions (one `a2a`) with user/assistant messages → labels `S1.M2`, `S1.M4`, `S2.M2` with channels `owner, owner, external`; whitespace collapsed; 300-char content cut to 280; 100 assistant messages → 40 excerpts and the first label is the first message.
  2. *Prompt:* system contains `使用核查`, does not contain `能力验证` or `记忆核对`; user lists refs and labels in the exact line formats.
  3. *Parser:* `applied: true` with `evidence: ['S9.M9']` (unknown label) → `applied: false`; `applied: 'yes'` → `false`; unknown ref dropped; duplicate ref keeps the first; extra keys ignored; missing `items` → `ok: false`; fenced JSON parses.
  4. *Flow (harness):* seed one injectable technique (validation score 0.7, so the promotion pass leaves it alone) and one hot procedure, record their exposures for D2 (`coworkStore.recordHotLayerExposures`), seed a D2 session whose assistant message applies the technique; `router.on(MARKERS.usageAudit, () => ({ items: [{ ref: 'technique:<id>', applied: true, evidence: ['S1.M2'] }, { ref: 'procedure:<id>', applied: false, evidence: [] }] }))`; run night D2 → the technique row has `applied = 1`, `evidence` JSON `{"labels":["S1.M2"],"channels":["owner"]}`, `audited_at` set; the procedure row has `applied = 0`; `telemetry(D2).usageAudit` deep-equals `{ ran: true, items: 2, applied: 1, excerpts: 1, parseFailed: false }`.
  5. *Flow, garbage output:* responder returns `'not json'` → `parseFailed: true`, both rows keep `audited_at IS NULL`, the run still completes.
  6. *Flow, no exposures:* no usage-audit call is made (`router.calls` has no `使用核查` system prompt) and `usageAudit.ran === false`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS. Existing flow tests that count LLM calls by index may now see an extra call on nights with exposures: route it by marker in the shared harness (the fallback must not answer `使用核查` with dream JSON — register a default responder `() => ({ items: [] })` for `MARKERS.usageAudit` inside `createDreamHarness`), and log any test changes. A test's own `router.on(MARKERS.usageAudit, …)` must replace that default: if the P1 router appends a second entry for the same marker, change `on()` to replace the responder of an already-registered marker in place (registration order unchanged).
- [ ] **Step 5: Commit**

```bash
git add src/main/libs/hotLayerUsageAudit.ts src/main/services/dreamService.ts tests/fixtures/rrsiDreamHarness.mjs
git add -f tests/hotLayerUsageAudit.test.mjs
git commit -m "feat: audit which hot-layer items the bot actually applied"
```

---

### Task 4: Utility-ranked rosters and L1 demotion

**Files:**
- Modify: `src/main/coworkStore.ts` (`listInjectableTechniques` ranking; `markCapabilityDraftDormant`)
- Modify: `src/main/metaidKnowledgeStore.ts` (`listHotProcedures` ranking)
- Modify: `src/main/services/dreamService.ts` (new private `pruneHotLayerAfterDream`, called right after `runHotLayerUsageAudit`; telemetry `hotLayerPruning`)
- Test: `tests/hotLayerPruning.test.mjs` (append store + flow sections)

**Interfaces:**

```ts
CoworkStore.listInjectableTechniques(metabotId: number, limit?: number, options?: { nowMs?: number }): CapabilityDraft[];
CoworkStore.markCapabilityDraftDormant(input: { id: number; metabotId: number; atMs: number; note: string }): boolean;
MetaIDKnowledgeStore.listHotProcedures(metabotId: number, options?: { limit?: number; nowMs?: number }): MetaIDProcedureEntry[];
```

**Behavior:**

- **Technique roster:** `nowMs = options.nowMs ?? Date.now()`; `today = formatBotWorkspaceDate(new Date(nowMs))`; pool = validated, unpromoted drafts (`ORDER BY created_at DESC, id DESC LIMIT 100`); stats = `queryHotLayerUsageStats(this.db, { metabotId, kind: 'technique', sinceDate: shiftDateKey(today, -(HOT_LAYER_UTILITY_WINDOW_DAYS - 1)), untilDate: today, itemIds: pool ids as strings })`; candidates `{ key: String(id), kind: 'technique', hotSinceMs: validatedAt ?? createdAt, appliedNights, exposedNights }` (0 when no stats); return `rankHotLayerItems(candidates, { cap: limit, nowMs, freshSlots: HOT_LAYER_FRESH_SLOTS, graceDays: HOT_LAYER_GRACE_DAYS })` mapped back to drafts.
- **Procedure roster:** same with `nowMs = options.nowMs ?? this.now()`, pool = active hot procedures (`ORDER BY updated_at DESC, id DESC LIMIT 200`), `kind: 'procedure'`, `hotSinceMs = hotSince ?? createdAt`, `cap = limit` (default `PROCEDURE_PROMPT_MAX_ITEMS`).
- **`markCapabilityDraftDormant`:** `UPDATE capability_drafts SET status = 'dormant', dormant_at = ?, validation_notes = ? WHERE id = ? AND metabot_id = ? AND status = 'validated' AND promoted_at IS NULL`; notes = existing notes + `' — '` + `note` (or just `note` when empty), cut to 1000 chars. Returns whether a row changed; saves when true. `dormant` drafts are not injected, not re-reviewed, not promoted, and not purged (the existing purge only deletes `draft` / `rejected`); a later dream re-proposal of the same title inserts a new draft (P1 dedupe only counts `draft`, `validated`, `disputed`). The settings panel's status groups do not list `dormant` (same as `disputed` today) — no UI change in this round.
- **`pruneHotLayerAfterDream(metabot, date)`:**
  1. `refMs = getDayBoundsMs(date).endMs` (deterministic per dreamed date); `sinceDate = shiftDateKey(date, -(HOT_LAYER_UTILITY_WINDOW_DAYS - 1))`.
  2. Technique candidates: every validated, unpromoted draft of the bot with stats from `dreamStore.listHotLayerUsageStats(… kind 'technique', sinceDate, untilDate: date)`; key `technique:<id>`.
  3. Procedure candidates: every active hot procedure (`listHotProcedures(metabot.id, { limit: 200, nowMs: refMs })`) with stats for kind `procedure`; key `procedure:<id>`.
  4. `demote = selectHotLayerDemotions([...techniques, ...procedures], { nowMs: refMs })` — one combined list, so the 2-per-night cap is shared.
  5. Technique → `markCapabilityDraftDormant({ id, metabotId, atMs: this.now().getTime(), note: 'dormant ${date}: shown on ${exposedNights} audited nights, applied on none' })`. Procedure → `setProcedureHotEligibility(id, { eligible: false, reason: 'unused' })`.
  6. Return `{ demotedTechniques, demotedProcedures, reentered: 0 }` (Task 5 fills `reentered`).
- Runs on the non-empty path only, after the usage audit, even when the audit was skipped (older audited nights still count).

- [ ] **Step 1: Write the failing tests** (append). Every flow night seeds one session (`seedSession`) so the non-empty path runs. Seed techniques with validation score 0.7 (below `CAPABILITY_PROMOTION_MIN_SCORE = 0.85`) so the promotion pass leaves them alone, set `validated_at` by raw SQL, and seed usage rows by raw SQL with `audited_at` set and `usage_date` inside `[D-29, D]`:
  1. *Store ranking:* techniques T1…T6 validated 60, 50, 40, 30, 20, 2 days before `nowMs`; T1 has 3 audited applied nights, the others none → `listInjectableTechniques(5, 5, { nowMs })` returns ids in the order T1, T6, T5, T4, T3 (T2 is left out).
  2. *Procedure ranking:* the same pattern through `listHotProcedures(5, { limit: 5, nowMs })` with `hot_since` set by raw SQL → same order by key.
  3. *Prune 5 vs 4:* technique A validated 40 days before D with 5 audited hot nights in the window, 0 applied → after night D it is `dormant`, `dormantAt` set, notes end with `applied on none`; technique B with 4 audited nights → still `validated`.
  4. *Grace:* validated 10 days before D with 9 audited nights, 0 applied → not demoted.
  5. *Cap:* three eligible items — technique A (7 audited nights), procedure P (6), technique B (5), all past grace → night D demotes A and P; night D+1 demotes B.
  6. *Procedure demotion:* P after night D → `active`, `hotEligible false`, `hotReason 'unused'`; `procedure_recall` still returns it with the `rarely applied` status line.
  7. *Nothing deleted:* `SELECT COUNT(*)` of `capability_drafts` and `metaid_knowledge_procedures` identical before and after the pruning nights.
  8. *Telemetry:* in test 5, `telemetry(D).hotLayerPruning` deep-equals `{ demotedTechniques: 1, demotedProcedures: 1, reentered: 0 }` and `telemetry(D+1).hotLayerPruning` deep-equals `{ demotedTechniques: 1, demotedProcedures: 0, reentered: 0 }`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` and `node --test tests/experiencePromptInjection.test.mjs tests/procedureRecall.test.mjs` → PASS. Repair any P2 test that assumed `created_at DESC` order for the rosters only if the new order is the subject; log changes.
- [ ] **Step 5: Commit**

```bash
git add src/main/coworkStore.ts src/main/metaidKnowledgeStore.ts src/main/services/dreamService.ts
git add -f tests/hotLayerPruning.test.mjs
git commit -m "feat: rank hot rosters by applied evidence and demote unused items"
```

---

### Task 5: Re-entry of unused procedures

**Files:**
- Modify: `src/main/metaidKnowledgeStore.ts` (`listUnusedProcedures`)
- Modify: `src/main/services/dreamService.ts` (`pruneHotLayerAfterDream`, before the demotion step)
- Test: `tests/hotLayerPruning.test.mjs` (append)

**Interfaces:** `MetaIDKnowledgeStore.listUnusedProcedures(metabotId: number, options?: { limit?: number }): MetaIDProcedureEntry[]` — `status = 'active' AND hot_eligible = 0 AND hot_reason = 'unused'`, `ORDER BY updated_at DESC, id DESC`, default limit 200.

**Behavior:**

- Re-entry runs **before** demotion in the same pass: candidates = `listUnusedProcedures(metabot.id)` with stats from `listHotLayerUsageStats(… kind 'procedure', sinceDate: shiftDateKey(date, -(HOT_LAYER_REENTRY_WINDOW_DAYS - 1)), untilDate: date)`; `selectHotLayerReentries(candidates, { minAppliedNights: HOT_LAYER_REENTRY_MIN_APPLIED_NIGHTS })`; each → `setProcedureHotEligibility(id, { eligible: true, reason: null, atMs: this.now().getTime() })`. Re-entered ids are excluded from tonight's demotion candidates. `reentered` = count.
- Re-entry applies only to `hot_reason = 'unused'`. `gate_rejected`, `demoted`, `rollback`, `situational`, and `probation` never re-enter through usage evidence.
- A re-entered procedure gets a new `hot_since`, so its 14-day grace restarts and it competes for the fresh slot.

- [ ] **Step 1: Write the failing tests** (append):
  1. An `unused` procedure with audited recall rows applied on 2 nights within the last 14 days → hot again, `hotReason null`, `hotSince` equals the injected clock, `reentered === 1`.
  2. Applied on 1 night → stays `unused`. Applied on 2 nights but one is 20 days old → stays `unused`.
  3. A `gate_rejected` procedure with the same evidence → unchanged.
  4. A procedure that re-entered tonight is not demoted tonight even if its 30-day stats would qualify.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/metaidKnowledgeStore.ts src/main/services/dreamService.ts
git add -f tests/hotLayerPruning.test.mjs
git commit -m "feat: let unused procedures re-enter the hot layer when applied again"
```

---

### Task 6: Report `usage` section

**Files:** Modify `scripts/rrsi-evolution-report.mjs`; append to `tests/rrsiEvolutionReport.test.mjs`.

**Report shape (added per bot):**

```js
usage: {
  auditedNights: 0,            // nights in the window whose telemetry has usageAudit.ran === true
  parseFailures: 0,            // usageAudit.parseFailed === true
  exposedItems: 0,             // distinct (kind, item_id) with any hot_layer_usage row in the window
  auditedItems: 0,             // distinct items with at least one audited row
  appliedItems: 0,             // distinct items with at least one applied = 1 row
  appliedRate: null,           // appliedItems / auditedItems, 4 decimals; null when 0/0
  demotedTechniques: 0, demotedProcedures: 0, reentered: 0,   // summed hotLayerPruning
  dormantTotal: 0,             // capability_drafts with status 'dormant' (all time)
  unusedProcedures: 0,         // active procedures with hot_reason 'unused'
} | null                       // null when hot_layer_usage is missing
```

Text line: `  usage: audited 6 nights (1 parse fail), items 9 exposed / 7 audited / 4 applied → 57.14%; demoted 1T+1P, re-entered 0; dormant 2, unused 1`.

- [ ] **Step 1: Write the failing test:** seed usage rows and two nights of `usageAudit` / `hotLayerPruning` telemetry; assert every field above and the formatted line; a DB without `hot_layer_usage` gives `usage: null`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** (guard the `dormant_at` / `hot_reason` columns with `PRAGMA table_info`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/rrsi-evolution-report.mjs
git add -f tests/rrsiEvolutionReport.test.mjs
git commit -m "feat: report hot-layer usage evidence and pruning"
```

---

### Task 7: Phase verification and handoff

- [ ] **Step 1:** Run the full verification block from P1 Task 10 (grep target: `src/main/libs/hotLayerPruning.ts src/main/libs/hotLayerUsageAudit.ts src/main/libs/hotLayerUsageQueries.ts` — `hotLayerUsageQueries.ts` takes a `Database` but must not read the clock).
- [ ] **Step 2:** Confirm `git diff main -- src/main/libs/dreamPrompt.ts` is empty (no `DREAM_VERSION` change).
- [ ] **Step 3:** Self-check the P3 gate in the overview.
- [ ] **Step 4:** Handoff note (overview format), including `localdocs/rrsi-p3-test-changes.md`.
