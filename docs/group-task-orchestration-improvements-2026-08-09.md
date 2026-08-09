# Group Task Orchestration Improvements (2026-08-09)

> Branch: `feat/group-task-orchestration-improvements` (worktree `.worktrees/group-task-orchestration-improvements`)
> Base: `main` @ 7c59901 (v0.4.1)
> Scope: the 8 improvement items from `group-task-improvements-2026-08-09.md` (Group Task #8 retrospective)

All changes are committed on the feature branch only — **not merged, not pushed**. Merge
into `main` awaits owner confirmation (AGENTS.md discipline).

---

## Summary of items

| # | Priority | Item | Status |
|---|----------|------|--------|
| 1 | P0 | review → executing 补充执行通道 (Back to work) | ✅ implemented (UI button + service + review-silence hint) |
| 2 | P0 | worker ACK / `[WORKING]` status broadcast | ✅ implemented (host auto-ACK before skill turns + prompt protocol + status readout) |
| 3 | P1 | invite immediate wake-up (eager session + `sessionStatus`) | ✅ implemented (local + guest side); remote `created` state needs the invitee host (see below) |
| 4 | P1 | member work status query (idle/working/error) | ✅ implemented (RPC `member-status` + `show` + UI badges) |
| 5 | P1 | status transition log + visualization | ✅ implemented (new table + detail-view history) |
| 6 | P2 | dependency DAG hint (`[DEPENDS_ON]` gate) | ✅ implemented (host hold + prompt annotation) |
| 7 | P2 | SKILL.md ↔ send implementation alignment | ✅ doc aligned; API chair-default **deliberately not restored** (see below) |
| 8 | P2 | multi-chair session driving mutex | ✅ implemented (kv heartbeat claim + driver annotation); agent-level soft mutex documented in SKILL.md |

---

## Item 1 — review → executing reopen path (P0-1)

The state machine already allowed `review → executing` (rework hatch via
`[STATUS:EXECUTING]`); what was missing was an owner-visible execution channel and a
hint when the chair mis-dispatches in review.

- `groupTaskService.reopenGroupTask()` — `review → executing` with an `owner` actor,
  clears the owner-report kv guard (next review re-reports), syncs the canonical
  orchestration task to `running`.
- IPC `groupTask:reopen` (main.ts) + preload + renderer service + `electron.d.ts`.
- UI: 「返回修改/继续执行」(Back to work) button in the review state header (owner
  visible), plus a review-state banner explaining the review-phase silence and the
  reopen options.
- Daemon: when a chair dispatch to workers arrives while the task is in `review`, the
  daemon logs a **review-phase silence** hint (the dispatch is intentionally not
  answered) — no more guessing why nobody replied.
- Prompt protocol: chair playbook now warns "dispatching in review achieves nothing;
  finish all assignments before `[STATUS:REVIEW]`".

**Verification**: `groupTaskReopenAndStatus.test.mjs` — reopen flips status + records
the owner actor + clears the guard + syncs canonical; rejects non-review tasks;
`groupTaskDaemonProtocol.test.mjs` — review-phase dispatch logs the hint and replies
nothing.

## Item 2 — worker ACK / `[WORKING]` protocol (P0-2)

Fixes the Eleven case (11-minute total silence during a long skill task).

- **Host auto-ACK**: before a worker's SKILL turn (the long path), the daemon posts a
  `[WORKING] 已接单，正在做X，预计N分钟` line via a fast chat call (template fallback on
  failure), kv-guarded per (task, bot, message) so retries never double-ACK.
  `autoAckWorkerDispatch` dep (default ON) allows disabling.
- **Prompt protocol**: workers must start replies with a `[WORKING]` status line when
  the work is substantial and post `[WORKING]` progress lines across stages.
- **Status tracking**: the daemon parses `[WORKING]` tags; the store exposes
  `getMembersWorkingAt()` (last `[WORKING]` timestamp per member) which feeds the
  P1-4 readout.
- **Honest limitation**: mid-skill-turn stage progress (inside `runSkillTurn`) is not
  instrumentable with the current runner — a progress callback inside skill turns is a
  **host-cooperation item** if the requirement tightens beyond the auto-ACK + final
  deliverable.

**Verification**: `groupTaskDaemonProtocol.test.mjs` — ACK posted before the turn,
template fallback, kv dedupe on message reprocessing, disable flag; existing
`groupTaskDaemon.test.mjs` skill-path tests updated to the new ACK-first ordering
(the `[NO_REPLY]` skill-path test now expects the ACK posted and the reply suppressed).

## Item 3 — invite immediate wake-up (P1-3)

Root cause of the ~20-min wake delay: worker sessions were created lazily on the first
daemon reply.

- New shared helper `services/groupTaskSession.ts` — the ONE session-creation path:
  - `ensureGroupTaskSession` (mapping `metaweb_group_task` / `group-task:<taskId>`)
  - `ensureGroupTaskMemberReady` (session + injected context: goal, acceptance, roster,
    recent transcript)
  - `ensureOpenTeamGuestSession` / `injectOpenTeamGuestContext` (invitee side, binds to
    `openteam:<groupId>`)
- Eager pre-creation: `createGroupTask` (each member) and `joinGroupTaskMember` (invite)
  create the session + inject the context inside the join call — the session exists
  within seconds, not 20 minutes.
- Invite response carries `sessionStatus`: local `invite` → `created | ready | failed`;
  `invite_remote` → always `pending` (the guest session is created on the INVITEE's
  host — **host cooperation**: the invitee-side eager creation is implemented in
  `openTeamGuestService.handleOpenTeamInvite`, and the guest daemon logs its turns into
  that session when `getCoworkStore` is wired, which main.ts now does).
- The group-task daemon's per-turn session lookup delegates to the same helper, so
  eager and lazy paths always agree.

**Verification**: `groupTaskSession.test.mjs` (mapping reuse, context injection,
idempotence, guest variant) + `groupTaskReopenAndStatus.test.mjs`
(joinGroupTaskMemberWithSession reports created → ready).

## Item 4 — member work status query (P1-4)

- `getGroupTask` member summaries now carry `workStatus` (`working | error | idle |
  unknown`), `lastSpeakAt`, `lastWorkingAt`:
  - `working`: canonical attempt `running` OR a `[WORKING]` tag within 20 min
  - `error`: canonical attempt `failed` within 60 min
  - `idle`: has spoken at some point; `unknown`: never spoken, no attempt
- New bridge method `getWorkerAttemptStatus()` (latest attempt per worker).
- New RPC `POST /api/idbots/group-task/member-status` (lightweight query for the
  chair) + `show` returns the same fields.
- UI: member list shows working/error/idle badges.

**Verification**: `groupTaskReopenAndStatus.test.mjs` — pure derivation matrix,
[WORKING]-tag readout, running/failed attempt readout.

## Item 5 — status transition log + visualization (P1-5)

- New table `group_task_status_events` (task_id, from_status, to_status, actor_kind
  chair/owner/system, actor_globalmetaid, actor_name, created_at) + index — idempotent
  `CREATE TABLE IF NOT EXISTS` migration, existing DBs untouched.
- `GroupTaskStore.updateTaskStatus(id, next, { actor })` records one event per REAL
  transition; a recording failure never breaks the transition.
- Actors: chair (on-chain `[STATUS:]` tags, RPC close), owner (UI close / Back to
  work), system (default).
- `getGroupTask` returns `statusEvents` (newest first, cap 100); the detail view shows
  a collapsible status-history timeline (from → to · actor · time).

**Verification**: `groupTaskStatusEvents.test.mjs` — event recording + actor, ordering,
persistence across reopen, no events on no-op/illegal transitions, transition survives
event-record failure.

## Item 6 — dependency DAG hint (P2-6)

- Protocol: `[DEPENDS_ON: <pinid>]` tag on a dispatch message. The daemon holds the
  worker dispatch until the referenced deliverable is recorded on the task (bounded
  wait, default 15 min, `dependencyWaitMaxMs` overridable), then proceeds anyway with a
  timeout log. Free-text refs (no pinid) are advisory.
- Prompt protocol: chair playbook + planning directive instruct the chair to tag
  dependent subtasks and tell members to wait for the upstream `[DELIVERABLE]`.
- Honest scope note: the doc's "kickoff 自动附提示" is implemented as prompt-level
  annotation (the host cannot parse the chair's natural-language plan reliably);
  host-enforced ordering only applies when the chair uses the `[DEPENDS_ON]` tag.

**Verification**: `groupTaskDaemonProtocol.test.mjs` — dispatch held until the upstream
deliverable lands; bounded wait times out and proceeds.

## Item 7 — SKILL.md ↔ send alignment (P2-7)

- The doc claimed "omit `metabot_name` to speak as the chair (default = chair)"; the
  implementation requires an explicit identity since Round-4, when the silent chair
  default was removed **on purpose** — it was the root cause of the #7 misattribution
  (Lucy's promotion recorded under the chair because she omitted the sender).
- SKILL.md updated to the implemented behavior (explicit `metabot_name`/`metabot_id`
  required, with the reason documented). **The API-side chair default was deliberately
  NOT restored** — restoring it would re-introduce the silent-misattribution bug that
  the Round-4 fix exists for. Acceptance ("按文档调用不报错") is met by the doc
  alignment; the API change is marked as not-done-by-design.

## Item 8 — multi-chair session driving mutex (P2-8)

- Daemon: per-task kv heartbeat claim `group_task_driver:<taskId>` = `<instanceId>|<epochMs>`
  refreshed every tick. Another instance holding a claim younger than the grace window
  (default 20 s, `driverGraceMs` overridable) makes THIS instance yield the whole tick
  (no heartbeat, no planning, no message processing). Stale claims are taken over.
  Works across app instances because kv is SQLite-backed.
- Annotation: `getGroupTask` returns `driver { instanceId, atMs }`; the UI shows
  「驱动会话 <id> · <time>」; SKILL.md's new "Multi-session driving" section tells Twin
  sessions to check `show`'s driver before driving.
- Honest scope note: the mutex arbitrates **daemon instances**; two Twin SESSIONS in
  one app still both speak through the RPC `send` path. Full session-level exclusion
  would need `send` to acquire the same claim (host-cooperation item); the soft mutex
  (driver annotation + SKILL.md guidance) covers the documented "或标注" option.

**Verification**: `groupTaskDaemonProtocol.test.mjs` — second loop yields (one reply
total), stale-claim takeover, own-lease refresh.

---

## Files changed

### Main process
- `src/main/sqliteStore.ts` — `group_task_status_events` table + index (idempotent).
- `src/main/groupTaskStore.ts` — status-event recording + actor in `updateTaskStatus`,
  `listStatusEvents`, `getMembersWorkingAt`.
- `src/main/services/groupTaskSession.ts` — **new** shared session pre-creation +
  context injection helpers.
- `src/main/services/groupTaskDaemon.ts` — [WORKING] auto-ACK, review-silence hint,
  [DEPENDS_ON] gate, driver mutex, `[STATUS:]` chair actor, session helper delegation,
  exported kv prefixes.
- `src/main/services/groupTaskPrompts.ts` — worker [WORKING] protocol, chair
  dependency/review-phase rules.
- `src/main/services/groupTaskService.ts` — `reopenGroupTask`, `closeGroupTask` actor,
  workStatus/driver/statusEvents in `getGroupTask`, eager sessions, `joinGroupTaskMemberWithSession`,
  `getGroupTaskMemberStatus`, coworkStore getter.
- `src/main/services/groupTaskOrchestrationBridge.ts` — actor threading in
  accept/cancel, `getWorkerAttemptStatus`.
- `src/main/services/metaidRpcServer.ts` — invite `sessionStatus`, new
  `member-status` endpoint, RPC close chair actor.
- `src/main/services/openTeamService.ts` — `sessionStatus: 'pending'` in invite result.
- `src/main/services/openTeamGuestService.ts` — invitee-side eager session + context.
- `src/main/services/openTeamGuestDaemon.ts` — session logging of guest turns.
- `src/main/main.ts` — `groupTask:reopen` IPC, close actor, coworkStore getter wiring,
  guest deps wiring.

### Renderer
- `src/renderer/types/groupTask.ts` — workStatus/lastWorkingAt/statusEvents/driver types.
- `src/renderer/types/electron.d.ts` + `src/main/preload.ts` — `reopen`.
- `src/renderer/services/groupTaskService.ts` — `reopenTask`.
- `src/renderer/components/groupTasks/groupTaskUtils.js` — `canReopenGroupTask`,
  workStatus label key.
- `src/renderer/components/groupTasks/GroupTaskDetailView.tsx` — Back-to-work button,
  review banner, work-status badges, status-history timeline, driver line.
- `src/renderer/services/i18n.ts` — new labels (zh + en).

### Docs / skill
- `SKILLs/metabot-group-task/SKILL.md` — send identity, `member_status`,
  sessionStatus, [WORKING]/[DEPENDS_ON]/review-phase protocol, multi-session note.
- `docs/group-task-orchestration-improvements-2026-08-09.md` — this document.

### Tests (all green: 190 tests across the group-task + OpenTeam suites)
- `tests/groupTaskStatusEvents.test.mjs` (new, 5 tests)
- `tests/groupTaskSession.test.mjs` (new, 3 tests)
- `tests/groupTaskReopenAndStatus.test.mjs` (new, 8 tests)
- `tests/groupTaskDaemonProtocol.test.mjs` (new, 7 tests)
- `tests/groupTaskDaemon.test.mjs` (2 skill-path tests updated for the ACK ordering)

## Verification evidence

- `npm run compile:electron` — clean.
- `npx tsc -p tsconfig.json --noEmit` — clean.
- `node --test tests/groupTask*.test.mjs tests/openTeam*.test.mjs` — **190/190 pass**.
- Test run summary (full suite): `ℹ tests 190 / pass 190 / fail 0`.

## Host-cooperation / not-implemented-by-design

1. Remote invite `created` sessionStatus + invitee-side eager session require the
   invitee host to run this build (implemented on both sides; the inviter can only
   report `pending`).
2. Mid-skill-turn stage progress callbacks inside `runSkillTurn` (only the auto-ACK +
   final deliverable are host-guaranteed today).
3. `send` chair-default restore — deliberately not done (Round-4 misattribution fix).
4. Twin-session-level driving exclusion on the RPC `send` path (daemon-level mutex +
   driver annotation implemented; see item 8).
