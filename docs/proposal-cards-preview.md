# Bot Action Card preview

This isolated Electron preview mounts the actual IDBots `Sidebar` and `CoworkSessionDetail` components, including the existing composer. `MessageExtensionContext` adds a Bot Action Card beneath the assistant reply and defaults to no extension in production. The card exposes actor, action, target, write impact, explicit non-effects, editable instruction, immutable confirmation, execution state, receipt, and the expected BotBrowser output URI. It does not boot the production main process, access Bot identities, or call a model. Session data and IPC reads are explicit in-memory fixtures, not live application state.

## Run

```sh
npx vite build --config vite.proposal-demo.config.ts
node_modules/.bin/electron scripts/proposal-demo.cjs
```

Review the acting Bot, action target and impact, edit the instruction, and confirm the local preview. The fixture advances through running to a successful execution receipt with a `preview-metaapp://` output. Reset example clears only this demo confirmation and receipt. The isolated Electron profile is `.proposal-demo-data` in this worktree. Other navigation, composer actions and BotBrowser navigation are not connected; the banner explains this boundary. The P2P offline indicator describes the isolated fixture, not the user's live IDBots.

## Integration boundary

`BotActionCard` accepts a versioned request, initial confirmation/receipt and asynchronous confirmation and output callbacks. Mount a new request with a new React key. The example adapter uses localStorage; production must persist confirmations and receipts in the session backend and deduplicate by session, request and version before continuing a model turn. Client-side gating alone does not guarantee exactly-once execution across windows or crashes.

The production Cowork tool renderer, DSH service, BotBrowser router and model tool registration are not connected yet. The successful receipt is explicitly fixture data. The preview now separates intent confirmation from the simulated `allowed-once` approval step; production must replace that button with the existing permission panel and DSH `idbots/approval/respond` flow. The next implementation step is a validated Bot action envelope, durable confirmation/receipt IPC, session-bound rendering, action execution and trusted BotBrowser handoff. The existing permission/question flow remains separate.

## Verification

Decision tests cover edits, provenance, duplicate acceptance, stale versions and invalid input. Visual acceptance should include selection, editing, submission, reload, reset, light and dark themes.

Native preview verification: full renderer TypeScript check, scoped ESLint, production preview build, and 3 decision tests passed. Electron accessibility inspection confirmed the native sidebar, session header, composer, DeepSeek preview model label, Gallery selection, read-only submission receipt, and persistence after restart/reload. Dark-theme and narrow-window interaction checks remain pending. The build retains existing CSS syntax and chunk-size warnings. Network requests are blocked by the preview main process and CSP; no production preload is installed.
