# RRSI-Regularized Dream Evolution — Design

- **Status:** Approved for planning (defaults D1–D8 adopted, see §9)
- **Date:** 2026-10-14
- **Plans:** `docs/superpowers/plans/2026-10-14-rrsi-evolution-00-overview.md` (index) and `-p1-` … `-p5-`
- **Source paper:** *Regularized Recursive Self-Improvement* (RRSI), arXiv:2609.24972v3, Google Cloud AI Research
- **Builds on:** `docs/superpowers/specs/2026-10-10-*` (Dream-RSI exploration: validation gate, reconciliation, chain evidence, self-curriculum), the RSI P0 prompt-layer rollback and prediction ledger, and `2026-10-14-ai-internet-preference-loop-design.md`

## 1. Summary

IDBots already runs a nightly self-improvement loop for every MetaBot: the dream distills capability drafts, a validation gate promotes or rejects them, promoted drafts harden into procedures, and a retention gate rolls back bad nights. The RRSI paper shows that this kind of harness self-evolution overfits in three predictable ways — fitting to the evaluator, chasing noise, and accumulating complexity — and that a small set of regularizers on both the proposal side and the selection side fixes most of it while *reducing* cost.

Reading the IDBots code against the paper shows the same failure surfaces: a draft is validated against the diary it was distilled from, thresholds are chosen rather than measured, rejected drafts leave no trace, up to three promotions per night cannot be attributed, the hot layer only grows, agent-saved procedures bypass the gate, and nothing distinguishes "pleases the owner" from "transfers to strangers".

This design adds those regularizers in five independently mergeable phases. Nothing new is learned by the bots in this round; what changes is *what is allowed to stick*. Every rule is deterministic host code or a bounded extra LLM call, every outcome is logged in the dream telemetry, and a read-only report script makes the effect measurable before anyone tunes a number.

## 2. Background

### 2.1 The paper in one page

RRSI treats the *harness* — prompts, control flow, tools, memory, skills, context management — around a frozen model as the thing that evolves. An outer loop proposes edits to the harness, evaluates them on a benchmark, and keeps the improvements. The paper's claim is that this is a genuine (system-level) form of recursive self-improvement and that it needs regularization exactly like a learned model does.

Three overfitting causes:

1. **Benchmark-specific fitting** — edits that restate the scorer's rubric. In the paper's baselines, accepted edits accumulated rubric-restating text, "fitted to the scorer rather than to the work".
2. **Noise chasing** — accepting edits whose measured gain is within evaluation noise.
3. **Complexity accumulation** — every accepted edit adds context; nothing is ever removed, so cost grows and transfer drops.

Regularizers (proposal side):

- **L0 annealed edit budget:** \(b_t=\lceil b_{min}+(b_{max}-b_{min})\tfrac12(1+\cos(\pi t/T))\rceil\), \(b_{max}\) 3–4, \(b_{min}=1\). Many edits early, one edit per round late.
- **Evidence-aware credit assignment:** an edit history of (component, hypothesis, diff, ΔS, ΔC, accepted) is shown to the proposer, so rejected hypotheses are not re-proposed.
- **Structured exploration when stalled:** if \(w=3\) rounds stay within δ, reserve one of two candidates for a component that has not been explored. Components: prompt, control_flow, config, output_plumbing, context_mgmt, client_tool, skill, memory, subagent; the novelty bonus ν counts only the structural ones (client_tool, skill, memory, subagent).

Regularizers (selection side):

- **Leakage critic** that reads the *diff*, not the proposer's rationale, and rejects instance-specific or scorer-specific edits.
- **Stability floor:** \(\hat S(H')\ge S^\star-\delta\), where δ is measured from repeated evaluation of the base harness and "must not be tuned".
- **Ridge (L2) cost rule:** \(\Delta C\le\beta_0+\beta_1\Delta S\) — an edit must pay for its context cost.
- **Within-band rule:** inside the noise band, accept only if \(w_s\Delta S-w_c\Delta C+w_n\nu>0\).
- **L1 pruning:** remove components whose contribution \(g_t(\ell)\le0\) over \(n_{prune}\) = 4–5 rounds.

Reported results: on the in-distribution benchmark RRSI had the *smallest* gain (90.5), but on out-of-distribution tasks it averaged 43.6 against 39.7 for the base harness, while every other method stayed at or below 40.6. It used 2.42M tokens against 3.80M for unregularized evolution, transferred across backbone models (+30%), and accepted only 4 of 32 proposed edits — all of them generic self-check probes.

The lesson for IDBots: **the regularized loop wins by refusing most edits and by measuring noise instead of guessing it.**

### 2.2 What IDBots already has

The nightly dream (`src/main/services/dreamService.ts`, `runDream`) runs, in order: pre-dream surf → day activity → prompt-layer retention gate → prediction reconciliation → dream synthesis → `writeDreamResults` (diary, memories, capability drafts, practice proposals) → capability validation → periodic re-review → memory reconciliation → promotion into procedures → counterfactual replay → weekly long dream → practice proposal approval → run telemetry.

| Mechanism | Where | RRSI analog |
|---|---|---|
| Capability drafts (`capability_drafts`) | `coworkStore.insertCapabilityDrafts` | proposed edits |
| Validation gate (LLM verdict vs 14 diaries, date grounding, chain evidence) | `validateCapabilityDraftsAfterDream` | selection |
| Re-review every 30 days | `reReviewValidatedCapabilityDrafts` | re-evaluation |
| Reconciliation keep/narrow/merge/dispute | `reconcileValidatedCapabilityDrafts` | partial leakage critic (overgeneralization only) |
| Promotion (score ≥ 0.85, ≥ 1 night old, ≤ 3/night) | `promoteCapabilityDraftsToProcedures` | fixed edit budget |
| Prompt-layer rollback (negative-signal spike) | `evaluatePromptLayerRetentionGate` | stability floor, coarse |
| Prediction ledger + calibration digest | `predictionLedger.ts`, `listPredictionCalibration` | measured outcomes |
| Self-curriculum practice proposals | `processPracticeProposalsAfterDream` | exploration, unstructured |
| Run telemetry + never-purged daily rollup | `updateRunTelemetry`, `metabot_dream_telemetry_daily` | measurement substrate |

The substrate is good. The gaps are in what the gate accepts and what nothing ever removes.

## 3. RRSI → IDBots mapping

| RRSI element | IDBots today | Change in this design |
|---|---|---|
| Held-out evaluation | Draft validated against its own source diary | P1 prospective validation: evidence must postdate the draft |
| δ measured, not tuned | Thresholds 0.6 / 0.85 / margin 0.2 chosen by hand | P1 dual-panel agreement measures judge noise; report exposes it |
| Edit history with outcomes | Rejected drafts purged after 90 days, never shown again | P1 falsified-hypothesis ledger, shown to the dream and the gate |
| L0 annealed budget | Fixed 3 promotions/night | P2 cosine-annealed 3 → 1 over 60 active nights |
| Every edit passes selection | Agent `procedure_save` goes straight to the hot layer | P2 probation: agent procedures enter the gate |
| ΔC accounting | No cost signal | P2 hot-layer footprint telemetry; P3 usage evidence |
| L1 pruning | Hot layer only grows; ordered by recency | P3 usage audit, utility ordering, dormant / recall-only demotion |
| Structured exploration | Practice proposals with no component notion | P4 component vocabulary, stall detection, exploration slot |
| Leakage critic on the diff | Reconciliation checks overgeneralization only | P5 specificity markers + scope verdict on the final text |
| OOD test set | Owner feedback and external outcomes mixed | P5 internal vs external split for predictions and usage |

## 4. Confirmed gaps (code anchors at `main` 5738b9e1)

- **G1 — In-distribution self-confirmation.** `runDream` calls `writeDreamResults` (writes tonight's diary and tonight's drafts) and then `validateCapabilityDraftsAfterDream`. The validator reads `listDailySummaries(metabotId, 14)`, which includes tonight's diary, and `pending` includes tonight's drafts. A draft is therefore judged against the diary it was distilled from. `tests/capabilityValidation.test.mjs` even asserts that "the validation prompt embeds tonight's freshly written diary as history".
- **G2 — Unmeasured thresholds.** `CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE = 0.6`, `CAPABILITY_PROMOTION_MIN_SCORE = 0.85` (`capabilityValidationPrompt.ts`), `COUNTERFACTUAL_LESSON_MIN_MARGIN = 0.2` are hand-picked. A single LLM verdict decides; its noise is unknown.
- **G3 — No negative evidence.** `insertCapabilityDrafts` is a plain INSERT (no dedupe — version-repair runs even re-insert the same drafts); the dream prompt never sees rejected drafts; hygiene (`purgeExpiredCapabilityDrafts`) deletes them after 90 days. The same wrong lesson can be re-proposed every night.
- **G4 — Non-attributable promotions.** Up to `CAPABILITY_PROMOTION_MAX_PER_NIGHT = 3` drafts harden per night; the retention gate can only roll back the whole night.
- **G5 — Recency-ordered hot layer.** `listProcedures` orders by `updated_at DESC`; the hot block takes the newest 5. The technique roster takes the newest 5 validated drafts. Nothing measures whether an injected item is ever used.
- **G6 — Gate bypass.** The `procedure_save` tool (`coworkRunner.runProcedureSaveTool`, origin `'agent'`) writes an active procedure that is immediately eligible for the hot layer. Surf sessions save procedures the same way. In addition `upsertProcedure` sets `status = 'active'` on every revision, so revising an archived (demoted) procedure silently resurrects it.
- **G7 — Double injection.** A promoted draft stays `validated`, so it is injected both as a `<proven_techniques>` entry (`listCapabilityDrafts({ status: 'validated', limit: 5 })` in `coworkRunner`, `privateChatDaemon`, and the group-task wiring in `main.ts`) and as a `<procedures>` entry.
- **G8 — Single component family.** Evolution only edits memory and procedures; practice proposals carry no notion of which part of the bot's environment they exercise, so exploration collapses onto whatever worked last.
- **G9 — No specificity critic.** Reconciliation guards against overgeneralization but nothing flags lessons that only hold for one pin, one order, one peer, or that restate how to get a good rating.
- **G10 — No OOD split.** Owner feedback (the training signal) and external outcomes (service orders, MetaTask reviews — the closest thing to a held-out test) are aggregated together, so "better at pleasing my owner" and "better at real work" cannot be told apart.

Two observations that are not fixed here but that the plans must respect:

- The re-review demotes on `verdict === 'rejected' && score < 0.85`, treating `score` as draft quality, while the validation prompt defines `score` as evidence strength. P1 keeps the existing per-panel rule and only adds agreement; the semantic inconsistency is recorded as an open question (§10).
- The prompt-layer rollback rejects that night's drafts through `updateCapabilityDraftValidation`; those rejections are not evidence about the hypothesis and must not enter the falsified ledger.

## 5. Design principles

1. **Regularize selection before proposal.** The cheapest place to stop overfitting is the gate; proposal-side changes come second.
2. **Measure noise, do not tune it.** A threshold that cannot be justified by a measured number is left unchanged and the measurement is added instead.
3. **Never delete knowledge the user or the bot authored.** Demotion means "not in the hot layer"; records stay retrievable. Only dream bookkeeping rows have retention limits.
4. **Budget everything.** Every new pass has a per-night cap and a token cap; every new prompt section has an item and a character cap.
5. **Deterministic host, bounded LLM.** The LLM judges; the host enforces citations, budgets, and state transitions by fixed templates. The LLM never writes stores directly.
6. **Observable.** Every rule writes a telemetry counter into `metabot_dream_runs.telemetry_json` (and therefore into the never-purged `metabot_dream_telemetry_daily.extra_json`). `scripts/rrsi-evolution-report.mjs` reads them.
7. **Fail closed, never fail the dream.** Any failure in a new pass leaves state unchanged and logs a warning; the dream run's outcome is unaffected.
8. **Old databases keep working.** New tables use `CREATE TABLE IF NOT EXISTS`; new columns are PRAGMA-guarded `ALTER TABLE ADD COLUMN` with defaults that preserve current behavior for existing rows.

## 6. Phase designs

### 6.1 P1 — Gate regularizers (selection side)

**P1.1 Prospective validation (fixes G1).**

- The fresh-draft gate only considers drafts with `dreamDate < date` (the date being dreamed), plus `disputed` drafts. Tonight's drafts wait until a later diary exists. Telemetry: `validation.deferredSameNight`.
- A `validated` verdict must cite, in its rationale, at least one diary date `d` with `draft.dreamDate < d` and `d` among the diary dates actually shown to the panel. Otherwise the verdict is downgraded to `keep_draft` before any state change. Telemetry: `validation.prospectiveDowngraded`.
- The grounding set becomes the shown diary dates only. Today the set also contains the bare dreamed `date`, which on an empty day lets a rationale cite a date that has no diary.
- `rejected` verdicts need no post-origin citation: a contradiction found anywhere is admissible, and rejecting is the conservative direction.
- The validation prompt gains two rule lines (exact text in the P1 plan) that tell the panel the rule.
- The same rule applies to the re-review pass (it is normally satisfied there because re-reviewed drafts are ≥ 30 days old).

**P1.2 Dual-panel agreement (fixes G2, measures δ).**

- Every gate call runs twice: panel A with the drafts in the current order, panel B with the drafts in reversed order. Each panel's output passes the date, chain, and prospective grounding independently.
- Each panel verdict is classified as `promote`, `demote`, or `hold` with the existing per-pass rule (fresh gate: validated ∧ score ≥ 0.6 → promote, rejected → demote; re-review: validated → promote (score refresh), rejected ∧ score < 0.85 → demote).
- The final outcome is the agreed outcome; any disagreement or a missing panel verdict is `hold` (no state change). On agreement the stored score is the minimum of the two panels; the stored notes keep both rationales.
- Telemetry per pass: `panels: { agreed, disagreed, incomplete }`. The disagreement rate `disagreed / (agreed + disagreed)` is the measured judge-noise proxy (the paper's δ). P1 does **not** derive any threshold from it automatically; the report shows it per bot so a later change can be justified by data.
- Re-review on `incomplete` does not refresh `last_reviewed_at` (a transient failure retries the next night); on `disagreed` it refreshes the timestamp and records "panels disagreed" in the notes.
- Cost: one extra gate call per pass per night (≤ 10 drafts, 4096 output tokens). Owner decision D1.
- A dependency-injected `capabilityGate?: { panels?: 1 | 2; prospective?: boolean }` on `DreamServiceDeps` defaults to `{ panels: 2, prospective: true }`. It exists so tests whose subject is downstream of the gate can pin the legacy behavior; production wiring never sets it.

**P1.3 Falsified-hypothesis ledger (fixes G3; the paper's edit history).**

- New table `capability_falsified_hypotheses` (DDL in the P1 plan). One row per (bot, normalized title key); re-falsification updates the row.
- Rows are written **only** when (a) the fresh gate's two panels agree on `demote`, or (b) the re-review's two panels agree on `demote`. Rollback rejections, disputed-timeout auto-rejections, and reconciliation merges never write the ledger.
- Insert-time checks (new `insertCapabilityDraftsChecked`, used by `writeDreamResults`):
  - same title key as a live draft (`draft` / `validated` / `disputed`) of the same bot → skip (`skippedDuplicate`); this also stops version-repair runs from duplicating drafts;
  - same title key as a ledger row falsified within `FALSIFIED_BLOCK_DAYS = 30` → skip and bump `hit_count` (`skippedFalsified`);
  - otherwise insert. A ledger match older than 30 days does not block; the panel sees it instead.
- The validation prompt shows, per draft, the most similar ledger entry within `FALSIFIED_RETENTION_DAYS = 180` (exact title key first, else title-token overlap coefficient ≥ 0.6) as `曾被证伪的相似做法:「…」(… 否决:…)`.
- The dream prompt gets a new section listing up to 8 most recent ledger entries (title + reason ≤ 120 chars) with an instruction not to re-distill them without new counter-evidence. This changes the dream prompt, so `DREAM_VERSION` goes from 16 to 17.
- Retention: a new hygiene step deletes ledger rows older than 180 days and caps each bot at 200 rows (oldest first). The ledger is dream bookkeeping, like rejected drafts.

**P1.4 Measurement.**

- Telemetry additions: `validation.{deferredSameNight, prospectiveDowngraded, panels}`, `reReviewPanels`, `capabilityDraftInsert.{inserted, skippedDuplicate, skippedFalsified}`.
- `scripts/rrsi-evolution-report.mjs`: read-only CLI over the user database (`node:sqlite`, `readOnly: true`). It also reports on history written before P1 shipped (for those nights the new fields are `null`), so the first run doubles as the baseline.

### 6.2 P2 — Retention budget and hot-layer hygiene (proposal-side L0, closes the bypass)

**P2.1 Annealed promotion budget (fixes G4).** `promotionBudgetForNight(t) = ceil(1 + 2 · ½ · (1 + cos(π · min(t, 60) / 60)))` where `t` is the number of non-empty dream nights the bot completed before the dreamed date (`metabot_dream_telemetry_daily`, `empty_day = 0`). A new bot promotes up to 3 per night; after 60 active nights, 1 per night. One promotion per night makes the retention gate's whole-night rollback effectively per-promotion. Owner decision D5.

**P2.2 Agent-procedure probation (fixes G6).**

- New procedure columns: `hot_eligible INTEGER NOT NULL DEFAULT 1`, `hot_since INTEGER`, `hot_reason TEXT`. Existing rows default to hot-eligible: **current procedures are grandfathered**.
- `upsertProcedure` semantics by origin:
  - a new procedure from origin `agent` is created recall-only (`hot_eligible = 0`, `hot_reason = 'probation'`); `dream` / `user` procedures are hot immediately;
  - an agent revision of an archived procedure re-activates it on probation, not hot (this closes the resurrection hole);
  - an agent revision of a hot procedure stays hot (owner decision D3);
  - an agent revision of a non-hot procedure goes to probation unless its reason is `unused` or `situational`;
  - a dream upsert always makes the procedure hot.
- Probation feeds the existing gate: the tool handler calls `ensureProbationDraftForProcedure`, which creates (or refreshes) one `capability_drafts` row with the new column `source_procedure_id`. The draft description renders trigger, steps, pitfalls, and source pin ids, so the chain-evidence digest verifies the pins that a surf session learned from.
- Promotion of a probation draft flips `hot_eligible` to 1 and never rewrites the agent's procedure body. An agreed rejection sets `hot_reason = 'gate_rejected'` (still recall-only, never archived). Re-review demotion and prompt-layer rollback of a probation-sourced procedure set `hot_reason = 'demoted'` / `'rollback'` instead of archiving it.
- `procedure_recall` keeps returning recall-only procedures, with a status line (`not yet validated` / `rejected by dream validation`) so the bot knows how much to trust them.

**P2.3 Single injection path (fixes G7).** `listInjectableTechniques(metabotId, limit)` returns validated drafts that were never promoted. All three technique injection sites switch to it (owner decision D4). `listHotProcedures` returns active, hot-eligible procedures.

**P2.4 Exposure ledger (prepares P3).** New table `hot_layer_usage`, one row per (bot, local date, item kind, item id). The host writes it at injection time (techniques via `markCapabilityDraftsInjected`, procedures via the hot block) and on `procedure_recall` (exposure `recall`). It carries `applied` / `evidence` columns that P3 fills. Retention 120 days (hygiene step).

**P2.5 Cost telemetry (ΔC).** At the end of every night (empty days included, since promotion also runs on them) the host renders the procedure and technique blocks it would inject right now and records their sizes: `hotLayer: { hotProcedures, probationProcedures, injectableTechniques, procedureBlockChars, techniqueBlockChars, exposedItems }`, plus `promotionBudget: { nights, budget, candidates, promoted }`.

### 6.3 P3 — Usage evidence and L1 pruning (fixes G5)

**P3.1 Usage audit pass.** After promotion, on non-empty nights where `hot_layer_usage` has exposures for the dreamed date, one bounded LLM call asks: for each exposed item, did the assistant's behavior that day actually apply it? Input: ≤ 12 items (title + gist) and ≤ 40 assistant-message excerpts (≤ 280 chars, labeled `S{n}.M{k}`, sampled evenly when the day is larger). `applied = true` requires at least one valid excerpt label; otherwise it is coerced to false. The verdicts fill `hot_layer_usage.applied` / `evidence` (labels plus the session channel, `owner` or `external`, used by P5). This is a separate pass rather than a dream-output field because busy days are dreamed from fragment summaries that no longer show individual turns; the dream prompt therefore does not change and no version bump is needed.

**P3.2 Utility ordering with a fresh slot.** Both hot rosters (5 techniques, 5 procedures) are ordered by applied nights in the trailing 30 days, then by recency, with one slot reserved for the newest item still inside a 14-day grace period. Without the reserved slot a new item could never earn exposure.

**P3.3 L1 pruning.** An item that is past its grace period, had ≥ 5 audited exposure nights in the trailing 30 days, and was applied on none of them is demoted:

- a technique moves to the new status `dormant` (not injected, not re-reviewed, kept as history; a later re-proposal is a new draft);
- a procedure becomes recall-only with `hot_reason = 'unused'`.

At most 2 demotions per night. A procedure demoted as `unused` re-enters the hot layer when it was applied (after recall) on ≥ 2 audited nights within 14 days. Nothing is deleted (owner decision D6).

Telemetry: `usageAudit: { ran, items, applied, excerpts, parseFailed }`, `hotLayerPruning: { demotedTechniques, demotedProcedures, reentered }`.

### 6.4 P4 — Structured exploration (fixes G8)

- Practice proposals get a required `component` from a fixed vocabulary: `memory`, `procedure`, `skill`, `remote_service`, `collaboration`, `metaweb`, `metaapp`. The structural components (the paper's ν set) are `skill`, `remote_service`, `collaboration`, `metaapp`. Unknown values are stored as NULL.
- **Stall detection (deterministic):**
  - *no acceptance* — three consecutive trailing 7-day windows, each with ≥ 3 non-empty nights, together produced 0 validated drafts and 0 promotions;
  - *component collapse* — the trailing 14 days produced ≥ 4 proposals with a component and they all share one component.
- When stalled, the dream prompt carries an exploration directive naming the components with no proposal in the trailing 30 days and asks that at least one of tonight's (max 2) proposals target one of them — the paper's "reserve one of two candidates" rule. Risk classes and owner approval are untouched; the novelty bonus is implemented only as ordering: while stalled, read-only proposals in an under-explored component are auto-approved first. No extra approvals are created.
- Telemetry: `exploration: { stalled, reason, underExplored, directed, complied }`.
- Changes the dream prompt and parse: `DREAM_VERSION` +1 (18 if P1 merged first). Owner decision D7.

### 6.5 P5 — Specificity critic and OOD split (fixes G9, G10)

**P5.1 Instance markers.** A pure detector finds pin ids, txids, GlobalMetaIDs, UUIDs, and ISO dates in draft text. The markers are shown to the reconciliation panel per draft. A title that contains any marker is situational by host rule.

**P5.2 Scope verdict.** Reconciliation (which already reads only the draft text, conditions, and diaries — never the validator's rationale) returns a new `scope`:

- `general` — holds across tasks and people;
- `situational` — only true for a specific person, order, pin, date, or peer;
- `scorer_fitted` — restates how to get a good rating or praise without changing the work itself (the paper's rubric-restating failure).

Effects:

- `situational` drafts stay validated but are excluded from the technique roster; on promotion they become recall-only procedures (`hot_reason = 'situational'`);
- `scorer_fitted` drafts become `disputed` and go through the existing disputed re-entry flow, which auto-rejects them after 7 nights.

New column `capability_drafts.scope` (NULL = not assessed = general). Owner decision D8.

**P5.3 OOD split.** Predictions are split by source class (`internal` = cowork, surf; `external` = metatask, service). `listPredictionCalibration` gains `bySourceClass`, the run telemetry records `predictionOod: { internal, external, gap }`, and the report adds the internal/external hit-rate gap plus the P3 applied-evidence split by channel (owner sessions vs A2A and order sessions). The dream prompt's calibration digest text is unchanged, so there is no version bump.

## 7. The AI-internet dimension

The MetaWeb is IDBots' external environment: other bots, other owners, on-chain content, paid services, MetaTasks. It is both the richest source of new capabilities and the only honest out-of-distribution test. This design uses it in four ways now and defers four more.

Now:

1. **External knowledge earns its slot locally.** Procedures learned during surf (`procedure_save` with `sourcePinIds`) enter probation (P2). They become hot only after a later diary shows they worked for this bot, and the chain-evidence digest verifies the cited pins.
2. **External outcomes are the held-out set.** Service-order and MetaTask outcomes are reported separately from owner feedback (P5). A growing internal/external gap is the IDBots signature of scorer fitting.
3. **External usage counts separately.** Usage evidence records whether an item was applied in owner sessions or in A2A and order sessions (P3 → P5 report). A technique used only with the owner is a candidate for `situational`.
4. **Exploration covers the network.** `remote_service`, `collaboration`, `metaweb`, and `metaapp` are first-class exploration components (P4), so a stalled bot is pushed toward the network instead of rehearsing private memory.

Deferred (see §12): population-level fitness across bots, a shared on-chain falsified-hypothesis ledger, transfer tests for preference-loop lessons, and brain-model tags for cross-model transfer.

## 8. Non-goals and frozen scope

- No self-modification of code, skills, tools, or the dream prompt by the bots. Only data moves.
- `self_identity`, impressions, value boundaries, and work reviews are out of scope and stay exactly as they are.
- No renderer UI in this round. The existing dream telemetry panel ignores unknown telemetry keys; the report script is the inspection surface.
- No change to the prompt-layer rollback trigger, the counterfactual replay, the weekly long dream, or the prediction ledger write path.
- No automatic threshold tuning. δ is measured and reported only.
- No deletion of user- or agent-authored records. Demotion only changes eligibility.

## 9. Decisions register

The defaults below are adopted so development can start; the owner may override any of them before the affected phase starts (the planner then updates that plan).

| ID | Decision | Default adopted | Affects |
|---|---|---|---|
| D1 | Pay one extra gate call per pass per night for dual-panel agreement | Yes | P1 |
| D2 | Prospective validation: tonight's drafts wait; `validated` must cite a later diary | Yes | P1 |
| D3 | Agent-saved procedures start recall-only; revisions of an already-hot procedure stay hot | Yes | P2 |
| D4 | Promoted drafts leave the technique roster (single injection path) | Yes | P2 |
| D5 | Promotion budget anneals 3 → 1 over 60 non-empty nights | Yes | P2 |
| D6 | L1 pruning: 30-day window, ≥ 5 audited exposures, 0 applied → dormant / recall-only; never delete | Yes | P3 |
| D7 | Stall = 3 active windows with 0 acceptance, or component collapse; 1 of 2 proposals reserved | Yes | P4 |
| D8 | Situational lessons become recall-only; scorer-fitted lessons are disputed | Yes | P5 |

## 10. Risks and open questions

| Risk | Mitigation |
|---|---|
| Fewer validated drafts per night (by design) look like a regression | The report shows the funnel; field acceptance compares owner negative signals, not acceptance counts |
| Dual panels cost tokens | Bounded at one extra call per pass; skipped when nothing is pending; `capabilityGate.panels = 1` exists for tests only |
| Panel B shares panel A's model, so agreement overstates independence | Accepted for this round; a cross-model panel B is deferred (§12) |
| Probation makes newly learned workflows less visible | Recall still returns them with a status line; the gate usually decides within 1–2 nights of activity |
| Usage audit misjudges "applied" | Requires a cited excerpt label; pruning needs ≥ 5 audited nights with zero applied, so one bad verdict cannot demote |
| DREAM_VERSION bumps re-dream up to 7 days per bot | Existing per-night repair cap applies; P3 and P5 avoid bumps by design |
| Re-review score semantics (quality vs evidence strength) are ambiguous | Open question for the owner. P1 preserves the current rule; a later change needs the P1 panel data |
| Existing tests encode same-night validation | P1 plan lists them; gate-subject tests move to the new semantics, downstream tests pin the legacy gate via DI |

## 11. Acceptance

**Merge gates** (per phase, checked by the planner) are in the overview plan. Each phase must leave `compile:electron`, `build:skills`, `lint`, `test:rrsi`, and the full node test suite green (no new failures versus the branch point).

**Field acceptance** (observation, not a merge gate). After each phase ships to the owner's machine, run `node scripts/rrsi-evolution-report.mjs --days 30` weekly for 4 weeks and record:

| Phase | Expected direction | Red flag |
|---|---|---|
| P1 | Validated per night drops; panel disagreement rate becomes known; `skippedFalsified` > 0 within 2 weeks on active bots | Owner negative signals per active day rise above the pre-P1 30-day median + 1 |
| P2 | Promotions per night follow the budget; hot-layer chars flat or falling; probation drafts reach a verdict | Probation drafts pile up as `draft` for > 14 active nights |
| P3 | Applied rate measured for most exposed items; ≤ 2 demotions/night; footprint falls on bots with long histories | Demoted items re-enter within a week repeatedly (audit noise) |
| P4 | Stalled bots get directives; compliance ≥ 50% of directed nights | Exploration proposals land mostly as `chain_write` (unsafe drift) |
| P5 | Internal/external gap reported; situational share stable | Gap widens for 3 consecutive weeks (scorer fitting) — escalate to owner |

## 12. Deferred items and activation triggers

| Item | Activate when |
|---|---|
| Randomized holdout ablation of hot items (true ΔS per item) | P3 audit data shows ≥ 30% of hot items with ambiguous usage after 30 days |
| Cross-model panel B (fallback brain as second judge) | P1 disagreement rate < 5% on most bots (same-model panels too correlated to be informative) or > 40% (too noisy to gate) |
| Adaptive thresholds derived from measured δ | ≥ 60 nights of panel data on ≥ 3 bots |
| Population-level fitness across a user's bots | ≥ 3 bots with ≥ 30 active nights each |
| Shared on-chain falsified-hypothesis ledger (new protocol) | Local ledger shows the same falsified titles across ≥ 2 bots |
| Preference-loop lesson transfer test (P5 OOD split applied to `/protocols/preference/lesson`) | Preference loop P3 merged and ≥ 5 decided rounds exist |
| Brain-model tags on lessons (cross-model transfer audit) | A bot's brain model changes and its validated rate drops by ≥ 50% for 2 weeks |
| Renderer panel for the RRSI report | Owner asks for it after reading the CLI report for 2 weeks |

## 13. Glossary

- **Draft** — a `capability_drafts` row proposed by a dream (or, after P2, by probation).
- **Gate** — the nightly validation pass and the re-review pass.
- **Panel** — one LLM call of the gate over the pending drafts.
- **Hot layer** — the `<proven_techniques>` and `<procedures>` blocks injected into prompts.
- **Recall-only** — retrievable through `procedure_recall`, never injected.
- **Non-empty night** — a completed dream run whose telemetry has `emptyDay = false`.
- **Exposure** — an item rendered into a prompt (`hot`) or returned by recall (`recall`) on a given local date.
