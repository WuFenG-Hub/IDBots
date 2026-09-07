# Interactive proposal cards preview

This isolated Electron preview mounts the actual IDBots `Sidebar` and `CoworkSessionDetail` components, including the existing composer. `MessageExtensionContext` adds the card beneath the assistant reply and defaults to no extension in production. It does not boot the production main process, access Bot identities, or call a model. Session data and IPC reads are explicit in-memory fixtures, not live application state.

## Run

```sh
npx vite build --config vite.proposal-demo.config.ts
node_modules/.bin/electron scripts/proposal-demo.cjs
```

Choose a proposal, edit its headline and accent, add instructions, and submit. Inspect the structured handoff and reload to verify persistence. Reset example clears only this demo decision. The isolated Electron profile is `.proposal-demo-data` in this worktree. Other navigation and composer actions are not connected; the banner explains this boundary. The P2P offline indicator describes the isolated fixture, not the user's live IDBots.

## Integration boundary

`ProposalCard` accepts a versioned request, an initial decision and an asynchronous host submission callback. Mount a new request with a new React key. The example adapter uses localStorage; production must persist decisions in the session backend and deduplicate by session, request and version before continuing a model turn. Client-side gating alone does not guarantee exactly-once execution across windows or crashes.

The production Cowork tool renderer and model tool registration are not connected yet. No fake model completion is displayed. The next implementation step is a validated proposal tool, durable decision IPC, session-bound rendering and turn continuation. The existing permission/question flow remains separate.

## Verification

Decision tests cover edits, provenance, duplicate acceptance, stale versions and invalid input. Visual acceptance should include selection, editing, submission, reload, reset, light and dark themes.

Native preview verification: full renderer TypeScript check, scoped ESLint, production preview build, and 3 decision tests passed. Electron accessibility inspection confirmed the native sidebar, session header, composer, DeepSeek preview model label, Gallery selection, read-only submission receipt, and persistence after restart/reload. Dark-theme and narrow-window interaction checks remain pending. The build retains existing CSS syntax and chunk-size warnings. Network requests are blocked by the preview main process and CSP; no production preload is installed.
