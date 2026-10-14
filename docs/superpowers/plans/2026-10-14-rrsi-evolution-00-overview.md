# RRSI-Regularized Dream Evolution — Implementation Plan Overview

> **For agentic workers:** This file is the index. Implement ONE phase file at a time (`-p1-` … `-p5-`). Inside a phase file use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans; steps use checkbox (`- [ ]`) syntax. Read the companion design first — it explains *why* every rule exists; this plan says *what* to build and how it is accepted.

**Goal:** Make every MetaBot's nightly self-improvement loop resistant to overfitting — validate lessons only on later evidence, measure judge noise, remember falsified ideas, budget and attribute promotions, put agent-learned procedures through the same gate, prune what is never used, explore under-used parts of the AI internet when stalled, and separate "pleases my owner" from "works for strangers".

**Architecture:** All changes live in the Electron main process around the existing dream pipeline (`src/main/services/dreamService.ts`). New logic goes into small pure modules under `src/main/libs/` (unit-testable without a database); stores get narrowly named new methods; `DreamService` wires them into `runDream` at fixed points. Every rule writes a counter into the run telemetry. A read-only script, `scripts/rrsi-evolution-report.mjs`, turns the telemetry into a per-bot report.

**Tech Stack:** Electron 40 main process (TypeScript, CommonJS build to `dist-electron/`), sql.js (`SqliteStore`, `CoworkStore`, `DreamStore`, `MetaIDKnowledgeStore`), `node:test` tests against compiled output, Node 24 `node:sqlite` for the report script.

**Companion design:** `docs/superpowers/specs/2026-10-14-rrsi-regularized-dream-evolution-design.md` (paper summary, gap analysis G1–G10, principles, decisions D1–D8, field acceptance, deferred items).

## Global Constraints

- The design spec is normative for behavior. If code and spec disagree, or a plan step cannot be done as written, stop and report to the planner; do not improvise a different rule.
- Node `>=24 <25`. pnpm only. Never run `npm install` / `npm ci` anywhere in the repo. Run scripts as `pnpm run <script>`.
- Every phase runs on its own branch + worktree created from `main` (names in the phase map). Never branch from another feature branch. Never push. Never merge; the planner merges after acceptance.
- Worktree setup on the exFAT SSD, immediately after `git worktree add`: `git config extensions.worktreeConfig true` and `git -C .worktrees/<name> config --worktree core.filemode false`; then `pnpm install` inside the worktree. Do not delete `._*` files.
- `tests/` is gitignored. Every new test file needs a `!tests/<file>` allowlist line in `.gitignore` (next to the existing `!tests/capabilityValidation.test.mjs` block, around line 425) **and** must be staged with `git add -f`. Files under `tests/fixtures/` are already allowlisted.
- TypeScript: strong typing, no `any` in new code (use `unknown` + narrowing). 2-space indent, single quotes, semicolons. Code comments in English and only for constraints the code cannot show.
- Both tsconfigs are non-strict (no `strictNullChecks`), so `!x.ok`, `x.ok ? … : …`, and `x !== undefined` do not narrow a discriminated union or an `unknown`. Narrow unions with literal comparisons (`if (parsed.ok === false) return …;`) and `unknown` with positive type predicates. Existing code uses `(parsed as { ok: false; error: string }).error`; follow that pattern.
- Pure modules under `src/main/libs/` added by this plan take time and data as inputs: no `Date.now()`, no I/O, no `Math.random()`.
- Modules imported by tests must not import `electron` at runtime. `dreamService.ts` is loaded in tests through the `Module._load` patch in `tests/fixtures/rrsiDreamHarness.mjs` (P1 Task 1).
- LLM prompt text in the dream passes is Simplified Chinese, matching the existing prompts. Where a plan gives exact prompt lines, copy them verbatim. Default user-facing UI copy is English (this plan adds no UI).
- Database: new tables only with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`; new columns only through PRAGMA-guarded `ALTER TABLE … ADD COLUMN` with defaults that preserve current behavior for existing rows. Never delete or reset user data; demotion changes eligibility only. Retention limits apply only to the dream bookkeeping tables named in this plan.
- `DREAM_VERSION` (in `src/main/libs/dreamPrompt.ts`, currently 16) is bumped only by the phases that change `buildDreamPrompt` / `parseDreamOutput` / `writeDreamResults` semantics: P1 and P4. Use "current `main` value + 1" at implementation time and add a `vN:` line to the doc comment above the constant.
- A new pass must never fail the dream run: wrap it in `try/catch`, log `console.warn('[DreamService] …')`, return a zero result. Follow the existing pass structure (`validateCapabilityDraftsAfterDream` is the template).
- Commits: one commit per task, message `<type>: <short description>` (`feat|fix|refactor|docs|chore`). Before each commit run the task's tests plus `pnpm run compile:electron` (0 errors) and `pnpm run lint` (0 errors/warnings). After each commit post an English development-journal buzz with Codex's `metabot-post-buzz` skill (`/Users/tusm/.cursor/skills/metabot-post-buzz/SKILL.md`, not `SKILLs/metabot-post-buzz`).
- **Branch-point baseline (first thing in every phase):** run `pnpm run compile:electron && node --test tests/*.test.mjs 2>&1 | tail -40` once before changing anything and save the list of failing files to `localdocs/rrsi-<phase>-baseline.txt` (`localdocs/` is local-only, not committed). `main` carries unrelated failures; the phase is accepted when it adds none.
- Before handing a phase back: `pnpm run compile:electron`, `pnpm run build:skills`, `pnpm run lint`, `pnpm run test:rrsi`, and `node --test tests/*.test.mjs` (no failing file beyond the baseline list; every file the phase touched or imports passes). Paste the tail of each output into the handoff note.

---

## Prerequisite (planner)

P0. The planner reviews and merges branch `docs/rrsi-regularized-evolution` (this design + these plans) into `main` with `git merge --no-ff`. Phase branches are created from `main` only after that merge.

## Phase map

| Phase | Plan file | Branch / worktree | Deliverable | Depends on |
|---|---|---|---|---|
| P1 | `2026-10-14-rrsi-evolution-p1-gate-regularizers.md` | `feat/rrsi-p1-gate` / `.worktrees/rrsi-p1-gate` | Test harness, prospective + dual-panel gate, falsified ledger, insert dedupe, dream prompt section (DREAM_VERSION 17), telemetry, report script, `test:rrsi` | P0 |
| P2 | `2026-10-14-rrsi-evolution-p2-retention-budget.md` | `feat/rrsi-p2-retention` / `.worktrees/rrsi-p2-retention` | Annealed promotion budget, procedure hot eligibility + agent probation, single injection path, exposure ledger, footprint telemetry | P1 merged |
| P3 | `2026-10-14-rrsi-evolution-p3-usage-pruning.md` | `feat/rrsi-p3-usage` / `.worktrees/rrsi-p3-usage` | Usage audit pass, utility-ranked rosters with fresh slot, dormant / unused demotion and re-entry | P2 merged |
| P4 | `2026-10-14-rrsi-evolution-p4-structured-exploration.md` | `feat/rrsi-p4-explore` / `.worktrees/rrsi-p4-explore` | Practice proposal `component`, stall detection, exploration directive (DREAM_VERSION +1), approval ordering, telemetry | P1 merged |
| P5 | `2026-10-14-rrsi-evolution-p5-specificity-ood.md` | `feat/rrsi-p5-scope` / `.worktrees/rrsi-p5-scope` | Instance markers, reconciliation `scope`, situational / scorer-fitted handling, internal vs external split | P3 merged |

P4 may run in parallel with P2/P3 (disjoint files except `dreamService.ts` `runDream` telemetry block, `package.json`, `.gitignore`, and the report script; the second to merge rebases and keeps both sides). P5 waits for P3 because both edit `listInjectableTechniques` and the promotion pass.

## File structure (all phases)

```
src/main/libs/capabilityGateRegularizers.ts   P1  gate config, citations, prospective rule, panel combine, hypothesis keys/similarity
src/main/libs/capabilityValidationPrompt.ts   P1  prospective rule lines, similar-falsified line
src/main/libs/dreamPrompt.ts                  P1  falsified section + DREAM_VERSION; P4 component field + exploration section + DREAM_VERSION
src/main/libs/promotionBudget.ts              P2  promotionBudgetForNight()
src/main/libs/procedureProbation.ts           P2  buildProbationDraftDescription(), ProcedureHotReason helpers
src/main/libs/procedurePromptBlocks.ts        P2  renderProcedureBlock() (included ids), recall status line
src/main/libs/hotLayerUsageAudit.ts           P3  excerpt selection, audit prompt, parser
src/main/libs/hotLayerPruning.ts              P3  rankHotLayerItems(), selectHotLayerDemotions(), selectHotLayerReentries()
src/main/libs/hotLayerUsageQueries.ts         P3  shared usage-stats SQL + row mapper
src/main/libs/evolutionExploration.ts         P4  component vocabulary, stall detection, directive rendering, compliance
src/main/libs/capabilitySpecificity.ts        P5  detectInstanceMarkers(), titleHasHardInstanceMarker()
src/main/libs/capabilityReconciliationPrompt.ts P5 markers line, scope field
src/main/libs/predictionLedger.ts             P3/P4 export shiftDateKey (identical one-word change); P5 PREDICTION_SOURCE_CLASS
src/main/sqliteStore.ts                       P1 falsified table; P2 source_procedure_id + hot_layer_usage; P3 dormant_at; P4 component; P5 scope
src/main/metaidKnowledgeStore.ts              P2  hot columns, upsert semantics, setProcedureHotEligibility, listHotProcedures; P3 ranking
src/main/coworkStore.ts                       P1 ledger + checked insert; P2 probation draft, injectable techniques, exposures; P3 dormant + ranking; P4 component; P5 scope
src/main/dreamStore.ts                        P2 countNonEmptyDreamNights, listActivePromotedProcedureIds filter; P3 usage reads/writes; P4 telemetry range read; P5 bySourceClass
src/main/services/dreamService.ts             every phase (gate, promotion, audit, pruning, exploration, scope, telemetry)
src/main/services/memoryHygieneService.ts     P1 falsified retention step; P2 usage retention step
src/main/libs/coworkRunner.ts                 P2 hot procedures + exposures + probation draft on procedure_save + recall status
src/main/services/privateChatDaemon.ts        P2 listInjectableTechniques
src/main/main.ts                              P2 group-task technique wiring
scripts/rrsi-evolution-report.mjs             P1 creates (gate section); P2–P5 add sections
tests/fixtures/rrsiDreamHarness.mjs           P1 shared DreamService harness
tests/capabilityGateRegularizers.test.mjs     P1
tests/capabilityFalsifiedLedger.test.mjs      P1
tests/capabilityProspectiveGate.test.mjs      P1
tests/rrsiEvolutionReport.test.mjs            P1 (extended by P2–P5)
tests/promotionBudget.test.mjs                P2
tests/procedureProbation.test.mjs             P2
tests/hotLayerExposure.test.mjs               P2
tests/hotLayerUsageAudit.test.mjs             P3
tests/hotLayerPruning.test.mjs                P3
tests/evolutionExploration.test.mjs           P4
tests/capabilitySpecificity.test.mjs          P5
tests/predictionOodSplit.test.mjs             P5
package.json                                  P1 adds test:rrsi; later phases append files
.gitignore                                    every phase: allowlist its new test files
```

## Cross-phase contracts (exact names)

Later phases import these verbatim. A phase may add members; it may not rename or change existing ones.

```ts
// src/main/libs/capabilityGateRegularizers.ts (P1)
export interface CapabilityGateConfig { panels: 1 | 2; prospective: boolean }
export const CAPABILITY_GATE_DEFAULTS: CapabilityGateConfig; // { panels: 2, prospective: true }
export function resolveCapabilityGateConfig(input?: Partial<CapabilityGateConfig> | null): CapabilityGateConfig;
export const FALSIFIED_BLOCK_DAYS = 30;
export const FALSIFIED_RETENTION_DAYS = 180;
export const FALSIFIED_MAX_PER_BOT = 200;
export const FALSIFIED_PROMPT_MAX_ITEMS = 8;
export const FALSIFIED_SIMILARITY_MIN = 0.6;
export function citedDiaryDates(rationale: string): string[];
export function hasPostOriginCitation(input: { rationale: string; draftDreamDate: string; evidenceDates: ReadonlySet<string> }): boolean;
export type GateOutcome = 'promote' | 'demote' | 'hold';
export type PanelAgreement = 'agreed' | 'disagreed' | 'incomplete';
export function combinePanelOutcomes(a: GateOutcome | null, b: GateOutcome | null): { outcome: GateOutcome; agreement: PanelAgreement };
export function joinPanelRationales(a: string, b: string, maxChars?: number): string;
export function hypothesisTitleKey(title: string): string;
export function hypothesisTokens(text: string): string[];
export function hypothesisSimilarity(a: string, b: string): number;
export function findSimilarFalsified<T extends { title: string; titleKey: string }>(title: string, ledger: readonly T[], minSimilarity?: number): T | null;

// src/main/coworkStore.ts (P1)
export type CapabilityFalsifiedSource = 'validation' | 're_review';
export interface CapabilityFalsifiedHypothesis {
  id: number; metabotId: number; title: string; titleKey: string; description: string; reason: string;
  source: CapabilityFalsifiedSource; sourceDraftId: number | null; falsifiedAt: number; hitCount: number; lastHitAt: number | null;
}
export interface CapabilityDraftInsertResult { inserted: number; insertedIds: number[]; skippedDuplicate: number; skippedFalsified: number }
CoworkStore.recordFalsifiedHypothesis(input: { metabotId: number; title: string; description: string; reason: string; source: CapabilityFalsifiedSource; sourceDraftId: number | null; falsifiedAt?: number }): CapabilityFalsifiedHypothesis | null;
CoworkStore.listFalsifiedHypotheses(metabotId: number, options?: { sinceMs?: number; limit?: number }): CapabilityFalsifiedHypothesis[];
CoworkStore.markFalsifiedHypothesisHit(id: number, atMs?: number): boolean;
CoworkStore.purgeFalsifiedHypotheses(input: { cutoffMs: number; maxPerBot: number; excludeMetabotIds?: ReadonlySet<number> }): number;
CoworkStore.insertCapabilityDraftsChecked(metabotId: number, dreamDate: string, learnings: Array<{ title?: string | null; description?: string | null; capabilityType?: string | null }>, options?: { nowMs?: number }): CapabilityDraftInsertResult;

// src/main/services/dreamService.ts (P1)
DreamServiceDeps.capabilityGate?: Partial<CapabilityGateConfig>;

// src/main/libs/promotionBudget.ts (P2)
export const PROMOTION_BUDGET_MAX = 3;
export const PROMOTION_BUDGET_MIN = 1;
export const PROMOTION_BUDGET_ANNEAL_NIGHTS = 60;
export function promotionBudgetForNight(completedNights: number, options?: { max?: number; min?: number; annealNights?: number }): number;

// src/main/libs/procedureProbation.ts (P2)
export const PROCEDURE_HOT_REASONS = ['probation', 'gate_rejected', 'demoted', 'rollback', 'unused', 'situational'] as const;
export type ProcedureHotReason = (typeof PROCEDURE_HOT_REASONS)[number];
export function normalizeProcedureHotReason(value: unknown): ProcedureHotReason | null;
export function buildProbationDraftDescription(input: { triggerText: string; steps: string[]; pitfalls: string[]; sourcePinIds: string[] }): string;

// src/main/metaidKnowledgeStore.ts (P2)
MetaIDProcedureEntry.hotEligible: boolean; .hotSince: number | null; .hotReason: ProcedureHotReason | null;
UpsertMetaIDProcedureResult.needsGate: boolean;
MetaIDKnowledgeStore.setProcedureHotEligibility(id: string, input: { eligible: boolean; reason: ProcedureHotReason | null; atMs?: number }): boolean;
MetaIDKnowledgeStore.listHotProcedures(metabotId: number, options?: { limit?: number }): MetaIDProcedureEntry[];

// src/main/coworkStore.ts (P2)
CapabilityDraft.sourceProcedureId: string | null;
export type HotLayerItemKind = 'technique' | 'procedure';
export type HotLayerExposure = 'hot' | 'recall';
CoworkStore.ensureProbationDraftForProcedure(input: { metabotId: number; procedureId: string; title: string; description: string; dreamDate: string }): { draftId: number; created: boolean } | null;
CoworkStore.listInjectableTechniques(metabotId: number, limit?: number): CapabilityDraft[];
CoworkStore.recordHotLayerExposures(input: { metabotId: number; usageDate: string; items: Array<{ kind: HotLayerItemKind; id: string; exposure: HotLayerExposure }>; atMs?: number }): number;

// src/main/dreamStore.ts (P2)
DreamStore.countNonEmptyDreamNights(metabotId: number, beforeDate: string): number;

// src/main/libs/procedurePromptBlocks.ts (P2)
ProcedurePromptEntry.id?: string; .statusNote?: string | null;
export function renderProcedureBlock(entries: ProcedurePromptEntry[], maxItems?: number, maxChars?: number): { text: string; includedIds: string[] };

// src/main/libs/hotLayerPruning.ts (P3)
export interface HotLayerCandidate { key: string; kind: HotLayerItemKind; hotSinceMs: number; appliedNights: number; exposedNights: number }
export function rankHotLayerItems<T extends HotLayerCandidate>(items: readonly T[], options: { cap: number; nowMs: number; freshSlots?: number; graceDays?: number }): T[];

// src/main/libs/evolutionExploration.ts (P4)
export const PRACTICE_COMPONENTS = ['memory', 'procedure', 'skill', 'remote_service', 'collaboration', 'metaweb', 'metaapp'] as const;
export type PracticeComponent = (typeof PRACTICE_COMPONENTS)[number];

// src/main/libs/capabilitySpecificity.ts (P5)
export type CapabilityScope = 'general' | 'situational' | 'scorer_fitted';
```

Telemetry keys (written into `updateRunTelemetry`, read by the report from `metabot_dream_telemetry_daily.extra_json`):

| Key | Phase | Shape |
|---|---|---|
| `validation.deferredSameNight` | P1 | number |
| `validation.prospectiveDowngraded` | P1 | number |
| `validation.panels` | P1 | `{ agreed: number; disagreed: number; incomplete: number }` |
| `reReviewPanels` | P1 | same shape as `validation.panels` |
| `capabilityDraftInsert` | P1 | `{ inserted: number; skippedDuplicate: number; skippedFalsified: number }` |
| `promotionBudget` | P2 | `{ nights: number; budget: number; candidates: number; promoted: number }` |
| `hotLayer` | P2 | `{ hotProcedures; probationProcedures; injectableTechniques; procedureBlockChars; techniqueBlockChars; exposedItems }` (numbers) |
| `usageAudit` | P3 | `{ ran: boolean; items: number; applied: number; excerpts: number; parseFailed: boolean }` |
| `hotLayerPruning` | P3 | `{ demotedTechniques: number; demotedProcedures: number; reentered: number }` |
| `exploration` | P4 | `{ stalled: boolean; reason: 'no_acceptance' \| 'component_collapse' \| null; underExplored: string[]; directed: boolean; complied: boolean \| null }` |
| `reconciliation.scope` | P5 | `{ general: number; situational: number; scorerFitted: number; hardMarkerOverrides: number }` |
| `predictionOod` | P5 | `{ internal: OodBucket; external: OodBucket; gap: number \| null }` with `OodBucket = { resolved: number; hit: number; hitRate: number \| null }` |

## Planner acceptance gates

The planner checks these on the handed-back branch before merging. A phase is rejected if any box fails; the dev agent fixes on the same branch.

**Every phase**
- [ ] Handoff note complete (see below); baseline failing list attached; no failing test file beyond it.
- [ ] `git diff --stat main` only touches files listed for that phase in its plan's File structure table, plus pre-existing test files repaired under the logged-repair rule (P1 Task 5 Step 6) and listed in the handoff.
- [ ] Every new test file is allowlisted in `.gitignore` and committed (`git ls-files tests | grep <name>`).
- [ ] Migrations: opening a database created by `main` (the test `schema migration … idempotently` pattern) succeeds twice in a row and existing rows keep their pre-phase behavior.
- [ ] No new `any`; no `Date.now()` / `Math.random()` in the new `src/main/libs/*` modules (`grep -nE "Date\.now|Math\.random" <new libs>` is empty).

**P1 — gate regularizers**
- [ ] `pnpm run test:rrsi` green; the vectors in P1 Task 2 pass exactly (similarity `0.6` for `先验证再交付` vs `交付前先验证一遍`, `combinePanelOutcomes('promote','hold')` → `hold`/`disagreed`).
- [ ] Flow test proves: a draft distilled tonight is not judged tonight; the next night, with a later diary cited by both panels, it validates; with only its own date cited it stays `draft` and `prospectiveDowngraded === 1`.
- [ ] Flow test proves: panels disagree → no status change, `panels.disagreed === 1`; a panel-B parse failure → `incomplete`, no change.
- [ ] Agreed rejection writes exactly one ledger row; a rollback rejection and a disputed-timeout rejection write none; re-proposing the same title next night is skipped with `skippedFalsified === 1` and `hit_count === 1`.
- [ ] `DREAM_VERSION` is 17 (or main+1) with a `v17:` comment line; the dream prompt shows the falsified section only when the ledger is non-empty and not in fragment mode.
- [ ] `node scripts/rrsi-evolution-report.mjs --db <fixture.sqlite> --json` prints the gate section; on a database without the new table it prints `"falsifiedLedger": null` instead of crashing.
- [ ] The handoff lists every pre-existing test assertion that changed, with a one-line reason each.

**P2 — retention budget**
- [ ] Budget vectors: `t = 0 → 3`, `29 → 3`, `30 → 2`, `59 → 2`, `60 → 1`, `500 → 1`, `-1 → 3`, `NaN → 3`.
- [ ] An existing (pre-migration) agent procedure is still hot after upgrade (grandfathering test).
- [ ] `procedure_save` of a new title creates a recall-only procedure and exactly one probation draft; saving it again refreshes the same draft; after an agreed validation and promotion it is hot and its steps are unchanged.
- [ ] Revising an archived procedure through `procedure_save` re-activates it recall-only (`hot_reason = 'probation'`), never hot.
- [ ] A promoted draft no longer appears in `<proven_techniques>` at any of the three injection sites.
- [ ] `hot_layer_usage` gets one row per item per day; repeated injections bump `exposure_count`; recall writes `exposure = 'recall'` unless the item was hot that day.
- [ ] Rollback of a night that promoted a probation procedure leaves it `active` with `hot_reason = 'rollback'`, not archived.

**P3 — usage + pruning**
- [ ] Ranking vectors in P3 Task 2 pass (fresh slot honored; ties broken by recency then key).
- [ ] Audit parse coerces `applied: true` without a valid label to `false`; unknown keys dropped.
- [ ] Pruning test: 5 audited exposures with 0 applied after grace → demoted; 4 → not; inside grace → not; max 2 per night.
- [ ] Re-entry test: an `unused` procedure applied on 2 audited nights within 14 days is hot again.
- [ ] Nothing is deleted: row counts of `capability_drafts` and `metaid_knowledge_procedures` unchanged by pruning.
- [ ] `DREAM_VERSION` unchanged.

**P4 — exploration**
- [ ] Stall vectors in P4 Task 1 pass (both stall reasons, the not-active-enough case, the collapse threshold).
- [ ] The dream prompt contains the exploration section only when stalled; `component` parses, unknown values store NULL; old rows read back with `component: null`.
- [ ] Compliance telemetry is `null` when not directed, `true` / `false` otherwise.
- [ ] Auto-approval order puts under-explored read-only proposals first while stalled; total auto-approvals still ≤ `PRACTICE_PROPOSALS_MAX_PER_NIGHT`; non-read-only proposals never auto-approve.
- [ ] `DREAM_VERSION` bumped once with a comment line.

**P5 — specificity + OOD**
- [ ] Marker vectors in P5 Task 1 pass (pin id not double-counted as txid).
- [ ] A title with a marker becomes situational even when the panel says `general` (`hardMarkerOverrides === 1`).
- [ ] Situational drafts are absent from `<proven_techniques>`; promoting one creates a recall-only procedure with `hot_reason = 'situational'`.
- [ ] `scorer_fitted` → `disputed`, and the existing disputed flow re-judges it the next night.
- [ ] `bySourceClass` sums equal the per-action totals; the report prints the internal / external hit-rate gap.
- [ ] `DREAM_VERSION` unchanged.

## Handoff note (dev agent → planner)

At the end of a phase, reply with: branch name and head commit; one line per commit; the verification command outputs (tails); the baseline failing list and confirmation that no new file fails; every changed pre-existing test assertion with its reason; every deviation from the plan with the reason; open questions. Do not merge, push, or delete the worktree — the planner does that after acceptance.

## Decisions that block phases

Defaults D1–D8 (design §9) are adopted. If the owner changes one before a phase starts, the planner updates that plan first: D1/D2 → P1 Tasks 3–5; D3 → P2 Tasks 3–5; D4 → P2 Task 6; D5 → P2 Task 2; D6 → P3 Tasks 4–5; D7 → P4 Tasks 1, 3, 4; D8 → P5 Task 3.
