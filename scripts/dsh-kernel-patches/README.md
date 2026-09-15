# dsh-runtime kernel patches

Post-install patches applied to `dsh-runtime/node_modules/**` by
`scripts/apply-dsh-kernel-patches.cjs` (wired into the root `postinstall`,
the `check:dsh-deps` gate, and `npm run upgrade:dsh`).

The DSH runtime is a nested npm package, so the root `patch-package` +
`patches/` setup cannot reach it. Patches here exist only when a shipped
kernel package has a defect we must fix between kernel releases — they are
technical debt that must be rebased or deleted at the next
`npm run upgrade:dsh`.

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

## Adding / rebasing a patch

1. Edit the installed file under `dsh-runtime/node_modules/<pkg>/` directly.
2. Regenerate the diff against the pristine package (reinstall the package
   in a scratch dir or reverse your edit) with repo-relative `a/` `b/`
   labels and save it here as `<name>+<installed-version>.patch`.
3. Run `node scripts/apply-dsh-kernel-patches.cjs` — it must report
   "already applied", and `--check` must pass.
4. On the next `npm run upgrade:dsh`, delete or rebase each patch; the
   script fails the upgrade until every patch matches the new versions.
