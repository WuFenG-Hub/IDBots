# SleepGuard work-source coverage matrix (Boss requirement: no device sleep during local / online / group-task work)

> Deliverable of the "verify and reinforce work-source coverage" step on the `fix/sleep-guard-macos` branch.
> The question here is not "can the assertion mechanism engage" (fixed in the previous round; see the header
> comment of `src/main/sleepGuard.ts`), but "which entry points count as work". The criterion is: **does this
> path produce sustained work on the scale of minutes**, not "does it count as a session".

## 0. Coverage model: bounded work vs resident daemons

`SleepGuard` holds the OS assertion only while "the setting is ON **and** at least one bounded work unit is running".

- **Bounded work (counted)**: a work unit a user/task is waiting on, with a clear start and end.
- **Resident daemons (not counted)**: processes/loops that run as long as the app is alive — the p2p indexer,
  MCP skill servers, the local MetaApp server, various listeners/sockets, backfill patrols. Counting them would
  hold the assertion **permanently**, turning "prevent sleep" into an always-on switch, which is not the
  semantics the Boss asked for.

Work-source collection is an injectable pure function: `src/main/sleepGuardWorkSources.ts`
(`collectSleepGuardWorkFrom`), with per-source try/catch: **a throwing source only degrades itself to empty —
it neither crashes the guard nor abandons the live work reported by the other sources**.

## 1. Entry-point matrix

| # | Entry point | Counted as work | Basis (code location) |
|---|---|---|---|
| 1 | Local chat (Cowork UI) | ✅ yes (`cowork`) | Renderer `coworkService.startSession` → IPC `cowork:session:start` (`src/main/main.ts:8609`) → `runner.startSession` (`src/main/main.ts:8741`) → `CoworkRunner.startSession` writes `activeSessions` (`src/main/libs/coworkRunner.ts:6117`, re-registered inside the turn at `:7463`) → `getActiveSessionIds()` (`:12070`) |
| 2 | Online chat A2A (inbound private chat) | ✅ yes (`a2aChat` + `cowork`) | Inbound handling tasks register in `privateChatDaemon`'s in-flight set (`src/main/services/privateChatDaemon.ts:3187`/`4895`, newly exported getter `:250`); the long path (skill turn) goes through `runPrivateChatSkillTurn` → `runSkillTurnInExistingSession` → `orchestratorCoworkBridge.ts:604` → `startSession` |
| 3 | Private-chat order execution (Gig Square / A2A orders) | ✅ yes (`cowork`) | `src/main/services/privateChatOrderCowork.ts:206` (first execution) and `:658` (resume after missing parts) both call `coworkRunner.startSession`; long order-video tasks live inside the same session (`startVideoLongTaskStatusUpdates`) |
| 4 | Group-task orchestration (Group Task daemon) | ✅ yes (`groupTask`, **new in this round**) | Session part: `groupTaskDaemon`'s `runSkillTurn` (`src/main/main.ts:3721`) → `runSkillTurnInExistingSession` → `orchestratorCoworkBridge.ts:604`; the **multi-minute part outside any session** (chair planning/acceptance, on-chain sends, deliverable uploads, acceptance summary) is captured by turn-level in-flight state: `turnInFlight.set(key…)` (`src/main/services/groupTaskDaemon.ts:6510`) → exported `getGroupTaskTurnActivity()` (`:10270`) → new work source |
| 5 | Group-chat auto-reply daemon (`group_chat_tasks`) | ✅ yes (`groupChat`, **new in this round**) | Reply-pipeline in-flight state: `thinkingTasks` (`src/main/services/cognitiveOrchestrator.ts:972`/`985`, newly exported getter `:181`); the skill branch still rides cowork (`runSkillTurnViaCowork` → `orchestratorCoworkBridge.ts:425`), while the pure-chat branch is a **session-less** reasoning completion (`cognitiveOrchestrator.ts:797`), so the pipeline as a whole must be its own work source |
| 6 | Scheduled tasks | ✅ yes (`scheduledTask` + `cowork`) | `Scheduler.getActiveTaskIds()` (`src/main/libs/scheduler.ts:82`; `activeTasks` covers the whole run, registered `:219` / released `:235`); the session itself `scheduler.ts:342` → `startSession` |
| 7 | IM triggers (Telegram/Discord/Feishu/DingTalk/NIM…) | ✅ yes (`cowork`) | `src/main/im/imCoworkHandler.ts:185` → `startSession` (delegates to `continueSession`, `coworkRunner.ts:6172`, when already active, otherwise `startSession`) |
| 8 | Night dreams | ✅ yes (`dream`) | `DreamService.getDreamingBotIds()` (`src/main/services/dreamService.ts:181`); `dreamingBots` registers/releases for the duration of a dream (`:605`/`:656`); a dream runs LLM consolidation inside the main process with no cowork session |
| 8b | Night study / on-chain QA surf (study / qa-surf job) | ✅ yes (`cowork`) | `runStudyJob` uses `runOrchestratorSkillTurn` (`src/main/main.ts:6836` onwards) to run a bounded background session → `orchestratorCoworkBridge.ts:425` → `startSession` |
| 9 | Bot Browser long tasks | ✅ yes (`cowork`) | A browser session is a cowork session with `sessionType === 'browser'`: renderer `src/renderer/services/browserCowork.ts:68-72` → the same `cowork:session:start` (`main.ts:8634` normalizes the type, `:8741` starts it); automation tools (screenshot/navigation/publish) all execute inside that session's turns |
| 10 | Direct spawn / dsh-runtime long runs | ✅ yes (`cowork`, lives and dies with the session) | `coworkVmRunner` (the code that actually spawns the DSH runtime: `src/main/libs/coworkVmRunner.ts:326`/`:331`) is only used by `coworkRunner` (its sole importer), i.e. the runtime subprocess is bound to an active session |
| 11 | OpenTeam guest daemon / Twin orchestration worker | ✅ yes (`cowork`) | Both start sessions via `runSkillTurnInExistingSession` / `runOrchestratorSkillTurn` (`openTeamGuestDaemon.ts:648` + injected at `main.ts:3726`) |
| 12 | Resident daemons / connectors (p2p indexer, MCP skill servers, MetaApp local server, listeners, backfill patrols) | ⛔ deliberately not counted | They exist as long as the app runs; counting them = assertion held forever; their individual network/DB operations are not "task progress" anyone waits on. See the header notes of `src/main/sleepGuardWorkSources.ts` |
| 13 | App-update downloads | ⛔ deliberately not counted | An OS-level resumable user-initiated download, not session/task progress; outside the Boss's current scope (local / online / group tasks) |

**Gaps reinforced this round**: `#4 / #5 / #2-pure-chat branch`. Before the fix they were **partially or
entirely uncovered** — the vast majority of a group-task turn (planning/acceptance/on-chain/upload) has no
cowork session at all, and neither do the pure-chat reply branches of group chat and A2A.
The fix adds 3 work sources: `groupTask` / `groupChat` / `a2aChat`.

## 2. Change list

| File | Change |
|---|---|
| `src/main/sleepGuard.ts` | `SleepGuardSource` gains `groupTask`/`groupChat`/`a2aChat`; `SleepGuardWorkInput` gains 3 fields; `evaluateSleepGuardWork` appends them in stable order; header comment documents "what counts as work" |
| `src/main/sleepGuardWorkSources.ts` (new) | Injectable work-source collector (per-source fault isolation + explicit error on non-array returns); `groupTaskTurnIdsOf()` builds `taskId:metabotId` keys |
| `src/main/main.ts` | Collector wired to 6 getters; `emitTaskEvent` recomputes immediately on `groupTask:turnActivityChanged` (group-task turns take effect at once instead of waiting for the 20s poll) |
| `src/main/services/cognitiveOrchestrator.ts` | Exports `getActiveGroupChatReplyTaskIds()` |
| `src/main/services/privateChatDaemon.ts` | Exports `getActiveA2AReplyTaskIds()` |
| `src/renderer/components/SleepGuardBadge.tsx` + `services/i18n.ts` | Tooltip labels for the 3 new sources (zh/en): group-task turn / group-chat reply / online private-chat reply |
| `tests/sleepGuard.test.mjs` | New-source evaluation, multi-source coexistence, a lone group-task turn holding the assertion, per-source collector fault isolation / non-array handling, existence of the real getters |
| `scripts/sleep-guard-real-host-check.cjs` | For each of the three new sources: "alone → real-host assertion appears → turn ends → assertion disappears", plus collector host checks |
| `scripts/sleep-guard-e2e-real-app.cjs` (new) | Real-app end-to-end driver: a real session runs `sleep 150` while sampling guard state + `pmset` |

## 3. Verification evidence

### 3.1 Unit tests (28/28 green)

```
npm run compile:electron && node --test tests/sleepGuard.test.mjs
ℹ tests 28   ℹ pass 28   ℹ fail 0   ℹ duration_ms 627
```

### 3.2 Real-host assertion loop (43/43 PASS, negative control must FAIL)

```
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/sleep-guard-real-host-check.cjs
RESULT: PASS (43/43)

PASS  groupTask: a session-less turn alone engages the guard: {"active":true,"sources":["groupTask"],"engaged":true,"engagedBy":"caffeinate",...}
  pmset (groupTask engaged): pid 57354(caffeinate): ... PreventUserIdleSystemSleep named: "caffeinate command-line tool" | Details: caffeinate asserting on behalf of Process ID 57333 | Created for PID: 57333. | Localized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.
PASS  OS: groupTask holds a real PreventUserIdleSystemSleep assertion
PASS  OS: groupTask assertion gone once the turn settles: (none)
(same for groupChat / a2aChat, 2 OS assertion checks each)

# Negative control (assertion mechanism disabled; must FAIL for the verification to be meaningful)
SLEEP_GUARD_CHECK_DISABLE_ASSERTIONS=1 ... → RESULT: FAIL (34/43), NEGATIVE CONTROL OK
```

### 3.3 Real end-to-end: the assertion truly exists while real work runs (primary evidence this round)

Isolated instance: `cdp 127.0.0.1:9444`, `userData=.dev-userdata-sleepguard-e2e` (configured profile with only
`sleep_guard_prevent_device_sleep=true`, listeners explicitly disabled), real Electron main pid **57771**.

Real work: a real session started through the instance's own IPC (not a mock); the Agent actually invoked bash:

```
startSession -> {"success":true,"id":"0cca8024-622c-4279-b3f8-910c3f00fdb9","status":"running"}
cowork_messages: tool_use metadata = {"toolName":"bash","toolInput":{"command":"sleep 150",...},"timeoutMs":180000}
session ends: cowork_sessions.status=completed
```

`pmset` during the work (raw lines, including the process pid and the Created-for-PID detail):

```
[e2e] 2026-09-10T15:25:34.231Z guard={"active":true,"sources":["cowork"],"engaged":true,"engagedBy":"caffeinate","preventDeviceSleepEnabled":true}
      assertion=58943(caffeinate) PreventUserIdleSystemSleep |
      Details: caffeinate asserting on behalf of Process ID 57771 | Created for PID: 57771. |
      Localized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.
(sampled every 5s thereafter; the assertion was held continuously until 15:28:10, about 2 min 36 s in total)

[e2e] pmset assertion for main pid AFTER work: (none)
[e2e] final guard status: {"active":false,"sources":[],"engaged":false,"engagedBy":null,...}
[e2e] RESULT: PASS — engaged while real work ran: true; released after work: true; assertion gone afterwards: true
```

The pid held no assertion before the work started; no mocks or keywords participated in the verdict (it rests on
the `caffeinate` assertion owned by this pid in `pmset`, with `Created for PID` pointing explicitly at the
Electron main pid); the assertion disappeared once the work finished.

## 4. Known boundaries (honestly noted, not fixed)

1. **20s sampling granularity**: the guard's fallback poll runs every 20s (`startSleepGuardRefresh` in
   `main.ts`). Session-type entry points recompute immediately via events, and group-task turns now have the
   `groupTask:turnActivityChanged` event; group-chat/A2A pure-chat replies currently rely on the 20s poll
   alone — a reply measured in seconds can finish entirely inside a sampling gap. The coverage target is
   minute-scale work (the Boss's scope), so the probability and impact of missing a seconds-long reply are
   both small; for stricter coverage the two daemons should get event hooks of their own.
2. **Assertion-type boundary unchanged**: `PreventUserIdleSystemSleep` only blocks "system sleep caused by
   user idleness"; closing the lid, Apple menu ▸ Sleep, and low-battery forced sleep are not covered
   (already documented in the `sleepGuard.ts` header).
3. **No on-chain writes**: none of the verification in this round triggered any on-chain write; the real-app
   E2E instance had listeners explicitly disabled and only ran a local `sleep` inside the session.
