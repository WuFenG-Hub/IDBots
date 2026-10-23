# Dream & RSI Mechanism Review (2026-10-23)

Scope: code-level audit of the dream pipeline, feedback loops (explicit + implicit), the memory/experience system, and the RSI machinery (capability drafts, prediction ledger, prompt rollback, practice, cerebellum), cross-checked against the design docs and against real local dev data (`.dev-userdata-dsh`, `.dev-userdata-fresh`). Method: six parallel read-only audits; all claims below cite `file:line` on `main` @ 40cde706.

Reference docs: `docs/analysis/2026-09-17-dream-rsi-analysis.md`, `docs/design/2026-10-10-dream-rsi-exploration-upgrade.md`, `docs/design/2026-10-13-prediction-ledger-and-prompt-rollback.md`, `docs/design/2026-10-13-cerebellum-system-handoff.md`, `localdocs/metabot-journey-p4-backlog.md`.

## 1. Architecture summary (as implemented)

Nightly per-bot dream (`dreamService.runDream`, `src/main/services/dreamService.ts:1178`) is the single consumer of all feedback:

```
inputs:  cowork sessions+messages (with message_feedback inlined), group-task ratings,
         service-order counts, scheduled-task runs, chain reads/writes, impression episodes,
         practice outcomes, prediction reconciliation, implicit structural signals,
         optional pre-dream surf report, last weekly summary
  ↓ budget: fast path ≤50% of model input cap; chunked path 35%/chunk
LLM synthesis (bot's own brain; global dreamLlmId override)
  ↓
outputs: daily_summary, user_memories (profile_fact / value_boundary / work_review /
         self_identity), knowledge entries, capability drafts, practice proposals,
         impression observations
  ↓ post-passes (all try/catch, never fail the run)
validation gate (2 LLM panels) → 30-day re-review (2 panels) → memory reconciliation (1)
→ promotion (budget-annealed) → hot-layer usage audit (1) → pruning →
counterfactual replay (1, negative-feedback days) → weekly long dream (≤1/week)
  ↓
re-injection every turn via coworkRunner.ts:6303-6418:
  self_identity(1) + value_boundaries(5) + work_reviews(5) + 7-day summaries +
  proven_techniques(≤5) + knowledge hot layer(≤8) + hot procedures(≤5)
```

Cost on a draft-backlogged night: ~8–9 brain-model LLM calls per bot per night.

## 2. Feedback channels: loop-closure verdicts

| Channel | Storage | Consumed by | Verdict |
|---|---|---|---|
| Cowork 👍/👎 + comment | `message_feedback` (`sqliteStore.ts:475`) | dream transcript annotation (`dreamPrompt.ts:380-386`), counterfactual replay → `value_boundary` memory → injected every turn (`coworkRunner.ts:6322-6330`), rollback gate (`promptLayerRollback.ts:40-58`), telemetry | **Closed (nightly batch)** — but 👍 has no symmetric reinforcement path, and nothing is real-time |
| Group-task acceptance rating | `group_tasks.rating/rating_comment` | dream ground-truth section → `work_review` memory → cowork + group-task turns; ≤2★ → replay + rollback counter | **Closed (nightly)** — but task-level, not member-level attribution (`dreamStore.ts:1547-1555`) |
| Skill-service rating | on-chain pin → `remote_skill_service_rating_seen` + `rating_avg` | buyer-side selection prompt only; provider bot sees it only as unstructured chat text in private session | **Weak/indirect** — no structured path into the provider's dream/memory, even when provider is local |
| Private-chat rating prompt | — | buyer-bot auto-rating flow, live (`privateChatDaemon.ts:4869-5071`) | Works, but the rater is the buyer **bot**, not the human |
| Implicit signals | `activity.implicitSignals` only | dream prompt section, replay (lowest priority), rollback counter | **Weak** — structural facts only (reask / unanswered_burst / repeat_order); zero detection of praise/warmth (`implicitSignals.ts:3-12` by design) |

Real data: `message_feedback` has **0 rows** in both dev profiles — the flagship feedback channel has never fired once, so replay/rollback/feedback-annotated dreams have never actually run on real data.

## 3. Memory system: bloat risk vs stored-but-unused risk

Bloat: **bounded, low-medium risk.** Every injected block has item+char caps; worst case ≈ 22–25k chars (~7–9k tokens) per cowork turn. No linearly-growing injection path. Exceptions:

- **P1**: `buildSelfIdentityBlock` has no char cap (`experiencePromptBlocks.ts:54-68`) — one uncapped LLM-written text sits in every turn of every channel.
- **P2**: no global budget across blocks; caps stack independently (`coworkRunner.ts:6754-6998`).
- Ranking dilution: candidate pool is latest-200 (`coworkRunner.ts:3953`), lexical-only scoring (no embeddings); cerebellum semantic rerank falls back to lexical on timeout (`coworkRunner.ts:6811-6819`).

Stored-but-unused: **real, medium severity.**

- Knowledge hot layer = latest 8 (`coworkRunner.ts:6267-6290`); everything older sinks, retrievable only via LIKE keyword recall.
- Procedures: hot layer = latest 5 hot_eligible; same sinking pattern.
- **P4**: private-chat direct-reply path never injects knowledge/procedures/culture (`privateChatDaemon.ts:5593-5647`).
- Team culture is read **only** in group-task turns (`groupTaskDaemon.ts:4393`) — invisible to daily cowork/private chat.
- Usage auditing covers only techniques/procedures (`dreamService.ts:2247-2448`); user memories mark `last_used_at` on mere **injection** (`coworkRunner.ts:4034-4036`) — self-reinforcing immortality, no applied-quality signal.
- Conversation-scope memories are written but the block is almost always empty (contact scope wins, `memoryPromptBlocks.ts:249-251`).

## 4. RSI machinery: status and data evidence

Everything is wired and LIVE; the problems are defaults, dead writes, and stacked costs:

1. **Practice proposals are dead writes by default**: dream writes ≤2 proposals nightly (`dreamService.ts:3879-3898`), but materialization requires `practiceTasksEnabled && practiceAutoApproveReadOnly`, both OFF by default (`dreamService.ts:2836-2849`); rows TTL-expire after 3 days. The proposal contract also consumes main-dream output tokens every night.
2. **Capability gate stack is high-cost/low-throughput**: dual panels × (validation + re-review) + reconciliation + audit + replay ≈ 6–7 extra LLM calls/night, each carrying a 14-day diary pool; pass rate triple-compressed by prospective-citation rule + min(panelA,panelB) + 0.85 promotion line. By design, but worth measuring.
3. **Structurally empty telemetry**: prediction OOD bucket (`dreamService.ts:3386`) can never fill — the host only derives cowork/surf sources; evolution-stagnation output only feeds the (default-off) practice pipeline.
4. **`hot_reason` single-field overwrite**: probation flip / re-review demote / pruning 'unused' / rollback all write the same field; earlier cause is lost.
5. **Exposure-ledger write amplification**: every hot-layer render and every recall writes SQLite rows purely for telemetry (`coworkRunner.ts:6406-6416`, `:4562`).
6. **Cerebellum thresholds shipped unvalidated**: #4/#5/#13/#15/#16 evals were dry-run only, #19 has no eval script, #12 intuition never smoke-tested live; all fail-open on 429 → real users may run cerebellum-less without knowing.
7. No "skill points" system exists in code — the concept lives as capability drafts + validationScore + falsified ledger.
8. Rollback is one-step only (`dreamStore.ts:2106-2118`) and once per date.

Dev-data evidence (`.dev-userdata-dsh`): `metabot_predictions`, `capability_drafts`, `capability_falsified_hypotheses`, `hot_layer_usage`, `dream_practice_proposals`, `metabot_prompt_layer_snapshots`, `team_culture_entries` — all **0 rows**. One night (2026-08-15) produced genuinely good diaries/memories/knowledge/impression; 27 of 29 dream runs were empty-day or instant backfill, 1 stuck in `running` forever.

## 5. Confirmed bugs / risks (prioritized)

1. **Pre-dream surf failure loop (data-confirmed)**: 13/13 surf runs failed with the same stale model binding (`deepseek-v4-flash`), each leaving an orphan cowork session holding a duplicated 49,011-char prompt. No alerting; silent waste.
2. **Skill-service ratings never reach the provider bot** structurally (§2).
3. **Positive feedback has no reinforcement path**: 👍 is only a transcript annotation; no positive replay, no "do more of this" mechanism; conversational praise is undetected by design. The RLHF "reward" half is prompt-voluntary only.
4. **No real-time feedback awareness**: a 👎 mid-session cannot influence the remaining turns that night; minimum feedback→behavior latency is one night by design.
5. **Group-task rating is not member-attributed** — free-riders and main contributors get the same `work_review` signal.
6. **Dream input silent drops**: group chat >400/task (`dreamStore.ts:1523`), chain entries >50/day/kind, later sessions in equal-share budgeting can degrade to title-only (`dreamPrompt.ts:558-560`) — no logs/telemetry for any of these.
7. **P1 self_identity uncapped** + written nightly from unfiltered user text — no sanitization against prompt-injection ("rewrite your self-image") before it lands in every future turn.
8. **Dead/vestigial code**: `DREAM_RETRY_BASE/MAX_DELAY_MS` unused with stale docstring (`dreamPrompt.ts:34-35,255-265`); `chunkToActivity` exported, no callers (`dreamFragments.ts:225-241`); dreamService header comment (`:165-176`) describes 3 output channels vs the actual 10+.
9. **`message_feedback` lacks `metabot_id`** — attribution currently correct only via session indirection; schema is not mistake-proof.
10. **Stuck `running` dream run** observed in data; restart resets exist (`dreamStore.ts:1266-1284`) but the in-app death left one permanently.

## 6. Recommended improvements (priority order)

P0 (close the reward loop, cheap):
- Skip writing practice proposals when the practice feature is off (one guard in `writeDreamResults`).
- Feed skill-service ratings into the provider bot's dream as a structured section (local provider case is trivial; remote case can reuse the rating pin sync).
- Add a positive counterpart to counterfactual replay (or at least a "reinforced techniques" extraction from 👍-with-comment messages), so reward and punishment are symmetric.
- Add drop-counters + telemetry for every silent truncation in dream input assembly.
- Cap `self_identity` injection (e.g. 1,500 chars) and add a lightweight sanitization/diff review before it replaces the previous identity.

P1 (make stored knowledge earn its tokens):
- Extend hot-layer usage auditing beyond techniques/procedures to knowledge entries and value_boundary/work_review memories; stop counting mere injection as usage for `last_used_at`.
- Inject knowledge/procedures hot layer into the private-chat direct-reply path (currently skill-turns only).
- Give team culture a daily-cowork read path (or consciously delete it from non-group contexts).
- Fix `hot_reason` to an append-only history.

P2 (measurement & calibration):
- Live-eval cerebellum thresholds (#4/#5/#13/#15/#16/#19) or annotate the panels as uncalibrated.
- Add the deferred per-bot fixed-exam (10-10 §P2.5) now that telemetry exists — it is the only designed metric of "getting smarter" that is per-bot comparable over time.
- Surface "feedback desert" in the UI (nudge first 👍/👎) — 0 rows after months means the RLHF loop is starved at the source.

P3 (cost hygiene):
- Make dual-panel validation configurable (dep seam already exists at `dreamService.ts:519`); consider cerebellum pre-triage of dreams (handoff backlog #8).
- Batch/throttle exposure-ledger writes.

## 7. Caveats

The dev profiles saw sparse real use (two active days months apart), so "0 rows" partly reflects usage starvation rather than broken code; but the surf failure loop, the practice dead writes, and the structural gaps (§2, §5) are code-level facts independent of data volume. No smoke test was possible for dream/RSI behavior; conclusions rest on code tracing plus the available telemetry.
