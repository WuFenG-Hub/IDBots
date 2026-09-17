# Dream-RSI × IDBots Dream Mechanism — Analysis and Optimization Proposal

Date: 2026-09-17
Branch: `feat/dream-rsi-optimization`
Paper: [Dream-RSI: Recursive Self-Improvement through Evolving Worlds](https://dream-rsi.com/assets/dream-rsi.pdf) (Google / Google DeepMind / UMD / UVA, 2026)

## 1. What the paper actually says

Dream-RSI targets **meta-level recursive self-improvement**: not improving the solutions an
agent produces, but improving the *exploration policy* that decides where to search, what to
refine, what to run in parallel, and when to stop.

Core mechanism (3 stages in a loop):

1. **Online Explore** — the current policy drives a coding agent through a discovery task;
   every attempt (workspace, artifact, score, diagnostics) is logged as a node in a
   *discovery tree*.
2. **Construct Replay Simulator** — the completed tree becomes a "world": since every node's
   outcome is already recorded, an *alternative* policy can be executed against the tree by
   simply **revealing stored outcomes** instead of re-running anything. One expensive online
   run yields thousands of zero-execution-cost off-policy evaluations.
3. **Dreaming-based Policy Improvement** — an LLM "policy-development agent" dreams up
   candidate policy revisions, each candidate is replayed over ALL recorded trees, scored by
   `V = best_quality − β1·cost + β2·parallelism`, and the best candidate (the candidate set
   always includes the current policy, so **the redeployed policy is provably no worse on
   history**) is deployed for the next online round. Only the policy code changes; the agent,
   evaluator, and interfaces stay fixed.

Results: equal or better discovery quality with 1.7×–162× less discovery compute across
algorithm engineering, math optimization, and GPU kernel tasks.

Two findings matter beyond the headline:

- **§2/§6 framing**: prior work uses history as *static prompt context* or *training data*;
  Dream-RSI uses history as an **interactive replay simulator**. That is the upgrade.
- **§5.1 (the caveat)**: injecting distilled "high-level directional insights" into prompts
  as semantic guidance **consistently hurt** discovery performance — strong semantic priors
  over-constrain the search space and kill diversity. Replay beats narration.

## 2. IDBots dream system as it exists today

(Mapped from `src/main/services/dreamService.ts`, `src/main/libs/dreamPrompt.ts`,
`src/main/dreamStore.ts`, `src/main/libs/experiencePromptBlocks.ts`,
`src/main/services/memoryHygieneService.ts`.)

Nightly per bot, inside 00:00–06:00 local (per-bot stagger, 7-day catch-up, bounded retry,
`DREAM_VERSION`-based repair re-dreaming):

1. Collect the day's activity: cowork sessions + human thumbs/comments, scheduled-task runs,
   service orders, group tasks + acceptance ratings + on-chain group chat, own chain
   writes/reads, impression evidence, existing knowledge, optional pre-dream surf report.
2. One LLM call (fragmented + synthesized for busy days), observer-perspective ("上帝视角")
   prompt, strict JSON out:
   `daily_summary`, `work_reviews` (warming/stable/cooling), `important_memories`,
   `value_lessons`, `impression_updates`, `knowledge_points`, `capability_learnings`,
   `self_identity` (forward-only monotonic rewrite).
3. Write to SQLite only (never on-chain): `metabot_daily_summaries`, dream-origin
   `user_memories` (profile_fact / value_boundary / work_review / self_identity),
   impression snapshots, knowledge entries, `capability_drafts` (status `draft`).
4. Consumption: dream output is the always-injected "hot layer" of every prompt
   (`<metabot_self_identity>`, `<value_boundaries>`, `<work_reviews>`,
   `<recent_daily_summaries>`); `experience_recall` tool covers warm/cold layers.
   `MemoryHygieneService` (from 04:00) decays/retires aged layers and runs a weekly LLM
   deep-consolidation.

In Dream-RSI's own taxonomy, IDBots dreaming is the **"history as static context"** paradigm:
the day is replayed *once, by narration*, compressed into prose, and injected as semantic
guidance. There is no evaluation step, no alternative-policy comparison, and — critically —
no loop closure for capabilities (`capability_drafts` are written every night and **never
promoted into real skills**; flagged in-code as "a later phase" at dreamService.ts:949-952).

## 3. Concept alignment / divergence

| Dream-RSI | IDBots today | Gap |
|---|---|---|
| History recorded as a structured, outcome-labeled tree | Rich structured history (sessions, feedback, ratings, orders) already in SQLite | Outcome labeling is partial: thumbs/ratings exist, but most assistant actions have no score |
| Dreaming = evaluate MANY candidate policies against replay | Dreaming = ONE narrative pass producing prose | No counterfactual evaluation at all |
| Candidate set always includes current policy ⇒ monotonic non-regression on history | self_identity is forward-only; other layers overwritten nightly | Distilled rules are accepted without any validation against recorded evidence |
| Policy is explicit, executable code (branching/parallelism/stopping) | The "policy" is prose: value_boundaries, knowledge, persona | Nothing executable evolves |
| Objective includes cost and parallelism penalties | No cost-awareness in dreams | Bots never reflect on token/time/tool efficiency |
| Improved artifact redeploys online and expands history | capability_drafts → (void) | **The RSI loop is open — this is the biggest gap** |
| §5.1: semantic guidance over-constrains | All dream output IS semantic guidance injected into every prompt | Directly applicable warning |

## 4. Optimization proposals (prioritized)

### P0 — Close the capability loop: replay-gated skill promotion

Today `capability_learnings` land in `capability_drafts` and die there. This is precisely the
open loop Dream-RSI closes. Proposal:

- Nightly (or weekly, alongside deep-consolidation), take new `capability_drafts` and
  **validate them against the history that motivated them**: the episodes/sessions/orders
  referenced in the dream already exist in SQLite. For each draft, replay the top-k past
  situations where the draft would have applied and ask the LLM to score
  "would following this draft have changed the outcome?" against the *recorded* outcome
  (thumbs down, cooling review, failed order = negative; accepted task, thumbs up = positive).
- Promote drafts that score well to `status='validated'` and surface them — first as an
  injectable hot-layer block (`<proven_techniques>`, low risk), later as real skill files.
  Demote/delete drafts contradicted by recorded outcomes.
- This is the Dream-RSI selection guarantee adapted: **a lesson only ships if it is
  consistent with (or improves upon) what actually happened**.

### P1 — Counterfactual replay inside the nightly dream

The dream currently re-narrates the day once. Add a targeted counterfactual pass over the
day's **negative-outcome decision points** (thumbs-down messages, cooling work_reviews,
rejected group-task work, failed orders — all already identifiable in the activity query):

1. Extract the 1–3 worst decision points (context + what the bot did + recorded outcome).
2. Generate 2–3 alternative responses/actions for each.
3. Evaluate each alternative with a fixed rubric (LLM-as-judge, anchored to the recorded
   human feedback and acceptance criteria) — the "replay score".
4. Only when an alternative clearly beats what happened does the dream emit a
   `value_lesson` / `knowledge_point` / `capability_learning` about it.

This converts value_lessons from *post-hoc rationalization* into *simulation-validated
rules*, at the cost of a few extra LLM calls on bad days only. It also directly implements
the paper's core move — "what would have happened if I had acted differently" — at near-zero
cost, because the contexts and outcomes are already recorded.

### P1 — Outcome-anchored gating for distilled memories

Adapt the monotonic-selection guarantee to memory writes: before a new `value_boundary` or
`work_review` replaces yesterday's batch, check it does not contradict recorded evidence
(e.g., a new rule that would have produced a thumbs-down response in a past session should
be flagged). Cheap version: include "cite the evidence" in the dream JSON contract and
reject unsourced rules; full version: the counterfactual replay above doubles as the gate.

### P2 — Dream telemetry: make the dream policy itself measurable

Dream-RSI improves its meta-policy because it has a replay score. IDBots has no metric for
dream quality. Add lightweight telemetry to `metabot_dream_runs`:

- utilization stats: how many of last night's value_lessons/knowledge/drafts were actually
  recalled or triggered in the following days (hot-layer blocks are injected; tool calls to
  `experience_recall` are logged);
- predictive validity: did `work_reviews` temperature predict subsequent human feedback?
- cost: tokens in/out per dream (the paper's β1 term — bots should eventually dream about
  their own efficiency).

These metrics enable a future "dream about dreaming" pass (adjust fragment budgets, section
emphasis, caps) and give the `DREAM_VERSION` bump an evidence basis instead of a manual one.

### P2 — Multi-day thematic replay (weekly horizon)

Dreaming is strictly per-day; the weekly deep-consolidation only prunes. Add a weekly
"long dream" that replays the week's 7 daily summaries + stats as a single discovery tree:
cross-day patterns (recurring pitfalls, improving/declining relationships, drafts that keep
reappearing unpromoted) are exactly the meta-level signal Dream-RSI extracts from its
history pool `Ht = (T1, …, Tt)`.

### P3 — Heed §5.1: keep guidance from over-constraining

The paper's negative result applies directly to us: everything the dream writes is semantic
guidance injected into every prompt. Guardrails:

- Keep `<value_boundaries>` and `<work_reviews>` small (they are, ≤5) and **phrased as
  boundaries/facts, not directives** — boundaries constrain the bad, directives constrain
  everything.
- Preserve exploration budget deliberately: pre-dream surf, group-task variety, and
  occasional "try a different style" latitude should not be optimized away by lessons.
- When P0/P1 add validated techniques, inject them as *available options* ("proven to work
  when…") rather than standing orders.

### Quick wins (independent of the above)

- `work_reviews` are written nightly but only injected in group-task turns — inject them
  into cowork/private-chat prompts too (coworkRunner.ts:5164-5191 passes only
  identity/valueBoundaries/summaries).
- Per-bot `dreamEnabled` has store support but no IPC/UI exposure (main.ts:11119-11150,
  MemorySettings.tsx) — add the toggle.
- Fragment cache invalidation is tied to manual `DREAM_VERSION` bumps; a prompt-hash check
  would make repair automatic.

## 5. What NOT to import

- **Executable policy-as-code for bot behavior.** Dream-RSI can make its policy code because
  its domain is a search loop with numeric scores. A companion bot's "policy" is social and
  semantic; forcing it into executable controllers would be over-engineering. Our analog of
  "policy code" is the validated skill/technique layer (P0).
- **Full tree replay infrastructure.** We don't need branch/parallelism simulation; our
  replay unit is the decision point, not a search tree.
- **Aggressive exploitation.** §5.1 warns that over-fitting guidance to history reduces the
  diversity that a social bot needs to stay interesting.

## 6. Suggested sequencing

1. Quick wins (work_reviews injection, dream toggle UI) — small, independent.
2. P0 capability validation loop — closes the RSI loop with existing data.
3. P1 counterfactual replay on negative-outcome days — the true "dreaming in a replay
   simulator" feature.
4. P2 telemetry, then multi-day long dreams once metrics exist to judge them.

Each step is independently shippable and testable against the existing `tests/dream*.test.mjs`
harness.
