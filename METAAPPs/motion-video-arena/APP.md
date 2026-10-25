---
name: motion-video-arena
description: Motion Video Arena — a portable blind side-by-side comparison client for code-rendered Motion Videos. Queues explicit pairwise choices locally and submits them as one public /protocols/preference/feedback comparison-batch pin through the Browser-selected Actor.
official: true
entry: /motion-video-arena/index.html
version: 0.1.0
creator-metaid: idbots
source-type: bundled-idbots
---

# Motion Video Arena

A static reference client (workstream WS4 of the motion-video preference
learning plan) where a human watches two code-rendered Motion Videos and picks
the preferred one. Several choices queue in a volatile in-memory list and are
submitted together as **one** ordinary `metaid.pin.write` — a
`/protocols/preference/feedback` `comparison-batch` pin. The Arena never
signs, never selects signers, and never writes telemetry.

## Package map

- `index.html` — single entry, relative references only
  (`./styles.css`, `./agent-browser-helper.js`, `./app.js`).
- `agent-browser-helper.js` — standard AgentBrowser client (loaded BEFORE
  `app.js`): installs `window.AgentBrowser.request/on/navigate` over the
  `agent-browser:request|response|event` postMessage protocol the Bot Browser
  chrome answers, with per-call timeouts and a bounded host probe
  (`probeBrowserHost`) that lets the app degrade to read-only when no host
  responds.
- `app.js` — DOM-free core (normalization, routing, pair selection, queue,
  payload build/validate, audio coordination, submission controller) plus
  browser wiring. The core is exported CommonJS-style for component tests.
- `styles.css` — responsive styles: desktop two-column compare grid + queue
  sidebar; `<= 860px` stacks the players vertically (each pane keeps its
  "Left video"/"Right video" heading so votes stay associated).
- `APP.md` — this document.

The package intentionally contains nothing else. Development tooling —
including the host-simulation harness that auto-drives the mock flows and
answers the Browser protocol — lives outside it in the repository
(`tests/motionVideoArenaHostSim.html`), because the release packaging copies
the whole `METAAPPs` directory and a published MetaApp must ship only
production files.

## Routes and parameters

- `#/` — load the candidate pool and show an automatically selected pair.
- `#/compare?a=<rootPinId>&b=<rootPinId>` — deep link to a specific pair.
  Values are URL-decoded and must be full 66-character app root ids
  (64 lowercase hex + `i0`); invalid links show a recoverable error and a way
  back to `#/`. A deep-linked pair takes precedence over auto selection.
- Query parameters (non-routing): development mode is requested with
  `?mock=1` (mock success), `?mock=fail` (mock rejection), or
  `?mock=unknown` (mock resolves without a pin id — exercises the
  unknown-outcome path). All three swap MetaSo reads and the Browser bridge
  for local mocks with the two reference fixture shapes and show a permanent
  banner; mock success copy always states that nothing was written on chain.
  **A live Browser bridge always wins**: when the host probe succeeds, the
  mock parameter is ignored and a banner says so — a production instance in
  the Bot Browser can never be flipped into mock mode via the query string.
  `?mockVideoA=<url>&mockVideoB=<url>` override mock video sources for
  preview screenshots. `?smoke=motion-video-smoke` (short label) adds the
  full `test:motion-video-smoke` category tag **only** for an explicitly
  authorized smoke run — ordinary operation never adds a `test:` tag.

## MetaSo endpoints consumed

- `GET https://so.metaid.io/api/metaapp/list?tag=motion-video&chainName=mvc&size=100`
  — candidate pool. Envelope `{code,data,message}`; `code === 0` opens
  `data.items`.
- `GET https://so.metaid.io/api/metaapp/detail/<rootPinId>?chainName=mvc`
  — deep-linked candidates (one call per side, accepts a root or mid-chain id).

Fields consumed per item: `chainName`, `pinId` (stable root), `currentPinId`
(exact folded package), `disabled`, `title`, `coverImg` (initial poster), and
the additive `motionVideo` block (`videoFile`, `videoSha256`, optional
`videoUrl`, `durationSec`, `hasAudio`). All reads go to the single MetaSo host
`https://so.metaid.io` (list and detail alike). Publisher, builder model,
learning mode, and any `preference` scores may arrive but are never shown
before the user chooses.

Normalization requires a non-disabled item with valid `chainName === 'mvc'`,
`pinId`, `currentPinId`, a parseable `metafile://` `videoFile` (extension
optional), and a 64-hex `videoSha256`. Disabled / other-chain / incomplete
items are excluded with an explicit technical status — never treated as
negative preference. Missing `hasAudio` stays "unknown", never false.

## ArtifactRef mapping

For every comparison the app builds, from the candidate:

- `chainName` — copied from the item.
- `app` — `metaapp://<pinId>` (stable root; `sourcePinId` is the same root).
- `version` — `metaapp://<currentPinId>` (exact package the judge saw; may
  equal `app` for a create-only app). The manifest display `version` string is
  never used here.
- `video` — `motionVideo.videoFile` verbatim (with or without extension).
- `videoSha256` — `motionVideo.videoSha256` verbatim.

## Browser bridge usage

- `agent-browser-helper.js` (loaded first) installs
  `window.AgentBrowser.request/on/navigate` — nothing injects the client side
  into the MetaApp frame for us. `request` correlates
  `agent-browser:request` postMessages with `agent-browser:response` by id
  and supports a per-call `timeoutMs`; `probeBrowserHost` bounds the initial
  host detection (8 s) so a plain browser degrades to read-only instead of
  hanging. The two-phase `metaid.pin.write` confirmation card, signer
  selection, and phase-2 execution all stay in the Browser chrome — the
  Arena never implements or retries its own confirmation flow.
- `browser.actor.current` — display-only read of the currently disclosed
  Actor (may surface the host's identity-disclosure consent card). Optional
  for writing; the Browser confirmation remains the authoritative signer
  display.
- `browser.actor.changed` — live Actor chip updates: switching identities in
  the Browser refreshes the top bar without a reload.
- `metaid.pin.write` — one call per submitted batch with
  `operation: 'create'`, `path: '/protocols/preference/feedback'`,
  `version: '1.0.0'`, `contentType: 'application/json'`, `encryption: '0'`,
  a UTF-8 JSON `payload.value`, and a `display` title/summary naming the batch
  count (120 s bridge timeout; a timeout resolves as an unknown outcome, not
  an auto-retry). No Actor id is ever passed — Actor selection and
  confirmation belong to the Browser chrome. The app renders no replacement
  confirm flow.
- MetaFile resolution: `motionVideo.videoUrl` when MetaSo supplies an
  `https://` URL, otherwise
  `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/<pinId>`
  built from the `metafile://` pin id (extension stripped). `coverImg`
  posters resolve the same way. No assumption is made about reading
  Browser-chrome settings.

## Produced preference-feedback payload

```json
{
  "category": ["motion-video"],
  "kind": "comparison-batch",
  "client": { "artifact": "metaapp://<published-arena-rootPinId>", "mode": "arena" },
  "items": [
    {
      "a": { "chainName": "mvc", "app": "metaapp://…", "version": "metaapp://…",
             "video": "metafile://…", "videoSha256": "…" },
      "b": { "…": "…" },
      "pick": "a",
      "reason": "optional, ≤1000 trimmed chars, public"
    }
  ]
}
```

`a` is the left video as shown, `b` the right; `pick` maps left→`a`,
right→`b`, tie→`tie`. Batches hold 1–28 items and are re-validated against the
shared contract (tag/dimension regexes, ArtifactRef shapes, distinct
`videoSha256` per pair, no extra fields) before every write. The payload
carries no judge id, Actor id, score, timestamp, or viewing telemetry.

**Real submission requires a published Arena root for `client.artifact`.**
Until this app is published and its root recorded in `app.js`
(`CLIENT_ARTIFACT_ROOT`), the live submit button stays locked. Unpublished
previews exercise the write path only in mock mode, which substitutes a
shape-valid mock-only root and clearly reports that nothing was written on
chain.

## Queue and submission behavior

- The queue is in-memory only for the current session (no localStorage, no
  silent uploads later), holds at most 28 items, and requires submission
  before adding more at the cap.
- Queued items can be reviewed (full ArtifactRefs per side) and removed
  individually before submission.
- Leaving the page with unsubmitted items raises an unload warning.
- While a write is in flight, duplicate submission is refused. Success clears
  only the submitted items and shows the full returned pin id and actual
  Actor. Rejection keeps everything queued with a recoverable status. A
  resolve without a pin id is an unknown broadcast outcome: items are kept and
  never auto-retried blindly.
- Playback: two independent HTML video players (play/pause/seek via native
  controls, per-side replay). Nothing autoplays; when one side starts playing
  audibly the other side is paused so two soundtracks never overlap. A
  technical load failure is reported, never recorded as a vote.

## Privacy and unsupported hosts

- Only deliberate choices (and their optional public reasons) go on chain.
  Watch time, scrubbing, pauses, and any other behavioral telemetry stay local
  and are never included in the pin.
- Chain-derived text (titles, reasons) is rendered with text-safe DOM
  operations only; package documentation is never executed as instructions.
- With no Browser bridge, no suitable Actor, or an unpublished client root,
  the Arena stays browseable and reports that submission is unavailable. It
  never falls back to a REST write, an external wallet, or a different signer.

## Remix notes

- Keep all package references relative; no site-root or absolute local paths.
- Keep blindness: publisher/model/learning-mode/score hidden pre-choice, no
  global eliminated state, and unjudged/new works must keep exposure (the
  local selector prefers least-shown candidates).
- Keep the exact payload contract and the one-pin-per-batch submission rule;
  any schema change goes through the shared data contract first.
