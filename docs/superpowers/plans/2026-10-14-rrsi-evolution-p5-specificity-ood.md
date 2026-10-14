# RRSI Evolution P5 — Specificity Critic and OOD Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop lessons that only hold for one person, order, pin, or date from becoming always-on techniques, catch lessons that merely restate how to get a good rating, and measure the bot's prediction accuracy separately on external outcomes (MetaTasks, service orders) — the held-out set that reveals scorer fitting.

**Architecture:** A pure detector finds instance markers (pin ids, txids, GlobalMetaIDs, UUIDs, ISO dates) in draft text. The existing reconciliation pass — which never sees the validator's rationale — shows the markers per draft and returns a new `scope` verdict. Situational drafts stay validated but are excluded from the technique roster and promote into recall-only procedures; scorer-fitted drafts become `disputed`. A title that contains a marker is situational by host rule. Predictions are bucketed by source class (`internal` / `external`) and the gap is recorded in telemetry and the report. No dream-prompt change, so no `DREAM_VERSION` change.

**Tech Stack:** TypeScript main process, sql.js stores, `node:test` against `dist-electron/`.

**Index / acceptance gate:** `docs/superpowers/plans/2026-10-14-rrsi-evolution-00-overview.md` (P5 gate). **Design:** spec §6.5. **Prerequisite:** P3 merged into `main` (P5 edits the ranked `listInjectableTechniques` and the promotion pass).

## Global Constraints

All constraints in the overview apply. Phase-specific:

- Branch `feat/rrsi-p5-scope`, worktree `.worktrees/rrsi-p5-scope`, from `main`. Never push, never merge.
- The reconciliation prompt changes; the dream prompt does not. **No `DREAM_VERSION` change.** `renderPredictionCalibrationDigest` output must stay byte-identical.
- `capability_drafts.scope = NULL` means "not assessed" and behaves exactly like `general` everywhere.
- Scope never deletes or rejects anything: `situational` keeps the draft validated; `scorer_fitted` moves it to `disputed`, and the existing disputed flow decides later. Neither writes the falsified ledger.
- The host marker rule runs even when the reconciliation LLM call or its parse fails.
- One commit per task + English dev-journal buzz after each commit.

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/libs/capabilitySpecificity.ts` | Create: `CapabilityScope`, `normalizeCapabilityScope`, `detectInstanceMarkers`, `titleHasHardInstanceMarker`, `formatInstanceMarkers` |
| `src/main/libs/capabilityReconciliationPrompt.ts` | Scope rules in the system prompt; per-draft `实例标记:` line; `scope` in the contract; parser `scope` |
| `src/main/sqliteStore.ts` | `capability_drafts.scope TEXT` in the guarded block |
| `src/main/coworkStore.ts` | `CapabilityDraft.scope`; `setCapabilityDraftScope`; techniques exclude `situational` |
| `src/main/services/dreamService.ts` | Scope execution + host rule in `reconcileValidatedCapabilityDrafts`; situational promotion; `predictionOod` telemetry |
| `src/main/libs/predictionLedger.ts` | `PREDICTION_SOURCE_CLASS`, `PredictionSourceClass`, `bySourceClass` on the digest type |
| `src/main/dreamStore.ts` | `listPredictionCalibration` fills `bySourceClass` |
| `scripts/rrsi-evolution-report.mjs` | `scope`, `ood`, `usageChannels` sections |
| `tests/capabilitySpecificity.test.mjs` | Create |
| `tests/predictionOodSplit.test.mjs` | Create |
| `tests/capabilityReconciliation.test.mjs`, `tests/rrsiEvolutionReport.test.mjs`, `tests/predictionLedger*.test.mjs` | Append / repair |
| `package.json`, `.gitignore` | Append / allowlist the new test files |

---

### Task 0: Worktree and baseline

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots
git worktree add .worktrees/rrsi-p5-scope -b feat/rrsi-p5-scope main
git config extensions.worktreeConfig true
git -C .worktrees/rrsi-p5-scope config --worktree core.filemode false
cd .worktrees/rrsi-p5-scope
pnpm install
test -f src/main/libs/hotLayerPruning.ts && echo "P3 present"
```

Expected: `P3 present`. Otherwise stop.

- [ ] **Step 2: Baseline** — same commands as P1 Task 0 Step 2, writing `localdocs/rrsi-p5-baseline.txt`; add the prediction-ledger test files (`ls tests | grep -i prediction`) to the loop.

---

### Task 1: Instance-marker detector and vectors

**Files:**
- Create: `src/main/libs/capabilitySpecificity.ts`
- Test: `tests/capabilitySpecificity.test.mjs`

**Interfaces:**

```ts
export type CapabilityScope = 'general' | 'situational' | 'scorer_fitted';
export function normalizeCapabilityScope(value: unknown): CapabilityScope | null;
export type InstanceMarkerKind = 'pin' | 'txid' | 'globalmetaid' | 'uuid' | 'date';
export interface InstanceMarker { kind: InstanceMarkerKind; value: string }
export function detectInstanceMarkers(text: string): InstanceMarker[];
export function titleHasHardInstanceMarker(title: string): boolean;
export function formatInstanceMarkers(markers: readonly InstanceMarker[], maxShown?: number): string;
```

**Behavior (exact):**

- Patterns (all case-insensitive, global):
  - pin: `/\b[0-9a-f]{64}i\d+\b/gi`
  - txid: `/\b[0-9a-f]{64}\b/gi` — a pin's hex part is never reported as a txid (the `\b` after 64 hex chars fails when `i` follows; keep a defensive check that skips any txid match that starts a pin match)
  - globalmetaid: `/\bidq1[0-9a-z]{20,}\b/gi`
  - uuid: `/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi`
  - date: `/\b\d{4}-\d{2}-\d{2}\b/g`
- Output: markers in order of first occurrence in the text; values lowercased except dates; duplicates (same kind + value) removed.
- `titleHasHardInstanceMarker(title)` = `detectInstanceMarkers(title).length > 0`.
- `normalizeCapabilityScope`: `trim().toLowerCase()`, `-` → `_`; one of the three → it; else `null`.
- `formatInstanceMarkers(markers, maxShown = 6)`: `无` when empty; otherwise items joined with `;`, each `<label> <short>` where labels are `pin`, `txid`, `GlobalMetaID`, `uuid`, `日期` and short forms are: pin → first 8 hex + `…` + `i<n>`; txid → first 8 + `…`; globalmetaid → first 10 + `…`; uuid → first 8 + `…`; date → as is. When more than `maxShown`, append `;等 <N> 个` where `N` is the total.

- [ ] **Step 1: Write the failing test** with `PIN = '3f225f43dde31ed107fdaf6c49ed9eba4bfa60ddd563186e5abc0fbabb5495edi0'`, `TX = '5d45547839dacb7d1872fb5e9f4d821a7cc46d433141b0f458c1ae5553691c8a'`, `GM = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz'`:
  1. `detectInstanceMarkers('引用 ' + PIN)` → `[{ kind: 'pin', value: PIN }]` (no txid).
  2. `detectInstanceMarkers(TX)` → one `txid`; a 63-hex string → `[]`; a 66-hex string → `[]`.
  3. `GM` → one `globalmetaid`; `'idq1short'` → `[]`.
  4. `'123e4567-e89b-12d3-a456-426614174000'` → one `uuid`.
  5. `'在2026-08-02交付'` → one `date` `2026-08-02` (CJK neighbors are boundaries).
  6. Upper-case `PIN.toUpperCase()` → detected, value lowercased.
  7. Mixed `'给 ' + GM + ' 的订单 ' + TX + ' 在 2026-08-02,再看 ' + TX` → kinds `['globalmetaid', 'txid', 'date']` (duplicate removed).
  8. `'先验证再交付'` → `[]`; `titleHasHardInstanceMarker('给 ' + GM + ' 先发预览')` → `true`.
  9. `formatInstanceMarkers` of vector 7 → `GlobalMetaID idq14hmv23…;txid 5d455478…;日期 2026-08-02`; of `[]` → `无`; of 8 dates with `maxShown` 6 → six dates then `;等 8 个`; of vector 1 → `pin 3f225f43…i0`.
  10. `normalizeCapabilityScope('Scorer-Fitted')` → `'scorer_fitted'`; `'local'` → `null`.
- [ ] **Step 2: Run to verify it fails.** `pnpm run compile:electron && node --test tests/capabilitySpecificity.test.mjs`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** Append `tests/capabilitySpecificity.test.mjs` to `test:rrsi`; allowlist it.
- [ ] **Step 6: Commit**

```bash
git add src/main/libs/capabilitySpecificity.ts package.json .gitignore
git add -f tests/capabilitySpecificity.test.mjs
git commit -m "feat: detect instance markers in capability drafts"
```

---

### Task 2: Draft scope column and technique-roster exclusion

**Files:**
- Modify: `src/main/sqliteStore.ts` (`if (!draftCols.includes('scope')) ALTER TABLE capability_drafts ADD COLUMN scope TEXT`)
- Modify: `src/main/coworkStore.ts` (column list + mapper; `setCapabilityDraftScope`; `listInjectableTechniques` pool filter)
- Test: `tests/capabilitySpecificity.test.mjs` (append store section)

**Interfaces:**

```ts
CapabilityDraft.scope: CapabilityScope | null;
CoworkStore.setCapabilityDraftScope(input: { id: number; metabotId: number; scope: CapabilityScope }): boolean;
```

**Behavior:**

- Mapper: `scope = normalizeCapabilityScope(row.scope)` (unknown stored text reads as `null`).
- `setCapabilityDraftScope`: `UPDATE capability_drafts SET scope = ? WHERE id = ? AND metabot_id = ?`; saves when a row changed.
- `listInjectableTechniques`: the pool query adds `AND COALESCE(scope, 'general') != 'situational'`. Ranking (P3) is unchanged.

- [ ] **Step 1: Write the failing tests:** an old row reads `scope: null`; `setCapabilityDraftScope` round-trips; a validated `situational` draft is absent from `listInjectableTechniques` while a `general` and a `null` one are present; the migration runs twice without error.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/sqliteStore.ts src/main/coworkStore.ts
git add -f tests/capabilitySpecificity.test.mjs
git commit -m "feat: store capability draft scope and keep situational drafts off the roster"
```

---

### Task 3: Scope verdict in reconciliation, host marker rule, situational promotion

**Files:**
- Modify: `src/main/libs/capabilityReconciliationPrompt.ts` (system prompt ~73–81; draft block ~90–96; contract ~113–125; `ReconciliationVerdict`; parser ~137–193; `ReconciliationDraftInput.markers?`)
- Modify: `src/main/services/dreamService.ts` (`reconcileValidatedCapabilityDrafts` ~1749–1880; `promoteCapabilityDraftsToProcedures`)
- Test: `tests/capabilitySpecificity.test.mjs` (append flow section), `tests/capabilityReconciliation.test.mjs` (repair)

**Prompt changes (exact text):**

- System prompt, appended after the existing last line:

```
另外,逐条判断草案的适用范围 scope:
- general:换一个任务、换一个对象也成立的做法;
- situational:只对某个具体的人、订单、pin、日期或对端 Bot 成立;
- scorer_fitted:只是在复述「怎样拿到好评、点赞或高分」,并没有改变工作本身该怎么做。
每条草案下方的「实例标记」是宿主从文本里机械找出的具体 ID 和日期,只作参考:有标记不等于一定是 situational,没有标记也可能是 situational。
```

- Per draft, right after the `描述:` line: `实例标记:${formatInstanceMarkers(draft.markers ?? detectInstanceMarkers(`${draft.title}\n${draft.description}`))}`.
- Contract: after the `"action"` line add `'      "scope": "general" | "situational" | "scorer_fitted",'`.

**Parser:** `scope = normalizeCapabilityScope(entry.scope) ?? 'general'`; `ReconciliationVerdict.scope: CapabilityScope`. All existing drop rules are unchanged.

**Execution (per verdict, inside the existing switch):**

| Verdict action | scope | Effect |
|---|---|---|
| `keep` / `narrow` | `general` | existing write, then `setCapabilityDraftScope(general)` |
| `keep` / `narrow` | `situational` | existing write, then `setCapabilityDraftScope(situational)` |
| `keep` / `narrow` | `scorer_fitted` | **no** keep/narrow write; `updateCapabilityDraftValidation({ status: 'disputed', validationScore: draft.validationScore, validationNotes: 'reconciliation scorer_fitted ${date}${note ? ` — ${note}` : ''}' })`; `setCapabilityDraftScope(scorer_fitted)`; counts `disputed += 1` |
| `merge` / `dispute` | any | existing behavior; scope not written |

**Host rule (after the verdict loop, and also when the LLM call or parse failed):** for each of tonight's drafts that is still `validated` and whose stored scope is not `situational` / `scorer_fitted`: if `titleHasHardInstanceMarker(draft.title)` → `setCapabilityDraftScope(situational)` and `hardMarkerOverrides += 1`. Implement it as a private helper called from both the success path and the early-return paths of the pass.

**Telemetry:** the pass result gains `scope: { general, situational, scorerFitted, hardMarkerOverrides }` — counts over tonight's drafts after the host rule (`general` includes drafts that got a keep/narrow verdict with scope general; drafts without a verdict are not counted). The zero result carries `scope: { general: 0, situational: 0, scorerFitted: 0, hardMarkerOverrides: 0 }`.

**Promotion of a situational draft:**

- Dream-origin draft: upsert as today; then, **only when `result.created === true`**, `setProcedureHotEligibility(result.entry.id, { eligible: false, reason: 'situational' })` (a situational lesson must not demote an existing general procedure that shares its title). Mark promoted as today.
- Probation draft (`sourceProcedureId`): `setProcedureHotEligibility(sourceProcedureId, { eligible: false, reason: 'situational' })` instead of making it hot; mark promoted with the source id.
- Situational promotions count toward the night's promotion budget (the budget limits hardening per night, which keeps rollback attribution simple).

- [ ] **Step 1: Write the failing tests.** Flow tests use the P1 two-night pattern: the draft is distilled on D1, both validation panels validate it on D2 citing the D2 diary, and the `记忆核对` responder on D2 returns the verdict under test.
  1. *Prompt:* contains `scope`, the three scope words, and `实例标记:` with the formatted markers for a draft whose description cites `PIN`; a draft without markers shows `实例标记:无`.
  2. *Parser:* `scope: 'Situational'` → `situational`; missing → `general`; `'local'` → `general`; existing drop rules still apply (a `keep` without conditions is still dropped).
  3. *Flow, situational:* tonight's validated draft gets `keep` + `situational` → stays `validated`, `scope 'situational'`, absent from `<proven_techniques>` (runner prompt) and from `listInjectableTechniques`; telemetry `reconciliation.scope.situational === 1`.
  4. *Flow, hard marker override:* draft title `给 ${GM} 先发预览`, verdict `keep` + `general` → `scope 'situational'`, `hardMarkerOverrides === 1`, `scope.general === 0`, `scope.situational === 1`.
  5. *Flow, override without a verdict:* reconciliation responder returns `'not json'` → the marker-titled draft is still set `situational`.
  6. *Flow, scorer_fitted:* verdict `keep` + `scorer_fitted` → status `disputed`, notes start with `reconciliation scorer_fitted`, no ledger row; the next night both validation panels see it (its id appears in both `能力验证` prompts) — the existing disputed re-entry path.
  7. *Promotion:* a situational validated draft (seeded directly: score 0.9, `validated_at` two days before the night, `setCapabilityDraftScope(situational)`) promotes into a new procedure with `hotEligible false`, `hotReason 'situational'`; `procedure_recall` returns it with the `only held in a specific situation` status line; it is absent from `<procedures>`.
  8. *No demotion of a namesake:* an existing hot procedure with the same title stays hot after the situational draft's promotion upserts into it.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS. `tests/capabilityReconciliation.test.mjs` assertions that pin the exact prompt text change by design — update and log them.
- [ ] **Step 5: Commit**

```bash
git add src/main/libs/capabilityReconciliationPrompt.ts src/main/services/dreamService.ts
git add -f tests/capabilitySpecificity.test.mjs tests/capabilityReconciliation.test.mjs
git commit -m "feat: judge capability scope in reconciliation and keep situational lessons recall-only"
```

---

### Task 4: Internal vs external prediction split

**Files:**
- Modify: `src/main/libs/predictionLedger.ts` (after `PREDICTION_SOURCES` ~19; `PredictionCalibrationDigest` ~237)
- Modify: `src/main/dreamStore.ts` (`listPredictionCalibration` ~1731)
- Modify: `src/main/services/dreamService.ts` (new private `buildPredictionOodTelemetry`; both telemetry blocks)
- Test: `tests/predictionOodSplit.test.mjs`

**Interfaces:**

```ts
export type PredictionSourceClass = 'internal' | 'external';
export const PREDICTION_SOURCE_CLASS: Record<PredictionSource, PredictionSourceClass> = { cowork: 'internal', surf: 'internal', metatask: 'external', service: 'external' };
PredictionCalibrationDigest.bySourceClass: Record<PredictionSourceClass, PredictionCalibrationBucket>;
```

**Behavior:**

- `listPredictionCalibration` runs one more aggregate in the same window: `SELECT source, status, COUNT(*) AS n FROM metabot_predictions WHERE metabot_id = ? AND created_at >= ? GROUP BY source, status`, folds rows into the two classes with the same bucket arithmetic as `byActionType` (`resolved = hit + miss + partial`, `hitRate = resolved > 0 ? hit / resolved : null`). Unknown sources are skipped.
- `renderPredictionCalibrationDigest` is not changed and must not print the new field.
- `buildPredictionOodTelemetry(metabotId)` (in `try/catch`, `null` on failure): `bucket = ({ resolved, hit, hitRate })` for each class; `gap = internal.hitRate != null && external.hitRate != null ? Math.round((internal.hitRate - external.hitRate) * 10_000) / 10_000 : null`. Telemetry key `predictionOod` on both paths.

- [ ] **Step 1: Write the failing test** `tests/predictionOodSplit.test.mjs` (DreamStore on a fresh DB; insert predictions by raw SQL with terminal statuses and `created_at = Date.now() - 3_600_000` — `listPredictionCalibration` windows on the real clock, not the harness clock):
  1. cowork: 3 hit, 1 miss; surf: 1 partial; metatask: 1 hit, 2 miss; service: 1 expired → `internal { hit: 3, miss: 1, partial: 1, resolved: 5, hitRate: 0.6 }`, `external { hit: 1, miss: 2, resolved: 3, hitRate: 1/3, expired: 1 }`.
  2. *Sums:* for each status, `internal + external` equals the sum over `byActionType`.
  3. *Digest text unchanged:* `renderPredictionCalibrationDigest(digest)` equals the same call on a copy of the digest with `bySourceClass` deleted.
  4. *Telemetry (harness):* a night with that data has `predictionOod` deep-equal to `{ internal: { resolved: 5, hit: 3, hitRate: 0.6 }, external: { resolved: 3, hit: 1, hitRate: 0.3333333333333333 }, gap: 0.2667 }`; with no external resolutions `gap === null`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file, the existing prediction tests, and `pnpm run test:rrsi` → PASS.
- [ ] **Step 5:** Append `tests/predictionOodSplit.test.mjs` to `test:rrsi`; allowlist it.
- [ ] **Step 6: Commit**

```bash
git add src/main/libs/predictionLedger.ts src/main/dreamStore.ts src/main/services/dreamService.ts package.json .gitignore
git add -f tests/predictionOodSplit.test.mjs
git commit -m "feat: split prediction calibration into internal and external outcomes"
```

---

### Task 5: Report `scope`, `ood`, and `usageChannels` sections

**Files:** Modify `scripts/rrsi-evolution-report.mjs`; append to `tests/rrsiEvolutionReport.test.mjs`.

**Report shape (added per bot):**

```js
scope: {
  assessed: { general: 0, situational: 0, scorerFitted: 0, hardMarkerOverrides: 0 },  // summed reconciliation.scope in the window
  current: { general: 0, situational: 0, scorerFitted: 0, unassessed: 0 },           // capability_drafts now, status validated or disputed
} | null,                                                                             // null when the scope column is missing
ood: {
  latest: { date: 'YYYY-MM-DD', internal: { resolved, hit, hitRate }, external: { … }, gap } | null,  // newest night in the window with predictionOod
  gapByNight: [{ date: 'YYYY-MM-DD', gap: 0.12 }],      // ascending, nights with a non-null gap
},
usageChannels: { ownerAppliedRows: 0, externalAppliedRows: 0 } | null,  // hot_layer_usage applied = 1 in the window; a row counts once per channel in its evidence JSON
```

Text line: `  ood: internal 3/5 (60.00%) vs external 1/3 (33.33%) → gap +26.67pt; scope assessed G4 S2 F1 (overrides 1); applied rows owner 9 / external 2`.

- [ ] **Step 1: Write the failing test:** seed telemetry for 3 nights with `predictionOod` and `reconciliation.scope`, drafts with mixed scopes, and usage rows whose evidence lists `owner` / `external`; assert every field and the line; a DB without the scope column yields `scope: null`; a DB without `hot_layer_usage` yields `usageChannels: null`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/rrsi-evolution-report.mjs
git add -f tests/rrsiEvolutionReport.test.mjs
git commit -m "feat: report capability scope, external-outcome gap and usage channels"
```

---

### Task 6: Phase verification and handoff

- [ ] **Step 1:** Run the full verification block from P1 Task 10 (grep target: `src/main/libs/capabilitySpecificity.ts`).
- [ ] **Step 2:** Confirm `git diff main -- src/main/libs/dreamPrompt.ts` is empty (no `DREAM_VERSION` change).
- [ ] **Step 3:** Self-check the P5 gate in the overview.
- [ ] **Step 4:** Handoff note (overview format), including `localdocs/rrsi-p5-test-changes.md`.
