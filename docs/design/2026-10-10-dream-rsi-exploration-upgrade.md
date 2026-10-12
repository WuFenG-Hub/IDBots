# Dream-RSI Exploration Upgrade: Self-Curriculum, Memory Reconciliation, Chain-Grounded Verification

- Date: 2026-10-10
- Status: Confirmed (owner decisions in §8)
- Branch: `feat/dream-rsi-exploration`
- References:
  - arXiv:2609.15364 — *RSIAgent: Autonomous Exploration for Recursive Self-improvement in New Environments*
  - `docs/analysis/2026-09-17-dream-rsi-analysis.md` — the earlier Dream-RSI gap analysis (P0–P3, all landed)
  - `docs/metaweb-learning-roadmap.md` — MetaWeb learning roadmap (M1–M5)

## 1. Background

RSIAgent demonstrates that a training-free loop of **curriculum → actor → verifier → memory distillation** lets open-source models surpass frontier closed-source models in a new environment, using only an accumulated, verified, frozen memory. Its ablation and failure-mode analysis (Section 4.4 / 4.6 of the paper) are the parts most relevant to us:

1. **Insufficiently targeted exploration** — practice that does not challenge the actual weak points produces no gain, no matter how diverse it is.
2. **Incomplete verification** — a locally accepted mistake becomes the basis for future memory updates.
3. **Unreliable memory consolidation** — a locally-valid rule recorded without its conditions/uncertainty keeps poisoning later behavior.

IDBots already implements the retrospective half of the loop: the nightly dream produces `capability_drafts`, a replay gate validates them against 14 days of dream diaries (`validateCapabilityDraftsAfterDream`, `src/main/services/dreamService.ts:1008`), a 30-day re-review demotes stale rules, promotion hardens the best into `metaid_knowledge_procedures` (`dreamService.ts:1012`), and counterfactual replay extracts value boundaries from negative outcomes (`dreamService.ts:1013`). What we lack is the **exploration half**: nothing generates new, targeted experience — the equivalent of RSIAgent's curriculum agent. Our surf is broad (BRS-like); nothing does deep, weakness-driven practice (DRS-like). And our verifier (the replay gate) judges from distilled diaries only, with no access to ground truth.

This document designs three increments:

- **P0 Self-curriculum** — the dream proposes a small number of targeted practice tasks each night; they execute as scheduled cowork sessions the next day; outcomes feed back into the next dream.
- **P1 Memory reconciliation** — a dedicated pass that checks new lessons against the existing memory bank, resolving conflicts and recording conditions/uncertainty instead of overgeneralized rules.
- **P1.5 Chain-grounded verification** — the replay gate receives a host-computed chain-evidence digest, so claims about on-chain actions are judged against chain state, not against diary prose.

Non-goals for this iteration: population-level evolution (on-chain skill fitness signals, practice-task exchange between bots), DRS-style multi-cycle deep dives, any change to model weights or training, and any change to the frozen-forward `self_identity` rule.

## 2. Design principles

Carried over from the Dream-RSI analysis and the RSIAgent paper, adapted to IDBots constraints:

1. **The host computes evidence; the LLM judges.** Dream-time LLM calls stay tool-less pure completions (`callDreamLlm`). All grounding (diary dates today; chain reads after P1.5) is collected deterministically by the host and injected as prompt evidence. This keeps the verifier auditable and cheap.
2. **Every autonomous action has a hard budget and an off switch.** Practice tasks run unattended; they inherit the surf philosophy (`surfInteractionGuard`) — a single counting guard with a hard cap, plus per-bot policy flags.
3. **Nothing autonomous writes to the chain by default.** Practice sessions default to a read/interact-limited tool surface. Chain writes (posts, publishes, payments) require either an existing human confirmation flow or an explicit opt-in policy.
4. **Reversibility over cleverness.** New memory states and tables must be idempotent migrations; every new status must have a purge/archive path; telemetry lands from day one so we can measure whether the loop helps.
5. **Preserve uncertainty.** Following the paper's distillation/reconciliation prompts, a lesson must record the conditions under which it was observed; an unresolved claim stays unverified (`keep_draft` / `disputed`) rather than being forced into validated or rejected.

## 3. P0: Self-curriculum (dream-proposed practice tasks)

### 3.1 Overview

Nightly flow extension, after the existing post-dream pipeline:

```
dream → validate drafts → re-review → promote → counterfactual replay
      → [NEW] propose practice tasks (self-curriculum)
      → next day: practice tasks run as scheduled cowork sessions
      → next dream reads their outcomes via scheduled_task_runs / sessions
```

The curriculum's inputs are exactly what RSIAgent's curriculum agent sees: the current memory (validated drafts, active procedures), recent outcomes (failures, low ratings, rejected drafts, surf-reported gaps), and the bot's current goals. Its output is **practice tasks**, not solutions.

### 3.2 New dream output: `practice_proposals`

Extend the dream output schema with an optional array, capped at `PRACTICE_PROPOSALS_MAX_PER_NIGHT = 2`:

```json
{
  "practice_proposals": [
    {
      "title": "string, short",
      "prompt": "string — the full self-contained task prompt for a cowork session",
      "rationale": "string — which weakness/failure/uncertainty this targets",
      "target_refs": ["draft:<id>", "procedure:<id>", "surf:<runId>", "date:<YYYY-MM-DD>"],
      "expected_evidence": "string — what observable result would count as informative",
      "risk_class": "read_only | interact_local | chain_write"
    }
  ]
}
```

Prompt guidance (new section in `dreamPrompt.ts`, mirroring the paper's P3/P4 curriculum prompts):

- Propose practice **only** when it targets a specific recorded weakness, uncertainty, or unresolved failure — never generic "get better at X".
- Each proposal must be self-contained (the practice session starts with no dream context).
- Prefer **discriminating** experiments: tasks whose outcome distinguishes between competing explanations (paper's DRS lesson), and **contrast/stress** variants of previously failed tasks.
- `risk_class` is mandatory; `chain_write` proposals are allowed but default-gated (see 3.4).
- Hard anti-target: do not propose practice for capabilities already covered by an active procedure with `use_count > 0` and no recent failures.

Parsing follows the existing fault-tolerant JSON conventions (`parseCapabilityValidationOutput` style): strip fences, take the outermost object, drop unknown fields, clamp counts.

### 3.3 Storage: `dream_practice_proposals` table

New table (idempotent migration in `sqliteStore.ts`, following the `capability_drafts` precedent at `sqliteStore.ts:597-653`):

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `metabot_id` | INTEGER NOT NULL | |
| `dream_date` | TEXT NOT NULL | which dream proposed it |
| `title` | TEXT NOT NULL | |
| `prompt` | TEXT NOT NULL | full task prompt |
| `rationale` | TEXT | |
| `target_refs_json` | TEXT DEFAULT `'[]'` | |
| `expected_evidence` | TEXT | |
| `risk_class` | TEXT NOT NULL DEFAULT `'read_only'` | `read_only` / `interact_local` / `chain_write` |
| `status` | TEXT NOT NULL DEFAULT `'pending'` | `pending` / `approved` / `rejected` / `scheduled` / `completed` / `failed` / `expired` |
| `scheduled_task_id` | INTEGER | link to `ScheduledTask` once materialized |
| `run_id` | INTEGER | link to `scheduled_task_runs` once executed |
| `outcome_summary` | TEXT | filled by the next dream's consumption pass |
| `created_at` / `updated_at` | INTEGER NOT NULL | |

State machine (enforced in store functions, same convention as `capability_drafts`):

- `pending → approved` (owner UI action, or auto when policy allows, see 3.4)
- `pending → rejected` (owner) or `pending → expired` (not acted on within `PRACTICE_PROPOSAL_TTL_DAYS = 3`; purged lazily)
- `approved → scheduled` (host creates the `ScheduledTask`)
- `scheduled → completed | failed` (from `scheduled_task_runs` status)
- Owner may `rejected` at any point before `scheduled`.

### 3.4 Approval and execution policy

New per-bot memory-policy flags (alongside `dreamEnabled`, resolved in `getEffectiveMemoryPolicyForMetabot`):

- `practiceTasksEnabled` (default **off** for existing bots; **on** for new bots only after onboarding copy explains it — final default is an owner decision, see §8).
- `practiceAutoApproveReadOnly` (default **on** when enabled): `read_only` proposals auto-approve; `interact_local` and `chain_write` always require owner approval in this iteration.

Materialization: on `approved`, the host creates a `ScheduledTask` via the same path as `ScheduledTaskAgentControl.createTask` (host side, `main.ts:6234` area):

- `prompt` = proposal prompt plus a fixed footer requiring a final structured report (`outcome`, `evidence_observed`, `what_this_means_for:<target_refs>`).
- `scheduleType: 'at'`, scheduled into the bot's night study window (00:00–06:00, jittered; exact time configurable — owner decision §8).
- `executionMode`: a **new** cowork execution mode `practice` that applies the practice tool policy (see 3.5).
- `disableMemoryUpdates: true` stays as in `scheduler.ts:415` — learning from the outcome happens in the dream, not in-session. This preserves the single-writer property of memory.

Execution results already flow into the next dream through `dreamStore.getActivityForDate` → `DreamDayActivity.taskRuns` (`dreamStore.ts:1257-1267`) plus the linked cowork session transcript. The dream prompt gains a short "last night's practice outcomes" section (capped, e.g. 1500 chars each) so the next curriculum decision sees verified results — closing the recursive loop.

### 3.5 Practice session tool policy

A practice session is a cowork session with a restricted tool surface, mirroring the surf whitelist approach:

- `read_only`: omni_read / metaweb search+read / chain-history recall / local file read + analysis tools. No chain writes, no wallet, no service purchases, no scheduled-task creation.
- `interact_local` (owner-approved): adds local write tools (files, KB writes) but still no chain writes.
- `chain_write` (owner-approved, this iteration: **deferred to manual approval per run**, not unattended): full surface with the standard text confirmation mode.

A single `practiceInteractionGuard` (counter + audit log, modeled on `src/main/libs/surfInteractionGuard.ts`) enforces a per-run cap on any side-effecting call even in approved sessions.

Budget limits per practice run: max iterations (default 60), wall-clock watchdog (default 20 min), one retry on infrastructure failure. All enforced by the scheduler runner, recorded in `scheduled_task_runs`.

### 3.6 Why this is the highest-value piece

The paper's first failure mode is "practice that never challenges the weakness". Our current surf/study loops are breadth-driven by persona and owner topics; nothing in the system is obligated to attack a recorded failure. Self-curriculum converts the dream from a retrospective summary into the **curriculum agent** of the RSI loop, with the chain and the local machine as the practice environment.

## 4. P1: Memory reconciliation pass

### 4.1 Problem

Today, drafts are validated individually against 14 days of diaries, then promoted. What is missing is the paper's **reconciliation** step (its prompt P6): before a memory update is promoted, check the *whole memory bank* for conflicting assertions, unsupported causal explanations, stale environment assumptions, and conclusions broader than the observed evidence. Without it, two drafts from different nights can contradict each other, and a locally-true rule silently generalizes.

### 4.2 Placement in the pipeline

New step between validation and promotion (mirroring the existing re-review placement at `dreamService.ts:1011`):

```
validate drafts → re-review → [NEW] reconcile newly validated drafts against memory bank
              → promote → counterfactual replay → self-curriculum proposals
```

Nightly cap: `RECONCILE_MAX_DRAFTS_PER_NIGHT = 5` (only drafts that became `validated` tonight, highest score first).

### 4.3 Inputs and outputs

Host-collected inputs for each validated draft (deterministic, no tools):

- The draft itself (title, description, score, evidence diary dates).
- Candidate conflicts: active procedures and validated drafts whose title/trigger token overlap exceeds a threshold (reuse the `listProcedures` token-overlap scoring, `metaidKnowledgeStore.ts:1209`) — top 10, each truncated.
- The draft's source diary excerpts (already collected for validation).

LLM verdict per draft (strict JSON, same parser conventions):

```json
{
  "verdicts": [
    {
      "id": 123,
      "action": "keep | narrow | merge | dispute",
      "conditions": "when/where this rule was observed to hold (required unless action=dispute)",
      "uncertainty": "what remains untested (may be empty string only when evidence is exhaustive)",
      "conflicts_with": ["procedure:<id>", "draft:<id>"],
      "note": "one sentence"
    }
  ]
}
```

Actions:

- `keep` — no conflict; host writes `conditions`/`uncertainty` onto the draft (new columns, see 4.4).
- `narrow` — the draft text is rewritten **by the host template**, not free-form: original text + `Applies when: <conditions>` + `Untested: <uncertainty>`; score unchanged.
- `merge` — draft is marked `rejected` with note `merged into procedure:<id>` and the target procedure's `pitfalls_json`/steps get a host-appended line referencing the draft id; no free-form edit of the procedure body in this iteration.
- `dispute` — new status `disputed` on the draft (see 4.4): neither validated nor rejected; it re-enters validation next night with the conflict evidence attached. This is our equivalent of the paper's `UNVERIFIED` — unresolved claims are suspended, not forced to a verdict.

### 4.4 Schema changes (idempotent migrations)

`capability_drafts` gains:

- `conditions_text TEXT` — recorded applicability conditions
- `uncertainty_text TEXT` — recorded residual uncertainty
- `status` vocabulary extended with `'disputed'` (update the union in `coworkStore.updateCapabilityDraftValidation`, `coworkStore.ts:7365`; note the table has no CHECK constraint, so the code union is the source of truth)

Behavioral rules:

- `disputed` drafts are excluded from promotion and from `<proven_techniques>` injection.
- `disputed` drafts older than 7 nights without resolution → `rejected` (with note), purgeable by the existing `purgeExpiredCapabilityDrafts`.
- Promotion prompt (`promoteCapabilityDraftsToProcedures`) gains a rule: when a draft has `conditions_text`, the procedure's `trigger_text` must incorporate it, and `uncertainty_text` lands in `pitfalls_json` as an `Untested: …` entry. This operationalizes the paper's "preserve the conditions and uncertainty of an experience".

### 4.5 Why not full free-form reconciliation

The paper lets the actor rewrite its whole memory bank. We deliberately do not: our memory is shared infrastructure (procedures feed real sessions), so this iteration only allows **annotate, narrow, merge-by-reference, or suspend** — all host-templated and auditable. Free-form reorganization stays with the weekly long dream, which already has the wider context.

## 5. P1.5: Chain-grounded verification for the replay gate

### 5.1 Problem

The replay gate's only evidence is 14 days of dream diaries (`dreamService.ts:1169-1187`). Diaries are the bot's own distilled prose — for claims about on-chain actions ("I published the service", "the payment confirmed", "the task node was accepted"), the ground truth is one chain read away, and we currently don't do it. This is exactly the paper's "incomplete verification" failure mode, and the AI Internet gives us a structural cure the paper's VM environments didn't have: **chain state is immutable, timestamped, and publicly checkable**.

### 5.2 Design: host-computed chain evidence digest

Keep `callDreamLlm` tool-less. Before validation, a deterministic host pass builds an evidence digest:

1. **Collect candidate references** for tonight's drafts:
   - The dream-day activity already includes `chainWrites` / `chainReads` (`dreamService.ts:948-957`); extract pin ids, txids, order ids, task ids from there.
   - Additionally, regex-extract pin-like / txid-like tokens from each draft's text (pins: 64-hex-ish ids; txids: 64-hex; explicit `pin://` / `metafile://` / `metaid://` URIs).
2. **Verify each reference** (bounded: `CHAIN_EVIDENCE_MAX_REFS = 8` per night, `CHAIN_EVIDENCE_TIMEOUT_MS = 8000` each, failures degrade to "unverified" not "error"):
   - pin id → `metawebPinService.readMetawebPin` (`services/metawebPinService.ts:220`): exists? path/protocol? timestamp?
   - txid → `txTransferVerification` (`services/txTransferVerification.ts`): confirmed? amount/recipient vs. claim?
   - service order id → `serviceOrderStore.getOrderById` (`serviceOrderStore.ts:862`): terminal status?
   - metatask node → projection store (`services/metatask/projectionStore.ts:430`): node status?
3. **Render the digest** as a compact, dated list:

```
Chain evidence (verified by host at 2026-10-10T02:13:44Z):
- pin://ab12…  EXISTS path=/protocols/skill-service created=2026-10-09 matches draft #3 claim "published service"
- txid 9f2c…   CONFIRMED amount=15000sat to=1Boat…  (draft #5 said "payment confirmed": SUPPORTED)
- order #8842  status=refund_pending  (draft #5 said "order completed": CONTRADICTED)
- pin://cd34…  NOT FOUND  (cited by draft #7)
```

4. **Inject** the digest into `buildCapabilityValidationPrompt` as a new optional parameter (`chainEvidence`), with new judging rules:
   - A claim **contradicted** by chain evidence ⇒ `rejected`, regardless of diary support.
   - A chain-action claim with **no** chain evidence ⇒ at best `keep_draft`, never `validated` (chain claims require chain grounding; non-chain claims are unaffected).
   - The existing anti-hallucination date gate extends: any pin id / txid cited in a rationale must appear in the digest, else the verdict is discarded.

### 5.3 Scope discipline

Only drafts whose text contains chain references get chain-grounded rules applied; purely conversational/value drafts judge as before. Chain reads are read-only, cached for the night, and recorded in the dream run telemetry (`chainEvidence: {refs, supported, contradicted, notFound, errors}`). No new network surface at dream time beyond what interactive sessions already use.

## 6. Telemetry and observability

Extend `updateRunTelemetry` (`dreamService.ts:1017-1046`) with:

- `practiceProposals: {proposed, autoApproved, pendingOwner, rejected, expired}`
- `practiceRuns: {completed, failed, avgIterations, avgWallMs}` (joined from `scheduled_task_runs`)
- `reconciliation: {considered, kept, narrowed, merged, disputed}`
- `chainEvidence: {…}` as above

The existing `CapabilityDraftsPanel` (`src/renderer/components/settings/CapabilityDraftsPanel.tsx`) gains a read-only "Practice" tab later (this iteration: data and CLI surface only, UI is a follow-up).

Success metrics for the feature itself (review after 2 weeks):

- Fraction of practice proposals that target a *recorded* weakness (vs. generic) — sampled audit.
- Practice outcomes cited by subsequent dreams (loop closure rate).
- Reconciliation actions per week; disputes resolved vs. expired.
- Chain-grounding contradiction catches (each one is a memory poison prevented).

## 7. Implementation plan

Single branch `feat/dream-rsi-exploration`, four commits:

1. `feat: dream practice-proposal schema, parsing, and store` — table + migration, dream output extension, parser, store functions, unit tests (follow `tests/capabilityValidation.test.mjs` conventions).
2. `feat: practice task materialization and practice execution mode` — policy flags, scheduler integration, tool-surface restriction + `practiceInteractionGuard`, practice report footer, dream consumption section.
3. `feat: memory reconciliation pass with conditions and uncertainty` — schema columns + `disputed` status, reconciliation prompt/parser/host actions, promotion prompt update, tests.
4. `feat: chain-grounded evidence digest for the replay gate` — reference extraction, host verification pass, prompt injection + judging rules, extended rationale gate, telemetry.

Each commit keeps `pnpm run check:dsh-deps` green and adds its own focused tests. DB changes are additive migrations only (per the database-upgrade-safety rules); old app versions reading a newer DB must not crash (new columns have defaults; new statuses are ignored by old queries because they filter on explicit status values).

## 8. Owner decisions (confirmed 2026-10-10)

1. **`practiceTasksEnabled` default**: off for everyone at first (opt-in), announced in release notes; revisit after two weeks of telemetry.
2. **Auto-approve scope**: `read_only` proposals auto-approve (when the feature is enabled), capped at 2/night, with a full audit trail; `interact_local` and `chain_write` always require owner approval in this iteration.
3. **Practice time slot**: reuse the night study window (00:00–06:00), keeping the "surf → dream → practice" rhythm on one nightly cadence and matching the paper's cost profile.
4. **Chain-write practice**: deferred entirely — no `chain_write` proposal executes in this iteration; the class exists in the schema so a later iteration can gate it behind per-run owner confirmation.

## 9. Risks

- **Curriculum hallucination**: the dream proposes practice for a weakness that doesn't exist. Mitigation: proposals must cite `target_refs`; uncited proposals are dropped by the parser.
- **Budget creep**: unattended sessions burn tokens. Mitigation: hard caps (2/night, 60 iterations, 20 min), policy default-off, telemetry on cost per practice run.
- **Verifier still an LLM**: chain grounding only covers chain claims; diary-based judging can still be wrong. Mitigation: contradiction catches are logged loudly; the 30-day re-review remains the backstop.
- **Memory bloat via annotations**: `narrow` appends text. Mitigation: `conditions`/`uncertainty` fields capped (300 chars each) at parse time.

## 10. Future iterations (deferred — with activation triggers)

Discussed and deliberately deferred on 2026-10-11. The governing discipline: **merge and observe §6 telemetry for ~2 weeks before funding any of these** — each item below lists the telemetry signal that would activate it.

### 10.1 Owner approval UI for practice proposals (most urgent follow-up)

This iteration shipped the data and IPC surface only. `interact_local` proposals and any proposal beyond the auto-approve cap sit in `pending` with **no owner-visible surface**, so they silently expire after 3 days. Until a Practice tab lands (candidate home: `CapabilityDraftsPanel`, `src/renderer/components/settings/CapabilityDraftsPanel.tsx`), the self-curriculum loop effectively runs read-only-only.

- Scope: list pending/approved/completed proposals per bot, approve/reject actions, run outcome view, policy toggles (`practiceTasksEnabled`, `practiceAutoApproveReadOnly`).
- Activation: none needed — this completes P0 rather than extending it.

### 10.2 P2 residue: explicit broad-then-deep staging

The P0 practice pipeline already subsumes most of the original P2 idea: `target_refs` accepts `surf:<runId>`, the practice session is the deep-dive container, and the curriculum guidance already prefers contrast/stress variants. What remains unbuilt:

1. A structured **"hard cases" field in the surf report** (today: free-text `notes` only) so surf findings become machine-targetable practice fodder.
2. A **depth marker on procedures** (e.g. `deep_validated` tag) distinguishing lessons validated by targeted practice from single-observation lessons.
3. **Multi-cycle DRS loops** (practice → outcome → harder follow-up practice within one lineage) — a non-goal this iteration and still the most complex piece; needs curriculum quality evidence first.

- Activation: telemetry shows proposals genuinely citing `surf:` refs (loop closes from breadth), and reconciliation/dispute rates show single-shot practice leaving uncertainty unresolved.

### 10.3 P2.5: frozen-memory capability evaluation

Periodic fixed-exam scoring against a hash-frozen memory copy (writeback disabled), giving per-bot comparable growth curves.

Open design questions that need their own document:

- Exam bank provenance: replay historical MetaTask nodes? owner-authored tasks? on-chain shared exam sets?
- Scoring: who judges — replay-gate LLM, MetaTask reviewer quorum, or deterministic checkers?
- Budget policy: exams burn tokens; cadence and cost caps are an owner decision.

- Activation: at least 2 weeks of loop telemetry exist (a baseline to measure against), and capability utilization numbers (`times_injected`, procedure `use_count`) are moving — otherwise there is nothing to measure.

### 10.4 Population-level evolution (the documented next frontier)

On-chain skill fitness signals (installs × validation pass rate feeding reputation), and a practice-task exchange where one bot's hard-won DRS exercise becomes the fleet's curriculum. Requires a stronger on-chain verification bar than local promotion — most mutations are harmful, so selection pressure must be front-loaded. Design only after §6 metrics show the single-bot loop producing durable capability gains.
