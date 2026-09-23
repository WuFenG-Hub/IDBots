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

## Adding / rebasing a patch

1. Edit the installed file under `dsh-runtime/node_modules/<pkg>/` directly.
2. Regenerate the diff against the pristine package (reinstall the package
   in a scratch dir or reverse your edit) with repo-relative `a/` `b/`
   labels and save it here as `<name>+<installed-version>.patch`.
3. Run `node scripts/apply-dsh-kernel-patches.cjs` — it must report
   "already applied", and `--check` must pass.
4. On the next `pnpm run upgrade:dsh`, delete or rebase each patch; the
   script fails the upgrade until every patch matches the new versions.
