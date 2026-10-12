# Prediction Ledger + Prompt-Layer Rollback (RSI P0)

Date: 2026-10-13
Status: implemented (feat/p0-prediction-rollback)
Scope: `src/main/dreamStore.ts`, `src/main/coworkStore.ts`, `src/main/services/dreamService.ts`, `src/main/libs/{predictionLedger,predictionAgentTools,promptLayerRollback,dreamPrompt,surfPrompt,coworkRunner}.ts`, `src/main/main.ts`, `src/main/sqliteStore.ts`

## Motivation

RSI-Anything (arXiv:2610.13912) argues that self-improvement needs two mechanical loops: (1) **prediction–observation pairs** — the agent states an explicit, checkable expectation before acting, and the outcome is later compared against it, producing calibration evidence instead of vibes; and (2) a **retention gate** — newly written "improved" state is kept only while it does not degrade observed behavior, with a cheap deterministic rollback when it does. IDBots' nightly dream already rewrites the bot's prompt-injected layers (dream-origin memories, promoted procedures) every night with no reconciliation of expectations and no rollback. This P0 implements both loops minimally: a prediction ledger with dream-time reconciliation, and snapshot-before-write plus conservative auto-rollback for the prompt layer.

## Feature A — prediction ledger with dream reconciliation

### Schema: `metabot_predictions` (dreamStore, also created in sqliteStore.initializeTables)

| column | meaning |
| --- | --- |
| `id` | uuid |
| `metabot_id` | owning bot |
| `created_at` | epoch ms |
| `session_id` | recording cowork/surf session (nullable) |
| `source` | `cowork` \| `surf` \| `metatask` \| `service` |
| `action_type` | `buzz_post` \| `metaweb_comment` \| `metatask_submission` \| `service_delivery` |
| `subject_ref` | pinId / `rootPinId:nodeId` / order id; NULL when only known after the action |
| `prediction_text` | the concrete claim (≥10 chars, enforced at write time) |
| `expectation_json` | closed per-action schema (below) |
| `resolve_deadline` | YYYY-MM-DD; default today+3d, max today+14d |
| `status` | `pending` \| `hit` \| `miss` \| `partial` \| `expired` \| `void` |
| `resolved_at` / `resolved_by` | verdict bookkeeping (`dream` for the nightly pass) |
| `outcome_text` / `outcome_json` | observed outcome (text + structured, e.g. `{metric, observed, likes, comments, resolvedSubjectRef}`) |

Index: `(metabot_id, status, resolve_deadline)`. Store API: `recordPrediction`, `listPendingPredictions`, `resolvePrediction` (only pending rows move — idempotent), `listPredictionCalibration(metabotId, sinceDays)`, `pruneResolvedPredictions({cutoffMs})` (terminal rows older than 90d; pending rows are never pruned).

### Expectation schema (validated deterministically in the tool)

- `buzz_post` / `metaweb_comment`: `{ metric: "likes"|"comments"|"interactions", op: ">=", value: <int ≥ 1> }`
- `metatask_submission`: `{ metric: "review_pass", value: true }`
- `service_delivery`: `{ metric: "order_completed", value: true }`

Unknown metrics/ops/keys, short text, past or >14d deadlines are refused before any write.

### Tool surface

`prediction_record` (src/main/libs/predictionAgentTools.ts) is registered on every cowork surface via `CoworkRunnerOptions.predictionTools` (main.ts wires it to `DreamStore.recordPrediction`), and is added to the **surf** session allowlist only — study sessions stay read-only. Guidance, not force: one line in the cowork memory-strategy section, one bullet in the surf CREATE step.

### Dream-time reconciliation (before synthesis)

`DreamService.reconcilePredictionsBeforeDream` runs on every dream run (empty days included), before the synthesis call so the digest is prompt input:

- `buzz_post` / `metaweb_comment`: reception counts for the bot's own pin via the same R3 interactions aggregation that feeds the surf reception column (`fetchPredictionReception` dep, wired in main.ts over `metawebInteractionsRemote`, split into likes/comments). A NULL subject_ref falls back to the bot's earliest own chain write of the matching protocol at/after the prediction (`findOwnChainWriteForPrediction` over `metabot_chain_writes`). An early hit (observed ≥ target) resolves immediately — reception only grows; otherwise the verdict waits for the deadline and lands as `partial` (observed > 0) or `miss` on the final tally.
- `metatask_submission`: the local projection's review outcome for `rootPinId:nodeId` (`getMetataskSubmissionOutcome` dep; competitive mode reads the candidate set, tree mode the effective submission + node status).
- `service_delivery`: the order's final status from `service_orders` (`completed` → hit; `failed`/`refunded` → miss; still in flight → pending).

Not-yet-observable stays `pending`; past `resolve_deadline` without an observable outcome → `expired`. Reception comparison: `observed >= value → hit; observed > 0 → partial; else miss`. Boolean: match → hit else miss.

### Calibration digest

Trailing 30 days: per action type counts by status + hit rate (`hit / (hit+miss+partial)`; expired never enters the judged set), plus up to 5 recent misses **and partials** (prediction text + observed outcome, truncated — a near-miss is calibration signal too). Rendered as a new dream-prompt section (`## 预测校准对账`); consumed by the existing `value_lessons` / `important_memories` outputs — no new dream-output schema field. Reconciliation counters land in `telemetry_json.predictions = { checked, resolved, hit, miss, partial, expired }`.

## Feature B — prompt-layer snapshot + deterministic rollback (retention gate)

### Schema: `metabot_prompt_layer_snapshots`

`id, metabot_id, dream_date, created_at, payload_json, status ('active'|'rolled_back'|'superseded'), rollback_reason, rolled_back_at`, `UNIQUE(metabot_id, dream_date)` (upsert). Payload: `{ version: 1, memories: [{id, text, fingerprint, status, archivedAt, usageClass}], promotedProcedureIds: [..] }` — every non-deleted dream-origin `user_memories` row EXCEPT `self_identity` (owner-frozen by design, never rolled back), plus the ids of the then-active procedures promoted from capability drafts. Capturing a new snapshot supersedes the bot's previous `active` one; at most 30 snapshots per bot (oldest superseded/rolled_back pruned first, never the active one).

### Capture point

`DreamService.writeDreamResults` calls `dreamStore.capturePromptLayerSnapshot(metabotId, date)` immediately before any of tonight's writes — i.e. before the day's memory batch replace and before that night's validation/promotion pass.

### Rollback evaluation (start of the next dream run, before synthesis)

Negative signals for the dreamed date (same mechanical sources the dream already collects): thumbs-down assistant messages + accepted group tasks rated ≤ 2 + implicit `reask` / `unanswered_burst` signals (`countNegativeSignalsForDay`; `repeat_order` never counts). Constants (top of `src/main/libs/promptLayerRollback.ts`):

- `ROLLBACK_NEGATIVE_FLOOR = 2` — absolute floor.
- `ROLLBACK_BASELINE_DAYS = 14` — trailing baseline window; only days with any activity count.
- `ROLLBACK_BASELINE_MIN_DAYS = 7` — below that, the cold-start rule applies.
- `ROLLBACK_COLD_START_MIN_NEGATIVE = 3` — cold-start absolute bar.

Rollback fires only when ALL hold: negative ≥ floor AND negative > trailing-14d daily median + 1 (cold start: negative ≥ 3, median ignored); an `active` snapshot exists for a strictly earlier dream date; that date was never rolled back (status `active` implies this — the mark is terminal). At most one date per run; repair runs never evaluate (their date is not yesterday's evidence).

### Rollback action (deterministic, no LLM)

1. `coworkStore.rollbackDreamMemoriesForDate(metabotId, dreamDate, snapshot.memories)`: tombstone the rolled-back date's dream batch (same semantics as `softDeleteDreamMemoriesForDate`, additionally requiring the provenance source row to be active so restored rows are not re-tombstoned), then restore every snapshotted row that still exists to its snapshotted text/fingerprint/status/archived_at — undoing both the tombstone and any cross-night dedup rewrite — and reactivate its source rows EXCEPT the rolled-back date's (that night's provenance stays disavowed). Rows physically purged meanwhile are counted as skipped, never resurrected.
2. Procedures that entered the active promoted set since the snapshot (the diff against `payload.promotedProcedureIds`, union the rolled-back date's drafts' procedures) are archived via the capability re-review's existing `archiveProcedureByTitle` path.
3. Capability drafts created on the rolled-back date (status draft/disputed/validated) are marked `rejected` with the rollback note, so tonight's validation/promotion skips them.
4. The snapshot is marked `rolled_back` with the reason; an audit line is logged; the run telemetry carries `promptLayerRollback = { evaluated, rolledBack, rolledBackDate, negativeSignals, baselineMedian, baselineDays, reason }`; and tonight's dream prompt gets the notice (Chinese, matching the surrounding dream-prompt sections): "YYYY-MM-DD 的提示层已因负反馈激增被自动回滚;蒸馏时请对那一天产出的教训保持警觉,不要直接沿用。"

`DREAM_VERSION` bumped 15 → 16 per the repo convention (new prompt input sections + write-semantics change), so in-window dates get one bounded version-repair re-dream.

## Non-goals

- No trained world model and no free-form expectation language — the expectation schema is a closed, machine-checkable set per action type.
- No forced predictions: the tool is guidance; the ledger only ever sees what the bot actually recorded.
- `self_identity` is never snapshotted and never rolled back.
- No multi-date rollback in one night, no rollback of predictions themselves (expired is the only automatic terminal besides the judged verdicts).
- Reception counting reuses the R3 interactions aggregation (bounded to 4×50 items per run); a busy month may undercount — that only softens the signal, never fails the dream.

## Tests

- `tests/predictionLedger.test.mjs` — schema idempotency, expectation validation (per-type metric sets, text length, deadline horizon), tool record/refuse path, per-action resolution (service/metatask/reception incl. subject fallback, pending-vs-expired edges, fetch-failure degradation), calibration digest shape, ledger pruning.
- `tests/promptLayerRollback.test.mjs` — snapshot capture/upsert/supersede/retention, trigger math (floor, baseline median, cold start), store-level rollback restore semantics (tombstone + restore + provenance disavow), terminal rolled_back mark, and a full two-night dream-flow test covering tombstone/restore/procedure archive/draft rejection/self-identity preservation/prompt notice/telemetry.
