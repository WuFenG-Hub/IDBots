# Copy-Paste Prompt — Native Shell Development Agent

```text
You are the development Agent for the IDBots native mobile shell. Work on the user's computer in the existing IDBots repository, not a new repository.

Repository:
/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots

Your task is to implement NS0 — Native Shell Foundation, then stop for independent review. Do not implement NS1/NS2/NS3 in this branch.

Read these first, in order:
1. /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/AGENTS.md
2. /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/cloud-mobile/HANDOFF.md
3. /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/cloud-mobile/native-shell/README.md
4. /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/cloud-mobile/native-shell/01-architecture-and-requirements.md
5. /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/cloud-mobile/native-shell/02-implementation-plan.md
6. /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/cloud-mobile/native-shell/03-acceptance-and-handoff.md

If docs/cloud-mobile/native-shell is not yet merged into main, read the same package at:
/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/cloud-mobile-native-shell/docs/cloud-mobile/native-shell/README.md
Do not edit that planning worktree.

Architecture decisions that are not optional:
- Keep development in IDBots under a new independent mobile-shell/ pnpm package. Do not create another repository.
- Use Capacitor Android/iOS shells around the deployed remote PWA; do not use React Native or rewrite a native product UI.
- Preserve the PWA and all browser fallbacks.
- The tenant-hosted IDBots main process remains responsible for Agent, LLM, skills, memory, wallet, chain, sessions, tasks, files, and workspaces. The shell and control plane must not acquire that business logic.
- Normal traffic continues through the existing PWA fetch/WebSocket and window.electron/C2 paths. Do not create a second native API client.
- Use staging.idbots.world by default and an explicit app.idbots.world production flavor. Restrict privileged WebView navigation to the intended HTTPS origin and provide a bundled offline/error page.
- Establish a versioned local native-adapter bootstrap and prove it is available before remote React use on both platforms. Do not assume remote injection works without evidence.
- Do not edit frozen 01-interface-contracts.md or 02-ipc-allowlist-v1.md. Local shell capabilities are not C2 channels.
- Push notifications, camera/share implementation, and broad lifecycle work are outside NS0.

Execution requirements:
1. Start from current main with one branch and same-named worktree:
   git worktree add -b feat/mobile-shell-foundation .worktrees/mobile-shell-foundation main
2. Read any applicable AGENTS.md before editing. Keep all IDBots edits inside this repository.
3. Use pnpm only. mobile-shell/ has its own package.json, pnpm-workspace.yaml, and lockfile. It must not enter root postinstall or Electron packaging. Update root AGENTS.md and CLAUDE.md together for the new package.
4. Confirm the selected Capacitor/plugin versions and available Android/iOS toolchains rather than assuming them. Do not silently add unrelated dependencies.
5. Keep code, comments, UI copy, documentation, and commit messages in English; user-facing mobile copy supports English and Chinese.
6. Add focused tests using the repository's existing conventions. Prove origin restrictions, offline behavior, adapter bootstrap, Capacitor detection, and unchanged browser fallback.
7. Run the NS0 verification in 02-implementation-plan.md, including Android/iOS debug builds and WebView smoke where toolchains exist. Missing SDK/device/account is NOT RUN, never a pass; do not claim native acceptance without the two-platform proof.
8. For root changes, run the applicable standard/mobile regression commands. Do not weaken tests, increase timeouts to hide a failure, or remove required coverage.
9. Commit small verified units using <type>: <short description>. Publish the required English metabot-post-buzz development journal for every commit.
10. Do not push, merge into main, deploy, use owner signing secrets, submit to a store, or release to users.

Deliver back:
- branch/worktree path, base/final SHAs, and commit list;
- changed files and NS0 requirement mapping;
- exact test/build commands and actual results;
- Android/iOS artifacts and WebView evidence where available;
- any NOT RUN items, open issues, and S1/S2/S3 findings;
- a delivery note suitable for independent review.
Stop after NS0. Do not start NS1 until the owner accepts and merges NS0.
```

## Handoff Note

After the native documentation package is merged, the canonical `docs/cloud-mobile/native-shell/` paths in the prompt work directly from any fresh `main` worktree. Until then, the fallback absolute planning-worktree path lets the development Agent begin without editing the planning branch.

For NS1, NS2, and NS3, reuse this prompt with the corresponding branch, worktree, scope, verification, and exit criteria from `02-implementation-plan.md`. Start each later package only after the preceding package is accepted and merged into `main`.
