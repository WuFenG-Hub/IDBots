# Audit — IPC Invoke Event Shape (REQ-A-13)

Date: 2026-10-20. Branch: `feat/ipc-registry`. Auditor: subagent audit per
`10-ws-a-idbots-server-mode.md` REQ-A-13.

> Naming note: REQ-A-13 in `10-ws-a-idbots-server-mode.md:179` names the
> deliverable `docs/cloud-mobile/audits/event-sender-review.md`; this
> document is the same review under the filename assigned to the audit task
> (`invoke-event-shape.md`). Keep one canonical path and update the spec
> reference when the plan text is next touched.

## Synthetic event shape (frozen by REQ-A-13)

When a mobile gateway client invokes an allowlisted channel, the gateway
dispatches to the registered handler without a renderer. The handler receives
a synthetic event instead of an `IpcMainInvokeEvent`
(`src/main/ipc/registry.ts:13-17`, constructed at
`src/main/ipc/registry.ts:63-67`):

```ts
{
  sender: null,        // no WebContents behind a gateway call
  senderFrame: null,   // no frame either
  gateway: { clientId: string },
}
```

Handlers must tolerate `sender === null`. This audit reviews every main-process
IPC handler site that reads `event.sender`, `event.senderFrame`, or calls
`BrowserWindow.fromWebContents`, and cross-references each channel against the
frozen allowlist `docs/cloud-mobile/02-ipc-allowlist-v1.md` (`02`).

## Method and inventory

Search: `grep -rn "event\.sender\|_event\.sender\|senderFrame\|fromWebContents"
src/main --include="*.ts"` — 24 raw hits, matching the "24 `event.sender` /
`fromWebContents` sites" named in REQ-A-13. Of the 24:

- **20 are IPC handler registrations** in `src/main/main.ts`
  (13 `registerIpcHandler` invoke handlers + 7 `ipcMain.on` send handlers) —
  the audit population below.
- **2 are non-handler helpers** in `src/main/main.ts`
  (`savePngWithDialog` at `src/main/main.ts:2331`, `fromWebContents` at
  `src/main/main.ts:2337`; `downloadMetafileWithDialog` at
  `src/main/main.ts:2396`, `fromWebContents` at `src/main/main.ts:2405`).
  Both only *consume* a `WebContents` passed by a handler and already branch on
  the resolved window being absent (`ownerWindow ? ... : ...`), so they are
  null-safe by construction; they are covered via their call sites
  (`src/main/main.ts:12994`, `src/main/main.ts:13050`,
  `src/main/main.ts:13068`).
- **2 are not IPC at all**: `src/main/im/feishuGateway.ts:398-399`
  (`event.sender.sender_id.user_id/open_id`) reads the *Feishu message event*
  in `parseMessageEvent` — an IM webhook payload, not an Electron IPC event.
  Excluded from the audit population.

No `senderFrame` usage exists anywhere in `src/main` outside the synthetic
event type itself (`src/main/ipc/registry.ts:15`, `src/main/ipc/registry.ts:65`).

## Send channels (`ipcMain.on`) are all tier N

`02:195-198` states renderer-to-main `send` channels are all **N** ("the shim
drops them"). Verified against the audit population: all 7 sender-reading send
handlers (`window-minimize`, `window-maximize`, `window-close`,
`window:move-by`, `window:showSystemMenu`,
`botBrowser:tab-command:response`, `botBrowser:capture-request:response`)
appear in that `02` list. The gateway only dispatches *invoke* channels
(`src/main/ipc/registry.ts` records invoke handlers; send channels are not
registered there), so no send handler can receive a synthetic event either.

## Verdicts

Verdict legend:

- `works-with-synthetic-event` — allowlisted (P1/P2) and tolerates
  `sender === null`.
- `not-allowlisted` — tier N/S/H in `02`, so the gateway never routes a call
  to it (`CHANNEL_NOT_ALLOWED`); the synthetic event cannot reach it. The
  "Null-`sender` behavior" column records what *would* happen if it were
  called anyway, as defense-in-depth information.
- `needs-followup` — allowlisted (P1/P2) AND would break with
  `sender === null`. **None found** (see summary).

### Invoke handlers (`registerIpcHandler`)

| # | Channel | Registration / sender use | What `sender` is used for | Tier (`02`) | Null-`sender` behavior | Verdict |
|---|---------|---------------------------|---------------------------|-------------|------------------------|---------|
| 1 | `window:isMaximized` | `src/main/main.ts:10216` (helper `windowFromEvent`, `src/main/main.ts:10195`) | Resolve the calling window to answer `isMaximized()` | S (`02:160`) | Falls back to `false` (`?? false`); no-op | not-allowlisted |
| 2 | `botBrowser:capturePage` | `src/main/main.ts:10394` (use at `src/main/main.ts:10407`) | `event.sender.capturePage(rect)` pixel capture of the Bot Browser guest | N (`02:167`) | Throws (`capturePage` of null) | not-allowlisted |
| 3 | `botBrowser:writeMetaIdPin` | `src/main/main.ts:10497` | `fromWebContents(sender)` → pick the per-window Bot Browser bridge | N (`02:167`) | `fromWebContents(null)` resolves no window; bridge lookup mis-resolves | not-allowlisted |
| 4 | `botBrowser:uploadMetaFile` | `src/main/main.ts:10504` | Same per-window bridge resolution | N (`02:167`) | Same as #3 | not-allowlisted |
| 5 | `botBrowser:completeLlm` | `src/main/main.ts:10511` | Same per-window bridge resolution | N (`02:167`) | Same as #3 | not-allowlisted |
| 6 | `botBrowser:requestPermissions` | `src/main/main.ts:10518` | Same per-window bridge resolution | N (`02:167`) | Same as #3 | not-allowlisted |
| 7 | `cowork:session:exportTranscript` | `src/main/main.ts:11388` (use at `src/main/main.ts:11401`) | `fromWebContents(sender)` to parent the native save dialog | N (`02:65`) | Null-safe: dialog shown without a parent window (`ownerWindow ? ... : ...`) | not-allowlisted |
| 8 | `cowork:session:exportResultImage` | `src/main/main.ts:12979` (use at `src/main/main.ts:12993`) | `event.sender.capturePage(rect)` desktop capture, then save dialog | N (`02:66`) | Throws at `capturePage` | not-allowlisted |
| 9 | `cowork:session:captureImageChunk` | `src/main/main.ts:13003` (use at `src/main/main.ts:13015`) | `event.sender.capturePage(rect)` desktop capture | N (`02:66`) | Throws at `capturePage` | not-allowlisted |
| 10 | `cowork:session:saveResultImage` | `src/main/main.ts:13032` (use at `src/main/main.ts:13050`) | Passes `sender` to `savePngWithDialog` (parents the save dialog) | N (`02:67`) | Null-safe via helper's `ownerWindow ? ... : ...` branch | not-allowlisted |
| 11 | `cowork:metafile:download` | `src/main/main.ts:13059` (use at `src/main/main.ts:13068`) | Passes `sender` to `downloadMetafileWithDialog` (parents the save dialog) | N (`02:68`) | Null-safe via helper's `ownerWindow ? ... : ...` branch | not-allowlisted |
| 12 | `appUpdate:download` | `src/main/main.ts:17239` (use at `src/main/main.ts:17242-17243`) | `event.sender.isDestroyed()` guard + `event.sender.send('appUpdate:downloadProgress', ...)` progress pushes | N (`02:167`) | Throws at `isDestroyed()` | not-allowlisted |
| 13 | `api:stream` | `src/main/main.ts:17350` (uses at `src/main/main.ts:17408-17418`) | `event.sender.send('api:stream:<id>:data|done|abort|error', ...)` SSE chunk forwarding to the invoking renderer | N (`02:165`) | Throws inside the async reader (`send` of null); the invoke itself already returned `{ ok: true }` | not-allowlisted |

### Send handlers (`ipcMain.on`)

| # | Channel | Registration / sender use | What `sender` is used for | Tier (`02`) | Null-`sender` behavior | Verdict |
|---|---------|---------------------------|---------------------------|-------------|------------------------|---------|
| 14 | `window-minimize` | `src/main/main.ts:10198` | `windowFromEvent(event)?.minimize()` | N (`02:195-198`) | Optional-chained no-op | not-allowlisted |
| 15 | `window-maximize` | `src/main/main.ts:10202` | `windowFromEvent(event)` → maximize/unmaximize | N (`02:195-198`) | Optional-chained no-op | not-allowlisted |
| 16 | `window-close` | `src/main/main.ts:10212` | `windowFromEvent(event)?.close()` | N (`02:195-198`) | Optional-chained no-op | not-allowlisted |
| 17 | `window:move-by` | `src/main/main.ts:10221` | `windowFromEvent(event)` → emulated drag `setPosition` | N (`02:195-198`) | Optional-chained no-op | not-allowlisted |
| 18 | `window:showSystemMenu` | `src/main/main.ts:10232` | `windowFromEvent(event)` → parent the system menu | N (`02:195-198`) | Optional-chained no-op | not-allowlisted |
| 19 | `botBrowser:tab-command:response` | `src/main/main.ts:10381` | `event.sender` keyed into the Bot Browser tab bridge response routing | N (`02:195-198`) | Bridge receives null sender; mis-routes or no-ops | not-allowlisted |
| 20 | `botBrowser:capture-request:response` | `src/main/main.ts:10385` | `event.sender` keyed into the Bot Browser capture bridge | N (`02:195-198`) | Bridge receives null sender; mis-routes or no-ops | not-allowlisted |

## Summary

- Raw grep sites: **24** (matches REQ-A-13's expected count).
- Excluded from the handler audit: **4** — 2 dialog helpers
  (`src/main/main.ts:2337`, `src/main/main.ts:2405`, both null-safe by
  construction) and 2 non-IPC Feishu message-parse sites
  (`src/main/im/feishuGateway.ts:398-399`).
- Handler sites audited: **20** — 13 invoke + 7 send.
- Verdicts:
  - `needs-followup`: **0**. **No P1/P2 allowlisted channel reads
    `event.sender`, `event.senderFrame`, or calls `fromWebContents`.** Every
    sender-dependent handler is tier N (or S for `window:isMaximized`), so the
    frozen allowlist alone guarantees the synthetic event never reaches one.
    This is the audit's principal finding.
  - `not-allowlisted`: **20**.
  - `works-with-synthetic-event`: **0** — the category is empty because no
    allowlisted channel uses `sender` at all (the audit's other possible
    outcomes collapse into "not-allowlisted").
- Defense-in-depth note: 9 of the 20 sites (all 5 window send handlers,
  `window:isMaximized`, `cowork:session:exportTranscript`,
  `cowork:session:saveResultImage`, `cowork:metafile:download`) tolerate a null
  sender by construction; the other 11 would throw or mis-resolve if invoked
  with one. Since all 11 are tier N, no change is required for v1. If any of
  them is ever promoted into the allowlist, its sender use must be reworked
  first — `appUpdate:download` (`src/main/main.ts:17242`) and
  `api:stream` (`src/main/main.ts:17408`) are the most fragile because they
  push progress back through `event.sender.send`.

## Follow-ups

None required for REQ-A-13. The audit population should be re-run whenever a
channel is promoted into the P1/P2 allowlist or when a new handler reads
`event.sender`; the cheap check is the same grep used above filtered through
`registerIpcHandler(` / `ipcMain.on(` registrations.
