# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commit and Merge Rules

- If you notice unfamiliar or unrelated file changes, continue working and stay focused on your own scoped edits unless the user asks you to inspect them.
- All IDBots-related edits must stay within this IDBots project directory; modifying files outside the IDBots project is strictly forbidden.
- Unless the user explicitly asks to work on `main`, make every change on a new branch paired with a same-named worktree (path and name following project convention — e.g. branch `fix/foo` or `feat/foo` uses worktree `.worktrees/foo`); you do not need to ask for confirmation before creating it. Edit directly on `main` only when the user explicitly says so.
- If the task is a new change request or a new feature, and the current checkout is `main`, do not start editing in that working directory. Create a new branch named for the task together with a matching local worktree, then implement the work in that worktree. Skip this only when the user explicitly instructs you to make the change on `main`.
- Every new branch must be created together with a dedicated local worktree; use one worktree working directory per branch, and do not create or switch branches in the main working directory.
- All feature or temporary branches must branch directly from `main`; never create a new branch from another branch. Branch depth is capped at 1.
- When the user says "commit", stage and commit only the files you changed and understand.
- After each commit, do not push to the remote GitHub repository unless the user explicitly asks you to push.
- Prefer small, frequent commits. Commit each independent, verifiable unit of work as soon as it is complete.
- ** For every modification or newly added feature, create one commit. **
- For every commit, use Codex's `metabot-post-buzz` skill (not this repository's `SKILLs/metabot-post-buzz` implementation) to post a detailed development-journal entry on-chain describing the change.
- Use commit messages in the format `<type>: <short description>`, where `<type>` is one of `feat`, `fix`, `refactor`, `docs`, or `chore`.
- Before committing, make sure the relevant local tests or verification steps pass for your changes.
- When merging completed work into `main`, use `git merge --no-ff` to preserve the feature merge point.
- Do not merge a feature branch back into `main` on your own initiative; wait for an explicit user instruction to merge or close out the work.
- When the user asks to merge a branch back into `main`, after the merge you may delete that branch and its worktree without asking, provided the branch is now fully absorbed into `main` (safe to delete). Do not delete branches that still carry unmerged or uncommitted work.

## Language Conventions

- Write all documentation in English: Markdown docs, design notes, code comments, and commit messages.
- Default UI copy (labels, messages, and prompts shown in the app) must be in English.
- Development-journal entries posted on-chain via the `metabot-post-buzz` skill must be written in English.
- The defaults above apply unless the user explicitly requests another language for that specific artifact.
- When replying to the user or otherwise communicating with them, always use the user's own language.

## Package Manager

- Supported Node.js: `>=24 <25`.
- Package manager: pnpm only (pinned via `packageManager` in `package.json`; run `corepack enable` once). `pnpm-lock.yaml` is committed; never reintroduce `package-lock.json`.
- Three packages, three lockfiles: the repository root, `dsh-runtime/`, and `SKILLs/web-search/` are installed separately (`pnpm install` in each; the root `postinstall` covers the two nested ones automatically). pnpm settings live in each directory's `pnpm-workspace.yaml` (root and nested: hoisted `nodeLinker` + overrides + build approvals) — pnpm 11 ignores `.npmrc` for settings, so do not move them there.
- `nodeLinker: hoisted` is a hard requirement, not a preference: electron-builder packages production `node_modules` into the app and copies `dsh-runtime/` + `SKILLs/` (with their `node_modules`) as extraResources — the default isolated linker would ship symlinks into the developer's pnpm store and break the packaged app. Packages are still hard-linked from the global pnpm store, so per-worktree install cost stays near zero.
- Never call `npm install` / `npm ci` anywhere in this repository (root, CI, scripts, or nested packages); use `pnpm install --frozen-lockfile` so installs stay deterministic and store-backed.

## Worktree Closeout

- Every task branch lives in a git worktree under `.worktrees/<branch>`.
- Every automated verification flow (gate, wt, gt, rsi-audit, and similar agent-driven task runners) MUST remove its own worktree with `git worktree remove` when the task finishes — success or failure alike. Leftover worktrees are the main source of disk bloat; each one that survives keeps a full dependency checkout.
- After a branch merges back to `main`, remove its worktree and delete the branch immediately: `git worktree remove .worktrees/<branch> && git branch -d <branch>`.
- Regular maintenance entry point: `scripts/prune-worktrees.sh` lists every worktree whose branch is fully merged into `main` and, after confirmation, removes the worktrees and deletes the branches. `--dry-run` only lists; `--force` also removes merged worktrees that have uncommitted changes.
- A fresh worktree needs `pnpm install` in the root before building (the postinstall covers `dsh-runtime/` and `SKILLs/web-search/`); thanks to the shared pnpm store the install is fast and adds almost no new disk usage.

### Worktrees live on the external SSD

- Worktrees physically live on an external SSD: `.worktrees` is a symlink to `/Volumes/Seagate/MacWork/worktrees/IDBots`. Always create worktrees as `git worktree add .worktrees/<name> ...` — the symlink puts them on the SSD automatically; never invent other temp directories.
- While the `Seagate` volume is unmounted, every worktree add/remove/status operation over `.worktrees/` fails with a path error. That is expected behavior — remount the same-named volume and everything resumes; no repair is needed.
- The SSD is exFAT, which needs two accommodations on every fresh worktree: (1) the volume has no POSIX mode bits, so immediately after `git worktree add` run `git config extensions.worktreeConfig true` (once per clone) and `git -C .worktrees/<name> config --worktree core.filemode false` — otherwise every tracked file shows as phantom-modified; (2) macOS writes `._*` AppleDouble sidecar files next to real files — they are git-ignored via `.gitignore` and skipped by the kernel-patch scanner, so do not "clean them up" and never feed them to tools. pnpm installs on the SSD fall back from hard links to copy mode (the pnpm store stays on the internal disk and must NOT be moved) — slower installs are the expected tradeoff for the disk relief.

## Important Runtime Rules

- Windows NSIS uninstall policy is to preserve user data (`electron-builder.json` -> `nsis.deleteAppDataOnUninstall=false`); do not flip this unless a release explicitly requires destructive uninstall behavior.
- The team preference is `main` as the only long-lived shared branch. Temporary branches should be short-lived and deleted after merge.

## DSH Runtime Dependencies

- `dsh-runtime/` is a nested pnpm package with its own `package.json` / `pnpm-lock.yaml` / `node_modules`; the root `pnpm install` only reinstalls it via `postinstall`, and a plain `git pull` or merge does NOT reinstall it.
- After pulling, merging, or switching to any commit that touches `dsh-runtime/package.json`, `dsh-runtime/pnpm-workspace.yaml`, or `dsh-runtime/pnpm-lock.yaml`, immediately run `pnpm --dir dsh-runtime install`. A stale `dsh-runtime/node_modules` crashes the spawned DSH runtime process at plugin-load time (`ERR_MODULE_NOT_FOUND` / "JSON-RPC input closed").
- ANY command that reinstalls `dsh-runtime/node_modules` (`pnpm --dir dsh-runtime install`, including manual invocations) wipes the kernel patches under `scripts/dsh-kernel-patches/`. Re-run `node scripts/apply-dsh-kernel-patches.cjs` after it — the root `postinstall` does this automatically, but a manual install does NOT. A missing patch keeps builds and tests green and only shows up as a Windows runtime regression in the shipped package (the v0.9.3 bash.exe console-flash incident); `pnpm run check:dsh-deps` and `node scripts/apply-dsh-kernel-patches.cjs --check` both detect it.
- `pnpm run check:dsh-deps` (scripts/check-dsh-runtime-deps.cjs) verifies installed dsh-runtime packages match `package.json` AND that `dsh-runtime/pnpm-lock.yaml` is in sync with it (importer-block specs both ways + resolved versions for exact pins); it is wired as a pre-hook of `electron:dev` / `electron:dev:dsh`. Any commit that bumps dsh-runtime dependencies must keep this gate green.

### Upgrading the DSH runtime version

- To bump the `@deepseek-ai/*` kernel versions, use the one-command path: `pnpm run upgrade:dsh -- <version>` (rewrites all pins in `dsh-runtime/package.json` plus the override lines in `dsh-runtime/pnpm-workspace.yaml`, regenerates the lockfile via `pnpm --dir dsh-runtime install`, re-runs the gate). Do NOT hand-edit `dsh-runtime/package.json`, `dsh-runtime/pnpm-workspace.yaml`, or `dsh-runtime/pnpm-lock.yaml` — every historical DSH upgrade incident (stale-lock ERESOLVE, the 0.1.3-alpha.1 lockfile left behind by the 0.1.2-rc.1 pin) came from manual partial edits.
- `dsh-runtime/package.json`, `dsh-runtime/pnpm-workspace.yaml`, and `dsh-runtime/pnpm-lock.yaml` must be committed together in the SAME commit; never commit one without the others.
- Before committing a dsh-runtime version change, `pnpm run check:dsh-deps` must pass (it also validates the lockfile sync, so an inconsistent bump cannot land silently).

## Database Upgrade Safety

- Treat user-directory SQLite databases as persistent upgrade state. Auto-update does not replace or reset them.
- Any database schema change must include a safe, idempotent first-run migration path so upgraded users get required tables, columns, indexes, and defaults before new code depends on them.
- Any change to field meaning, data shape, or storage semantics must include an explicit migration or compatibility strategy for existing user data on first launch after upgrade.
- Do not delete, reset, or casually discard user data. Maintain old-user database continuity across releases unless a deliberate, well-documented migration plan says otherwise.
