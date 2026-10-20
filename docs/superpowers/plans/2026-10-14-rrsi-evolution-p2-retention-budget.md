# RRSI Evolution P2 — Retention Budget and Hot-Layer Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anneal how many lessons may harden per night, put procedures that the agent saves at runtime (including surf-learned ones) through the same gate as dream drafts, inject each lesson through exactly one path, and record which hot-layer items were exposed each day and how much context they cost.

**Architecture:** A pure `promotionBudget.ts` computes the nightly budget from the count of completed non-empty nights. Procedures gain a hot-eligibility flag; `upsertProcedure` decides it by origin, and the `procedure_save` tool opens a probation draft (`capability_drafts.source_procedure_id`) that the existing gate judges. Promotion of a probation draft flips eligibility instead of rewriting the procedure. A new `hot_layer_usage` table records exposures at injection and recall time. The dream run records the budget and the hot-layer footprint.

**Tech Stack:** TypeScript main process, sql.js stores, `node:test` against `dist-electron/`.

**Index / acceptance gate:** `docs/superpowers/plans/2026-10-14-rrsi-evolution-00-overview.md` (P2 gate). **Design:** spec §6.2. **Prerequisite:** P1 merged into `main`.

## Global Constraints

All constraints in the overview apply. Phase-specific:

- Branch `feat/rrsi-p2-retention`, worktree `.worktrees/rrsi-p2-retention`, from `main`. Never push, never merge.
- **Grandfathering:** every procedure that exists before the migration stays hot (`hot_eligible` column default 1). Only procedures created or revised by origin `agent` after the upgrade can enter probation.
- Never archive or delete an agent-authored procedure because of a gate outcome, a re-review, or a rollback; change `hot_eligible` / `hot_reason` instead. Dream-origin procedures keep today's archive behavior.
- `procedure_recall` must keep returning recall-only procedures (with a status line); only the hot layer filters them.
- Exposure writes are best-effort telemetry: wrap each in `try/catch`; a failure must never break a turn.
- No `DREAM_VERSION` change in this phase (the dream prompt is untouched).
- One commit per task + English dev-journal buzz after each commit.

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/coworkStore.ts` | Task 1 refactor (shared draft columns + mapper); `source_procedure_id`; `ensureProbationDraftForProcedure`; `listInjectableTechniques`; `recordHotLayerExposures`; exposure write inside `markCapabilityDraftsInjected`; purge exclusion for probation drafts |
| `src/main/sqliteStore.ts` | `capability_drafts.source_procedure_id` column; `hot_layer_usage` table |
| `src/main/libs/promotionBudget.ts` | Create: `promotionBudgetForNight()` |
| `src/main/libs/procedureProbation.ts` | Create: `PROCEDURE_HOT_REASONS`, `normalizeProcedureHotReason`, `buildProbationDraftDescription` |
| `src/main/metaidKnowledgeStore.ts` | Hot columns (PRAGMA-guarded), entry fields, upsert semantics, `setProcedureHotEligibility`, `listHotProcedures` |
| `src/main/libs/procedurePromptBlocks.ts` | `renderProcedureBlock` (included ids), recall status line |
| `src/main/libs/coworkRunner.ts` | `CoworkKnowledgeStore` seam additions; hot block from `listHotProcedures`; exposures; probation draft on `procedure_save`; techniques from `listInjectableTechniques` |
| `src/main/services/privateChatDaemon.ts` | Techniques from `listInjectableTechniques` (~line 5601) |
| `src/main/main.ts` | Group-task `listValidatedCapabilityDrafts` wiring uses `listInjectableTechniques` (~line 4511) |
| `src/main/dreamStore.ts` | `countNonEmptyDreamNights`; `listActivePromotedProcedureIds` requires `hot_eligible = 1` |
| `src/main/services/dreamService.ts` | Budgeted promotion; probation-draft promotion / rejection / re-review / rollback handling; `promotionBudget` + `hotLayer` telemetry |
| `src/main/services/memoryHygieneService.ts` | `hot-layer-usage` retention step |
| `scripts/rrsi-evolution-report.mjs` | `retention` section |
| `tests/promotionBudget.test.mjs` | Create |
| `tests/procedureProbation.test.mjs` | Create |
| `tests/hotLayerExposure.test.mjs` | Create |
| Existing tests | `metaidKnowledgeStore`, `procedureRecall`, `experiencePromptInjection`, `capabilityValidation`, `promptLayerRollback`, `rrsiEvolutionReport`, `memoryHygieneService` — append or repair per P1 Task 5 Step 6 rules; the seven runner stub-store files in Task 6 Step 4 get one stub method each |
| `package.json` | Append new + touched files to `test:rrsi` |
| `.gitignore` | Allowlist the three new test files |

---

### Task 0: Worktree and baseline

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots
git worktree add .worktrees/rrsi-p2-retention -b feat/rrsi-p2-retention main
cd .worktrees/rrsi-p2-retention
pnpm install
test -f src/main/libs/capabilityGateRegularizers.ts && test -f tests/fixtures/rrsiDreamHarness.mjs && echo "P1 present"
```

Expected: `P1 present`. Otherwise stop.

- [ ] **Step 2: Baseline** — same commands as P1 Task 0 Step 2, writing `localdocs/rrsi-p2-baseline.txt`; add `procedureRecall`, `metaidKnowledgeStore`, `experiencePromptInjection` to the per-file loop.

---

### Task 1: Refactor — one column list and mapper for capability drafts

**Files:** Modify `src/main/coworkStore.ts` only.

Every capability-draft SELECT in `coworkStore.ts` (`listCapabilityDrafts` ~7314, `listPromotableCapabilityDrafts` ~7414, `listStaleDisputedCapabilityDrafts` ~7615, `listReReviewableCapabilityDrafts` ~7661) repeats the same column list and the same row mapping. Extract:

- `const CAPABILITY_DRAFT_COLUMNS = '…'` (the exact current list), and
- `private mapCapabilityDraftRow(row: CapabilityDraftRow): CapabilityDraft`,

and use them in all four methods. No behavior change; later columns are added in one place.

- [ ] **Step 1:** Run `pnpm run test:rrsi` → PASS (before).
- [ ] **Step 2:** Refactor.
- [ ] **Step 3:** Run `pnpm run test:rrsi` and `node --test tests/capabilityReconciliation.test.mjs tests/dreamCapabilityLearnings.test.mjs` → PASS, unchanged.
- [ ] **Step 4: Commit** `git commit -am "refactor: share capability draft column list and row mapper"`

---

### Task 2: Annealed promotion budget

**Files:**
- Create: `src/main/libs/promotionBudget.ts`
- Modify: `src/main/dreamStore.ts` (new method near `listRecentRuns` ~1086)
- Modify: `src/main/services/dreamService.ts` (`promoteCapabilityDraftsToProcedures` ~1684; telemetry)
- Test: `tests/promotionBudget.test.mjs`

**Interfaces:**
- Produces: `PROMOTION_BUDGET_MAX`, `PROMOTION_BUDGET_MIN`, `PROMOTION_BUDGET_ANNEAL_NIGHTS`, `promotionBudgetForNight` (overview contract); `DreamStore.countNonEmptyDreamNights(metabotId, beforeDate)`; telemetry `promotionBudget: { nights, budget, candidates, promoted }` on both the empty-day and the non-empty path.

**Behavior:**

- `promotionBudgetForNight(t, { max = 3, min = 1, annealNights = 60 })`: if `t` is not a finite number, or `t < 0`, use `t = 0`. `tt = Math.min(Math.floor(t), annealNights)`. `value = min + (max - min) * 0.5 * (1 + Math.cos(Math.PI * tt / annealNights))`. Return `Math.max(min, Math.ceil(value - 1e-9))`.
- `countNonEmptyDreamNights(metabotId, beforeDate)`: `SELECT COUNT(*) FROM metabot_dream_telemetry_daily WHERE metabot_id = ? AND empty_day = 0 AND dream_date < ?`.
- Promotion pass: `nights = countNonEmptyDreamNights(metabot.id, date)`; `budget = promotionBudgetForNight(nights)`; query `listPromotableCapabilityDrafts` with `limit: 50` (so the telemetry can show how many were eligible), then promote `candidates.slice(0, budget)` in the existing order; return `{ promoted, nights, budget, candidates: candidates.length }`. Leave `CAPABILITY_PROMOTION_MAX_PER_NIGHT` (`capabilityValidationPrompt.ts:28`, equal to `PROMOTION_BUDGET_MAX`) untouched; `dreamService.ts` simply stops passing it, and drops the import if nothing else uses it.

- [ ] **Step 1: Write the failing test** `tests/promotionBudget.test.mjs`:
  - Vectors: `0 → 3`, `10 → 3`, `20 → 3`, `29 → 3`, `30 → 2`, `40 → 2`, `59 → 2`, `60 → 1`, `500 → 1`, `-1 → 3`, `NaN → 3`; custom `{ max: 4, min: 1, annealNights: 10 }`: `0 → 4`, `5 → 3`, `10 → 1`.
  - Store: insert three rows into `metabot_dream_telemetry_daily` by raw SQL (`metabot_id`, `dream_date`, `empty_day`; all other columns are nullable) for `2026-08-01` (0), `2026-08-02` (1), `2026-08-03` (0) → `countNonEmptyDreamNights(5, '2026-08-04') === 2`, `countNonEmptyDreamNights(5, '2026-08-03') === 1`, another bot → 0.
  - Flow (harness): seed 4 validated drafts with score 0.9 (above `CAPABILITY_PROMOTION_MIN_SCORE = 0.85`) and `validated_at` two days before the night; no prior telemetry → the night promotes 3 and `telemetry.promotionBudget` deep-equals `{ nights: 0, budget: 3, candidates: 4, promoted: 3 }`. In a fresh harness, first insert 60 earlier non-empty rows by raw SQL → the night promotes 1 and the telemetry shows `{ nights: 60, budget: 1, candidates: 4, promoted: 1 }`.
- [ ] **Step 2: Run to verify it fails.** `pnpm run compile:electron && node --test tests/promotionBudget.test.mjs`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new test + `tests/capabilityValidation.test.mjs` (promotion tests) → PASS; repair existing promotion-count assertions only if they relied on 3/night with no telemetry history (they should not change: a fresh test DB has `nights = 0 → budget 3`).
- [ ] **Step 5:** Append `tests/promotionBudget.test.mjs` to `test:rrsi` and the `.gitignore` allowlist.
- [ ] **Step 6: Commit**

```bash
git add src/main/libs/promotionBudget.ts src/main/dreamStore.ts src/main/services/dreamService.ts package.json .gitignore
git add -f tests/promotionBudget.test.mjs
git commit -m "feat: anneal the nightly capability promotion budget"
```

---

### Task 3: Procedure hot eligibility and upsert semantics

**Files:**
- Create: `src/main/libs/procedureProbation.ts`
- Modify: `src/main/metaidKnowledgeStore.ts` (`ensureMetaIDKnowledgeSchema` ~248; `MetaIDProcedureEntry` ~118; `UpsertMetaIDProcedureResult` ~154; `ProcedureRow` ~506; `rowToProcedure` ~551; `upsertProcedure` ~1134; new methods after `archiveProcedureByTitle` ~1249)
- Test: `tests/procedureProbation.test.mjs` (store section)

**Interfaces:** overview P2 contracts for `procedureProbation.ts` and `MetaIDKnowledgeStore`.

**Migration (append to `ensureMetaIDKnowledgeSchema`, after the procedures index):**

```ts
const procedureCols = (db.exec('PRAGMA table_info(metaid_knowledge_procedures)')[0]?.values?.map((row) => row[1]) || []) as string[];
if (!procedureCols.includes('hot_eligible')) db.run('ALTER TABLE metaid_knowledge_procedures ADD COLUMN hot_eligible INTEGER NOT NULL DEFAULT 1');
if (!procedureCols.includes('hot_since')) db.run('ALTER TABLE metaid_knowledge_procedures ADD COLUMN hot_since INTEGER');
if (!procedureCols.includes('hot_reason')) db.run('ALTER TABLE metaid_knowledge_procedures ADD COLUMN hot_reason TEXT');
```

Wrap in `try/catch` with `console.warn('migrate metaid_knowledge_procedures hot columns:', error)`. The `CREATE TABLE` statement is not changed.

**Entry mapping:** `hotEligible = Number(row.hot_eligible ?? 1) !== 0`; `hotSince = row.hot_since == null ? null : Number(row.hot_since)`; `hotReason = normalizeProcedureHotReason(row.hot_reason)`.

**`upsertProcedure` semantics (origin = normalized `input.origin`, default `agent`):**

| Case | status | hot_eligible | hot_reason | hot_since |
|---|---|---|---|---|
| insert, origin `agent` | active | 0 | `probation` | NULL |
| insert, origin `dream` / `user` | active | 1 | NULL | now |
| update, existing `archived`, origin `agent` | active | 0 | `probation` | NULL |
| update, existing `archived`, origin `dream` / `user` | active | 1 | NULL | now |
| update, existing active + hot, origin `agent` | active | 1 (unchanged) | NULL | unchanged |
| update, existing active + not hot, origin `agent`, reason ∈ {`unused`, `situational`} | active | 0 | unchanged | unchanged |
| update, existing active + not hot, origin `agent`, any other reason | active | 0 | `probation` | NULL |
| update, existing active, origin `dream` / `user` | active | 1 | NULL | existing `hot_since` ?? now |

All other columns are written exactly as today. Result gains `needsGate = entry.hotEligible === false && entry.hotReason === 'probation'`.

**New methods:**

- `setProcedureHotEligibility(id, { eligible, reason, atMs = this.now() })`: only for `status = 'active'` rows. `eligible: true` → `hot_eligible = 1, hot_reason = NULL, hot_since = COALESCE(hot_since, atMs)` when the row was already hot, else `hot_since = atMs`; `eligible: false` → `hot_eligible = 0, hot_reason = reason`. Does not touch `updated_at` (eligibility is not a content revision). Returns whether a row changed; saves when true.
- `listHotProcedures(metabotId, { limit = PROCEDURE_PROMPT_MAX_ITEMS })`: `status = 'active' AND hot_eligible = 1`, `ORDER BY updated_at DESC, id DESC`, clamp limit 1–200. (P3 replaces the ordering.)

**`buildProbationDraftDescription({ triggerText, steps, pitfalls, sourcePinIds })`** returns, joined with `\n` and truncated to 1200 chars:
`触发:<trigger>` / `步骤:<steps joined with ' → '>` / `避免:<pitfalls joined with ';'>` (only when non-empty) / `来源 pin:<ids joined with ', '>` (only when non-empty). Including the pin ids lets `collectChainEvidenceRefs` verify them.

- [ ] **Step 1: Write the failing tests** (`tests/procedureProbation.test.mjs`, store section) with `new MetaIDKnowledgeStore(db, () => {}, () => clock)`:
  1. *Grandfathering:* on an empty sql.js DB, create `metaid_knowledge_procedures` with the pre-P2 DDL copied verbatim from `main` (`metaidKnowledgeStore.ts` ~328–353, with the `${ORIGINS_SQL}` template expanded to its literal value), insert one row with `origin = 'agent'` by raw SQL, then call `ensureMetaIDKnowledgeSchema(db)` twice → no error, and the store reads the row back with `hotEligible: true`, `hotReason: null`.
  2. *Insert by origin:* agent → `hotEligible false`, `hotReason 'probation'`, `needsGate true`; dream → `hotEligible true`, `hotSince === clock`, `needsGate false`.
  3. *Archived resurrection closed:* archive an agent-created hot procedure (`setProcedureHotEligibility(true)` first, then `archiveProcedureByTitle`) and re-save the same title as agent → `status 'active'`, `hotEligible false`, `hotReason 'probation'`.
  4. *Hot agent revision stays hot:* a hot procedure revised by agent keeps `hotEligible true` and its `hotSince`.
  5. *Reason rules:* a non-hot procedure with reason `gate_rejected` revised by agent → `probation`; with reason `unused` → stays `unused`, `needsGate false`.
  6. *Dream upsert promotes:* a probation procedure upserted by origin dream → hot.
  7. *setProcedureHotEligibility:* refuses archived rows; does not change `updatedAt`.
  8. *listHotProcedures* excludes recall-only and archived rows; `listProcedures` (recall) still returns recall-only rows.
  9. *Description builder:* exact output for a sample with 2 steps, 1 pitfall, 1 pin id; omits empty sections; 1200-char cap.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file + `tests/metaidKnowledgeStore.test.mjs` + `tests/procedureRecall.test.mjs` → PASS. If an existing test asserts that an agent-saved procedure appears in the hot block, that is the intended behavior change: update it to save with origin `dream` or to flip eligibility first, and log it.
- [ ] **Step 5:** Append `tests/procedureProbation.test.mjs`, `tests/metaidKnowledgeStore.test.mjs`, `tests/procedureRecall.test.mjs` to `test:rrsi`; allowlist the new file.
- [ ] **Step 6: Commit**

```bash
git add src/main/libs/procedureProbation.ts src/main/metaidKnowledgeStore.ts package.json .gitignore
git add -f tests/procedureProbation.test.mjs
git commit -m "feat: add procedure hot eligibility with agent probation semantics"
```

---

### Task 4: Probation drafts from `procedure_save`, recall status line

**Files:**
- Modify: `src/main/sqliteStore.ts` (capability-drafts migration block: `source_procedure_id TEXT`)
- Modify: `src/main/coworkStore.ts` (`CapabilityDraft.sourceProcedureId`, column list, `ensureProbationDraftForProcedure`, purge exclusion)
- Modify: `src/main/libs/procedurePromptBlocks.ts` (`ProcedurePromptEntry.statusNote`, recall rendering)
- Modify: `src/main/libs/coworkRunner.ts` (`CoworkKnowledgeStore.upsertProcedure` return type ~1785, `listProcedures` return type ~1762; `runProcedureSaveTool` ~4129; `runProcedureRecallTool` ~4083)
- Test: `tests/procedureProbation.test.mjs` (append)

**Behavior:**

- Migration: `if (!draftCols.includes('source_procedure_id')) ALTER TABLE capability_drafts ADD COLUMN source_procedure_id TEXT` inside the existing guarded block.
- `ensureProbationDraftForProcedure({ metabotId, procedureId, title, description, dreamDate })`: if a draft of the bot with this `source_procedure_id` and `status IN ('draft', 'disputed')` exists → `UPDATE title, description` (keep `dream_date`, `created_at`, status), return `{ draftId, created: false }`; otherwise INSERT a `draft` row with `capability_type = 'workflow'`, `source_procedure_id = procedureId`, return `{ draftId, created: true }`. Invalid input → `null`. This method bypasses the falsified-ledger block on purpose (an explicit agent save is never silently dropped); the gate still sees the similar-falsified line.
- `purgeExpiredCapabilityDrafts`: add `AND NOT (status = 'draft' AND source_procedure_id IS NOT NULL)` so a pending probation ticket never ages out while its procedure waits.
- `runProcedureSaveTool`: after a successful upsert, when `result.needsGate === true`, call `this.store.ensureProbationDraftForProcedure({ metabotId, procedureId: result.entry.id, title: result.entry.title, description: buildProbationDraftDescription(result.entry), dreamDate: formatBotWorkspaceDate(new Date()) })` in `try/catch` (failure → `console.warn`, the save still succeeds). Append to the tool's text result: `' It is saved for recall now; it joins your always-on procedures after a later dream validates it.'` when `needsGate` is true.
- Seam types in `coworkRunner.ts`: `upsertProcedure` returns `{ created; revised; needsGate?: boolean; entry: { id; title; version; triggerText?: string; steps?: string[]; pitfalls?: string[]; sourcePinIds?: string[] } }`; `listProcedures` rows gain optional `hotEligible?: boolean; hotReason?: string | null`. Optional fields keep test stubs compiling.
- `formatBotWorkspaceDate` comes from `src/main/libs/botWorkspace.ts` (local `YYYY-MM-DD`, no Electron dependency); import it where needed in this phase.
- Recall rendering: `ProcedurePromptEntry` gains `id?: string` and `statusNote?: string | null`; `formatProcedureRecallResults` prints `  status: <statusNote>` right after the `when:` line when set. `runProcedureRecallTool` maps `id: entry.id` into each entry (Task 7 needs it) and sets `statusNote` for rows with `hotEligible === false`: reason `probation` → `'not yet validated by a dream — treat as a hypothesis'`; `gate_rejected` / `demoted` → `'rejected by dream validation — use only if the situation clearly differs'`; `rollback` → `'withdrawn after a bad day — verify before relying on it'`; `unused` → `'rarely applied — recalled on demand'`; `situational` → `'only held in a specific situation — check the trigger carefully'`.

- [ ] **Step 1: Write the failing tests** (append):
  1. `ensureProbationDraftForProcedure` creates once, refreshes on the second call (same `draftId`, new description), and creates a new row after the first is `rejected`.
  2. Hygiene purge with a cutoff in the future deletes an old plain `draft` but keeps an old probation `draft`.
  3. Runner seam (follow the existing `procedureRecall.test.mjs` pattern for invoking the tool handlers): `procedure_save` for a new title as an agent creates one probation draft whose description contains `触发:` and the source pin id, and the tool text contains `joins your always-on procedures`; saving again keeps one draft; `procedure_recall` shows `status: not yet validated by a dream`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/sqliteStore.ts src/main/coworkStore.ts src/main/libs/procedurePromptBlocks.ts src/main/libs/coworkRunner.ts
git add -f tests/procedureProbation.test.mjs
git commit -m "feat: open a probation draft when the agent saves a procedure"
```

---

### Task 5: Gate outcomes for probation drafts

**Files:**
- Modify: `src/main/services/dreamService.ts` (fresh-gate demote branch; `reReviewValidatedCapabilityDrafts` demote branch; `promoteCapabilityDraftsToProcedures`; `applyPromptLayerRollback` ~2247)
- Modify: `src/main/dreamStore.ts` (`listActivePromotedProcedureIds` ~1839)
- Test: `tests/procedureProbation.test.mjs` (append flows)

**Behavior:**

- **Promotion:** for a candidate with `sourceProcedureId`:
  `ok = metaidKnowledgeStore.setProcedureHotEligibility(sourceProcedureId, { eligible: true, reason: null })`. If `ok`, `markCapabilityDraftPromoted({ id, metabotId, procedureId: sourceProcedureId })` and count it. If not `ok` (procedure missing or archived), `updateCapabilityDraftValidation({ status: 'rejected', validationNotes: 'source procedure no longer active' })` — no ledger write, no count. Never call `upsertProcedure` for these drafts. Candidates without `sourceProcedureId` keep the current path.
- **Fresh-gate agreed demote** of a probation draft: after the existing write and ledger record, `setProcedureHotEligibility(sourceProcedureId, { eligible: false, reason: 'gate_rejected' })`.
- **Re-review agreed demote** of a promoted probation draft: replace `archiveProcedureByTitle` with `setProcedureHotEligibility(sourceProcedureId, { eligible: false, reason: 'demoted' })`.
- **Rollback:** build `agentSourced = new Set(listCapabilityDrafts(metabot.id).filter((d) => d.sourceProcedureId).map((d) => d.sourceProcedureId))`. For each procedure id in the rollback set (the existing union at ~2264–2271): if in `agentSourced` → `setProcedureHotEligibility(id, { eligible: false, reason: 'rollback' })` (count it in `archivedProcedures` for the existing log/notes, since it left the active hot set); else archive as today. In the existing draft-rejection loop (~2288), when a rejected draft has a `sourceProcedureId`, also set that procedure to `{ eligible: false, reason: 'rollback' }` so its recall note reflects the bad day; a later agent re-save reopens probation (Task 3 table). Rollback rejections never write the falsified ledger (P1 rule).
- **Snapshot set:** `listActivePromotedProcedureIds` adds `AND COALESCE(p.hot_eligible, 1) = 1`.
- **Reconciliation:** `buildReconciliationConflictCandidates(metabotId, draft)` takes the draft's `sourceProcedureId` and skips `procedure:<sourceProcedureId>` (a probation draft must not conflict with, or be merged into, its own procedure). A `merge` verdict on a probation draft keeps today's handling (draft `rejected` with `merged into …`); the source procedure stays recall-only with reason `probation` and no ledger row is written.

- [ ] **Step 1: Write the failing flow tests** (harness, `capabilityGate` default):
  1. *Probation to hot:* agent-save a procedure on D1 (call `knowledgeStore.upsertProcedure({ origin: 'agent', … })` + `coworkStore.ensureProbationDraftForProcedure` with `dreamDate: D1`, or drive the runner tool if the harness exposes it); night D2 both panels validate it (score 0.9, D2 citation) → draft `validated`; night D3 (promotion needs a verdict at least one night old) → procedure hot, its `steps` unchanged, `version` unchanged, draft `promotedProcedureId === procedure.id`.
  2. *Probation rejected:* both panels reject on D2 → procedure stays `active`, `hotReason 'gate_rejected'`, ledger has one row.
  3. *Rollback keeps the agent record:* reuse the negative-spike setup from `tests/promptLayerRollback.test.mjs` for a night that promoted a probation procedure → procedure `active`, `hotReason 'rollback'`, not archived; a dream-origin procedure promoted the same night is archived (unchanged behavior).
  4. *Missing source:* archive the source procedure before the promotion night → draft becomes `rejected` with note `source procedure no longer active`, ledger unchanged.
  5. *No self-conflict:* on the validation night, the `记忆核对` prompt for the probation draft does not contain `procedure:<its source id>`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/services/dreamService.ts src/main/dreamStore.ts
git add -f tests/procedureProbation.test.mjs
git commit -m "feat: route probation procedures through promotion, demotion and rollback"
```

---

### Task 6: Single injection path

**Files:**
- Modify: `src/main/coworkStore.ts` (`listInjectableTechniques` next to `listCapabilityDrafts`)
- Modify: `src/main/libs/procedurePromptBlocks.ts` (`renderProcedureBlock`)
- Modify: `src/main/libs/coworkRunner.ts` (`buildExperiencePromptBlocksXml` region ~5874 and ~5918; `CoworkKnowledgeStore.listHotProcedures?`)
- Modify: `src/main/services/privateChatDaemon.ts` (~5601), `src/main/main.ts` (~4511)
- Test: `tests/hotLayerExposure.test.mjs` (injection section), `tests/experiencePromptInjection.test.mjs` (repair if needed)

**Behavior:**

- `listInjectableTechniques(metabotId, limit = 5)`: `status = 'validated' AND promoted_at IS NULL`, `ORDER BY created_at DESC, id DESC`, `LIMIT` (clamp 1–50). P3 replaces the ordering; P5 adds a scope filter.
- `renderProcedureBlock(entries, maxItems, maxChars)` returns `{ text, includedIds }` where `includedIds` are the `id`s of the entries actually rendered (entries without `id` are rendered but not listed). `buildProcedureBlock` becomes `renderProcedureBlock(...).text` (unchanged output). The hot block (~5918) passes the store rows, which already carry `id`.
- `CoworkKnowledgeStore` gains optional `listHotProcedures?(metabotId: number, options?: { limit?: number }): <listProcedures row shape>[]`. The hot block uses it when present, else falls back to `listProcedures({ metabotId, status: 'active', limit })`.
- Replace the three technique reads with `listInjectableTechniques(metabotId, 5)` (`coworkRunner`), `coworkStore.listInjectableTechniques(metabot.id, 5)` (`privateChatDaemon`), and `getCoworkStore().listInjectableTechniques(metabotId, 5)` (`main.ts` group-task dep — keep the dep name `listValidatedCapabilityDrafts`).

- [ ] **Step 1: Write the failing tests:**
  1. A validated-and-promoted draft is absent from `listInjectableTechniques`; an unpromoted validated draft is present.
  2. `buildExperiencePromptBlocksXml` through the runner (follow `tests/experiencePromptInjection.test.mjs`): the promoted draft's title appears inside `<procedures>` and not inside `<proven_techniques>`; a recall-only procedure appears in neither.
  3. `renderProcedureBlock` with a 300-char budget returns fewer `includedIds` than entries, and `buildProcedureBlock` output is byte-identical to `renderProcedureBlock().text`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Repair runner stub stores.** Seven test files hand-roll a store stub with `listCapabilityDrafts() { return [] }` that the runner now bypasses: `tests/coworkDshSessionTypes.test.mjs`, `tests/coworkDshSessionTitle.test.mjs`, `tests/coworkDshIntegration.test.mjs`, `tests/dshHostToolRegistry.test.mjs`, `tests/cerebellumVolatileBlockGate.test.mjs`, `tests/cerebellumKnowledgeHotRank.test.mjs`, `tests/cerebellumIntuitionTool.test.mjs`. Add `listInjectableTechniques() { return [] }` (same style) next to each stub's `listCapabilityDrafts`; change nothing else in them. Re-check with `rg -l "listCapabilityDrafts\s*\(\)\s*\{" tests` that no stub was missed, and log the files.
- [ ] **Step 5: Run** `pnpm run test:rrsi`, the seven files above, and `node --test tests/experiencePromptInjection.test.mjs tests/privateChatScopedMemory.test.mjs tests/groupTaskDaemon.test.mjs` → PASS (repair stubs that implement `listValidatedCapabilityDrafts` only if they break; log changes).
- [ ] **Step 6:** Append `tests/hotLayerExposure.test.mjs` and `tests/experiencePromptInjection.test.mjs` to `test:rrsi`; allowlist the new file.
- [ ] **Step 7: Commit**

```bash
git add src/main/coworkStore.ts src/main/libs/procedurePromptBlocks.ts src/main/libs/coworkRunner.ts src/main/services/privateChatDaemon.ts src/main/main.ts package.json .gitignore
git add -f tests/hotLayerExposure.test.mjs tests/coworkDshSessionTypes.test.mjs tests/coworkDshSessionTitle.test.mjs tests/coworkDshIntegration.test.mjs tests/dshHostToolRegistry.test.mjs tests/cerebellumVolatileBlockGate.test.mjs tests/cerebellumKnowledgeHotRank.test.mjs tests/cerebellumIntuitionTool.test.mjs
git commit -m "feat: inject each lesson through one path and only hot procedures"
```

---

### Task 7: Exposure ledger

**Files:**
- Modify: `src/main/sqliteStore.ts` (new table after the capability-drafts block)
- Modify: `src/main/coworkStore.ts` (`recordHotLayerExposures`; exposure write in `markCapabilityDraftsInjected` ~7352)
- Modify: `src/main/libs/coworkRunner.ts` (hot procedure block; recall tool)
- Modify: `src/main/services/memoryHygieneService.ts` (`hot-layer-usage` step)
- Test: `tests/hotLayerExposure.test.mjs` (append)

**Schema (exact):**

```sql
CREATE TABLE IF NOT EXISTS hot_layer_usage (
  metabot_id INTEGER NOT NULL,
  usage_date TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('technique', 'procedure')),
  item_id TEXT NOT NULL,
  exposure TEXT NOT NULL CHECK (exposure IN ('hot', 'recall')),
  first_exposed_at INTEGER NOT NULL,
  exposure_count INTEGER NOT NULL DEFAULT 1,
  applied INTEGER CHECK (applied IS NULL OR applied IN (0, 1)),
  evidence TEXT,
  audited_at INTEGER,
  PRIMARY KEY (metabot_id, usage_date, item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_hot_layer_usage_item
  ON hot_layer_usage(metabot_id, item_kind, item_id, usage_date DESC);
```

Comment: dream bookkeeping; one row per item per local day; `applied` / `evidence` / `audited_at` are filled by the P3 usage audit; retention 120 days.

**Behavior:**

- `usage_date` = `formatBotWorkspaceDate(new Date(atMs))` (local date, same convention as dream dates).
- `recordHotLayerExposures({ metabotId, usageDate, items, atMs = Date.now() })`: per item `INSERT … ON CONFLICT(metabot_id, usage_date, item_kind, item_id) DO UPDATE SET exposure_count = exposure_count + 1, exposure = CASE WHEN hot_layer_usage.exposure = 'hot' OR excluded.exposure = 'hot' THEN 'hot' ELSE 'recall' END`. Saves once. Returns the number of items written.
- `markCapabilityDraftsInjected(ids)`: after the existing UPDATE, run one upsert of technique exposures for today:
  ```sql
  INSERT INTO hot_layer_usage (metabot_id, usage_date, item_kind, item_id, exposure, first_exposed_at, exposure_count)
  SELECT metabot_id, ?, 'technique', CAST(id AS TEXT), 'hot', ?, 1
  FROM capability_drafts WHERE id IN (…)
  ON CONFLICT(metabot_id, usage_date, item_kind, item_id) DO UPDATE SET exposure_count = exposure_count + 1, exposure = 'hot'
  ```
  (The `WHERE` clause is required before `ON CONFLICT` in the `INSERT … SELECT` form.) Wrap in `try/catch` so the existing counter update still saves.
- Runner hot block: after `renderProcedureBlock`, if `includedIds.length > 0` and the block is non-empty, `this.store.recordHotLayerExposures({ metabotId, usageDate: formatBotWorkspaceDate(new Date()), items: includedIds.map((id) => ({ kind: 'procedure', id, exposure: 'hot' })) })` in `try/catch`.
- Recall tool: after results, record `{ kind: 'procedure', id, exposure: 'recall' }` for every returned row with an id, in `try/catch`.
- Hygiene step `hot-layer-usage` (after `capability-falsified`): delete rows with `usage_date < formatBotWorkspaceDate(new Date(nowMs - 120 * 86_400_000))`, skipping excluded bots; constant `HOT_LAYER_USAGE_RETENTION_DAYS = 120` exported from `coworkStore.ts` next to the method; counter `hotLayerUsagePurged`.

- [ ] **Step 1: Write the failing tests** (append):
  1. Two `markCapabilityDraftsInjected([id])` calls on the same day → one row, `exposure_count 2`, `exposure 'hot'`.
  2. `recordHotLayerExposures` recall then hot → `exposure 'hot'`; hot then recall → stays `'hot'`; recall only → `'recall'`.
  3. Runner: building the memory prompt for a bot with 2 hot procedures writes 2 procedure rows for today; a `procedure_recall` returning a recall-only procedure writes a `recall` row.
  4. A failing exposure write (drop the table before the call) does not throw from `markCapabilityDraftsInjected` and still bumps `times_injected`.
  5. Hygiene: a row dated 121 days ago is purged, one dated 119 days ago is kept.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/sqliteStore.ts src/main/coworkStore.ts src/main/libs/coworkRunner.ts src/main/services/memoryHygieneService.ts
git add -f tests/hotLayerExposure.test.mjs tests/memoryHygieneService.test.mjs
git commit -m "feat: record daily hot-layer exposures for techniques and procedures"
```

---

### Task 8: Footprint telemetry and report section

**Files:**
- Modify: `src/main/services/dreamService.ts` (new private `buildHotLayerTelemetry(metabotId, date)`; both telemetry blocks)
- Modify: `scripts/rrsi-evolution-report.mjs` (`retention` section)
- Test: `tests/hotLayerExposure.test.mjs` (telemetry), `tests/rrsiEvolutionReport.test.mjs` (append)

**Behavior:**

- `buildHotLayerTelemetry(metabotId, date)` (inside `try/catch`, `null` on failure):
  - `hotProcedures` = `listHotProcedures(metabotId, { limit: 200 }).length`;
  - `probationProcedures` = count of active procedures with `hotEligible === false && hotReason === 'probation'` (use `listProcedures({ status: 'active', limit: 500 })` and filter);
  - `injectableTechniques` = `listInjectableTechniques(metabotId, 50).length`;
  - `procedureBlockChars` = `buildProcedureBlock(listHotProcedures(metabotId, { limit: PROCEDURE_PROMPT_MAX_ITEMS })).length`;
  - `techniqueBlockChars` = `buildProvenTechniquesBlock(listInjectableTechniques(metabotId, 5)).length`;
  - `exposedItems` = rows in `hot_layer_usage` for `(metabotId, date)` (add `CoworkStore.countHotLayerExposures(metabotId, usageDate): number`).
- Telemetry key `hotLayer` on both paths (empty days still report the current footprint).
- Report `retention` section per bot: `promotionsPerNight` (mean over nights with `promotionBudget`), `budgetLatest`, `hotLayerChars: { first, last }` (sum of the two char fields on the first and last night in the window that have `hotLayer`), `probation: { opened, validated, rejected, promoted }` (from `capability_drafts` where `source_procedure_id IS NOT NULL` and `created_at` within the window; `null` when the column is missing), `exposure: { nights, items }` (from `hot_layer_usage`; `null` when missing).

- [ ] **Step 1: Write the failing tests:** a non-empty night's telemetry has `hotLayer.procedureBlockChars > 0` when one hot procedure exists and `0` when none; the report test gets two nights of `hotLayer` / `promotionBudget` telemetry and asserts the `retention` numbers; a DB without `hot_layer_usage` yields `exposure: null`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/services/dreamService.ts src/main/coworkStore.ts scripts/rrsi-evolution-report.mjs
git add -f tests/hotLayerExposure.test.mjs tests/rrsiEvolutionReport.test.mjs
git commit -m "feat: record hot-layer footprint and report retention metrics"
```

---

### Task 9: Phase verification and handoff

- [ ] **Step 1:** Run the full verification block from P1 Task 10 (replace the grep target with `src/main/libs/promotionBudget.ts src/main/libs/procedureProbation.ts`).
- [ ] **Step 2:** Self-check the P2 gate in the overview.
- [ ] **Step 3:** Handoff note (overview format), including the list of changed pre-existing assertions (`localdocs/rrsi-p2-test-changes.md`).
