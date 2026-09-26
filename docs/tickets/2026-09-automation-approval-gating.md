# TICKET-2026-09-04 — Experimental automation providers execute with zero approval: wire ctx.approval into browser-use / computer-use (kernel patch + upstream issue)

| Field | Value |
| --- | --- |
| Ticket ID | TICKET-2026-09-04 |
| Date filed | 2026-09-26 |
| Status | Open (deferred from the 0.1.7 automation integration; isolation + kill-switch shipped in `fix/automation-slot-isolation`) |
| Severity | Medium (physical-desktop input and arbitrary website actions run without any user-approval round-trip; mitigated today by per-bot opt-in default-off, slot isolation, and the global kill-switch) |
| Area | DSH runtime composition — `@deepseek-ai/dsh-experimental-browser-use-*` and `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` (kernel 0.1.7-rc.2) |
| Reporter | Pre-release reviewer agent (P1 finding follow-up) |
| Evidence | `grep -ri approval dsh-runtime/node_modules/@deepseek-ai/dsh-experimental-{browser-use-*,computer-use-*}` → zero matches; kernel seam exists in `@deepseek-ai/dsh-user-approval` (`ctx.approval`, waterfall `approval/request`, fail-closed by default) but the providers never call it |

## Summary

The 0.1.7 experimental automation backends (Playwright-MCP browser tools, cua-driver desktop control) execute every tool call with **no approval step**: the packages contain no reference to the kernel's `dsh-user-approval` seam, so `browser_navigate` or a desktop click round-trips straight to execution. The kernel already ships a fail-closed approval mechanism (`ctx.approval` + composed answerers over the `approval/request` waterfall), but only providers that explicitly ask are gated — these two never ask.

## Why this is deferred

- Host-side configuration cannot enable approval: the seam is pull-based (provider asks, answerer answers). Nothing the host composes can make a provider that never calls `ctx.approval` start asking.
- Gating from the host's tool-event stream is fail-open-then-abort: the event arrives after execution started, so cancelling the turn does not prevent the irreversible action (desktop input cannot be rolled back).
- Doing it properly means a kernel patch (our `scripts/dsh-kernel-patches/` mechanism) that injects approval calls into the two providers — a design task of its own (which tools are mutating vs read-only, what the answerer UX is, how the decision is scoped: one-shot vs per-session).

## Mitigations already shipped (branch `fix/automation-slot-isolation`)

- Per-bot opt-in, default off, for both backends (`cowork.browserAutomation` / `cowork.computerUse`).
- Runtime slot isolation: opted-in bots run on a dedicated `provider.auto-*` slot; sessions whose bot did not opt in never see the tools.
- App-level kill-switch (`automation.experimentalEnabled`) cuts both backends fleet-wide from the next turn.
- The Bot Browser side-panel prompt only mentions Playwright tools for bots that actually opted in.

## Proposed work

Upstream note: `deepseek-ai/deepseek-harness` does not accept issues, so there is no upstream track — the kernel patch below is the fix, not a stopgap. That also keeps the approval semantics fully under our control.

1. **Kernel patch (the fix)**: wrap the providers' tool execution so mutating tools (`browser_navigate`, `browser_click`, `browser_type`, …; all cua-driver input tools) call `ctx.approval` first, fail-closed. Read-only tools (`browser_snapshot`, screenshots) may stay ungated. Patch lives in `scripts/dsh-kernel-patches/` with a manifest entry (see the README there).
2. **Host answerer**: register an approval answerer in the runtime composition that bridges to the cowork permission overlay UI (the existing `evaluatePolicy` ask path / `coworkPermissionOverlay`), so the user gets an approve/deny prompt per action or per session.
3. **Tests**: E2E in `dsh-runtime/test/browser-use.test.mjs` asserting a mutating call without an answerer fails closed; host-side contract test that the patch stayed applied (the manifest verifier covers this).

## References

- Slot isolation + kill-switch implementation: branch `fix/automation-slot-isolation` (this repo).
- Kernel approval seam: `dsh-runtime/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js` (fail-closed normalization at the `OUTCOMES` check).
- Patch mechanism: `scripts/dsh-kernel-patches/README.md`.
