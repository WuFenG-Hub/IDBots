# ABC Theme Integration Handoff

Status: **waiting for a published Agent Browser Core npm release**

This document records the IDBots consumer work required after Agent Browser Core (ABC) publishes its native theme contract. It intentionally does not guess unreleased API names or message payloads.

## Current Baseline

- IDBots directly pins these packages at `0.3.10`:
  - `@openagentinternet/agent-browser-core`
  - `@openagentinternet/agent-browser-host-contract`
  - `@openagentinternet/agent-browser-name-resolvers`
  - `@openagentinternet/agent-browser-ui`
- `src/renderer/services/theme.ts` resolves the IDBots preference to an effective `light` or `dark` theme.
- `src/renderer/features/botBrowser/BotBrowserSurface.tsx` builds the ABC page as `srcDoc` and owns parent-to-iframe messaging.
- ABC `0.3.10` does not expose a native theme render option or a runtime theme message contract.

Do not add IDBots-owned dark CSS, HTML color rewriting, or iframe inversion as a permanent integration. ABC owns its Browser chrome and page presentation; IDBots owns host theme selection and delivery.

## Upstream Release Gate

Do not start the consumer implementation until the published npm package can answer all of the following:

| Required fact | Upstream value |
| --- | --- |
| Published ABC version | `TBD` |
| Packages that must move together | `TBD` |
| Theme type import path | `TBD` |
| Initial render option and import path | `TBD` |
| Runtime theme message helper or constant | `TBD` |
| Exact runtime message payload | `TBD` |
| Default behavior when theme is omitted | `TBD` |

Confirm the version exists on npm before editing the consumer:

```bash
npm view @openagentinternet/agent-browser-ui@<ABC_VERSION> version
```

If upstream changes the proposed contract, use the published types and release handoff as source of truth. Do not preserve placeholder names from this document.

## Consumer Implementation

### 1. Update the exact ABC package set

Update `package.json` and `package-lock.json`. Preserve exact versions without `^` or `~`. Move all packages that upstream declares release-coupled, then verify both direct and transitive ABC packages:

```bash
npm ls \
  @openagentinternet/agent-browser-core \
  @openagentinternet/agent-browser-host-contract \
  @openagentinternet/agent-browser-name-resolvers \
  @openagentinternet/agent-browser-ui \
  @openagentinternet/agent-browser-renderers
```

Do not infer installed correctness from `package.json` alone. The manifest, lockfile, installed tree, and built renderer must agree.

### 2. Make effective theme observable

Extend `src/renderer/services/theme.ts` with an effective-theme subscription API. The callback should receive `light` or `dark` after:

- an explicit IDBots theme change;
- a `system` preference resolving to a new OS theme;
- initial subscription, so a consumer can render the correct first frame.

The subscription must return an unsubscribe function and must not expose the internal `MediaQueryList`.

### 3. Pass theme through the app shell

In `src/renderer/App.tsx`, subscribe to the effective theme and pass it to `BotBrowserSurface` as a typed prop. IDBots should normally pass the resolved `light` or `dark` value, so ABC matches the exact theme already applied to the host shell.

### 4. Render the first ABC frame with the theme

In `src/renderer/features/botBrowser/BotBrowserSurface.tsx`, call the published ABC render API with the current effective theme when creating `srcDoc`.

Acceptance requirement: opening Bot Browser in dark mode must never paint an intermediate light ABC frame.

### 5. Synchronize runtime changes without rebuilding

Use the official ABC message helper, constant, and type from the published package. Do not duplicate ABC message string literals when an exported helper exists.

When the effective IDBots theme changes:

- send the official theme message to `iframeRef.current.contentWindow`;
- keep the existing Browser iframe and page state alive;
- do not rebuild `srcDoc`;
- do not navigate away from the current URI;
- queue the latest theme while ABC is not ready, then flush it after `browser-ready`;
- update the mounted Browser even while Bot Home is selected and Browser is hidden.

Only the latest pending theme matters. Repeated changes before readiness should coalesce to one value.

### 6. Keep MetaApp content independent

Do not inject styles into `iframe.browser-html-frame`, rewrite MetaApp assets, or apply filters to the outer Browser iframe. ABC dark mode covers ABC-owned chrome and pages. A MetaApp remains responsible for its own `prefers-color-scheme` behavior.

## Verification

Add focused regression coverage for:

1. Initial light rendering.
2. Initial dark rendering without a light first frame.
3. Theme changes after `browser-ready` use the official ABC message.
4. Theme changes before readiness queue and flush only the latest value.
5. Theme changes do not replace the iframe or lose the active Browser URI.
6. A mounted but hidden Browser receives theme updates.
7. `system` changes from the OS propagate through `themeService`.
8. MetaApp iframe markup and sandbox behavior remain unchanged.

Run the repository gates with Node.js 24:

```bash
npm run build
npm run compile:electron
```

Also run the focused Bot Browser tests and inspect the real Electron UI in both light and dark modes. Cover at least the Welcome page, Bot Page, PIN page, settings/modal state, Bot Home switch, and collapsed navigation state.

## Completion Checklist

- [ ] Replace every `TBD` above with the published upstream facts.
- [ ] Confirm npm availability before changing dependency pins.
- [ ] Preserve exact-version dependency policy.
- [ ] Implement initial and runtime theme delivery using only public ABC APIs.
- [ ] Keep MetaApp content outside host theme rewriting.
- [ ] Pass focused tests, Electron compile, production build, and visual checks.
- [ ] Inspect the built renderer bundle to confirm the new ABC theme code is present.
- [ ] Commit the integration and publish the required development journal.

After completion, change this document's status to **integrated**, record the consumed ABC version and commit hash, and replace the release-gate table with the final public contract.
