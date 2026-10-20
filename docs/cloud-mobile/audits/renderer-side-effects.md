# REQ-A-2 Audit — Renderer Startup and Periodic Side Effects

**Date:** 2026-10-21. **Branch:** `feat/server-mode` (merge of `feat/ipc-registry`,
`feat/ipc-contract`, `feat/gateway`), audited at commit `7808fe45`.
**All `file:line` citations are against this worktree.**

Requirement under audit: **REQ-A-2** (`docs/cloud-mobile/10-ws-a-idbots-server-mode.md:110-118`).
Server mode (`IDBOTS_SERVER_MODE=1`) creates no `BrowserWindow`, does not quit when no
window exists, and never waits for `startup:rendererInitialized`. Every startup or
periodic side effect that today runs **only** in the renderer must be identified and
given a verdict:

- **`main-side-must`** — server mode needs this provisioning/behavior to run in the
  main process. Each maps to a REQ-A-8 step or a new one; these become REQ-A-8's scope.
- **`main-side-already`** — the main process already performs this on its own
  initiative; the renderer call is only a manual trigger or a status read.
- **`ui-only`** — pure UI/data refresh; no server-mode action needed (some are
  desktop-only features that REQ-A-4/REQ-A-5 explicitly keep out of server mode).

Method: `src/renderer/App.tsx` mount/boot effects reviewed one by one; every
`setInterval`/`setTimeout` in `src/renderer` classified; every renderer IPC call that
triggers main-process provisioning traced into its main-side handler; first-run flows
(`WelcomeFlow`, free-quota bootstrap) traced end to end. Data loading (list reads,
session restores, Redux hydration) is listed but marked `ui-only` without deep
analysis, per the audit's focus on side effects.

---

## TL;DR

- **6 `main-side-must` items** (details and REQ-A-8 mapping in §7):
  1. Free-quota LLM provisioning (`ensureFreeQuotaProvisioning` → `llmRelay:bootstrap`)
     — today runs **only** in the renderer. → REQ-A-8 step 2.
  2. Twin MetaBot on-chain creation — today gated behind a user click in `WelcomeFlow`.
     → REQ-A-8 step 3.
  3. Traffic account ensure + bind all bots (+ free-grant claim, redeem code) — today
     triggered only from the Traffic settings view. → REQ-A-8 steps 5–6.
  4. First-run locale/config seeding (`i18nService.initialize`). → folded into
     REQ-A-8's `IDBOTS_BOOTSTRAP_LOCALE` handling (no new step).
  5. Network-restored reconnect of IM gateways — today driven by the browser's
     `online` event in the renderer. → new sub-step (suggest folding into step 7).
  6. **The task scheduler start is gated on the first window's `ready-to-show`**
     (`main.ts:17818-17828`) — a main-side window gate, not a renderer effect.
     → server mode must start the scheduler without a window.
- **2 `main-side-already` items:** MetaWeb listener auto-start (`main.ts:18111-18119`)
  and the welcome-bot guide seeding (`welcomeBootstrap.ts`).
- **The remaining 26 inventoried items are `ui-only`** — including the 30-minute
  app-update check loop, which REQ-A-4 keeps out of server mode.
- **Biggest surprise:** a fresh install gets its free LLM provider **exclusively**
  from the renderer boot path, and the twin + traffic account are created even later
  (user click / settings visit). With no window, an unmodified tenant would boot with
  no identity-signed provider, no twin, and no traffic account.
- **What main gates on renderer readiness:** almost nothing — the
  `startup:rendererInitialized` handler only logs (§5). **One real exception:** the
  task scheduler start (and cowork-store heavy maintenance) sits behind the first
  window's `ready-to-show` (`main.ts:17818-17828`) and must be hoisted main-side for
  server mode. All deferred startup tiers are time-based.

---

## 1. `App.tsx` mount/boot effects

The boot effect is `useEffect` at `src/renderer/App.tsx:268-409` (guarded by
`hasInitialized` at `App.tsx:269-272`). Effects below are listed in execution order.

### 1.1 `coworkService.init()` — `ui-only`

- **Site:** `src/renderer/App.tsx:185-187` (app-level, so permission prompts enqueue
  even when `CoworkView` never mounts).
- **What:** loads cowork config + session list and subscribes to main→renderer stream
  channels (message / stream update / permission request / permission resolved /
  complete / error). `src/renderer/services/cowork.ts:139-146`, listeners
  `cowork.ts:149-341`.
- **When:** App mount.
- **Verdict:** `ui-only`. In server mode the stream consumers are the gateway clients
  (REQ-A-14) and main keeps its own permission-pending list (`mobile:permission:listPending`,
  REQ-A-11). The renderer listener is not what makes main-side turns run.

### 1.2 `configService.init()` — `ui-only` (data)

- **Site:** `src/renderer/App.tsx:280`.
- **What:** reads the `app_config` store row over IPC and normalizes it in memory;
  writes happen only via `updateConfig`. `src/renderer/services/config.ts:654-697`.
- **Verdict:** `ui-only`. Note for the main-side bootstrap: the provisioned-provider
  write of §1.3 lands in the same `app_config` row, so main must write the identical
  shape (`providers[metaid-free]` + `model.defaultModel/defaultProvider`,
  `llmFreeQuotaBootstrap.ts:95-119`) rather than a parallel config.

### 1.3 `themeService.initialize()` — `ui-only`

- **Site:** `src/renderer/App.tsx:286`. Theme/mode application. `ui-only`.

### 1.4 `ensureFreeQuotaProvisioning()` — **`main-side-must` → REQ-A-8 step 2**

- **Site:** `src/renderer/App.tsx:288-293` (before `i18nService.initialize()` on
  purpose — i18n writes a full config snapshot back, `App.tsx:295-299`).
- **What:** fresh-install bootstrap of the built-in free LLM provider.
  - Gate: `planFreeQuotaProvisioning` — bootstrap only when the provider is
    unconfigured **and** the metabot roster is empty; idempotency comes from the
    written provider config. `src/renderer/services/llmFreeQuotaBootstrap.ts:131-162`,
    gate at `src/renderer/services/llmFreeQuotaGate.js:216-221`.
  - Renderer calls `window.electron.llmRelay.bootstrap()`
    (`llmFreeQuotaBootstrap.ts:154`), channel `llmRelay:bootstrap`, main handler
    `src/main/services/llmRelayService.ts:466-468` → `bootstrapLlmRelay()`
    (`llmRelayService.ts:411-428`).
  - Main side: `ensureUserIdentity()` (`llmRelayService.ts:363-389`) **creates the
    local user identity when missing** (`createUserIdentity`, `deferChainSync: true`,
    `llmRelayService.ts:372-373`) — this is also what REQ-A-8 step 1 needs. Then an
    identity-signed `POST /v2/assist/llm/bootstrap` returns `{apiKey, baseUrl, models}`.
  - The renderer then writes the provider into `app_config` via
    `configService.updateConfig` and sets it as the default model
    (`llmFreeQuotaBootstrap.ts:95-119`).
- **When:** every App boot; does network work only on a fresh install (no provider +
  no metabots).
- **Verdict:** `main-side-must`. **Today this provisioning happens only because the
  renderer exists.** Server mode must replicate the whole flow main-side: fresh-install
  gate (provider absent **and** zero metabots), identity creation, signed bootstrap
  call, and the `app_config` provider/default-model write. Mapped to REQ-A-8 step 2
  (`llmProvider`); its identity side feeds step 1 (`identity`).

### 1.5 `i18nService.initialize()` — **`main-side-must`** (locale seeding; folded into REQ-A-8 locale input)

- **Site:** `src/renderer/App.tsx:299`.
- **What:** on first run (`language_initialized` absent) detects the OS locale and
  **writes `language` + `language_initialized` into `app_config`**
  (`src/renderer/services/i18n.ts:6242-6285`); legacy users with a custom language are
  migrated the same way.
- **When:** every boot; writes only on first run / legacy migration.
- **Verdict:** `main-side-must` (small). Main reads the persisted language in several
  places (e.g. group-task copy via `getPersistedAppLanguage`,
  `src/main/main.ts:5157`), and REQ-A-8 step 3's "default persona in the user's
  locale" presumes a seeded locale. Server mode should write the same two config keys
  from `IDBOTS_BOOTSTRAP_LOCALE` during bootstrap; no new REQ-A-8 step needed, but it
  must be recorded in the bootstrap state so a crash mid-seed resumes correctly.

### 1.6 `apiService.setConfig` + provider→Redux model list — `ui-only` (data)

- **Site:** `src/renderer/App.tsx:304-348`. In-memory API config + Redux hydration.
  `ui-only`.

### 1.7 `scheduledTaskService.init()` / `groupTaskService.init()` / `longTermTaskService.init()` — `ui-only` (data + subscriptions)

- **Site:** `src/renderer/App.tsx:350-364` (one `Promise.all`).
- **What:** each subscribes to its main→renderer push channel and loads its board.
  `src/renderer/services/scheduledTask.ts:25-31`,
  `src/renderer/services/groupTaskService.ts:35-43`,
  `src/renderer/services/longTermTask.ts:40-46` (plus the 30 s fallback poll, §4).
- **Verdict:** `ui-only`. The schedulers/daemons that actually fire tasks live in main
  (`src/main/libs/scheduler.ts`, started in the deferred startup tier,
  `src/main/main.ts:4021`); these renderer services only mirror state into Redux.

### 1.8 Welcome-flow gate (`metabot.list()`) — `ui-only` (data read)

- **Site:** `src/renderer/App.tsx:366-384`. Reads the roster; a machine with no Twin
  Bot gets `WelcomeFlow` (`App.tsx:1289-1295`).
- **Verdict:** `ui-only` as a renderer behavior. The *decision it makes* ("no twin →
  onboarding") is exactly the condition REQ-A-8 step 3 evaluates main-side
  (`if no twin exists`), so it is subsumed by §2.1, not a separate item.

### 1.9 Persisted session restore (`coworkService.loadSession`) — `ui-only` (data)

- **Site:** `src/renderer/App.tsx:386-397`. `ui-only`.

### 1.10 `reportRendererStartupComplete()` (`startup:rendererInitialized`) — `ui-only` (and must not be waited on)

- **Site:** `src/renderer/App.tsx:205-211`, fired at `App.tsx:399` (success) and
  `App.tsx:404` (init error — reported even on failure).
- **What:** invoke of `startup:rendererInitialized`; main handler
  `src/main/main.ts:10040-10047` only logs startup timing and returns
  `{success, elapsedMs, startedAt}`. **Nothing in main awaits or branches on it**
  (verified by full-tree search; §6).
- **Verdict:** `ui-only`. Server mode: channel must simply never be invoked and never
  waited for (REQ-A-2). The gateway already denies it —
  `src/main/gateway/allowlist.ts:285` ("the mobile shim answers locally; the gateway
  denies it (REQ-A-2)").

### 1.11 Default-model persistence effect — `ui-only` (config write on user action)

- **Site:** `src/renderer/App.tsx:473-486`. Writes `model.defaultModel` /
  `model.defaultProvider` to `app_config` when the Redux selection changes after boot.
- **Verdict:** `ui-only`. Server mode has no model picker; the default comes from
  bootstrap step 2. (Same `app_config` row as §1.3/§1.5 — main must not let concurrent
  writes clobber the provisioned provider; the desktop ordering hazard is documented
  at `App.tsx:295-299`.)

### 1.12 Network status monitor → IM gateway reconnect — **`main-side-must`** (new sub-step; suggest folding into step 7)

- **Site:** `src/renderer/App.tsx:420-437` — listens to the browser's `online` /
  `offline` events and `ipcRenderer.send`s `network:status-change`.
- **Main side:** `src/main/main.ts:9931-9941` — on `online`,
  `imGatewayManager.reconnectAllDisconnected()`. The manager's own docstring says it
  is "Called when network is restored via IPC event"
  (`src/main/im/imGatewayManager.ts:145-169`).
- **When:** browser network-flap events, app lifetime.
- **Verdict:** `main-side-must`. In server mode no browser `online` events exist, so
  the designed reconnect path has no trigger. Main needs its own connectivity watch
  (e.g. on listener-socket close or a periodic probe) calling
  `reconnectAllDisconnected()`. Not a tenant-readiness blocker (IM gateways are
  user-configured, unlike the MetaWeb listener), so a new numbered step is optional —
  folding it into step 7's "listener/gateway liveness" scope is sufficient; record the
  decision in REQ-A-8.

### 1.13 Agent-Game consent listeners — `ui-only`

- **Site:** `src/renderer/App.tsx:985-1003` (`setupListeners` + `listPendingConsent`
  rehydrate). Subscriptions + data. `ui-only`.

### 1.14 App-update check loop (30 min) + silent download — `ui-only` (desktop-only; OFF in server mode per REQ-A-4)

- **Site:** `src/renderer/App.tsx:1170-1202` — `maybeCheck()` on init, then
  `window.setInterval(..., UPDATE_HEARTBEAT_INTERVAL_MS)` at `App.tsx:1186` (both 30
  min, `src/renderer/services/appUpdate.ts:13-14`), plus a `visibilitychange` re-check.
- **What:** `checkForAppUpdate()` fetches `https://idbots.ai/update.json`
  (`src/renderer/services/appUpdate.ts:105-140`,
  `src/renderer/services/endpoints.ts:6`) through the main HTTP bridge; when an update
  exists it silently downloads and installs via the `appUpdate:*` IPC family
  (`App.tsx:742-788`, `App.tsx:870-949`).
- **Verdict:** `ui-only` — **not** a server-mode duty. REQ-A-4 lists auto-update among
  the desktop subsystems server mode skips, and the tenant image updates out-of-band
  (WS-C). Server mode must simply never start this loop (no renderer → no loop;
  confirm no main-side update check is added).

### 1.15 Tray-menu event listeners — `ui-only` (desktop-only)

- **Site:** `src/renderer/App.tsx:1109-1123` (`appEvents.onOpenSettings`,
  `appEvents.onNewTask`). Tray is desktop-only (REQ-A-4). `ui-only`.

### 1.16 Bot Browser shell listeners — `ui-only` (desktop-only)

- **Site:** `src/renderer/App.tsx:618-704` (`useBotBrowserShell` + `botBrowser:*`
  subscriptions). Bot Browser is disabled in server mode (REQ-A-5). `ui-only`.

---

## 2. First-run-only flows

### 2.1 Twin MetaBot creation (`WelcomeFlow`) — **`main-side-must` → REQ-A-8 step 3**

- **Site:** rendered when no Twin exists, `src/renderer/App.tsx:1289-1295` (gate at
  `App.tsx:375-384`, also re-offered after a mid-flow reload via
  `isOnboardingEnterPending()`).
- **What:** on the "Enter IDBots" **click** (`src/renderer/components/onboarding/WelcomeFlow.tsx:203-225`):
  1. `ensureTwinBot()` (`WelcomeFlow.tsx:132-166`): adopts an existing Twin, else
     resolves the brain — provisioned free provider's first model, else the configured
     default (`WelcomeFlow.tsx:106-119`) — then
     `window.electron.idbots.createMetaBotOnChain({...})` (`WelcomeFlow.tsx:148-159`)
     with the built-in persona constants (`WelcomeFlow.tsx:22-32`). This is the same
     handler REQ-A-8 step 3 names (`idbots:createMetaBotOnChain`); chain failure keeps
     the bot locally and a retry adopts it (`WelcomeFlow.tsx:127-134`, `160-165`).
  2. `coworkService.init()` (`WelcomeFlow.tsx:217`) — idempotent, see §1.1.
  3. `createTwinGreetingSession()` (`WelcomeFlow.tsx:175-187`) →
     `cowork:session:createGreeting`, main handler `src/main/main.ts:10968-10982`
     (implementation `src/main/services/onboardingGreeting.ts`): creates the first
     chat and runs one real greeting agent turn in main.
- **When:** first run, explicitly click-gated; nothing happens at mount.
- **Verdict:** step 1 is `main-side-must` → REQ-A-8 step 3 (`twinMetabot`), including
  the adopt-on-retry semantics and the "resume a pending chain setup" requirement.
  Steps 2–3 are `ui-only`: the greeting chat is a desktop UX nicety; tenant readiness
  does not depend on it (product note: decide whether the mobile client's first open
  should create a greeting session via the allowlisted `cowork:session:createGreeting`,
  `src/main/gateway/allowlist.ts:72`, or leave the first chat user-created).

### 2.2 Onboarding pending flag — `ui-only`

- **Site:** `markOnboardingEnterPending` / `clearOnboardingEnterPending`,
  `WelcomeFlow.tsx:209-210`, `219`, `228`; persisted view state
  (`src/renderer/services/viewState.ts`). Renderer-reload recovery for the flow.
  `ui-only` (server bootstrap records state in the DB per REQ-A-8 instead).

---

## 3. Renderer-initiated IPC that triggers main-process provisioning

### 3.1 `llmRelay:bootstrap` — the provisioning core of §1.4 — **`main-side-must`**

- **Call sites:** boot `src/renderer/services/llmFreeQuotaBootstrap.ts:154`; manual
  opt-in `enableFreeQuotaManually()` (`llmFreeQuotaBootstrap.ts:80-91`) behind the
  Settings free-quota card (`src/renderer/components/FreeQuotaCard.tsx:80-91`).
- **Main side:** `src/main/services/llmRelayService.ts:466-468` →
  `bootstrapLlmRelay()` (`llmRelayService.ts:411-428`) → identity creation
  (`llmRelayService.ts:363-389`) + signed `POST /v2/assist/llm/bootstrap`
  (`llmRelayService.ts:12`, `420-428`).
- **Verdict:** `main-side-must` (REQ-A-8 step 2; also the identity feeder for step 1).
  The manual card trigger itself is `ui-only` — a user action the server bootstrap
  subsumes.

### 3.2 Free-quota quota fetch + provider-catalog sync — `ui-only` (with a staleness note)

- **Site:** `src/renderer/components/FreeQuotaCard.tsx:49-86` — on settings open,
  `llmRelay:getQuota` (`src/main/services/llmRelayService.ts:470-476`) then
  `syncFreeProviderCatalogFromQuota()` (`src/renderer/services/llmFreeQuotaBootstrap.ts:48-73`),
  which rewrites `providers[metaid-free].models` from the relay directory carried in
  the quota response (planner: `src/renderer/services/llmFreeQuotaGate.js:223-243`).
- **Verdict:** `ui-only` (settings card data + config sync). **Staleness note:** today
  the catalog only moves forward when someone opens the Model settings; a headless
  tenant's catalog freezes at bootstrap time. Not a REQ-A-8 blocker (the bootstrapped
  default model stays valid), but if WS-D's directory drifts, a periodic main-side
  quota/catalog refresh may be wanted later — flag for REQ-A-8 review, not a step.

### 3.3 Traffic account ensure/bind/claim/redeem — **`main-side-must` → REQ-A-8 steps 5–6**

- **Call sites:** `src/renderer/components/traffic/TrafficSettings.tsx`:
  - **Mount effect, conditional:** `useEffect` at `TrafficSettings.tsx:552` — only if
    the persisted fee mode is already `traffic`, it fires `trafficApi.ensureAccount()`
    then `trafficApi.bindAllBots()` (`TrafficSettings.tsx:566-567`).
  - User-click handlers: free-grant claim (`TrafficSettings.tsx:729`),
    redeem code (`TrafficSettings.tsx:759`), manual ensure+bind
    (`TrafficSettings.tsx:647-653`).
- **Main side** (`src/main/services/trafficAccountService.ts`, registered at
  `trafficAccountService.ts:1374-1505`): `traffic:ensureAccount` (`:1376`) →
  `ensureTrafficAccount()` get-or-create (`:581-586`) → signed
  `POST /v1/traffic/accounts` (`:588-…`); `traffic:bindAllBots` (`:1418`) →
  `bindAllLocalBots()` (`:663`); `traffic:claimFreeGrant` (`:1478`) →
  `claimFreeGrant()` (`:1101-1127`); `traffic:redeemCode` (`:1485`) →
  `redeemTrafficCode()`. All require the user identity (`requireIdentity`), i.e. they
  depend on bootstrap step 1.
- **When:** mount of the Traffic settings view (only in `mode==='traffic'`) or button
  clicks.
- **Verdict:** `main-side-must`. **Surprise:** on desktop, a fresh install with the
  default fee mode never calls any of this — the traffic account is created only when
  the user has already switched to traffic mode and opens the settings. So REQ-A-8
  steps 5–6 are *new* main-side behavior (ensure + bind + grant claim + redeem), not a
  port of an existing always-run path. Maps to step 5 (`trafficAccount`) and step 6
  (`redeemCode`).

### 3.4 MetaWeb listener start — `main-side-already` (with a fresh-tenant ordering caveat)

- **Call sites:** start/restart button `src/renderer/components/listenerHub/ListenerHubView.tsx:94-109`
  (click-gated); toggles `src/renderer/components/im/IMSettings.tsx:156-173`.
- **Main side:** auto-starts in `initApp` from stored config —
  `src/main/main.ts:18111-18119` (`getListenerConfigFromStore`,
  `main.ts:2963-2966`); reapplied on config change (`main.ts:10705-10722`); readiness
  plan `ensurePrivateChatListenerReady` (`main.ts:3018-3047`) self-heals from daemon
  paths. Defaults: `enabled=true, privateChats=true`
  (`src/main/services/metaWebListenerReadiness.ts:22-29`), so `shouldRunListener` is
  true on a fresh install.
- **Verdict:** `main-side-already` for "the listener runs without the renderer" —
  REQ-A-8 step 7 mostly formalizes ordering and failure policy. **Caveat:** on a fresh
  tenant the `initApp` auto-start fires before any Twin exists (it runs right after
  store init, `main.ts:18111-18119`, long before bootstrap step 3 would create the
  Twin), and `planPrivateChatListenerReadiness` refuses to start without a local
  `globalMetaId` (`metaWebListenerReadiness.ts:44-56`). Step 7 must therefore (a) run
  after step 3 and (b) verify the listener actually came up, retrying if the first
  attempt raced the twin creation.

### 3.5 Welcome-bot onboarding guide seeding — `main-side-already`

- **What:** `src/main/libs/welcomeBootstrap.ts:34-62` seeds a writable
  `Bootstrap.md` copy in userData from the bundled guide, read by the Welcome Bot
  runner. Pure main-side; no renderer trigger. REQ-A-8 needs nothing (the doc comment
  at `welcomeBootstrap.ts:1-11` describes it as on-first-use seeding).
- **Verdict:** `main-side-already`.

---

## 4. Periodic timers started in the renderer

Full `setInterval`/`setTimeout` sweep of `src/renderer`; every hit classified. None
of these provision, sync chain state, or start services — they are UI refresh,
debounce, or animation timers, all `ui-only`:

| # | Timer | Site | Purpose | Verdict |
|---|-------|------|---------|---------|
| 1 | 30 min interval + visibility re-check | `App.tsx:1170-1202` (interval at `App.tsx:1186`) | App-update check (§1.14) | `ui-only` (desktop-only, REQ-A-4) |
| 2 | 30 s fallback poll | `src/renderer/services/longTermTask.ts:83-89` | Backstop for missed `longtermTask:update` pushes | `ui-only` |
| 3 | 60 s fallback poll | `src/renderer/services/metatask.ts:77-83` | Backstop for missed `metatask:update` pushes | `ui-only` |
| 4 | 3 s interval | `src/renderer/components/cowork/CoworkSessionDetail.tsx:3039` | Git-branch probe for the current session cwd (stops after 3 failures) | `ui-only` |
| 5 | 5 s interval | `src/renderer/components/groupTasks/GroupTaskDetailView.tsx:345` | Group-task detail/message refresh backstop | `ui-only` |
| 6 | interval | `src/renderer/components/Sidebar.tsx:320-333` | OpenTeam collab list refresh on the records tab | `ui-only` |
| 7 | interval | `src/renderer/components/groupTasks/OpenTeamCollabsSection.tsx:255` | Same, in the group-tasks view | `ui-only` |
| 8 | interval | `src/renderer/components/groupTasks/OpenTeamCollabDetailView.tsx:73` | Collab detail refresh | `ui-only` |
| 9 | interval | `src/renderer/components/traffic/TrafficSettings.tsx:861` | Pending recharge-order status poll | `ui-only` |
| 10 | 1 min tick | `src/renderer/components/cowork/CoworkSessionList.tsx:214` | Relative-time labels | `ui-only` |
| 11 | debounce | `src/renderer/services/cowork.ts:567` (stream flush), `cowork.ts:644` (session-list reload) | Renderer store batching | `ui-only` |
| 12 | animation/countdown timers | `AssistantActivityIndicator.tsx:59`, `MetaBotDeleteConfirmModal.tsx:40`, and view-scoped `setTimeout`s | UI | `ui-only` |

The daemons with real periodic work (scheduler, private-chat/group-task daemons,
Gig Square sync, service-order scans, SQLite maintenance, provider discovery) all
live in main and are started from `initApp` / the deferred startup tiers
(`src/main/main.ts:3710-3743`, `3753-3770`, `4021-4022`) — no renderer involvement.

---

## 5. What `main.ts` currently gates on renderer readiness

Searched `src/main/main.ts` for `rendererInitialized`, `whenReady`, splash/loading
gates, and `webContents` load events:

1. **`startup:rendererInitialized`** — handler `src/main/main.ts:10040-10047` logs
   "renderer initialization complete" and returns timing info. **It is informational
   only: nothing in main awaits, branches, or defers on it** (verified by
   full-worktree search for the channel and any `onRendererReady`-style promise). The
   renderer calls it once, after boot settles or fails (`App.tsx:399`, `App.tsx:404`).
   Server-mode action: none beyond not waiting (REQ-A-2) and the existing gateway
   denial (`src/main/gateway/allowlist.ts:285`).
2. **Deferred startup tiers** — `scheduleStartupTier` (`main.ts:3728`) schedules
   "message daemons" (+2 s, `main.ts:4021`) and "idle background work" (+7 s,
   `main.ts:4022`), plus "IM gateway reconnect" (+7 s, `main.ts:18342`). All are
   **time-based from `initApp`**, not renderer-signaled. Server mode keeps them as-is
   (they need no window); REQ-A-33's jitter applies to what they start.
3. **First-window `ready-to-show` one-time init** — `main.ts:17818-17828`: the first
   window's `ready-to-show` gates `scheduleCoworkStoreHeavyMaintenance()`,
   `createTray(...)`, **`getScheduler().start()`**, and `startSleepGuardRefresh()`
   behind `didInitAppOnce`. Tray and sleep guard are desktop-only (REQ-A-4), but the
   **task scheduler and the cowork-store heavy maintenance currently cannot start
   without a window**. This is the one place where main genuinely gates runtime work
   on window/renderer readiness; server mode must hoist the scheduler (and, per
   REQ-A-11's unattended scheduled sessions, must start it) plus the heavy
   maintenance out of this handler into the server bootstrap path.
4. **Window lifecycle events** — `did-finish-load` (`main.ts:17672-17676`) drives
   startup logging/loading-state only. They exist solely because a window exists;
   server mode creates none (REQ-A-2).
5. **`app.whenReady()`** (`main.ts:18059`) and `waitForStore()` (e.g. the `store:set`
   handler, `main.ts:9917-9921`) are main-process-internal; no renderer dependency.
6. **`window-all-closed` quits the app off-macOS** (`main.ts:18382-18386`). With no
   window in server mode this fires immediately if registered — REQ-A-2 ("does not
   quit when no window exists") requires guarding this branch in server mode.
7. REQ-A-22 scaffolding already present: the gateway starts from `initApp` in server
   mode and fails fast if it cannot (`main.ts:18086-18104`).

## 6. Notes for REQ-A-8 implementation (from the findings above)

- The bootstrap state machine should record: provider-provisioned (step 2), locale
  seeded (§1.5), twin created/adopted + pending-chain-setup resumed (step 3),
  traffic ensure/bind/claim/redeem done (steps 5–6), listener verified running
  (step 7, after twin exists — see §3.4 caveat).
- All main-side steps must tolerate "already done" because desktop today may have
  done them through the renderer paths (fresh-install gate §1.4, adopt-on-retry
  §2.1, get-or-create §3.3 are already idempotent in spirit).
- `app_config` concurrency: steps 2, locale seeding, and any model write hit the same
  store row; serialize them (the desktop ordering hazard is documented at
  `App.tsx:295-299`).

## 7. The `main-side-must` list (REQ-A-8 scope)

| # | Item | Today (file:line) | REQ-A-8 mapping |
|---|------|-------------------|-----------------|
| 1 | Free-quota LLM provider bootstrap (incl. identity creation + `app_config` provider/default-model write) | `App.tsx:293` → `llmFreeQuotaBootstrap.ts:131-162` → `llmRelayService.ts:411-428` | Step 2 `llmProvider` (feeds step 1 `identity`) |
| 2 | Twin MetaBot on-chain creation (adopt-on-retry, pending chain-setup resume, default persona in bootstrap locale) | `WelcomeFlow.tsx:132-166` (click) → `idbots:createMetaBotOnChain` | Step 3 `twinMetabot` |
| 3 | Traffic account ensure + bind all bots + free-grant claim + redeem code | `TrafficSettings.tsx:552-567`, `729`, `759` → `trafficAccountService.ts:581-586`, `663`, `1101` | Steps 5 `trafficAccount` + 6 `redeemCode` |
| 4 | First-run locale/config seeding (`language`, `language_initialized`) | `App.tsx:299` → `i18n.ts:6242-6285` | Fold into REQ-A-8 locale handling (`IDBOTS_BOOTSTRAP_LOCALE`); record in bootstrap state |
| 5 | Network-restored IM gateway reconnect | `App.tsx:421-437` → `main.ts:9931-9941` → `imGatewayManager.ts:147-169` | New sub-step or fold into step 7; main-side connectivity watch required |
| 6 | Task scheduler start + cowork-store heavy maintenance (currently behind first-window `ready-to-show`) | `main.ts:17818-17828` | New server-mode branch: start without a window (REQ-A-11 depends on the scheduler); fold into REQ-A-8 as a step-7 sibling or a guarded `didInitAppOnce` equivalent in the server bootstrap |

Steps already covered without new work: step 4 `workspace` (no renderer equivalent
exists today; pure new main-side config), step 7 listener start is `main-side-already`
(§3.4) with the ordering caveat.

## 8. Surprises

1. **The free provider is renderer-only.** Nothing in main ever bootstraps the LLM
   relay; without the window, a fresh tenant has no brain at all. This is the single
   most critical item — it is REQ-A-8 step 2.
2. **Traffic provisioning is lazier than the doc implied.** Desktop creates the
   traffic account only from the Traffic settings view and only when fee mode is
   already `traffic`; steps 5–6 are genuinely new main-side behavior, not parity.
3. **The listener auto-start races the twin on a fresh tenant.** `initApp` starts it
   (`main.ts:18113-18119`) before any bot exists, while the readiness plan refuses to
   start without a local `globalMetaId` (`metaWebListenerReadiness.ts:44-56`). Step 7
   must re-verify after step 3 — on desktop this hole is masked because the listener
   long outlives the welcome click.
4. **`startup:rendererInitialized` gates nothing — but `ready-to-show` does.** The
   rendererInitialized handler is a log line's worth of contract (REQ-A-2's "never
   waits" is a removal, not a rework), and the deferred tiers are time-based. The real
   window gate is the first window's `ready-to-show`, which owns `didInitAppOnce`
   (`main.ts:17818-17828`): without a window the **task scheduler never starts** and
   scheduled tasks (REQ-A-11 background sessions) never fire. Server mode must hoist
   the scheduler (and decide on heavy maintenance) into the bootstrap path.
5. **Config-row contention.** Three independent writers (provider provisioning,
   locale seeding, default-model persistence) share the `app_config` row through
   whole-snapshot writes today; the main-side bootstrap must serialize them or it can
   reproduce the clobbering hazard the renderer ordering comment
   (`App.tsx:295-299`) exists to prevent.
