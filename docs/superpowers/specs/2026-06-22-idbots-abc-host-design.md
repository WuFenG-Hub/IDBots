# IDBots ABC Host Integration Design

**Date:** 2026-06-22
**Project:** IDBots
**Status:** Confirmed design, pending user review

---

## 1. Goal

Embed Agent Browser Core (ABC) into IDBots so IDBots becomes an ABC host inside the existing Electron app, while keeping the current IDBots experience intact as a peer-level mode.

The user should experience one application with two top-level modes:

- `Bot Home`: the current IDBots application surface
- `Bot Browser`: a full ABC browser surface with its own address bar, toolbar, history, and acting-bot selector

The integration target for Phase 1 is not "make IDBots look a bit like a browser." The target is:

1. IDBots can switch into a real embedded ABC browser mode.
2. Bot Home and Bot Browser can deep-link into each other.
3. ABC can see local IDBots bots as host actors.
4. ABC bot actions such as opening a conversation can route back into IDBots's existing conversation UI.

This design explicitly reuses OAC's ABC consumption shape at the host-adapter level, but not OAC's `/browser` route-hosting architecture.

---

## 2. Confirmed Decisions

### 2.1 Product Surface Model

IDBots and Bot Browser are two peer-level surfaces inside one Electron app.

The app shell always keeps a very light top switch strip visible with:

- `Bot Home`
- `Bot Browser`

The body below that strip switches between:

- the current IDBots UI, and
- the embedded ABC browser UI.

ABC keeps its own toolbar and browser chrome. The outer shell does not merge, replace, or absorb ABC's toolbar.

### 2.2 Shell Visual Weight

The switch strip should follow the lightweight `B2` direction confirmed during visual review:

- very thin and visually light,
- no strong host header,
- no extra workspace branding in the strip,
- visible in both modes,
- present enough to switch modes, but not strong enough to weaken the "real browser" feel.

### 2.3 Browser Lifecycle

Within one app lifetime:

- first entry into `Bot Browser` lazily initializes the ABC surface,
- switching back to `Bot Home` hides the ABC surface,
- the ABC surface stays alive in memory,
- switching back to `Bot Browser` restores the previous ABC state.

Across full app restart:

- the first entry into `Bot Browser` should open ABC with no explicit target,
- ABC should show its own default browser home behavior,
- IDBots should not restore the prior browser page after restart.

### 2.4 No-Bot Guard

If there is no local bot, IDBots blocks entry into `Bot Browser` before ABC is shown and displays the existing IDBots-style guidance that the user must create a bot first.

This is an IDBots responsibility, not an ABC responsibility.

### 2.5 Acting Bot Semantics

In this feature, "acting bots" means only ABC's existing acting-bot selector surface in the browser UI. It is not a separate homepage concept and it is not a reinitialization flow.

Phase 1 default actor rule:

- `defaultActor = the first local bot in IDBots's existing local bot list order`

No cross-restart acting-bot restore is required in Phase 1.

### 2.6 Bot Entry Semantics

From `Bot Home`:

- clicking a **local bot avatar** opens that bot's bot page in `Bot Browser` and switches ABC's acting bot to that bot.
- clicking a **remote bot avatar** opens that bot's bot page in `Bot Browser` and does not change the current acting bot.

The avatar is the browser-open affordance. Existing card body behavior such as edit/detail stays with the rest of the card.

### 2.7 MetaApp Entry Semantics

From `Bot Home`, clicking MetaApp `Run` switches to `Bot Browser` and opens the corresponding MetaApp page in ABC.

This does not change the current acting bot.

### 2.8 Browser-to-Home Conversation Semantics

When the user triggers `open conversation` or `private chat` from a remote bot page inside ABC:

- the app switches back to `Bot Home`,
- IDBots opens its existing conversation UI,
- the local side of the conversation is the current ABC acting bot,
- the remote side is the bot currently being viewed in ABC.

Example:

- acting bot = `Bot A`
- viewed remote bot = `Bot X`
- browser action = `open conversation`

Result:

- IDBots opens the `Bot A <-> Bot X` A2A/private conversation in Bot Home.

No outbound message is auto-sent just because the page action was clicked. The action opens or reuses the local conversation surface.

### 2.9 OAC Reuse Boundary

Reuse from OAC is limited to:

- ABC package consumption shape,
- host adapter contract shape,
- runtime snapshot mapping,
- trusted-action semantics.

Do not copy OAC's browser-serving model:

- no `/browser` route shell,
- no local daemon page-hosting dependency,
- no OAC-style route injection as the primary IDBots integration form.

---

## 3. Existing Repo Context

This design is anchored to the current IDBots structure.

### 3.1 Current App Shell

`src/renderer/App.tsx` currently owns the top-level renderer shell and switches the main content through:

- `cowork`
- `metaapps`
- `skills`
- `scheduledTasks`
- `metabots`
- `gigSquare`

This is the natural insertion point for the new `Bot Home / Bot Browser` top shell mode.

### 3.2 Current Local Bot Surface

`src/renderer/components/metabots/MetabotsManager.tsx` loads the local bot list via `window.electron.metabot.list()` and sorts it by `created_at`.

`src/renderer/components/metabots/MetaBotListCard.tsx` already renders the bot avatar, name, and GlobalMetaID and currently makes the whole card clickable for edit.

This is the primary Bot Home local-bot entry surface that needs avatar-specific browser deep-link behavior.

### 3.3 Current Bot Hub Surface

`src/renderer/components/gigSquare/GigSquareView.tsx` and `src/renderer/components/gigSquare/GigSquareServiceCard.tsx` render remote provider/service cards.

Today the whole service card opens the service/order flow. The provider avatar is rendered but is not a separate browser-open entry.

Phase 1 should add a distinct avatar/browser entry there without breaking the existing service card behavior.

### 3.4 Current MetaApp Surface

`src/renderer/components/metaapps/MetaAppsManager.tsx` and `src/renderer/components/metaapps/metaAppLaunch.js` currently launch a MetaApp through the existing local MetaApp open flow.

`src/renderer/types/metaApp.ts` shows that local MetaApp records may carry:

- `sourcePinId`
- `codePinId`
- `sourceType`

This is sufficient for a canonical ABC URI when `sourcePinId` exists.

### 3.5 Current Conversation Surface

`src/renderer/services/cowork.ts` already loads and navigates Cowork sessions.

`src/renderer/types/cowork.ts` and `src/main/coworkStore.ts` already model:

- `sessionType: 'standard' | 'a2a'`
- `peerGlobalMetaId`
- `peerName`
- `peerAvatar`

This means IDBots already has the right underlying conversation model for browser-triggered A2A/private-chat entry, but it does not yet expose a clean "open or reuse peer conversation" renderer-facing API.

### 3.6 Current Main/Preload Boundary

`src/main/main.ts`, `src/main/preload.ts`, and `src/renderer/types/electron.d.ts` are the natural place to add any new high-level IPC needed for:

- ensuring or creating an A2A session for a `(localMetabotId, peerGlobalMetaId)` pair,
- exposing that helper back to the renderer.

---

## 4. External Reference Boundary

### 4.1 OAC Reference

OAC consumes ABC through:

- `src/daemon/browser/oacBrowserHostAdapter.ts`
- `src/browser/page.ts`
- `src/browser/app.ts`
- `src/daemon/routes/ui.ts`

That implementation shows the correct host-contract layering:

- runtime snapshot generation,
- resource resolution via ABC core,
- trusted-action dispatch,
- a thin shell around ABC UI.

### 4.2 ABC Reference

ABC already exposes the host/runtime contract needed by IDBots:

- `@openagentinternet/agent-browser-host-contract`
- `@openagentinternet/agent-browser-core`
- `@openagentinternet/agent-browser-ui`

Relevant ABC contract facts already exist:

- `BrowserHostKind` includes `idbots`
- `BrowserActorKind` includes `idbots-agent`
- `BrowserRuntimeSnapshot.defaultUri` is nullable
- `BrowserTrustedActionKind` / `BrowserResolveActionKind` include `open-conversation`
- supported browser URIs include `metaid://`, `metaapp://`, `metafile://`, `map://`, and `pin://`

For MetaApps, the canonical ABC page URI is `metaapp://{pinId}` when a stable MetaApp pin ID exists.

---

## 5. Architecture

### 5.1 Layer 1: IDBots App Shell

Add a new outer shell mode above the current `mainView` switching logic:

- `surfaceMode: 'home' | 'browser'`

Responsibilities:

- render the very light top `Bot Home / Bot Browser` switch strip,
- decide which peer-level surface is visible,
- block browser entry when no local bot exists,
- keep the embedded browser mounted after first initialization,
- route high-level browser intents into the browser bridge.

`Bot Home` is the current IDBots application.

`Bot Browser` is the ABC surface.

### 5.2 Layer 2: Bot Home Surface

`Bot Home` remains the current IDBots UI and does not take on browser behavior.

Its responsibility in this feature is to emit browser navigation intents from selected entry points:

- local bot avatar
- remote bot avatar
- MetaApp run button
- future browser-capable entry points

It should not know ABC component internals.

### 5.3 Layer 3: Bot Browser Surface

The ABC browser UI should be rendered directly inside the renderer tree as a dedicated persistent surface.

Requirements:

- lazy mount on first browser entry,
- stay mounted after initialization,
- hidden when `surfaceMode === 'home'`,
- preserve ABC internal state while hidden,
- no route-hosted `/browser` server shell,
- no separate Electron `BrowserView` for Phase 1.

### 5.4 Renderer Module Split

Phase 1 should introduce a dedicated renderer feature area, for example:

- `src/renderer/features/botBrowser/BotBrowserSurface.tsx`
- `src/renderer/features/botBrowser/BotBrowserModeSwitch.tsx`
- `src/renderer/features/botBrowser/botBrowserShellController.ts`
- `src/renderer/features/botBrowser/botBrowserBridge.ts`
- `src/renderer/features/botBrowser/botBrowserHostAdapter.ts`
- `src/renderer/features/botBrowser/conversationNavigationAdapter.ts`
- `src/renderer/features/botBrowser/types.ts`

Exact filenames may vary, but the boundary must stay the same.

### 5.5 `botBrowserShellController`

This controller belongs to the IDBots outer shell.

It owns:

- current `surfaceMode`,
- whether the browser surface has been initialized,
- browser entry guard checks,
- high-level browser intents.

It does not know how ABC internally opens a resource.

Its public responsibilities are roughly:

- `openBrowserHome()`
- `openBotPage(...)`
- `openMetaApp(...)`
- `switchToHome()`

### 5.6 `botBrowserBridge`

This bridge is the thin imperative boundary between the shell controller and the live ABC surface instance.

It translates high-level shell intents into ABC operations such as:

- ensure browser ready,
- open a normalized ABC URI,
- switch current acting actor,
- restore visible state.

This avoids scattering direct ABC refs and browser-specific imperative calls across multiple renderer components.

### 5.7 `botBrowserHostAdapter`

This is the IDBots-to-ABC translation layer and is the most important reuse point from OAC.

Responsibilities:

- expose an ABC `BrowserRuntimeSnapshot`
- map local IDBots bots to ABC actors
- set `host.kind = 'idbots'`
- set `defaultActor = first local bot`
- set `defaultUri = null` for first-entry ABC default home behavior
- resolve supported browser resources using ABC core conventions
- implement supported trusted actions by delegating into IDBots host capabilities

This adapter is a host-contract translator, not a shell controller and not a UI component.

### 5.8 `conversationNavigationAdapter`

This adapter is the ABC-to-IDBots reverse bridge.

Responsibilities:

1. receive a browser trusted action like `open-conversation` or `private-chat`,
2. resolve the current local acting bot,
3. ensure or create the corresponding local A2A/private conversation session,
4. switch the app back to `Bot Home`,
5. navigate the current UI into that session.

This adapter should live in the renderer, but it should use one new high-level main/preload helper to ensure the session exists.

### 5.9 New Main/Preload Conversation Helper

Phase 1 should add one new high-level IPC helper in the Cowork domain, for example:

```ts
window.electron.cowork.ensureA2ASession({
  metabotId,
  peerGlobalMetaId,
  peerName?,
  peerAvatar?,
})
```

Expected semantics:

- if an A2A/private conversation already exists for `(metabotId, peerGlobalMetaId)`, return it,
- otherwise create one with the correct local bot and remote peer metadata,
- do not auto-send a message,
- return enough session info for the renderer to load/navigate to it.

This keeps conversation persistence in the main process where Cowork session truth already lives.

### 5.10 Dependency Ingestion Strategy

Phase 1 should consume ABC as package dependencies, not by copying OAC source files into IDBots.

Target package boundary:

- `@openagentinternet/agent-browser-host-contract`
- `@openagentinternet/agent-browser-core`
- `@openagentinternet/agent-browser-ui`

Development may point IDBots to local package paths during integration, but the architectural boundary remains package-based.

Do not vendor or fork OAC's browser HTML shell as the primary integration pattern.

---

## 6. Navigation Intent Contract

Bot Home and Bot Browser should communicate through a small intent contract.

### 6.1 Intent Set

Phase 1 only needs four high-level intents:

```ts
type BotBrowserIntent =
  | { type: 'openBrowserHome' }
  | {
      type: 'openBotPage';
      uri: string; // usually metaid://{globalMetaId}
      switchActingBotToLocalMetabotId?: number | null;
    }
  | {
      type: 'openMetaApp';
      uri: string; // metaapp://{sourcePinId}
    }
  | {
      type: 'openConversationInHome';
      localMetabotId: number;
      peerGlobalMetaId: string;
      peerName?: string | null;
      peerAvatar?: string | null;
    };
```

These are design-level shapes, not mandatory final symbol names.

### 6.2 Canonical URI Rules

Phase 1 should normalize external targets into ABC URIs before they reach the bridge:

- bot page: `metaid://{globalMetaId}`
- MetaApp page: `metaapp://{sourcePinId}`

If a MetaApp record does not have a stable `sourcePinId`, it has no canonical ABC page URI for Phase 1. In that case the app must not fake a browser URI.

Recommended Phase 1 behavior for such MetaApps:

- either keep the current local open flow,
- or show a concise "not available in Bot Browser" message.

Do not invent a synthetic scheme just to force unsupported local MetaApps into ABC.

---

## 7. Key Interaction Flows

### 7.1 Top Switch: `Bot Browser`

```text
user clicks Bot Browser
-> shell controller checks local bot count
-> if 0: show existing IDBots-style create-bot guidance and stop
-> if browser not initialized: mount ABC surface with no explicit target URI
-> switch visible surface to Bot Browser
-> ABC shows its own default home behavior
```

### 7.2 Local Bot Avatar

```text
user clicks local bot avatar in Bot Home
-> emit openBotPage(metaid://{botGlobalMetaId}, switchActingBotToLocalMetabotId={botId})
-> shell switches to Bot Browser
-> bridge ensures browser ready
-> bridge switches acting bot
-> bridge opens the bot page
```

### 7.3 Remote Bot Avatar

```text
user clicks remote bot avatar in Bot Hub
-> emit openBotPage(metaid://{remoteGlobalMetaId}, no acting-bot switch)
-> shell switches to Bot Browser
-> bridge opens the remote bot page
-> acting bot remains unchanged
```

### 7.4 MetaApp Run

```text
user clicks Run on a browser-capable MetaApp with sourcePinId
-> emit openMetaApp(metaapp://{sourcePinId})
-> shell switches to Bot Browser
-> bridge opens the MetaApp page
-> acting bot remains unchanged
```

### 7.5 Browser `open conversation` / `private chat`

```text
user clicks browser action on remote bot page
-> ABC host adapter normalizes the action into openConversationInHome
-> conversationNavigationAdapter reads current acting bot
-> ensureA2ASession(localMetabotId, peerGlobalMetaId, peerName, peerAvatar)
-> shell switches to Bot Home
-> coworkService.loadSession(sessionId)
```

The browser action opens or reuses the local conversation UI. It does not automatically send a greeting or handshake message just by opening the conversation.

---

## 8. Host Adapter Mapping

### 8.1 Host Identity

Phase 1 runtime snapshot should report:

- `host.kind = 'idbots'`
- `host.name = 'IDBots'`
- `host.localMode = true`

### 8.2 Actor Mapping

Each local IDBots bot should map to an ABC actor of kind `idbots-agent`.

At minimum each actor mapping should include:

- stable actor id
- local bot id
- display name
- GlobalMetaID
- avatar
- capability set relevant to browser actions

The adapter should treat the existing IDBots local bot list as the source of truth for available actors.

### 8.3 Default Actor

The adapter sets:

- `defaultActor = first local bot in current IDBots bot list order`

This deliberately avoids Phase 1 complexity such as last-used actor restore.

### 8.4 Default URI

The adapter sets:

- `defaultUri = null`

That allows first browser entry after app startup to land on ABC's own default browser home behavior rather than forcing a bot page.

### 8.5 Trusted Actions

Phase 1 required trusted-action behavior:

- `open-conversation` -> supported
- `private-chat` -> supported and normalized to the same local open/reuse conversation flow

Phase 1 optional/disabled behavior:

- `service-call` should remain disabled unless it is fully wired into an IDBots-native order flow during implementation

It is better to hide or explicitly reject an unsupported browser action than to surface a broken CTA.

### 8.6 Feature Flags

Phase 1 runtime feature posture should be conservative:

- `privateChat: true`
- `serviceCall: false` unless fully implemented
- other browser-local capabilities can stay enabled only when they do not depend on missing host behavior

The implementation should prefer "capability advertised only when real" over optimistic feature flags.

---

## 9. Phase 1 Scope

Phase 1 is complete when all of the following are true:

1. IDBots has a persistent outer `Bot Home / Bot Browser` shell.
2. Bot Browser embeds the full ABC browser UI in the renderer.
3. Browser mode is lazily initialized and preserved in memory while hidden.
4. Local IDBots bots appear in ABC as acting-bot choices.
5. Clicking the top `Bot Browser` switch opens ABC default home.
6. Clicking a local bot avatar opens that bot page and switches acting bot.
7. Clicking a remote bot avatar in Bot Hub opens that bot page without switching acting bot.
8. Clicking MetaApp `Run` opens the MetaApp in Browser when a canonical browser URI exists.
9. Clicking `open conversation` or `private chat` in Browser returns to Bot Home and opens the correct local conversation UI.

Phase 1 intentionally does **not** include:

- browser state restore across full app restart
- last-used acting-bot restore
- merging ABC toolbar into IDBots shell
- OAC-style `/browser` route hosting
- separate Electron `BrowserView`
- broad service-order/service-call parity
- deep Browser/Home state synchronization beyond the required entry flows

---

## 10. Phase 2 Direction

After Phase 1 lands, follow-up work can extend:

- fuller trusted-action coverage,
- service-call integration with IDBots order/session flows,
- more Home-to-Browser deep links,
- more Browser-to-Home reverse links,
- richer actor/session synchronization,
- eventual extraction toward a stronger standalone browser product surface.

Phase 2 should build on the same shell-controller / bridge / host-adapter split rather than replacing it.

---

## 11. Error Handling

### 11.1 No Local Bots

Block browser entry before ABC mount and show the existing create-bot guidance.

### 11.2 Browser Initialization Failure

If the ABC surface fails to initialize:

- keep the app in `Bot Home`,
- show a concise IDBots toast or inline error,
- do not leave the app in a half-switched blank shell.

### 11.3 Unsupported MetaApp Browser URI

If a MetaApp lacks a canonical ABC URI such as `metaapp://{sourcePinId}`:

- do not manufacture a fake browser target,
- either keep the existing open flow or show an unsupported-in-browser message,
- do not route the user into a broken browser page.

### 11.4 Missing Acting Bot for Reverse Action

If ABC requests `open-conversation` but there is no resolvable local acting bot:

- reject the action with a clear host error,
- keep the user in Browser,
- do not open an arbitrary conversation with the wrong local identity.

### 11.5 Conversation Session Creation Failure

If `ensureA2ASession(...)` fails:

- keep the user in the current surface,
- surface a clear error,
- do not partially switch to Home without a valid target session.

---

## 12. Testing and Verification

### 12.1 Renderer/Unit Coverage

Add focused tests for:

- shell controller state transitions,
- browser entry guard behavior,
- intent normalization for local bot / remote bot / MetaApp,
- host adapter runtime snapshot generation,
- default actor selection from sorted local bot list,
- reverse-action normalization into `ensureA2ASession` requests.

### 12.2 Main/IPC Coverage

Add focused tests for the new conversation helper:

- reuse existing A2A/private session when present,
- create a new A2A/private session when absent,
- preserve `peerGlobalMetaId`, `peerName`, and `peerAvatar`,
- reject invalid local bot or invalid peer input.

### 12.3 Manual Electron Verification

Manual validation for Phase 1 should cover:

1. enter Browser from top switch on first launch,
2. switch back to Home and then back to Browser with state preserved,
3. click local bot avatar -> browser opens correct bot page and acting bot changes,
4. click remote bot avatar -> browser opens correct bot page and acting bot stays the same,
5. click MetaApp run -> browser opens correct MetaApp page when supported,
6. click browser `open conversation` -> app returns to Home and opens the expected A2A/private conversation.

---

## 13. Recommended File Touch Surface

The expected implementation surface for Phase 1 is intentionally narrow:

- `src/renderer/App.tsx`
- `src/renderer/components/metabots/MetaBotListCard.tsx`
- `src/renderer/components/metabots/MetabotsManager.tsx`
- `src/renderer/components/metaapps/MetaAppsManager.tsx`
- `src/renderer/components/metaapps/metaAppLaunch.js` or replacement browser-launch helper
- `src/renderer/components/gigSquare/GigSquareServiceCard.tsx`
- `src/renderer/components/gigSquare/GigSquareView.tsx`
- new `src/renderer/features/botBrowser/*`
- `src/main/main.ts`
- `src/main/preload.ts`
- `src/renderer/types/electron.d.ts`

The implementation should stay close to these surfaces and avoid unrelated app-shell refactors.

---

## 14. Recommendation

Proceed with the renderer-hosted persistent browser surface design:

- shell in `App.tsx`,
- ABC rendered as a persistent peer surface,
- OAC contract ideas reused only in the host adapter,
- one new high-level Cowork IPC helper for open/reuse conversation routing,
- Phase 1 constrained to the core dual-mode and deep-link flows above.

This is the smallest architecture that matches the requested user experience without overcommitting to a heavier Electron/browser-hosting model.
