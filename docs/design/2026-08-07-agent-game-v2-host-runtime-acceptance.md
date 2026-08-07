# Agent-Game-v2 Host Runtime — Delivery & Acceptance Report

- **Date:** 2026-08-07
- **Branch:** `feat/agent-game-runtime` (branched from `main`, depth 1)
- **Worktree:** `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots-agent-game-runtime`
- **Requirement source:** `llm-play-chinese-chess/docs/14-idbots-app-session-runtime-prompt.md`
- **Status:** Development complete; awaits real dual-host integration test (blocked on ABC shipping the latest forwarder)

This document is written so the requirement owner can read it directly and
judge acceptance against the prompt. It lists what was built, the file
inventory, how each acceptance criterion is satisfied, the self-test evidence,
and the explicit out-of-scope / follow-up items.

---

## 1. What was built

The host side of Agent-Game-v2 in the IDBots Electron app:

1. **`browser.app.session.*` host API** — `start` / `list` / `status` / `pause`
   / `resume` / `stop` with the exact request/response/error shapes from
   `docs/09-abc-app-session-requirements.md`. IDBots is the authorization and
   session-state owner; ABC (once integrated) only forwards.
2. **A persistent, game-agnostic App/Game Runtime** that runs in the main
   process and survives MetaApp close and host restart. Every game is a
   conforming `adapter.js`; the host contains no game-specific business code.
3. **Task-level authorization** with a consent card, persisted/revocable/expiring grants.
4. **An Adapter sandbox** that runs third-party `adapter.js` in a capability-free
   `worker_threads` Worker with hash pinning and resource limits.
5. **Persistence + recovery** for sessions, grants, the idempotent write ledger,
   and the audit trail.
6. **Lease / fencing** over `(groupId, seat)` with heartbeat renewal.
7. **A renderer consent-card UI** + IPC service mirroring the existing cowork
   permission-modal pattern.

### Reused infrastructure (no duplication, no new npm dependencies)

| Concern | Reused from |
|---|---|
| LLM | `chatCompletionWithTools` (`src/main/services/cognitiveChatCompletion.ts`) — the same main-process stack used by Cowork and the `completeLlm` bridge. 120s call timeout; 180s stall watchdog; `reasoning_content` fallback already handled in `coworkOpenAICompatProxy`. |
| Chain write | `sendGroupChatMessageAsIdentity` (`groupChatTransport.ts`) — host owner identity signs `/protocols/simplegroupchat`, AES-encrypted. Reuses the existing pin-worker sign/broadcast path (`metaidCore.ts` / `createPinWorker.ts`). |
| Group-chat messages | Existing `group_chat_messages` table + `msg_index` cursor; `metaWebListenerService` socket push; `groupChatBackfillService` history gap-fill. |
| SQLite | `sql.js` via `sqliteStore.ts`; new tables follow the existing `CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE` migration pattern. |
| IPC / preload | Existing `botBrowser:*` handler + `window.electron` contextBridge conventions. |
| Sandbox isolation | `worker_threads` (consistent with the child-process isolation used by `coworkVmRunner`). |

---

## 2. File inventory

21 files changed, +2978 lines, −3.

### New main-process files (`src/main/agentGame/`)

| File | Role |
|---|---|
| `abi.ts` | Adapter ABI v1 types (10 frozen functions), `agent-game/1` envelope, session state machine, budget, consent grant, full error-code union, session API request/response shapes. |
| `adapterSandbox.ts` | Loads + verifies `adapterHash` (sha256) on the main thread, spawns the Worker, enforces per-call timeout (5s), output cap (1MB, secondary 2MB in-worker), `resourceLimits`; ABI smoke-load. |
| `adapterSandboxWorker.cjs` | Worker entry (CommonJS). Loads ESM adapter via dynamic `import`, validates all 10 exports, exposes them over message RPC. No host capabilities. |
| `sessionStore.ts` | SQLite CRUD for sessions / grants / write-log / audit. |
| `leaseRegistry.ts` | Lease/fencing over `(groupId, seat)`; TTL 1h, heartbeat at TTL/3, expiry reclaim. |
| `llmStrategy.ts` | Game-agnostic move prompt built from `getObservation` + `getActionSchema`. |
| `runtime.ts` | The persistent runtime: message intake, catch-up, action loop, idempotent writes, state hashing, recovery, session lifecycle. |
| `consent.ts` | Consent-card flow + grant queries (auto-write authorization). |
| `index.ts` | `createAgentGameHost(deps)` wiring + `handleSessionMethod` dispatch + `readMessagesSince` cursor reader. |

### Modified main-process files

| File | Change |
|---|---|
| `sqliteStore.ts` | 4 new tables (`agent_game_sessions`, `agent_game_grants`, `agent_game_write_log`, `agent_game_audit`) + 2 guarded migrations. No existing column changed. |
| `main.ts` | `startAgentGameHost()` (started after the sqlite daemons), IPC handlers (`agentGame:session`, `respondConsent`, `listPendingConsent`, `listSessions`), event broadcast to renderer, backfill active-set now unions game groups, group-chat intake hook. |
| `preload.ts` | `window.agentGame` surface (session / respondConsent / listPendingConsent / listSessions + onConsentRequired / onSessionUpdated). |
| `metaWebListenerService.ts` | Optional post-insert hook `setGroupMessageInsertedHook` fired after every group message insert; no-op + swallowed errors when no session exists. |
| `electron-builder.json` | `extraResources` entry ships the Worker `.cjs` into `resources/agentGame/`. |

### New renderer files

| File | Role |
|---|---|
| `types/agentGame.ts` | `AgentGameSessionView`, `AgentGameConsentCardInfo`, `AgentGameSessionResult`. |
| `store/slices/agentGameSlice.ts` | `pendingConsents` queue (dedup by requestId). |
| `services/agentGame.ts` | Singleton service wrapping the IPC surface + listener lifecycle. |
| `components/agentGame/AgentGameConsentCard.tsx` | Tailwind overlay card (English copy) showing actor/game/seat/group/MetaApp/hashes/TTL/budget/protocolPaths; Authorize / Deny. |

### Modified renderer files

| File | Change |
|---|---|
| `types/electron.d.ts` | `agentGame` member declared on `IElectronAPI`. |
| `store/index.ts` | `agentGame` slice registered. |
| `App.tsx` | Selector + listener effect (toasts on session transitions, re-hydrate pending cards), consent response handler, card render, `isOverlayActive` includes consent queue. |

---

## 3. Commit log (each with an on-chain dev-journal buzz)

```
8eee068 fix: resolve adapter sandbox worker from app resources for packaged builds
bf6cdb6 feat: add agent-game consent card UI and IPC service
d20c321 feat: wire browser.app.session host bridge with recovery and message intake
01dd48f feat: add task-level consent authorization for agent-game sessions
2a9e467 feat: add persistent agent-game runtime with action loop and idempotent writes
a52ec6f feat: add lease registry and fencing
33ff981 feat: add agent-game session/grant/write-log/audit persistence
828d8f2 feat: add adapter sandbox worker with hash pinning
60d76dd feat: add agent-game ABI types and protocol envelope
```

All commits are on the feature branch only; `main` is untouched. Nothing has
been pushed (per project rules). Each commit has a corresponding `simplebuzz`
on-chain journal entry (MVC).

---

## 4. Acceptance checklist (from the prompt)

The prompt's acceptance criteria, mapped to where they are satisfied and the
self-test evidence:

| # | Criterion | How it is satisfied | Self-test |
|---|---|---|---|
| 1 | MetaApp closed → session keeps moving; reopen shows status | Runtime lives in the main process, not the iframe. Status is queryable via `browser.app.session.status` and the `agentGame:sessionUpdated` IPC event. | Runtime smoke: match runs to `finished` with the MetaApp-iframe entirely absent. |
| 2 | Host restart → sessions recover, no lost/duplicated actions | `startAgentGameHost()` calls `runtime.recover()`: load unfinished → re-verify grant → history catch-up from `lastIndex` → re-acquire lease (`running`) or stay `paused`+`session_conflict`. | Recovery path implemented + exercised; catch-up replays `msg_index > cursor` and dedups by `eventId`/`actionSeq`. |
| 3 | Socket drop → history gap-fill, no holes | Game groupIds added to the backfill active-set getter (union with group-task groups). `groupChatBackfillService` already paginates `group-chat-list-by-index`. | Backfill wiring in `main.ts` (active-set getter). |
| 4 | 2nd runner on same `(groupId, seat)` → `session_conflict` | `LeaseRegistry.acquire` rejects a different session while a live lease holds the seat; `start()` maps that to `session_conflict`. | Lease smoke: 2nd acquire returns `conflictSessionId`; runtime `start()` throws `session_conflict`. |
| 5 | Write retry / response loss → each action lands at most once | `recordWriteIntent(groupId, actionSeq, eventId)` BEFORE write; on failure, bounded backoff then re-check history — if landed, advance cursor only, never rewrite. UNIQUE constraint on the write-log guards dedup. | Runtime smoke: 2 actions written, `actionSeq`s unique (`[1,2]`); store smoke: duplicate intent ignored via UNIQUE. |
| 6 | Grant expire / budget depleted → auto-pause + reason | `isExpiredOrDepleted()` checked in the loop + on recovery; maps to `rate_limited` / `budget_exhausted` in `lastError`. | Logic implemented; `llmCalls`/`writes` counters incremented per call/write. |
| 7 | Terminal → stop writing, release lease, stay `finished` | `getTurn().phase === 'finished'` → `finish()`: releases lease, sets `finished`, audits `match-finished`. | Runtime smoke: final status `finished`, writes stop at the terminal move. |
| 8 | Normal group chat: no regression | Intake hook is a post-insert, early-return-when-no-session notification; hook failures are swallowed; backfill getter still includes group-task groups. | No changes to `routeGroupChat` control flow except the trailing notification; `groupTaskDaemon`/orchestrator untouched. |
| 9 | Legacy `browser.llm.complete`: no regression | No changes to `completeLlm` / `chatCompletionWithTools` / bridge dispatch. The runtime calls `chatCompletionWithTools` as a client only. | The LLM entry point is read-only reuse; `tsc` clean. |

### Additional prompt requirements

| Requirement | Status |
|---|---|
| Implement `start/list/status/pause/resume/stop` per docs/09 | ✅ `index.ts` `handleSessionMethod` + runtime methods. Error results use `{ __error, code, message }` with the docs/09 code union. |
| Reuse existing group-chat socket; per-`groupId` session lookup; normal logic unaffected | ✅ `onGroupMessage(groupId)` no-ops unless a session exists. |
| Socket = realtime notify; backfill via `group-chat-list-by-index`; dedup by `index` | ✅ Cursor is `msg_index`; catch-up reads `msg_index > lastIndex`. |
| Decrypt `simplegroupchat` content (AES-128-CBC, key = groupId first 16 chars), parse `agent-game/1`, hand payload to Adapter | ✅ Decryption already done by `routeGroupChat`; runtime parses `agent-game/1` envelopes and validates `protocol`/`gameId`/`rulesHash` before `reduce`. |
| Action loop: `reduce` → `getTurn` → observation/schema → host LLM → `parseAction`/`validateAction` → write `action` | ✅ `processSession`. |
| Verify `prevStateHash` before write; verify `stateHash` after | ✅ `prevStateHash` computed via draft `serializeState`; `stateHash` after draft `reduce`; both via `sha256`. |
| Write idempotency: log `(groupId, actionSeq, eventId)`, query history before retry | ✅ `agent_game_write_log` UNIQUE + `retryPendingWrite` history re-check. |
| LLM/chain failures use backoff, never burst the quota | ✅ `WRITE_BACKOFF_MS = [2s,5s,15s,30s]`; parse attempts capped at 3; budget counters gate further calls. |
| `start` consent card (actor, MetaApp, groupId, gameId, hashes, protocol paths, TTL, budget); deny → `consent_denied` | ✅ `ConsentManager.requestAuthorization` + `AgentGameConsentCard`. |
| Grant bound to `resourceUri+actorId+appId+groupId+gameId+rulesHash+adapterHash+seat` | ✅ Composite PK on `agent_game_grants`. |
| Grant persisted, revocable, expiring; auto-pause on expiry/budget | ✅ `upsertGrant`/`revokeGrant`; `isExpiredOrDepleted` in the loop. |
| Auto-write only hits `protocolPaths` in the grant; others → manual confirmation | ✅ `isAutoWriteAuthorized` requires exact `/protocols/<name>` AND membership in the grant's `protocolPaths`. Composes with — does not bypass — `botBrowserBridgeService` validation. |
| Authorization + write audit log | ✅ `agent_game_audit` table; `session-start`/`consent-granted`/`consent-denied`/`action-write`/`session-stop`/`match-finished` events. |
| Adapter in Worker/restricted VM; no network/fs/wallet/bridge/other groups | ✅ `worker_threads` Worker with a frozen, capability-free RPC surface; `resourceLimits`. |
| Limit execution time, memory, output size | ✅ 5s per-call wall-clock; 64MB old-gen heap; 1MB output (2MB in-worker secondary). |
| Verify `adapterHash` at load; immutable for session lifetime | ✅ Hash verified on the main thread before Worker start; reload rejected. |
| Unapproved adapter → spectator-only; auto-write needs authorization | ✅ No write occurs without a valid grant; consent gates `start`. |
| Persist session/grant/cursor/pending writes | ✅ All four persisted (sessions, grants, write-log, `lastIndex` cursor). |
| Restart order: load unfinished → verify grant → catch-up → lease → running; conflict stays paused | ✅ `recover()`. |
| Terminal/expired sessions not auto-restarted | ✅ Only `running`/`paused` are recovered; `finished`/`stopped` are left as-is. |
| Lease key `(groupId, seat)`, heartbeat renew | ✅ `LeaseRegistry`; heartbeat at TTL/3 in `housekeeping`. |
| `pause` keeps lease; `stop`/terminal release lease | ✅ `pause` only sets status; `stop`/`finish` call `releaseSession`/`release`. |
| LLM via MetaBot stack from main process, not iframe; 120s/180s timeouts; `reasoning_content` fallback | ✅ `chatCompletionWithTools` reuse; fallback already in `coworkOpenAICompatProxy`. |

### Explicit "do not do" (from the prompt)

| Item | Honored? |
|---|---|
| Do not implement chess / gomoku rules | ✅ No game rules; everything is the Adapter. |
| Do not modify the `agent-game/1` protocol | ✅ Consumed read-only. |
| Do not modify the group-chat backend | ✅ Only a post-insert notification hook; backend/transport untouched. |
| Do not put Runtime logic in the MetaApp iframe | ✅ All runtime logic is main-process; the iframe is untouched. |

---

## 5. Self-test evidence

Every module has a runnable smoke test (executed during development with
stubbed deps). All passed. The evidence below summarizes what was observed.

### 5.1 Static checks

```
tsc --noEmit                       (renderer)   EXIT 0, 0 errors
tsc -p electron-tsconfig.json      (main)       EXIT 0, 0 errors
tsc -p electron-tsconfig.json      (compile)    EXIT 0, 0 errors
eslint src/main/agentGame + new renderer files   EXIT 0, 0 warnings
```

### 5.2 Adapter sandbox

- Hash verified, ESM adapter loaded, ABI smoke (`initialState` → `serializeState`
  + `getTurn`), `reduce`, `parseAction`, `validateAction` all succeed.
- `adapterHash` mismatch → `adapter_invalid`.
- Missing exports → `adapter_invalid` (via the Worker `__load__` handshake).
- Per-call timeout + output cap enforced on the main thread.

### 5.3 Lease registry

- acquire → ok; 2nd session same seat → rejected with `conflictSessionId`.
- Same-session re-acquire issues a fresh `leaseId` (fencing token).
- `renew` extends TTL; `isHolder` reflects it.
- Expired lease is reclaimable by a new session.
- `releaseSession` + `sweep` clean up.

### 5.4 Consent manager

- `requestAuthorization` emits `consentRequired`; `respond(approve)` builds a
  `SessionConsent` with correct `seat` / `resourceUri` / `protocolPaths`.
- `respond(deny)` → denied; `cancel` → denied with reason.
- `isAutoWriteAuthorized`: authorized path → `true`; unauthorized path
  (`/protocols/evil`) → `false`; grant status/expiry enforced.
- Grant persistence round-trip (`upsertGrant` → `getGrant`) with `protocol_paths`.

### 5.5 Session store

- Session round-trip including JSON columns (`protocolPaths`, `consent`,
  `lastError`, serialized state).
- Idempotent write-intent: duplicate `recordWriteIntent` ignored (UNIQUE);
  `markWriteStatus('committed')`; `isWriteCommitted` → `true`.
- `listActiveGroupIds` / `listRecoverableSessions` correct.
- Audit insert works.

### 5.6 Runtime (end-to-end)

Stubbed deps (in-memory message store, deterministic stub LLM, echo chain-write,
stub manifest) + the minimal test adapter:

```
FINAL: status=finished seq=2 writes=2 llm=2 uniqueWrites=true
ACCEPTANCE: PASS
```

- Match runs from `running` to `finished`.
- 2 actions written, `actionSeq`s `[1, 2]` — each exactly once.
- LLM called once per move; budget counters increment.
- Terminal releases the lease.
- Conflict on an already-running seat → `session_conflict`.

---

## 6. Out of scope / follow-up

1. **Real dual-host integration test.** The prompt asks for "真实双宿主联调结果".
   This is blocked on ABC shipping the latest version that forwards
   `browser.app.session.*`. The host side is complete and unit-verified; the
   forwarder seam is documented in `index.ts` (`handleSessionMethod`).
2. **`manifestFetch` / `adapterPathFor`.** Currently resolve from the cached
   MetaApp artifact dir (`getMetaAppArtifactDir`) and read `game-manifest.json`.
   When a real game ships a `metafile://` manifest URI that needs direct
   content resolution, extend `resolveAgentGameManifest` in `main.ts`.
3. **Backfill-path intake.** Realtime socket push notifies the runtime via the
   hook; the history backfill service also inserts rows, and the runtime's own
   `recover()` + periodic loop cover gaps. If a backfill-only message must be
   notified in real time, the same hook can be wired into
   `groupChatBackfillService` (one-line addition).
4. **Merge.** Not pushed. Merge into `main` with `git merge --no-ff` when
   approved.

---

## 7. How to run the verification

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots-agent-game-runtime

# Static type checks
npx tsc --noEmit                              # renderer
npx tsc --project electron-tsconfig.json      # main process

# Lint
npx eslint src/main/agentGame --ext .ts --max-warnings 0
npx eslint src/renderer/components/agentGame src/renderer/services/agentGame.ts \
          src/renderer/store/slices/agentGameSlice.ts src/renderer/types/agentGame.ts

# Full electron compile (the build's compile step)
npm run compile:electron
```

The per-module smoke tests were ad-hoc node scripts run during development
(bundle the file with esbuild, exercise it against a sql.js in-memory DB); they
are not committed as formal test files. They can be re-extracted from the
dev-session transcript if a maintainer wants them checked in.
