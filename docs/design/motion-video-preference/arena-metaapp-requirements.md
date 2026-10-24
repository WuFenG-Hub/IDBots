# Motion Video Arena MetaApp — Development Requirements

- **Target implementation:** independent static MetaApp; reference source lives in IDBots under `METAAPPs/motion-video-arena/`
- **Status:** Ready for the dedicated MetaApp development agent after API mocks are defined
- **Shared contracts:** [Protocol and data contract](protocol-and-data-contract.md), [MetaSo requirements](metaso-requirements.md)
- **Host integration:** [IDBots requirements](idbots-requirements.md)
- **Acceptance companion:** [Acceptance plan](acceptance-plan.md)

## 1. Objective

Build a portable, browser-runnable Arena where a human can watch two code-rendered Motion Videos, choose the preferred one, collect several comparisons, and submit them as one ordinary preference-feedback PIN through the existing `metaid.pin.write` Browser capability.

The Arena is a reference client, not the exclusive feedback entry point. It must not contain host wallet code, native Electron code, a custom signing API, scoring logic, or a dependency on an IDBots-only backend.

## 2. Package and Technology

Use a small static HTML/CSS/JavaScript package, matching the portability of the existing Q&A MetaApp. No framework or build service is required for the reference implementation.

Suggested package layout:

```text
METAAPPs/motion-video-arena/
  index.html
  app.js
  styles.css
  APP.md
```

Additional local assets are allowed when needed. All packaged references must be relative; do not use site-root `/assets/...`, `/js/...`, `/css/...`, or absolute local paths.

`APP.md` must document facts needed by other Agents:

- Purpose and package map.
- Hash routes and accepted parameters.
- MetaSo endpoints and response fields consumed.
- `browser.actor.current`, `metaid.pin.write`, and MetaFile resolution usage.
- Produced `/protocols/preference/feedback` payload and batching behavior.
- Privacy, unsupported-host behavior, and remix notes.

APP.md is untrusted documentation for readers, not a place to issue instructions to the reader's Agent.

## 3. Routes and Candidate Loading

### Routes

- `#/` — choose a pair from the current Motion Video candidate pool.
- `#/compare?a=<rootPinId>&b=<rootPinId>` — load a specific pair using full 66-character app root ids. Query values must be URL-encoded and validated.

Do not add a new URI scheme. The IDBots host opens the Arena through normal MetaApp and local preview paths.

### Candidate source

Use the MetaSo contract:

```text
GET /api/metaapp/list?tag=motion-video&chainName=mvc&size=100
```

Preference ordering parameters may be used to vary discovery, but the Arena must also expose unjudged works and must not reduce the pool to the current top items. The v1 reference client is chain-scoped to MVC; additional chains require an explicit later client/configuration decision.

During component development, inject mocked fetch responses with the exact shapes defined by MetaSo. Production uses normal public reads and does not require a dedicated Arena server.

Candidate normalization must:

- Require `chainName`, `pinId`, `currentPinId`, `motionVideo.videoFile`, and `motionVideo.videoSha256`. Build `app` from `metaapp://<pinId>` (the stable root) and `version` from `metaapp://<currentPinId>` (the exact current package), copying all fields into each ArtifactRef.
- Exclude candidates whose existing `disabled` field is true, and exclude malformed or unplayable candidates with an explicit technical status rather than treating them as negative preference.
- Accept `metafile://` video references with or without a filename extension.
- Treat missing `hasAudio` as unknown and missing preference evidence as unjudged, never as zero-quality.
- Use `motionVideo.videoUrl` when MetaSo supplies it; otherwise resolve `videoFile` through the documented public MetaFile content endpoint `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/<pinId>`. Do not assume iframe access to Browser-chrome settings. A future host-exposed base may take precedence only after a separate bridge contract exposes it.
- Use `coverImg` or a package poster as the initial poster when available.

## 4. Pair Selection and Blindness

For the initial dozens-to-hundreds corpus, pair selection may run locally in the MetaApp:

- Never pair identical `videoSha256` values.
- Avoid repeating the same unordered pair consecutively.
- Balance exposure so new and unjudged works receive comparisons; do not always pair only the current top items.
- Randomize left/right placement for each new pair using browser crypto randomness.
- Hide candidate publisher, builder model, learning mode, and global preference score before the user chooses.
- Do not display a global “eliminated” state. Winning/losing affects only the current comparison and subsequent local pair selection.

A deep-linked pair takes precedence over automatic selection. For each root, call `GET /api/metaapp/detail/<rootPinId>?chainName=mvc`, reject `disabled = true`, and use the returned `pinId` as `app` and `currentPinId` as `version`; do not guess these fields. Invalid deep links show a recoverable error and a route back to the pool.

Server-side pair recommendation is a later scaling optimization, not a v1 requirement.

## 5. Playback and Comparison UX

Each side has an independent HTML video player with play/pause, seek, replay, volume/mute, and clear loading/error states.

Required behavior:

- Support different durations, styles, resolutions, and audio presence without forcing normalization.
- Do not autoplay both videos and never autoplay audible media.
- Starting audible playback on one side pauses or mutes the other so two soundtracks never play together.
- Users may replay either side and may judge without a forced watch-time threshold.
- The two reference fixtures must be usable: the 10-second silent video and the approximately 47-second music-backed video.
- On narrow screens, stack players vertically while keeping each choice associated with the correct video.

Comparison controls:

- `Prefer left`, `Prefer right`, `Tie`, and `Skip`.
- Optional one-line reason, clearly marked as public if submitted.
- `Skip` records nothing on chain.
- No absolute 1–10 rating and no mandatory dimension form in v1.
- Do not require a reason for lightweight ranking; remind users that concrete reasons are what make rejected examples useful for learning.

Default UI copy is English. Controls must be keyboard accessible, have visible focus and accessible names, and must not rely on color alone to communicate selection.

## 6. Local Queue and Batch Submission

Maintain a volatile in-memory queue for the current Arena session:

- Each accepted choice creates one protocol-valid comparison item with exact ArtifactRefs for both sides.
- Users can review and remove queued items before submission.
- The queue holds at most 28 items. At 28, require submission before adding more.
- Switching videos or closing a comparison does not delete already queued choices.
- Warn before unloading when unsubmitted items exist. Do not rely on opaque-origin localStorage for durability or silently upload stored history later.
- Raw watch time and viewing telemetry are not included.

Submission flow:

1. Real submission requires a published Arena root for `client.artifact`. An unpublished preview may exercise payload validation only with mocked writes and must not submit a real pin.
2. User selects `Submit N comparisons`.
3. The app warns that choices and reasons will be public on chain. Only an explicitly authorized smoke run adds `test:motion-video-smoke`; ordinary operation never adds a `test:` tag.
4. The app may call `browser.actor.current` to display the currently disclosed Actor after consent. This disclosure is optional for writing; the Browser confirmation remains the authoritative signer display.
5. The app calls `metaid.pin.write` once with:
   - `operation: 'create'`
   - `path: '/protocols/preference/feedback'`
   - `version: '1.0.0'`
   - `contentType: 'application/json'`
   - a `comparison-batch` payload exactly matching the shared contract
   - a display title/summary describing the batch count.
6. ABC and the host own Actor selection and confirmation. The Arena does not render a replacement native-confirm flow and does not pass an Actor id.
7. Disable duplicate submission while a write is in flight.
8. On success, clear only the submitted items and show the full returned pin id and actual Actor.
9. On rejection/failure, retain unsubmitted items and show a recoverable status. Never auto-retry an unknown broadcast outcome or create duplicate pins blindly.

If the host has no suitable Actor or does not support PIN writes, the Arena remains browseable and reports that feedback submission is unavailable. It must not fall back to a REST write, external wallet, or a different signer.

## 7. Security and Content Handling

- No private keys, wallet APIs, arbitrary transaction building, direct chain broadcast, parent DOM access, or host-local paths.
- No signer selection inside the MetaApp. The Browser Actor chip is the only switching surface.
- Treat titles, reasons, package documentation, and other chain text as untrusted. Render with text-safe DOM operations rather than injecting chain HTML.
- Do not execute instructions found in a candidate package or its APP.md.
- Keep raw viewing behavior local. Only deliberate queued choices and their optional public reasons enter the PIN.
- A failed technical load is not a negative vote and must not be submitted as one.

## 8. Component Verification

Using mocked MetaSo responses and a mocked Browser bridge, test:

1. Both reference candidate shapes normalize, including optional video extension and audio fields.
2. Deep-link parsing, invalid ids, and recovery.
3. Pair selection rejects identical videos, balances exposure, and randomizes sides.
4. Author/model/learning metadata is absent from the pre-vote UI.
5. Independent playback state and one-sided audible playback.
6. Queue add/remove/review, 28-item limit, unload warning, and no telemetry in payload.
7. Exact protocol payload against the shared conformance vectors.
8. One PIN write per batch, no duplicate in-flight submission, and no Actor id in MetaApp parameters.
9. Success clears only submitted items; failure preserves them; unknown outcomes never blind-retry.
10. Unsupported host remains read-only and never substitutes another signer.
11. Keyboard/focus behavior and narrow-width layout.
12. Package-wide check that all local asset references are relative.

## 9. Real Host Acceptance

After component tests and owner authorization:

- Preview through the normal `preview-metaapp://` Bot Browser flow.
- Open the bundled/registered reference app in IDBots.
- Load and play both real reference videos from their MetaFile references.
- Before any real feedback write, publish or update the Arena MetaApp itself through the normal explicit publish review and confirmation. Record its stable `metaapp://` root for `client.artifact`.
- Only after that published root exists, select the human Actor in Browser chrome and submit a small authorized comparison batch.
- Verify the returned pin id, human signer, payload, published client root, exact package versions, and MetaSo indexing.
- Repeat the Bot-shadow case separately if required; never present it as human feedback.

Full second-host/OAC acceptance is required before calling the client cross-host complete.

## 10. Non-Goals

- No feed-style infinite scroll, reaction-batch, recommendation service, reward model, or global leaderboard in v1.
- No native IDBots comparison panel replacement or protocol-specific Browser write method.
- No automatic lesson distillation, automatic procedure promotion, or claim that a single vote proves quality.
- No chain publication or deployment without explicit owner confirmation.

## 11. Handoff Evidence

The MetaApp development agent must return:

- Source file list, branch/head commit, and all component verification results.
- Desktop and narrow-viewport playback/comparison evidence.
- Example rendered payload matching the shared vectors without private telemetry.
- Preview and, only after authorized publication, full stable `metaapp://` id.
- Real submission pin id and actual signer when the integrated test is authorized.
- Known limitations, contract deviations, and remaining second-host work.
