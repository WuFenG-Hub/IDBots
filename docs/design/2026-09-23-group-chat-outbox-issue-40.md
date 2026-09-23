# IDBots Issue #40: Fix Plan and Implementation Record

- Repository worktree: `/Users/wufeng/idbots/project/bots/2/2026-09-22/idbots-bugfix/IDBots/.worktrees/group-broadcast-durability`
- Branch: `fix/group-broadcast-durability` (baseline `37ee6e6`, byte-identical with local main)
- Date: 2026-09-23
- Status: **implementation complete + verified locally; second-round review rework (N1 / N4) completed and verified by actual runs**; changes are not committed, not pushed, no PR opened, nothing published publicly.
- One-liner: all three root causes were addressed at the minimal viable scope, and the same case set went "5 fail before / 5 pass after"; N1 (two bots in the same group on the same trigger message — the second bot's reply silently swallowed) and N4 (the new test file ignored by .gitignore) found in the second review round have been fixed, with before/after runs in §7.

---

## 0. Conclusion summary (read this first)

### Verified (reproducible locally)

| Item | Result |
|---|---|
| Before-fix reproduction (baseline 37ee6e6, first round, 5 cases) | `tests/groupChatOutboxDurability.test.mjs`: tests 5 / pass 0 / **fail 5** |
| After-fix verification (this worktree, incl. rework) | Same command: tests **7 / pass 7 / fail 0** (original 5 + 2 new cross-bot cases from the rework) |
| Regression | `npm run test:group-tasks`: tests **544 / pass 544 / fail 0** (including the 7 new cases) |
| Adjacent tests | `cognitiveGroupChatPrompt / sleepGuard / llmSafeText / sqliteRecoveryLifecycle`: 50 pass / 0 fail |
| Existing orchestrator cases | `tests/groupChatAllowChatSkillsRuntime.test.mjs`: 4 pass / 0 fail (adapted for outbox reads) |
| Rework N1 (two bots, same group, same trigger message) | 2 fail before → 2 pass after; both probe-crossbot scenarios verified by actual runs, see §7.2 |
| Rework N4 (test file trackable by git) | `git check-ignore -v` no longer matches; whitelist + `git add` verified in §7.3 |
| Static checks | `tsc` (`npm run compile:electron`) passes; `eslint` on the three changed TS files exits 0 |
| Repo state | No leftover stash; `main` branch untouched; no remote writes |

### Three root causes → resolution status

| Issue #40 failure fact | Status | How it landed |
|---|---|---|
| ① Lost on failure, no retry | ✅ Fixed this round | Persist a "delivery obligation" row before broadcasting; on failure keep `pending` + backoff; the drain resends the **same text** (LLM not re-run) |
| ② Cursor advances even on failure | ✅ Fixed this round | Cursor changed to "may only pass the trigger message once the obligation reaches a terminal state"; while `pending`, it stays pinned at `trigger_msg_id - 1` |
| ③ Transport-layer pinId discarded, cannot ACK | ✅ Fixed this round (up to "local-write ACK") | `BroadcastGroupChatFn` contract now returns `{pinId}`; `main.ts` captures it; the obligation row stores `pin_id` |

### To be verified (cannot verify locally, see §6)

- Real Electron + real-chain end-to-end behavior (wallet signing, broadcast, read-back);
- Actual retry cadence of `SUBMITTED` rows and `saveDb()` flush timing in production;
- "Whether upstream accepts this direction" (the issue body is awaiting a reply; this task is forbidden from posting anything publicly, so no interaction).

### Explicitly not done (recommend handling separately later, see §5.2)

- `SUBMITTED → CONFIRMED` external read-back confirmation (pin readback / `verifyPinSources`);
- Placeholder message (`copyRespondingPlaceholder`) half-state problem (fact ② in the issue body);
- Read-back dedup for duplicate delivery (the window where `createPin` is already on-chain but the call throws);
- UI observability, `ABANDONED` row cleanup policy, and the same hardening for other outbound paths.

---

## 1. Root-cause confirmation (checked line by line against the three failure facts on 37ee6e6)

> How it was checked: read the source line by line at baseline 37ee6e6 and ran the "before-fix reproduction" cases (§3); the two lines of evidence agree.

**① Lost on failure, no retry — confirmed**
`src/main/services/cognitiveOrchestrator.ts` original `:818-824`:

```ts
try {
  await broadcastGroupChat(task.metabot_id, task.group_id, metabot.name, trimmed);
} catch (err) {
  rethrowSqliteWasmBoundsError(err);
  console.error('[Orchestrator] Broadcast failed:', ...);
  return;   // only logs: the reply text, the failure reason, and "which message is owed a reply" are never persisted
}
```

The original file contained only 4 occurrences of `UPDATE group_chat_tasks` and zero `INSERT`s — there was no retryable persistent record of any kind.

**② Cursor advances even on failure — confirmed**
Same file, original `:990-995`: at the end of `tick()`, executed unconditionally:

```ts
db.run('UPDATE group_chat_tasks SET last_processed_msg_id = ? WHERE id = ?', [maxProcessedId, task.id]);
```

The early-exit branch on broadcast failure never rolls back the cursor, so the next tick's `id > last_processed_msg_id` selection can never pick up the trigger message again — failure and success are indistinguishable at the cursor level.

**③ Transport-layer pinId discarded, cannot ACK — confirmed**
- Original type contract `:124-129`: `BroadcastGroupChatFn = (...) => Promise<void>`;
- The actual transport layer `src/main/services/groupChatTransport.ts:275-300` `sendGroupChatMessage()` already does `return { pinId: result.pinId }`;
- The wiring site `src/main/main.ts:3516-3518`: `await sendGroupChatMessage(...)` does not capture the return value.

**Differences from the issue body (verified)**: the issue body lists the "placeholder half-state" as fact ② and takes `5026b235` as the baseline; in this task's three root causes, ② is "cursor advances even on failure" and the baseline is `37ee6e6`. After the line-by-line check, all three of this task's root causes hold on 37ee6e6 (line numbers ±1 shift). The placeholder problem is out of scope this round (§5.2).

---

## 2. Fix plan (files + line numbers + changes + rationale)

### 2.1 New `src/main/services/groupChatOutbox.ts` (new file, 261 lines, after rework)

**Delivery obligation table** (schema owned by the module; `ensureGroupChatOutboxSchema()` creates the table idempotently and is called by the orchestrator on first access each tick. Follows the in-tree "store-owned table" precedent of `dreamStore.ts` / `teamCultureStore.ts`; does not touch `sqliteStore.ts`):

```sql
CREATE TABLE IF NOT EXISTS group_chat_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metabot_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  trigger_msg_id INTEGER NOT NULL,      -- group_chat_messages.id that triggered this reply
  nick_name TEXT,
  content TEXT NOT NULL,                -- the generated reply text (resent verbatim on retry)
  content_hash TEXT,                    -- sha256(groupId + '\n' + content), reserved for later read-back confirmation
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  pin_id TEXT,                          -- transport-layer ACK
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (group_id, metabot_id, trigger_msg_id)   -- rework N1: isolated per (group, bot, message)
);
```

**State machine and constants** (`:35-64`):

```
PENDING --inline send ok (pinId received)--> SUBMITTED        (terminal; no read-back this round)
PENDING --inline send failed---------------> PENDING           (backoff, resent by drain)
PENDING --retry limit reached--------------> ABANDONED         (terminal; row kept for audit)
```

- `GROUP_CHAT_OUTBOX_BACKOFF_MS = [30s, 60s, 120s, 300s]` (explicit constants, no magic numbers);
- `GROUP_CHAT_OUTBOX_MAX_ATTEMPTS = 5` (= 1 inline attempt + 4 retries).

**Function list**: `ensureGroupChatOutboxSchema(:69)`, `groupChatContentHash(:94)`, `enqueueGroupChatSend(:123)`, `findGroupChatSendByTrigger(:155)`, `listPendingGroupChatSends(:173)`, `lowestPendingTriggerMsgId(:193)`, `markGroupChatSendSubmitted(:207)`, `markGroupChatSendFailed(:222)`.

**Key design rationale**:
1. **Persist the obligation first, then send (persist-then-send)**: even if the process crashes between INSERT and broadcast, the drain after restart can still deliver that reply — the first line of defense against "lost on failure".
2. **`UNIQUE (group_id, metabot_id, trigger_msg_id)`** (rework N1 fix; the first version used `(group_id, trigger_msg_id)`): one trigger message owes **each bot** at most one obligation; when the same message hits several bots in one group, each gets its own row and they never overwrite each other, and `enqueue` / `markSubmitted` never cross-write another bot's obligation row. When the message is re-selected, the gate (§2.2) uses this to block duplicate LLM runs and duplicate sends.
3. **Retries resend the stored text instead of re-running the LLM**: the failure point is "after the LLM, during send"; resending `content` is cheaper, content-consistent, and avoids the context drift a freshly generated reply would introduce.
4. **`INSERT OR IGNORE` + read back the id**: defensive idempotency — no duplicate enqueue can ever produce a second row.
5. In-tree precedent comparison: `groupTaskDaemon`'s durable defer queue retries at the **turn layer** (`tests/groupTaskDaemon.test.mjs` task #64); this module retries at the **delivery layer** — because the failure point is after generation, resending the text is the smaller unit of action.

### 2.2 `src/main/services/cognitiveOrchestrator.ts` (+148/-6, measured after rework; the first round was actually +141/-6)

| Location (post-change line) | Change | Root cause |
|---|---|---|
| `:141-163` | `BroadcastGroupChatFn` contract: `Promise<void>` → `Promise<GroupChatBroadcastAck \| void>` (`{ pinId?: string }`); `ackPinId()` reads it tolerantly (compatible with existing JS test doubles that return void) | ③ |
| `:616` | `runReplyPipeline()` gains a `triggerMsgId` parameter (the key of the obligation table) | ①② |
| `:853-885` | Before broadcasting: `enqueueGroupChatSend()` + `saveDb()`; on success → `markGroupChatSendSubmitted(pin_id=ACK)`; on failure → `markGroupChatSendFailed()` keeps `pending`/`abandoned` then returns (replaces the original "log-only" at `:818-824`) | ①②③ |
| `:892-933` | New `drainPendingGroupChatSends()`: at the start of each task's tick, rebroadcasts `pending` rows whose `next_attempt_at` has arrived **using the stored text**; on success → `submitted`, on failure → backoff/`abandoned` | ① |
| `:997` | Drain **before** reading new messages in the tick (full-group scan, rows are self-contained); return value = the smallest `trigger_msg_id` among this bot's remaining `pending` (the cursor floor) | ①② |
| `:1080-1109` | Trigger gate: if the message already has an obligation in **this bot's** name (any state) → do not re-run the LLM (`break`; rework N1 isolates per (group, bot), another bot's obligation does not block this bot); if an older `pending` obligation exists (`msgId > pendingFloor`) → defer this message to preserve reply order | ①② |
| `:1113-1128` | Cursor cap (replaces the original unconditional `UPDATE`): `nextCursor = min(maxProcessedId, max(floor-1, effectiveLastProcessed))` | ② |

**Cursor semantics (the core of root cause ②)**:

- Broadcast failure → obligation `pending` → cursor pinned at `trigger_msg_id - 1`: the message is still selected on the next tick, but the gate sees the existing obligation and **does not re-invoke the LLM**; the drain retry uses the stored text.
- Retry success (`submitted`) or retry limit reached (`abandoned`) → no longer `pending` → the cursor passes the trigger message and later messages continue to be processed.
- The floor is filtered by **(group_id, metabot_id)**: another bot task's pending obligations in the same group do not freeze this task (covered by a dedicated case; after rework N1 this also holds for a single trigger message hitting two bots, see §7).
- `max(floor-1, effectiveLastProcessed)` guarantees the cap never moves the cursor **back** before an already-processed position.

### 2.3 `src/main/main.ts:3514-3520`

```ts
async (metabotId, groupId, nickName, content) => {
  // Issue #40: hand the transport ACK (pinId) back to the orchestrator so
  // the outbox can record it instead of discarding the return value.
  return await sendGroupChatMessage(metabotId, groupId, { content, nickName });
},
```

The original implementation discarded the value after `await`. The transport layer's existing `recordOutgoingGroupSend` (in-process send ledger, R4 single-send dedup) is unaffected.

### 2.4 Tests and wiring

- **New** `tests/groupChatOutboxDurability.test.mjs` (442 lines / 7 cases, after rework): uses a real in-memory `sql.js` database + the compiled `dist-electron/.../cognitiveOrchestrator.js` `runTickOnce` with injected mocks, covering: failure persistence + cursor not advancing, backoff retry (LLM not re-run), ACK persisted, retry limit → ABANDONED → cursor unblocked, multiple bots in one group not interfering with each other, **a single trigger message reaching two bots in one group must deliver BOTH replies (added in rework N1), and the first bot's failure must neither swallow the second bot's reply nor cross-write its obligation row (added in rework N1)**.
- **Adapted** `tests/groupChatAllowChatSkillsRuntime.test.mjs:61-65`: that file's strict fake DB throws on unknown SQL, so a "no obligation" branch was added for the outbox reads (no assertions changed).
- **Wired** `package.json:36`: the `test:group-tasks` list appends the new test file (enters the existing regression gate via `test:release-regressions`).

---

## 3. Reproduction / verification (runnable commands + actual outputs)

### One-time local setup

```bash
cd /Users/wufeng/idbots/project/bots/2/2026-09-22/idbots-bugfix/IDBots/.worktrees/group-broadcast-durability
ln -sfn ../../node_modules node_modules    # the worktree has no deps; symlink the repo-root node_modules
export PATH="/Users/wufeng/idbots/project/bots/2/2026-09-22/idbots-bugfix/tools/node-v24.21.0-darwin-arm64/bin:$PATH"
npm run compile:electron
```

### "Reproduces before the fix, does not reproduce after" (same command, actually run)

```bash
# ---- Before (baseline behavior): roll back only src/main, keep the test file ----
git stash push -u -m "issue40-baseline-repro" -- src/main
npm run compile:electron
node --test tests/groupChatOutboxDurability.test.mjs      # actual: tests 5 / pass 0 / fail 5

# ---- Restore the fix ----
git stash pop && npm run compile:electron
node --test tests/groupChatOutboxDurability.test.mjs      # actual: tests 5 / pass 5 / fail 0
```

**Actual output before the fix** (each failure maps to one root cause):

```
✖ failed broadcast persists a pending obligation and keeps the cursor before the trigger message
  AssertionError: cursor must NOT advance past the trigger message (id 1) while its reply is undelivered
    actual: 1, expected: 0                       ← root cause ②: cursor advances even on failure
✖ pending obligation is retried with the stored text (no LLM re-run) and releases the cursor after success
    actual: undefined, expected: 'pending'       ← root cause ①: no persistent record after failure
✖ successful broadcast records the transport ACK pinId on the obligation
  AssertionError: obligation row must exist      ← root cause ③: ACK/obligation row does not exist
✖ after MAX attempts the obligation is abandoned (terminal) and the cursor unblocks
    actual: 1, expected: 5                       ← root cause ①: never retried (broadcast only once)
✖ one bot's pending obligation never pins another bot task's cursor in the same group
    actual: 0, expected: 2                       ← root cause ①: no obligation table
ℹ tests 5 / pass 0 / fail 5
```

**Actual output after the fix**:

```
✔ failed broadcast persists a pending obligation and keeps the cursor before the trigger message
✔ pending obligation is retried with the stored text (no LLM re-run) and releases the cursor after success
✔ successful broadcast records the transport ACK pinId on the obligation
✔ after MAX attempts the obligation is abandoned (terminal) and the cursor unblocks
✔ one bot's pending obligation never pins another bot task's cursor in the same group
ℹ tests 5 / pass 5 / fail 0
```

> After the rework the same command runs **7 cases** (2 new cross-bot same-trigger-message cases): `ℹ tests 7 / pass 7 / fail 0`, see §7.2.

### Regression commands

```bash
npm run test:group-tasks                         # actual: tests 542 / pass 542 / fail 0 (including new cases)
npx eslint src/main/services/groupChatOutbox.ts \
           src/main/services/cognitiveOrchestrator.ts src/main/main.ts   # exit 0
node --test tests/cognitiveGroupChatPrompt.test.mjs tests/sleepGuard.test.mjs \
            tests/llmSafeText.test.mjs tests/sqliteRecoveryLifecycle.test.mjs   # 50 pass / 0 fail
```

### Existing scripts confirmed "same before and after" (avoid collateral damage; unrelated to this fix)

The following two scripts **already failed** on baseline 37ee6e6; each was run once before and once after the fix with identical output (not introduced by this fix):

- `node scripts/test_cognitive_phase2.mjs`: the script's in-memory schema lacks the `sender_global_metaid` column (`no such column`), unrelated to this fix;
- `node scripts/test_cognitive_hook.mjs`: 2 `FAIL:` lines already on the baseline (Cowork skill turn path assertions).

---

## 4. Changed file list

| File | Type | Size |
|---|---|---|
| `src/main/services/groupChatOutbox.ts` | New | 261 lines (after rework) |
| `src/main/services/cognitiveOrchestrator.ts` | Modified | **+148 / -6** (measured after rework; review N6 correction: the first-round submission was actually +141 / -6; the original draft's "+147 / -8" was wrong) |
| `src/main/main.ts` | Modified | +3 / -1 |
| `tests/groupChatOutboxDurability.test.mjs` | New | 442 lines / **7 cases** (2 added in rework) |
| `tests/groupChatAllowChatSkillsRuntime.test.mjs` | Modified | +5 |
| `.gitignore` | Modified | +1 (N4 whitelist `!tests/groupChatOutboxDurability.test.mjs`) |
| `package.json` | Modified | 1 line (test wiring) |

> `dist-electron/` (build output) and `node_modules` (symlink) are both covered by `.gitignore` and not part of the change set.

---

## 5. Scope this round and uncovered items (guard against scope creep)

### 5.1 Done this round (minimal viable fix, all verified in §3)

1. Failure persistence + backoff retry path (obligation table + drain, resending the stored text, no LLM re-run);
2. Cursor advances only after the obligation reaches a terminal state (per-bot floor + gate + cap);
3. pinId captured into an ACK (type contract + main.ts wiring + `pin_id` persisted);
4. Corresponding regression cases and CI wiring; existing orchestrator cases adapted.

### 5.2 Recommended for separate follow-up (not this round; needs separate evaluation / separate PR)

1. **`CONFIRMED` external read-back** (the issue's full design): `SUBMITTED` only proves the local write; upgrade the terminal state to on-chain confirmation via pin readback / `verifyPinSources` (a single-source 404 does not mean nonexistent). **`pin_id` / `content_hash` are already reserved in the table this round.**
2. **Duplicate delivery window**: when `createPin` is already on-chain but the call throws (timeout / response parse failure), a retry will send a duplicate. A complete fix depends on the read-back criterion from item 1 (the issue's "cooldown longer than measured indexing delay" belongs to this layer).
3. **Placeholder message half-state** (fact ② in the issue body): the privileged skill path broadcasts `copyRespondingPlaceholder()` before the body (post-change `cognitiveOrchestrator.ts:732`, baseline `:697`); if the body fails, a half-state is left on-chain; untouched this round.
4. **LLM failure / empty-reply path**: there is no reply content to deliver, and the message is still consumed (baseline semantics preserved).
5. **Observability**: how `pending/abandoned` rows are surfaced to the user (log panel / group-task view), and the retention and cleanup policy for ABANDONED rows.
6. **Hardening other outbound paths**: whether the private-chat daemon, the `group_chat` tool's inline send, etc. have the same "lost on failure" semantics needs individual verification (out of issue #40 scope).

---

## 6. Things that could not be verified / are uncertain (listed honestly)

1. **No real-chain end-to-end**: all verification ran in-process via `runTickOnce` with injected mocks (send success = mock returns `{pinId}`); real wallet signing, `createPin` network behavior, and indexing delay were not verified.
2. **`saveDb()` flush timing not separately verified**: wired per existing tick usage (called after every obligation write); the store layer's throttling/flush semantics were not examined in depth.
3. **Backoff constants not measured in production**: 30s/60s/120s/300s are conservative explicit constants; the issue's suggestion to use measured values for the "post-SUBMITTED confirmation cooldown" does not apply to this round, which does not cover that phase.
4. **Post-restart drain verified only by equivalence reasoning**: table rows are persisted writes + the tick will scan by `pending` after restart (code path verified), but "real process crash → restart" was not actually run.
5. **Upstream direction unconfirmed**: the issue body asks "is this direction acceptable"; this task is forbidden from posting publicly, so no reply and no interaction.
6. **Production database migration**: the new table is created idempotently by the orchestrator's first tick (`CREATE TABLE IF NOT EXISTS`, no `ALTER`), not exercised against a real user database (low risk: brand-new table + IF NOT EXISTS).

---

## Appendix A: Acceptance checklist

| Acceptance item | Evidence |
|---|---|
| Fix-plan doc: files + changes + rationale for each | This doc §2 (each change annotated with its root cause) |
| Runnable commands that reproduce before / do not reproduce after | §3 stash sequence; actual 5 fail → 5 pass |
| Root cause ① (lost on failure, no retry) addressed | §2.1 + §2.2 (drain/gate); cases 1/2/4 |
| Root cause ② (cursor advances on failure) addressed | §2.2 cursor cap; cases 1/2/4 |
| Root cause ③ (pinId discarded) addressed | §2.2 contract + §2.3; case 3 |
| This round vs. follow-up marked | §5.1 / §5.2 |
| No touching main, no push, changes only in the worktree | Throughout, `git status` showed only worktree files; the `main` worktree untouched; no remote operations |
| "Verified / to be verified" not conflated | §0 two lists + §6 |

## Appendix B: Operations quick reference (for reviewers; not a deliverable this round)

```sql
-- replies not yet delivered (should be retried by the drain)
SELECT id, metabot_id, group_id, trigger_msg_id, state, attempts, last_error, next_attempt_at
  FROM group_chat_outbox WHERE state = 'pending' ORDER BY id;
-- replies locally written (with pinId)
SELECT id, trigger_msg_id, attempts, pin_id FROM group_chat_outbox WHERE state = 'submitted';
-- replies whose retries were abandoned (need human attention)
SELECT id, trigger_msg_id, attempts, last_error FROM group_chat_outbox WHERE state = 'abandoned';
```

---

## 7. Second-round review rework record (N1 / N4, 2026-09-23)

> Review conclusion: the first-round fix introduced one behavioral regression N1 (when two bots in the same group hit the same trigger message, the second bot's reply was silently swallowed),
> and the new test file was ignored by `.gitignore` (N4 — a clean clone / CI checkout would not get it). Both must-fix items have been fixed in this rework and verified by actual runs.
> N2 / N3 / N5 / N6 are not fixed this round; their status is recorded honestly in §7.4 (not pretended resolved).

### 7.1 N1 root cause (independently re-reviewed + reproduced by actual runs)

The first round made the "delivery obligation" key and the reply gate **group-level**, missing the `metabot_id` dimension:

- `groupChatOutbox.ts:87` unique constraint `UNIQUE (group_id, trigger_msg_id)`;
- the read-back SELECT in `enqueueGroupChatSend()` also lacked `metabot_id`;
- `findGroupChatSendByTrigger()` did a group-level lookup → the orchestrator gate (`cognitiveOrchestrator.ts:1085`) matched **the first bot's obligation row** in the second bot's tick → `break`: the second reply was neither generated nor sent;
- the cursor cap was already filtered by (group, bot) → the second bot's cursor advanced as usual → **silently swallowed**.

**Actual run before the fix (probe-crossbot scenario, PRE-FIX build)**:

```text
trigger message : msg id 1 mentions TestBot + OtherBot (same group)
LLM replies generated : 1
broadcast attempts    : [{"metabotId":7,"content":"status ok from bot 1"}]
outbox rows           : [[7,1,"submitted","pin-bot-7"]]
task cursors          : [[7,1],[8,1]]
VERDICT: SECOND BOT REPLY SWALLOWED (N1 reproduces)
```

(bot 8's cursor = 1, but there is no LLM reply, no broadcast, and no obligation row of its own — word-for-word identical to the review's actual run.)

### 7.2 N1 fix and verification

| Location | Change |
|---|---|
| `groupChatOutbox.ts` schema | `UNIQUE (group_id, metabot_id, trigger_msg_id)` (the table was introduced on an unreleased branch; no historical-data migration) |
| `groupChatOutbox.ts` `enqueueGroupChatSend()` | read-back SELECT gains `metabot_id`, returning **this bot's** obligation row id (no more cross-writing another bot's row) |
| `groupChatOutbox.ts` `findGroupChatSendByTrigger()` | signature gains `metabotId`, queried by the triple (gate isolated per (group, bot, message)) |
| `cognitiveOrchestrator.ts` gate `:1085` | passes `task.metabot_id`; comment makes explicit "another bot's obligation must not block this bot's reply" |
| `drainPendingGroupChatSends()` | stays a group-level scan (each row is self-contained and carries its own `metabot_id`); comment adds "never cross-writes this bot's rows" |

**2 new coverage cases (2 fail before / 2 pass after, same compiled baseline)**:

```text
Before (first-round build, i.e., pre-rework):
✖ same trigger message reaching two bots in one group delivers BOTH replies (N1 regression)
  AssertionError: each bot runs its own reply pipeline        1 !== 2
✖ a failing first bot never suppresses the second bot's reply nor cross-writes its obligation
  AssertionError: both bots must attempt their own send       1 !== 2
ℹ tests 2 / pass 0 / fail 2

After (this worktree):
✔ same trigger message reaching two bots in one group delivers BOTH replies (N1 regression)
✔ a failing first bot never suppresses the second bot's reply nor cross-writes its obligation
ℹ tests 7 / pass 7 / fail 0
```

**Post-fix probe-crossbot actual runs (both scenarios)**:

```text
=== scenario 1: both bots succeed on the SAME trigger message ===
LLM replies generated : 2
broadcast attempts    : [{"metabotId":7,"content":"reply 1"},{"metabotId":8,"content":"reply 2"}]
outbox rows (bot,msg,state,attempts,pin) : [[7,1,"submitted",1,"pin-bot-7"],[8,1,"submitted",1,"pin-bot-8"]]
task cursors (bot,cursor)                : [[7,1],[8,1]]
=== scenario 2: bot 7 fails, bot 8 must still reply (no cross-write) ===
LLM replies generated : 2
broadcast attempts    : [{"metabotId":7,"content":"reply 1"},{"metabotId":8,"content":"reply 2"}]
outbox rows (bot,msg,state,attempts,pin) : [[7,1,"pending",1,null],[8,1,"submitted",1,"pin-bot-8"]]
task cursors (bot,cursor)                : [[7,0],[8,1]]
```

Scenario 2 proves: bot 7's failure does not affect bot 8's reply or its record; bot 7's `pin_id` stays `null` (not cross-written by bot 8's ACK), and its cursor is pinned at 0.

### 7.3 N4 fix (test file ignored by .gitignore)

- **Before**: `git check-ignore -v tests/groupChatOutboxDurability.test.mjs` → `.gitignore:57:tests/*` (exit 0); `git status` did not show the file; but `package.json:36` `test:group-tasks` already referenced it → a clean clone / CI lacked the file and `node --test` exited 1.
- **Fix (option a, consistent with 100+ similar whitelists in the repo)**: `.gitignore` adds `!tests/groupChatOutboxDurability.test.mjs` (placed after the `groupChatAllowChatSkillsRuntime` entry, line 116).
- **Actual output after the fix**:

```text
$ git check-ignore -v tests/groupChatOutboxDurability.test.mjs
(no output) exit=1                                # no longer matches an ignore rule
$ git check-ignore --no-index -v tests/groupChatOutboxDurability.test.mjs
.gitignore:116:!tests/groupChatOutboxDurability.test.mjs   # the rule that finally applies is the "un-ignore" whitelist
$ git add tests/groupChatOutboxDurability.test.mjs          # without -f, exit 0 (the command would refuse while ignored)
$ git ls-files --error-unmatch tests/groupChatOutboxDurability.test.mjs
tests/groupChatOutboxDurability.test.mjs                    # now in the git index
$ git status --short
 M .gitignore
 M package.json
 M src/main/main.ts
 M src/main/services/cognitiveOrchestrator.ts
 M tests/groupChatAllowChatSkillsRuntime.test.mjs
A  tests/groupChatOutboxDurability.test.mjs
?? <this design doc, then at the repo root — since relocated to docs/design/2026-09-23-group-chat-outbox-issue-40.md>
?? src/main/services/groupChatOutbox.ts
```

(Editorial note: the second-to-last untracked-entry line in the original output named this design doc under its original root-level filename; it is shown above in its relocated form, since the original filename no longer exists in the repo.)

Counter-evidence that the `tests/*` rule itself is not broken (a non-whitelisted path under the same rule is still ignored):
`git check-ignore --no-index -v tests/zzz-not-whitelisted-probe.mjs` → `.gitignore:57:tests/*`.

> No push and no commit in this step: the test file has been `git add`ed (index state `A`), and the `.gitignore` whitelist is in the worktree;
> once the follow-up commit step commits everything, a clean clone / CI can fetch the file. **The "clean-clone verification" claim is marked as pending until after the commit.**

### 7.4 Review items N2 / N3 / N5 / N6 status (not fixed this round, recorded honestly)

| Item | Status | Notes |
|---|---|---|
| N2: message permanently lost after ABANDON (30s+60s+120s+300s backoff ≈ 8.5 minutes, no replay path) | **Not fixed; semantics await upstream decision** | ABANDONED is a terminal state under the current design; whether to introduce infinite retry / manual replay / dead-letter alerting must be decided in the issue's context; behavior unchanged this round. |
| N3: bounded head-of-line blocking (upper bound ≈ 8.5 minutes, no permanent deadlock); pending rows left behind after all group tasks are disabled | **Not fixed; known boundary (confirmed in code)** | `tick()` returns early when `taskCount === 0` → once all tasks are disabled the drain no longer runs, and pending rows stay in the table waiting for the tasks to be re-enabled; no behavior change. |
| N5: the ACK wiring in `main.ts` has no test coverage (the suite is still all green after rolling back to baseline) | **Not fixed; confirmed** | The **production wiring** of root cause ③ has no test guardrail; introducing a testable seam at the Electron entry layer exceeds this round's minimal rework scope. |
| N6: document numbers and the word "isolated" | **Corrected (documentation level)** | The first round's "+147/-8" was actually `cognitiveOrchestrator.ts` **+141/-6** (the review's correction is right); after rework it is **+148/-6** (§4 corrected). "Isolated" originally did not hold for the same trigger message (group-level key) — after this rework it holds per (group, bot, message) (§7.2 actual runs). |

### 7.5 Overall verification after the rework (actual local runs)

```text
npm run compile:electron                      # exit 0
node --test tests/groupChatOutboxDurability.test.mjs          # 7 / pass 7 / fail 0
npm run test:group-tasks                      # tests 544 / pass 544 / fail 0
node --test tests/cognitiveGroupChatPrompt.test.mjs tests/sleepGuard.test.mjs \
            tests/llmSafeText.test.mjs tests/sqliteRecoveryLifecycle.test.mjs   # 50 / pass 50 / fail 0
node --test tests/groupChatAllowChatSkillsRuntime.test.mjs    # 4 / pass 4 / fail 0
npx eslint src/main/services/groupChatOutbox.ts src/main/services/cognitiveOrchestrator.ts src/main/main.ts  # exit 0
```

**To be verified (cannot verify locally)**: real Electron + real-chain end-to-end, real process-crash recovery, clean-clone verification after commit — consistent with §6, unchanged.
