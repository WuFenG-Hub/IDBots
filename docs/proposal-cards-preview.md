# Interactive proposal cards preview

This isolated Electron preview uses IDBots theme tokens and a reusable React component. It does not boot the production main process, access Bot identities, or call a model. The surrounding Cowork view is a demo fixture, not the production session renderer.

## Run

```sh
npx vite build --config vite.proposal-demo.config.ts
node_modules/.bin/electron scripts/proposal-demo.cjs
```

Choose a proposal, edit its headline and accent, add instructions, and submit. Inspect the structured handoff and reload to verify persistence. New example clears only this demo decision. The isolated Electron profile is `.proposal-demo-data` in this worktree.

## Integration boundary

`ProposalCard` accepts a versioned request, an initial decision and an asynchronous host submission callback. Mount a new request with a new React key. The example adapter uses localStorage; production must persist decisions in the session backend and deduplicate by session, request and version before continuing a model turn. Client-side gating alone does not guarantee exactly-once execution across windows or crashes.

The production Cowork tool renderer and model tool registration are not connected yet. No fake model completion is displayed. The next implementation step is a validated proposal tool, durable decision IPC, session-bound rendering and turn continuation. The existing permission/question flow remains separate.

## Verification

Decision tests cover edits, provenance, duplicate acceptance, stale versions and invalid input. Visual acceptance should include selection, editing, submission, reload, reset, light and dark themes.
