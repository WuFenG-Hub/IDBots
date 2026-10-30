# Design Note — Daily Report Pending-Follow-Up False Positives

Branch: `fix/daily-report-pending-criteria` (off `origin/main` = `be53ed2f`)
Date: 2026-10-28. Owner ruling 2026-10-28 09:41: fix the reporting criteria so
finished/stopped work stops appearing as "N天待处理 · 已逾期" (pending N days · overdue).

## 1. Verified facts (what renders the owner's list, with evidence)

**Section.** The owner-facing "需要你处理 / Needs you" list is rendered from
`facts.pendingFollowUps` by:

- Markdown: `buildDailyReportFollowUpListMarkdown` —
  `src/main/services/dailyReportGenerator.ts:309-323`. Renders
  `- [title](deeplink) · bot · {ageDays}天待处理 · **已逾期**`.
- HTML: `buildNeedsHtml` — `src/main/services/dailyReportGenerator.ts:638-650`.
- zh strings `waitingDaysSuffix: '天待处理'` / `overdueBadge: '已逾期'` —
  `dailyReportGenerator.ts:201-202` (en: `'d waiting'` / `'overdue'`, lines 139-140).

**Collection.** `collectDailyReportFacts` — `src/main/services/dailyReportCollector.ts:697-706`
queries `cowork_sessions WHERE follow_up_state='pending' AND hidden_from_session_list=0
AND archived_at IS NULL`, ordered by `follow_up_at ASC`. `shapePendingFollowUpRows`
(collector lines 338-355) slices to `DAILY_REPORT_MAX_PENDING_FOLLOW_UPS = 10` (line 45)
and stamps `overdue = ageDays >= DAILY_REPORT_FOLLOW_UP_OVERDUE_DAYS` where the
threshold is **2**, not 3 (line 53).

**Real-DB confirmation (read-only, prod `idbots.sqlite`).**

- This morning's run (`daily_report_runs` id=5, 2026-10-28, completed/scheduled)
  stores `counts.pendingFollowUps: 10` — the cap, i.e. the list was full of items.
- Running the collector's query verbatim right now returns 18 pending sessions:
  4 `auto_origin='orchestration'`, 4 `'longterm'`, 10 `'schedule'`; all
  `follow_up_source='cerebellum'`.
- The owner's named example "定时 登记册 v2：定向征集 + 自带实例" is session
  `5a27042d…`, whose scheduled task row (`cddaa9a9…`) has `enabled=0`,
  `last_status='success'` — verifiably done and stopped, still listed.

**Root cause.** `follow_up_state='pending'` is set at turn end by the cerebellum
classifier (`coworkRunner.ts:3845-3865`) and cleared only by the next user turn or
a later cerebellum verdict on the SAME session. When the underlying work finishes
without another turn (scheduled task disabled/deleted, orchestration closed,
sub-project accepted), nothing ever clears the marker, and the collector reports
it forever with no lifecycle cross-check.

## 2. Linkages chosen (the ones that actually exist in the schema)

| Lane | Linkage (verified in prod DB) | Exclusion semantics |
|---|---|---|
| Scheduled task | `scheduled_tasks.cowork_session_id` (live; `target_session_id` kept as secondary) | Exclude when the session has ≥1 linked task row and **every** linked task is stopped: `enabled=0` OR `expires_at <= date('now')`. Any enabled, unexpired task ⇒ keep (live automation still targets the session). |
| Scheduled orphan | no `scheduled_tasks` row references the session, `auto_origin='schedule'` | Exclude when the **latest** `scheduled_task_runs` row for the session has `status='success'` (one-shot task fired, succeeded, row later deleted — scheduler.ts:463-466 self-disables 'at' tasks, so deleted-with-success is the same "done" state). Latest run failed/error ⇒ keep. |
| Orchestration | `orchestration_attempts.worker_session_id → orchestration_steps.task_id → orchestration_tasks.status` | Exclude when the linked task status ∈ {`completed`,`cancelled`,`failed`} (schema CHECK, orchestrationStore.ts:298). Verified: one worker session maps to exactly one orchestration task in prod (no all-vs-any ambiguity; checked, 0 multi-task sessions). |
| Long-term subtask | `long_term_subtasks.session_id` (primary seat) **and** `session_history_json` (history, JSON array parsed in TS) | **Primary seat** subtask done (`accepted`/`skipped`/`rejected`, or parent task `stage IN ('done','cancelled')` or `done_at` set) ⇒ exclude. **History-only** sessions: exclude only when EVERY linked subtask is done/parent-done; if any linked live subtask is `waiting_external` (or has `wait_until`) ⇒ keep but mark `waitingOnExternal` (waiting badge, never overdue). Precedence: done-beats-waiting (prod case: session `688c44f7…` is #3's primary seat (accepted) AND in #5's history (waiting_external) → excluded, because its own sub-project is verifiably closed). |

Ordering: exclusions are applied to the RAW rows **before** the 10-item cap slice
(otherwise surviving legitimate items lose slots to zombies ahead of them in
`follow_up_at ASC` order).

Fail-soft: every new query runs inside `safeCollect` — a broken lane degrades to
"no exclusions from that lane", never sinks the report (matches collector
philosophy, header comment lines 1-24).

`follow_up_source='manual'` rows are NEVER lifecycle-excluded: the owner
deliberately pinned them (coworkStore.ts:4135-4138 documents manual stickiness);
an explicit pin outranks task lifecycle. (All 18 current prod rows are
`'cerebellum'`; no behavior change today.)

## 3. Overdue vs waiting (goal 2)

A clean signal IS derivable for the long-term lane: `long_term_subtasks.status =
'waiting_external'` and/or `wait_until IS NOT NULL` (prod: subtask #5
`waiting_external`, `wait_until 2026-10-29T21:30:00+08:00`). So:

- New fact field `waitingOnExternal: boolean` on `DailyReportPendingFollowUp`.
- Generator: waiting items keep the `N天待处理` age suffix, drop the `已逾期`
  overdue badge, and gain a `等待外部` / `waiting on external` badge (new string
  pair `waitingBadge`, added to the interface + EN + ZH tables in sync).
- No fallback "no assistant activity in window" heuristic is needed and none is
  invented.

## 4. What is NOT derivable today / deliberately not covered

1. **Orchestration source/report lanes.** `orchestration_tasks.source_session_id`
   and `longterm_report_session_id` also reference sessions, but one source
   session can spawn MANY orchestrations, so "any closed task ⇒ exclude" would
   wrongly exclude a session whose sibling orchestration still runs. Verified
   zero current false positives arrive via these lanes (the one session that
   matches, `688c44f7…`, is already excluded via the long-term lane). Not
   covered; revisit only if it ever produces noise.
2. **Orphan schedule sessions whose latest run failed.** Task row deleted +
   last run `error` ⇒ kept as pending (a genuinely failed one-shot may deserve
   attention). Cannot distinguish "stale failed one-shot" from "failure the
   owner never saw" — no schema signal exists.
3. **No waiting concept for schedule/orchestration lanes.** `waiting_external`
   exists only on long-term subtasks; scheduled tasks and orchestrations have no
   external-wait state, so no waiting badge is attempted for them.
4. **Expired-but-enabled tasks** (`expires_at` in the past, `enabled=1`):
   scheduler.ts:370-373 skips them at fire time but never disables them. Treated
   as stopped in the scheduled lane (`expires_at <= date('now')`), since they can
   never fire again.
5. **Zombie markers themselves are not cleaned.** This change only fixes the
   REPORT's criteria. The stale `follow_up_state='pending'` rows stay in the DB
   (the sidebar Follow-Up list still shows them); a bot-side cleanup/lifecycle
   auto-linkage is separate future work per the owner's ruling.

## 5. Implementation plan (minimal, collector/generator only)

- `dailyReportCollector.ts`:
  - New exported helper `collectPendingFollowUpLifecycle` (or split shapers)
    that takes the raw pending rows + db and returns
    `{ excluded: Set<string>, waitingExternal: Set<string> }`, using four
    chunked queries (IN-lists chunked at 400 params; long-term lane is a full
    table scan of `long_term_subtasks` — 18 rows in prod, parsed in TS).
  - `DailyReportPendingFollowUp` gains `waitingOnExternal: boolean`.
  - `shapePendingFollowUpRows` gains an optional
    `waitingExternalSessionIds` param; overdue stays as-is for non-waiting.
  - The main collect path filters raw rows before the cap slice.
- `dailyReportGenerator.ts`: `waitingBadge` string (en+zh); markdown + HTML
  render waiting badge and suppress overdue for waiting items.
- Tests (`tests/dailyReportCollector.test.mjs`, `tests/dailyReportGenerator.test.mjs`):
  extend the existing fake-db dispatch with empty-row branches for the four new
  lanes (existing assertions unchanged), add regression cases for each lane
  (disabled task, orphan-success, closed orchestration, accepted subtask,
  waiting_external, manual-pin immunity, exclusion-before-cap).
- No schema changes, no new dependencies, no service-layer changes.

## 6. Expected effect on tomorrow's report (simulated against prod, read-only)

18 pending today → 15 excluded (3 disabled-task sessions incl. the owner's named
"登记册 v2" example, 6 orphan-success one-shots, 4 closed orchestrations, 2
accepted sub-project seats) → 3 kept: 1 live-cron session ("Agentpedia 编辑注册")
+ 2 waiting-external sessions (#5 history), the latter shown as 等待外部, not 已逾期.
