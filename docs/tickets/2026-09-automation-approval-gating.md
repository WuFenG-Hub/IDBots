# TICKET-2026-09-04 — Experimental automation providers execute with zero approval: wire ctx.approval into browser-use / computer-use (kernel patch)

| Field | Value |
| --- | --- |
| Ticket ID | TICKET-2026-09-04 |
| Date filed | 2026-09-26 |
| Status | **Fixed** (2026-09-27, branch `fix/automation-slot-isolation` — two kernel patches + E2E; see Resolution) |
| Severity | Medium (physical-desktop input and arbitrary website actions ran without any user-approval round-trip) |
| Area | DSH runtime composition — `@deepseek-ai/dsh-experimental-browser-use-*` and `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` (kernel 0.1.7-rc.2) |
| Reporter | Pre-release reviewer agent (P1 finding follow-up) |
| Evidence | `grep -ri approval dsh-runtime/node_modules/@deepseek-ai/dsh-experimental-{browser-use-*,computer-use-*}` → zero matches; kernel seam exists in `@deepseek-ai/dsh-user-approval` (`ctx.approval`, waterfall `approval/request`, fail-closed by default) but the providers never call it |

## Summary

The 0.1.7 experimental automation backends (Playwright-MCP browser tools, cua-driver desktop control) executed every tool call with **no approval step**: the packages contain no reference to the kernel's `dsh-user-approval` seam, so `browser_navigate` or a desktop click round-tripped straight to execution. The kernel already ships a fail-closed approval mechanism (`ctx.approval` + composed answerers over the `approval/request` waterfall), but only providers that explicitly ask are gated — these two never asked.

## Why host-side fixes were insufficient

- Host-side configuration cannot enable approval: the seam is pull-based (provider asks, answerer answers). Nothing the host composes can make a provider that never calls `ctx.approval` start asking.
- Gating from the host's tool-event stream is fail-open-then-abort: the event arrives after execution started, so cancelling the turn does not prevent the irreversible action (desktop input cannot be rolled back).

## Resolution (2026-09-27)

`deepseek-ai/deepseek-harness` does not accept issues, so there was no upstream track — the fix is ours, via the kernel-patch mechanism. Investigation found the answerer chain already complete end-to-end: the runtime composition mounts `dsh-user-approval` and idbots-sdk-server registers a **global** `approval/request` answerer that bridges into the renderer permission dialog (60s auto-reject), and the host short-circuits repeat prompts via session `autoApproveTools` / permission modes (`acceptEdits` / `bypassPermissions`) — identical semantics to the bash tool. The only missing piece was the providers never asking.

Two new kernel patches (both fingerprinted in `scripts/dsh-kernel-patches/manifest.json`):

1. `@deepseek-ai+dsh-experimental-browser-use-runtime+0.1.7-rc.2.patch` — gates the provider's `tools/execute` dispatch (`lib/types/mcp.js`): any `mcp__<server>__*` call outside the observation set (`browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_wait_for`) asks `approval.request(...)` first and proceeds only on `allowed-once`; missing service / rejection / cancellation / unavailable answerer all throw (fail-closed).
2. `@deepseek-ai+dsh-experimental-computer-use-cua-driver-native+0.1.7-rc.2.patch` — same seam in the cua-driver provider's `tools/execute` listener. The observation allowlist covers the real 49-tool catalog's read surface (`list_apps`, `list_windows`, `get_window_state`, `get_screen_size`, `verify_state`, `get_desktop_state`, `get_cursor_position`, `get_accessibility_tree`, `get_browser_state`, `clipboard_read`, `check_permissions`, `health_report`, `get_config`, `get_agent_cursor_state`, `get_recording_state`, `get_session`, `list_sessions`, `get_session_state`); everything else — including `install_ffmpeg`, `escalate_session`, recording and `browser_*` driver tools — asks. An unclassified catalog addition asks rather than silently executing.

Tests: `dsh-runtime/test/automation-approval.test.mjs` (wired into `pnpm --dir dsh-runtime test`) proves the matrix end to end over the real wire — browser reject (navigate never executes, audit pair on the session feed), browser allow (snapshot returns), browser observation (no ask), desktop reject (no macOS grants needed: the gate fires before the driver is called), desktop observation (no ask). The existing `browser-use.test.mjs` now answers the gate with `allowed-once`. `tests/coworkDshAutomationSlotIsolation.test.mjs` keeps covering the slot isolation.

## Mitigations shipped earlier on the same branch

- Per-bot opt-in, default off, for both backends (`cowork.browserAutomation` / `cowork.computerUse`).
- Runtime slot isolation: opted-in bots run on a dedicated `provider.auto-*` slot; sessions whose bot did not opt in never see the tools.
- App-level kill-switch (`automation.experimentalEnabled`) cuts both backends fleet-wide from the next turn.
- The Bot Browser side-panel prompt only mentions Playwright tools for bots that actually opted in.

## Follow-ups (not blocking)

- Per-session "always allow this tool" UX rides the existing `autoApproveTools` set; if prompting proves too noisy for long CU sessions, consider a dedicated remember-choice in the permission dialog.
- Discovery note: a worktree install left `@trycua/cua-driver-darwin-arm64` missing after an aborted pnpm install on exFAT (pnpm's `.modules.yaml` recorded it as installed; later incremental installs trusted that). Fresh installs (main repo, CI) include it. If a runtime slot ever fails to boot with `ResolveLibPathError: ... cua-driver-darwin-arm64`, heal with `pnpm --dir dsh-runtime install --force` (or copy the package directory from a healthy checkout).

## References

- Kernel approval seam: `dsh-runtime/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js` (fail-closed normalization at the `OUTCOMES` check).
- Answerer bridge: `dsh-runtime/plugins/idbots-sdk-server.mjs` (`approval bridge` section).
- Patch mechanism: `scripts/dsh-kernel-patches/README.md`.
