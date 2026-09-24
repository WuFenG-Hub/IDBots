# dsh-runtime kernel patches

Post-install patches applied to `dsh-runtime/node_modules/**` by
`scripts/apply-dsh-kernel-patches.cjs` (wired into the root `postinstall`,
the `check:dsh-deps` gate, and `pnpm run upgrade:dsh`).

The DSH runtime is a nested pnpm package, so root-level
`patches/` setup cannot reach it. Patches here exist only when a shipped
kernel package has a defect we must fix between kernel releases — they are
technical debt that must be rebased or deleted at the next
`pnpm run upgrade:dsh`.

## Naming

`<package-name>+<exact-version>.patch` — the same convention patch-package
uses, e.g. `@deepseek-ai+dsh-win32-process+0.1.5-rc.2.patch`. The apply
script refuses to run a patch whose version differs from the installed
package, so a kernel upgrade without a patch rebase fails loudly instead of
silently shipping an unpatched kernel.

Diff paths are repository-relative (`a/dsh-runtime/node_modules/...`), so
the script applies them with plain `git apply` from the repo root.

## Current patches

### `@deepseek-ai+dsh-win32-process+0.1.5-rc.2.patch`

On Windows the kernel's subprocess-local service launches every tool
subprocess (bash.exe first of all) through a dedicated "Job runner" child,
which creates the target process with raw `CreateProcessW`/`CreateProcessAsUserW`.
Upstream passes creation flags `CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB`
without `CREATE_NO_WINDOW` (0x08000000), so each console-subsystem target
allocates a visible console window — the "bash.exe black window flashing on
every bash tool call" Windows users reported. The host-side
`windowsHide: true` fixes and the runtime's own `win32-spawn-shim` cannot
reach this path because the runner process uses FFI bindings, not
`child_process`.

The patch ORs `0x08000000` into all three creation-flag call sites
(`spawnCurrentTokenJobProcess` — the ordinary job path the bash tool uses;
`spawnInheritedJobProcess` — restricted-token job spawns; `spawnPipedProcess`
— piped restricted spawns). `CREATE_NO_WINDOW` only suppresses console
allocation; it does not affect GUI windows.

### `@deepseek-ai+dsh-tool-ask-user+0.1.5-rc.2.patch`

Upstream's `ask_user_question` ships a one-line description ("Ask the user a
concise question…") that actively pushes the model toward firing the question
panel cold: observed in production, the bot writes the full background and
recommendation in its (invisible) reasoning and then pops the modal with no
visible context, leaving the user staring at options like "方案A/方案B" with no
idea what is being decided. The downstream chain already supports a per-question
`detail` markdown block — `dsh-user-questions` passes it through, the
idbots-sdk-server bridge forwards it, and the host modal renders it above the
options (that is how exit_plan_mode plan reviews render) — but the stock tool
neither declares `detail` in its schema nor forwards it in `execute()`.

The patch: (1) extends the tool description to require a short visible
explanation (background, why asking, recommendation) in the same assistant
message before the tool call, plus spelling out internal shorthand;
(2) declares the optional `detail` string property so the model can attach that
context to the panel itself; (3) threads `detail` through `execute()` into the
`ctx.userQuestions.ask` payload so it actually reaches the modal.

### `@deepseek-ai+dsh-subprocess-local+0.1.5-rc.2.patch`

Incident (2026-09-24, ~1 in 50 sessions): an external tmp cleanup removed the
shared DSH runtime's private `dsh-subprocess-*` spill directory
(`/var/folders/…/T/dsh-subprocess-ysdKLS`) while the process was serving turns.
The next overflowing bash stdout hit `openSync(spillFile, "wx")` ENOENT inside
the socket `data` handler (`OutputCollector.spillAll`); the uncaught throw
killed the whole runtime process (exit 1, "DSH runtime is not running") and
cascaded into every active conversation for minutes (146 log entries, two
user-visible broken conversations). Upstream already contains the degradation
concept — `discardSpill()` for an over-cap stream, `spillPath ?? "(unavailable)"`
in the bash truncation notice, a contained `seal()` — but the spill open/append
path itself is unprotected.

The patch makes the collector resilient without changing its behavior on the
happy path: (1) `spillAll` routes file establishment through a new `openSpill()`
that on ENOENT recreates the private directory once (`mkdirSync` recursive,
0700) and retries — an external deletion self-heals and full-output recovery
keeps working; (2) when the spill target stays unavailable the collector
degrades via `discardSpill()` (in-memory tail only, truncation flagged, no
crash) instead of throwing; (3) append failures (`writeSync`) are contained the
same way; (4) the `stream.on("data")` handler wraps `collector.push(chunk)` so
no residual collector failure can escape into the event loop. Regression test:
`dsh-runtime/test/subprocess-spill-resilience.test.mjs` reproduces the exact
incident (mid-stream spill-dir deletion crashes the unpatched process) and the
unrecoverable-spill degradation case.

## Adding / rebasing a patch

1. Edit the installed file under `dsh-runtime/node_modules/<pkg>/` directly.
2. Regenerate the diff against the pristine package (reinstall the package
   in a scratch dir or reverse your edit) with repo-relative `a/` `b/`
   labels and save it here as `<name>+<installed-version>.patch`.
3. Run `node scripts/apply-dsh-kernel-patches.cjs` — it must report
   "already applied", and `--check` must pass.
4. On the next `pnpm run upgrade:dsh`, delete or rebase each patch; the
   script fails the upgrade until every patch matches the new versions.
