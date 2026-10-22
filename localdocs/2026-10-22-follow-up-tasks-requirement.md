# Follow-Up Tasks (待跟进任务) — Requirement & Design Alignment

Date: 2026-10-22 (aligned with user same day)
Branch: `feat/follow-up-tasks` (worktree `.worktrees/follow-up-tasks`)
Status: **implemented (v1)** — main process `a12cc5ee`, renderer `e3573226`

## 1. Background and goal

IDBots aims to be a personal-agent platform for ordinary users, not just developers. Today the sidebar already folds machine-created sessions into a collapsed **「自主任务」(Autonomous Tasks)** group, which removed a lot of sidebar noise. In practice this is not enough: sessions that genuinely need a human decision (approval, verdict, reply) also get folded away, so users either miss the decision window or never learn a decision was needed.

Target mental model for the local tab:

- **Main session list** — only sessions the human initiated (unchanged from today).
- **自主任务 (Autonomous Tasks)** — bot-created sessions that need no human follow-up (Twin Bot ↔ Worker Bot handoffs, clean scheduled reports, heartbeat progress). Folded; humans open it only for post-hoc review.
- **待跟进任务 (Follow-Up Tasks)** — bot-created sessions that currently need a human decision or reply. A new group **parallel** to Autonomous Tasks. Everything landing here is expected to be reviewed by the human, one by one.

A session's bucket is **not fixed at creation** — it moves between Autonomous and Follow-Up as the session progresses, re-judged at every turn end.

## 2. Current mechanism (as explored)

- Classification is a **creation-time marker**: `cowork_sessions.auto_origin` ∈ `'longterm' | 'orchestration' | 'schedule' | NULL`, stamped right after `createSession` by exactly three flows:
  - long-term heartbeat sessions — `src/main/services/longTermAdvanceService.ts:938-948`
  - scheduled/cron runs — `src/main/libs/scheduler.ts:450-459`
  - twin/worker orchestration — `src/main/services/orchestratorCoworkBridge.ts:254-263`
- Renderer fold policy: `src/renderer/utils/sessionAutoGrouping.ts` (`FOLDED_AUTO_ORIGINS`, `shouldFoldIntoAutonomousTasks`, `splitSessionsByAutonomousFold`); manual `fold_override` (`'in' | 'out'`) always wins; a live `decisionSessionIds` set (long-term board cards in `waiting_owner`) forces rows out of the fold onto the main timeline.
- Sidebar: `src/renderer/components/Sidebar.tsx:223-236` splits; `CoworkSessionList.renderAutoTasksSection` (`:475-506`) renders the fold; folded unreads surface only on the fold header.
- Structured "needs human" signals that already exist:
  - long-term subtasks `waiting_owner` / `waiting_external` + decision briefs (`src/main/longTermTaskStore.ts`, agent tool `waitSubtask`)
  - group-task `[CHECKPOINT]` HITL state machine (`group_task_checkpoints`, `groupTaskDaemon.ts`)
  - mid-task `AskUserQuestion` — **in-memory only**, not persisted on the session row, not shown on sidebar rows
- **Gaps**: no session-level "awaiting human" state; a scheduled run ending with warnings looks identical to one ending clean; no runtime reclassification anywhere.
- Cerebellum (小脑): pure modules under `src/main/cerebellum/`, HTTP `POST /v1/systemone` JEV decisions (`noul` / `choice` / `score`), never throws, `null` = fail-open, ~1.5 s hard timeout, fractions of a cent per call; add-a-decision recipe in `docs/design/2026-10-13-cerebellum-system-handoff.md` §3.5.

## 3. Design (v1, aligned)

### 3.1 Data model

Add to `cowork_sessions` (idempotent migration, following the `fold_override` pattern at `src/main/sqliteStore.ts:2355-2363`):

- `follow_up_state` — `NULL | 'pending'`
- `follow_up_source` — `NULL | 'cerebellum' | 'ask_user' | 'manual'` (`waiting_owner` is live-derived in the renderer, not persisted)
- `follow_up_at` — timestamp

Placement rule (renderer, pure function extending `sessionAutoGrouping.ts`):

1. `fold_override` (manual) still wins (`'in'` → Autonomous fold, `'out'` → main list).
2. `follow_up_state = 'pending'` **or** session ∈ live `decisionSessionIds` → **Follow-Up** section.
3. `auto_origin` set → **Autonomous** fold.
4. otherwise → main list.

Manual context-menu moves become three-way: 移入待跟进 / 移出待跟进 / 移入或移出自主任务. 移入待跟进 = set pending with source `manual`; 移出待跟进 = clear pending (falls back to the fold).

### 3.2 How a session enters Follow-Up

Two lanes, deterministic first, cerebellum second; only sessions with `auto_origin` set are eligible (v1 scope):

1. **Structured signals (no cerebellum, exact)** — pending while the signal is active, cleared on resolution:
   - long-term subtask in `waiting_owner` → its bound session lands in Follow-Up (today this force-lifts the row to the *main* list via `decisionSessionIds`; it lands in Follow-Up instead)
   - an `AskUserQuestion` pending on an auto-origin session → persist `pending` / `ask_user` on the session row (survives restart); cleared when the ask resolves
2. **Cerebellum turn-end classifier** — new module `src/main/cerebellum/sessionFollowUpGate.ts`:
   - fires on every turn completion for sessions with `auto_origin` set
   - input: session title + truncated last assistant message (+ task name for scheduled runs), kept in the original language; English `noul` question `needs_human_followup` ("the turn ends asking the human to decide / approve / reply" vs "final report or bot-to-bot handoff, no human action needed")
   - verdict true → `pending` / `cerebellum`; verdict false → clear only when current source is `cerebellum` (manual and structured sources are never cleared by the classifier); `null` (disabled/timeout/quota) → no change (fail-open)
   - standalone solo call (like `groupReplyGate`), not part of `turnDecisionBundle`; wiring factory in `main.ts` per the handoff recipe; log verdict + latency only

### 3.3 How a session leaves Follow-Up

- The structured signal resolves (owner verdict lands, ask answered) → cleared automatically.
- The human sends a reply in that session → `cerebellum`-sourced pending clears at the next turn start; the session keeps working and is **re-judged at the next turn end** (it may re-enter Follow-Up or settle back into Autonomous depending on the new outcome).
- Manual "移出待跟进" → cleared; session returns to the Autonomous fold. Manual pendings are sticky: the classifier never clears them.

### 3.4 UI

- New **待跟进任务** section in the local tab, rendered above the Autonomous fold, **collapsed by default** (user decision; revisit after usage), with its own localStorage expand key; count badge on the section header; rows visible when expanded; unread dots behave normally inside it.
- Follow-Up rows **count toward the local-tab badge** (the fold is deliberately excluded from `tabStats`; Follow-Up is not), and a session that is follow-up pending lights the unread dot **even for heartbeat-origin turns** (which normally never mark unread).
- i18n: zh 「待跟进任务」, en "Follow-Up Tasks", keys next to `i18n.ts:1215-1217`.

### 3.5 Migration & backfill

- Schema migration is additive and idempotent.
- **No mass reclassification of existing sessions** — classification happens lazily on new turns; existing `waiting_owner` sessions are covered immediately by the deterministic signal.

### 3.6 Out of scope (v1)

- Consolidating the N-sessions-per-scheduled-task / heartbeat-session-rotation problem (acknowledged, later).
- OS/IM push notifications when an item enters Follow-Up (candidate v2).
- Reclassifying human-initiated sessions; group-task/A2A/IM sessions keep their current homes (group tasks already have their own CHECKPOINT mechanism).

## 4. Aligned decisions (user, 2026-10-22)

1. Follow-Up section is **collapsed by default** (like Autonomous); revisit default-expanded later.
2. Exit rule: reply auto-clears + manual move-out; in-progress sessions are re-judged by the cerebellum at every turn end, so a session can leave and re-enter Follow-Up dynamically.
3. Scope: v1 covers only the three `auto_origin` flows in the local tab; group-task/A2A/IM sessions unchanged.
4. Cerebellum question shape: single `noul` (needs human follow-up, threshold).
5. Follow-Up pending items light the unread badge, including heartbeat-origin turns.

## 5. Verification plan

- Unit: placement/split pure functions; cerebellum request/parse module (mirroring `tests/cerebellum*.test.mjs` — remember the `tests/` gitignore allowlist gotcha); migration idempotency.
- Manual: scheduled run ending clean → stays folded; scheduled run ending with warnings/questions → appears in Follow-Up; reply → returns to fold, next turn end re-judges; `waiting_owner` card → row in Follow-Up, verdict → back to fold.
