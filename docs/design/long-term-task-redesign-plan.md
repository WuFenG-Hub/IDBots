# Long-Term Task Redesign — Development Plan

Status: aligned with owner (2026-09-22), ready for implementation.
Branch/worktree: `feat/tracking-tasks` @ `.worktrees/tracking-tasks`.
UI reference: `docs/design/long-term-task-board-prototype.html` (frozen per owner).
Related commit on this branch: `04bd6c48` (RSI ladder star card removed).

## 1. Why the current implementation is being replaced

The shipped "长期任务" tab projects the entire delegation ledger
(`orchestration_tasks`) into a kanban: every group task, twin delegation and
attached scheduled task becomes a card. The owner never asked for a delegation
acceptance queue — the ask is a **first-class long-term task entity**: a
persistent, cross-session task decomposition ("a todo list that survives the
session") that the TwinBot proactively drives over days or weeks, with the
owner deciding at every blocking point.

The old model fails this in four ways:

- Group tasks / one-shot delegations flood the board (they are short tasks).
- Admission rules (ADM-1..5, wide/strict, archive override) patch over "everything
  gets in" instead of asking "was this explicitly created as a long-term task".
- ADM-1's explicit-registration write path (`registerLongTask`) has no caller —
  there is no first-class creation flow at all.
- Nothing carries the task forward: the board is a passive verdict view, and the
  heartbeat only records liveness.

Owner ruling (2026-09-22): discard the current implementation where it conflicts;
do not force reuse. Data is kept, display is dropped; the feature never shipped,
so no migration story is needed.

## 2. Definition and boundaries

**A long-term task is a persistent decomposition of a fuzzy, multi-week goal into
ordered sub-projects, each with explicit acceptance criteria, continuously and
proactively driven by the TwinBot, with the owner deciding at blocking points.**

Task routing quadrants (the creation skill enforces this routing):

|               | Short (a few turns)  | Long (multi-session, blocking points) |
| ------------- | -------------------- | ------------------------------------- |
| Single owner  | cowork session       | **long-term task (this feature)**     |
| Multi party   | group task           | MetaTask (out of scope, on-chain multi-bot collaboration) |

Corollaries:

- A task that can run to completion automatically is a *short* task — route it
  to cowork/group task, never onto this board.
- Group tasks, scheduled tasks and one-shot twin delegations never appear on
  the long-term board. They may be *referenced* by a sub-project as its
  execution channel (linked, not mixed in).
- MetaTask stays out of scope; the creation skill only needs the routing rule
  "on-chain multi-bot collaborative decomposition → MetaTask tools, not this".

## 3. UX (locked to the prototype)

### 3.1 Board (home)

- Status-column kanban, one page, horizontal scroll. Columns left→right:
  **Waiting (owner decision) · In progress · Waiting external · Defining ·
  Paused · Done**. Column order is attention-first; trivially reorderable.
- Card content: title, sub-task progress bar with `accepted x / total n`,
  current sub-project line, next-action line, updated/created timestamps.
  "Defining" cards render dashed and show the grilling round state.
- Header keeps the existing L1 tabs (长期任务 | 定时任务); "新建长期任务" opens a
  **creation session** (chat), not a form.

### 3.2 Detail page

- Header: back, title, status chip, **per-task "delegate acceptance to TwinBot"
  toggle**, pause.
- Goal block + overall progress bar.
- Left: ordered sub-project checklist (status icon, dependency tag, evidence and
  session counts; accepted rows struck through; the current row highlighted).
- Right (selected sub-project): acceptance criteria bullets, TwinBot's current
  proposal, evidence list (local dir / metaapp:// / pin:// / URL), bound
  sessions, actions (open session, edit definition/criteria, propose acceptance).
- Bottom: event stream (creation, replans, begins, proposals, acceptances,
  blocks, nudges).

### 3.3 Interaction ruling (owner, 2026-09-22)

**Decisions are taken in prose, in chat — not via UI option panels.** Textual
answers are more precise and capture more information. UI buttons on the
card/detail may only deep-link into the bound session with a prefilled draft;
they never write a decision themselves. The prototype's option buttons are
illustrative of "TwinBot presented 3 options"; in the app those options live in
the conversation.

## 4. Data model (new first-class tables)

Migration: one additive, idempotent `migrateLongTermTaskTables()` in
`sqliteStore.ts` (same PRAGMA-guarded pattern as the existing `migrate*`
methods). No change to existing tables.

```sql
CREATE TABLE IF NOT EXISTS long_term_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  -- lifecycle flags stored; the kanban column is DERIVED (see below)
  stage TEXT NOT NULL DEFAULT 'defining'
    CHECK (stage IN ('defining','active','paused','done','cancelled')),
  acceptance_delegate INTEGER NOT NULL DEFAULT 0,  -- owner may delegate sign-off to TwinBot
  current_subtask_id TEXT,
  definition_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS long_term_subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES long_term_tasks(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','waiting_owner','waiting_external',
                      'accepted','rejected','skipped')),
  depends_on TEXT NOT NULL DEFAULT '[]',           -- JSON subtask-id[]
  preferred_channel TEXT,                          -- delegate_bot|group_task|owner_external|owner_together|NULL
  evidence TEXT NOT NULL DEFAULT '[]',             -- JSON [{kind,uri,note}]
  session_id TEXT,                                 -- bound longterm cowork session
  wait_note TEXT NOT NULL DEFAULT '',              -- what we are waiting for (owner/external)
  wait_until TEXT,                                 -- optional time-based re-check
  notes TEXT NOT NULL DEFAULT '',
  accepted_by TEXT,                                -- owner|twin
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS long_term_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  kind TEXT NOT NULL,   -- created|replanned|began|proposed|accepted|rejected|
                        -- blocked|unblocked|nudged|paused|resumed|completed|note
  actor TEXT NOT NULL,  -- owner|twin|system
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
```

Derivation rules (pure, read-time, matching the repo's "store facts, derive at
read" convention):

- Column of an `active` task: `waiting_owner` if the current sub-task is
  `waiting_owner`; `waiting_external` likewise; otherwise `in_progress`.
- `defining`/`paused`/`done`/`cancelled` come straight from `stage`.
- Progress = accepted sub-tasks / non-skipped sub-tasks.
- `current_subtask_id` = lowest-ordinal sub-task that is not
  accepted/skipped and whose `depends_on` are all accepted.

The event journal is the memory backbone: it is what lets the TwinBot resume
correctly after days or an app restart (§7).

## 5. TwinBot tools (agent tools, twin sessions only)

New `src/main/libs/longTermTaskAgentTools.ts`, wired like
`trackedTaskClosureAgentTools.ts` (deps injected in `main.ts`, registered in
`coworkRunner`, gated to twin sessions). All writes journal an event.

| Tool | Purpose |
| --- | --- |
| `longterm_task_create` | Create in `defining` with draft sub-projects (after grilling; not yet active). |
| `longterm_task_activate` | Owner confirmed in chat → `active`, ordering computed, first sub-task offered. |
| `longterm_task_list` / `longterm_task_get` | Board read / **state brief**: goal, current sub-task + its acceptance criteria, last N events, blocking reason, suggested next action. This is the "never forget after restart" read path. |
| `longterm_task_update` | title/goal/acceptanceDelegate/pause/resume/cancel. |
| `longterm_subtask_add` / `longterm_subtask_update` | Edit title/description/acceptance criteria/dependencies/preferred channel/notes/order (owner may redefine any time → `replanned` event). |
| `longterm_subtask_begin` | Pick execution channel, create/bind the `longterm` session. |
| `longterm_subtask_propose` | Present evidence + summary → `waiting_owner` (acceptance request). |
| `longterm_subtask_accept` / `longterm_subtask_reject` | Accept writes `accepted_by`; TwinBot may call accept **only** when the task's `acceptance_delegate = 1`, otherwise it is owner-only. Reject carries feedback and returns the sub-task to `in_progress`. |
| `longterm_event_note` | Free-form journal annotation (context capture). |

## 6. Skills

Two shipped skills under `SKILLs/`, registered in `SKILLs/skills.config.json`,
following the existing convention (e.g. `metabot-group-task`).

### 6.1 `long-term-task` (creation)

The watershed skill. Contents:

- **Background**: users state fuzzy goals; misalignment here wastes weeks (the
  old board is the cautionary tale — built from a one-line ask without
  alignment). Methodology follows the grilling skill
  (github.com/mattpocock/skills `productivity/grilling`): a design tree worked
  in frontier rounds, every question with a recommended answer.
- **Routing first**: decide cowork / group task / long-term task / MetaTask
  before anything is created (quadrant table above).
- **Facts are the bot's job**: research the codebase / chain / existing projects
  itself; only *decisions* go to the user.
- **Alignment media**: use HTML prototypes, sketches, tables when they make the
  boundary clearer — then confirm in prose.
- **Text Q&A only**: ask in prose; the owner answers in text. No option-panel
  decision capture.
- **Output contract**: a proposal of sub-projects, each with title, description,
  acceptance criteria, dependencies, suggested order and preferred execution
  channel — presented for owner sign-off before `longterm_task_activate`.
- A `defining` draft persists across restarts; the skill resumes an open draft
  instead of starting over.

### 6.2 `longterm-task-exec` (advancement)

- Discipline per heartbeat/session: read the state brief → decide {advance,
  ask owner, wait} → act via tools → journal everything.
- How to run a sub-project session: present options *in prose* with a
  recommendation; capture the owner's textual decision; execute via the chosen
  channel (delegate / group task / owner-external / together); collect evidence;
  check against acceptance criteria; propose acceptance.
- Correction loop: rejection feedback re-shapes the sub-task, not just retries.
- When *not* to nudge: no state change since last check → stay silent (the only
  throttle; there is no daily cap — driving completion outranks quiet).

## 7. Heartbeat service (decoupled, settled this round)

Today the de-facto heartbeat is the group-task daemon's 5 s guarded tick
(`groupTaskDaemon.ts` `DEFAULT_INTERVAL_MS = 5_000`, inactivity watchdog +
epoch guard at ~line 11662), with concerns piggybacking under their own
throttles (the tracked sweep rides it at 1 h, `main.ts:3753`).

New `src/main/services/heartbeatService.ts`:

- Owns the master tick (5 s), reusing the guarded-tick pattern (inactivity
  watchdog + epoch guard) — but as a **first-class dispatcher**, not a daemon
  sidecar.
- `registerHandler({ name, intervalMs, run })`; each tick runs due handlers;
  a throwing handler is logged and skipped, never bricks the loop.
- First handler: `longterm.advance` (default 5 min): cheap **local** checks only —
  current sub-task state, `wait_until` expiry, new evidence on linked artifacts,
  dependency resolution. Only when actionable does it escalate: open/continue the
  bound `longterm` session with a TwinBot turn (message to the owner).
- The tracked-board sweep migrates off the daemon piggyback into a heartbeat
  handler. The group-task daemon's own loop is untouched this round (folding it
  in as a handler is a later refactor).

## 8. Session binding

- `cowork_sessions` gains nullable `long_term_task_id` / `long_term_subtask_id`
  columns (additive migration) and `sessionType` accepts `'longterm'`.
- A `longterm` session is a normal cowork session with binding + the two skills
  active; it appears in the session list with an origin chip (replacing the
  current ledger-derived `TrackedTaskOriginChip` lookup in P2).

## 9. UI implementation mapping (prototype → components)

- `ScheduledTasksView.tsx`: L1 tabs unchanged; the `longTerm` tab renders the new
  `LongTermTasksBoard` instead of `TrackedTasksSection`.
- New `src/renderer/components/longTermTasks/`:
  `LongTermTasksBoard.tsx` (columns), `LongTermTaskCard.tsx`,
  `LongTermTaskDetail.tsx` (goal + checklist + selected sub-project + events),
  `subtaskStatusChip.tsx`. Tokens per prototype (`claude`/semantic palette).
- Renderer service `services/longTermTask.ts` + slice `longTermTaskSlice.ts`
  (mirror of the trackedTask service/slice shape: IPC → Redux, zero derivation).
- IPC: `longtermTask:list|get|update|subtaskUpdate|accept|reject|pause...` +
  `longtermTask:update` push event (same seq-dedup pattern as `trackedTask:update`).
- i18n: English source of truth, zh translations, keys under `longTermTask.*`.

## 10. Retirement of the old board

- P0: `TrackedTasksSection` unmounted from the tab; `trackedTask:*` IPC and the
  `TrackedTaskBoardService` stay in tree (the `trackedTask:cardsForSession`
  origin chip in `CoworkSessionDetail` still reads it).
- P2: re-source the origin chip from `long_term_subtasks.session_id`, then
  physically remove the trackedTask board stack (components, IPC, ADM kv keys,
  `trackedTaskClosureAgentTools`) once nothing references it. Ledger tables and
  kv rows are left unread, never deleted.

## 11. Phasing

**P0 — first-class entity, manually driven (usable without heartbeat)**
1. `migrateLongTermTaskTables()` + `src/main/longTermTaskStore.ts` (CRUD,
   derivation, events) + unit tests.
2. `longTermTaskAgentTools.ts` + twin-session gating + tests.
3. `SKILLs/long-term-task/SKILL.md` (+ skills.config.json entry).
4. Board + detail UI per prototype; `新建长期任务` opens a creation session.
5. `TrackedTasksSection` unmounted; `cowork_sessions` binding columns.
Verify: `pnpm run build`, `compile:electron`, new store/tool tests, existing
`test:tracked-task` still green (IPC untouched in P0).

**P1 — proactive TwinBot (heartbeat + acceptance loop)**
1. `heartbeatService.ts` + handler registry + `longterm.advance` + tests
   (fake clock, due/throttle, watchdog reset).
2. `longterm` session type + nudge→session flow + `SKILLs/long-term-task-exec/`.
3. Evidence/propose/accept flow incl. the acceptance-delegate switch.
Verify: advance-handler unit tests; scripted end-to-end (create → activate →
begin → propose → accept) against a fixture DB.

**P2 — polish & cleanup**
1. Dependency re-planning UX, origin chip re-sourcing, old trackedTask stack
   removal.
2. Heartbeat handler for the legacy sweep; evaluate folding the daemon loop in.
3. MetaTask routing copy in the creation skill.

## 12. Risks / watch items

- **Grilling quality is the make-or-break** (owner): the creation skill's
  prompt engineering gets real iteration; keep the skill self-contained so it
  can evolve without app releases.
- Nudge cost: local checks are free, LLM escalation only on actionable change;
  watch token spend in dogfooding.
- Session proliferation: one `longterm` session per sub-task, reused across
  nudges (never a new session per heartbeat).
