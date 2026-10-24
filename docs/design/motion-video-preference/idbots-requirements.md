# IDBots Human/Bot Actor, Thin Hosting, and Bot Learning — Development Requirements

- **Target project:** IDBots
- **Status:** Ready for the dedicated IDBots development agent after ABC/MetaSo contract mocks are available
- **Shared contracts:** [Protocol and data contract](protocol-and-data-contract.md), [ABC Actor requirements](abc-actor-requirements.md), [MetaSo requirements](metaso-requirements.md)
- **Acceptance companion:** [Acceptance plan](acceptance-plan.md)

## 1. Objective

Make IDBots the first complete host for the Motion Video preference loop without turning the feature into a native feedback application:

1. Expose the registered local human MetaID alongside local MetaBots in the Browser Actor selector.
2. Route ordinary `metaid.pin.write` to the actual selected Human or Bot signer with existing confirmation and authorization safeguards.
3. Register and open the independent Arena MetaApp through a thin Q&A-like association, not a native Arena UI.
4. Extend MetaApp retrieval and bot-learning flows so preference evidence can improve later Motion Video production.

## 2. Dependencies and Integration Rules

- ABC integration uses a released, pinned `@openagentinternet/agent-browser-*` version containing the agreed generic Actor behavior and tests. Do not depend on a developer-local ABC checkout.
- Adapter work may begin against existing ABC contracts because no new business bridge method is required. Final integration must record the exact pinned ABC version.
- MetaSo work may be developed against the fixtures and API contract in `metaso-requirements.md`; final acceptance uses the real service.
- Arena source is implemented independently under `METAAPPs/motion-video-arena/` as defined in `arena-metaapp-requirements.md`.
- Existing sealed preference behavior must remain green. Open feedback must not be routed through the sealed-round writer or inserted into existing tallies.
- All work follows IDBots branch/worktree, pnpm, database-migration, test, commit, and release rules.

## 3. Workstream A — Human and Bot Actors in Browser Runtime

### Current-state anchors

- `src/renderer/features/botBrowser/idbotsBrowserHostAdapter.ts` currently builds `runtime.actors` only from `listMetabots()`.
- `src/renderer/features/botBrowser/idbotsBrowserActorModel.js` maps Bots to `idbots-agent`.
- The local human identity lives in the main-process `user_identity` store and must never be exposed with its mnemonic.

### Required changes

- Add a trusted, sanitized host path that supplies the current human identity's display label, globalMetaId, and optional avatar to the Browser runtime. Do not expose mnemonic, private keys, wallet/session snapshots, filesystem paths, or raw store rows.
- Map the human identity to a stable host-local Actor id and `kind: 'idbots-account'`.
- Continue mapping MetaBots to their existing ids and `kind: 'idbots-agent'`.
- Return `runtime.actors = [human when registered, ...availableBots]` with no duplicate globalMetaId-driven identity confusion. Actor ids, not display names, determine selection. `Registered` means a human globalMetaId and signing path exist; a locked/unavailable signer may remain visible but must return an explicit write error rather than being treated as usable or replaced by a Bot.
- Preserve the current default Bot whenever existing Bot defaults are available. Adding a human Actor must not silently change signing behavior on upgrade.
- If no Bot exists but a usable human identity exists, the human may be the default so generic signing remains possible; no forced Bot creation is allowed.
- If neither a usable Human nor Bot exists, retain a clear setup action and generic Actor wording.
- Human identity creation/import/replacement/removal must invalidate stale runtime and signing state before further writes. Refresh or reopen the Browser runtime as appropriate and revoke affected session grants.
- Labels must allow the user to distinguish the human identity from Bots before selection; the Browser chip remains the only selection surface.

## 4. Workstream B — Generic Human/Bot PIN Signing

### Current-state anchors

- `src/main/services/botBrowserBridgeService.ts` currently resolves only local MetaBot actor ids and calls MetaBot `createPin`.
- `src/main/services/preference/userWriter.ts` demonstrates human signing, serialization, subsidy checks, and UTXO threading, but fixes paths to sealed preference segments.

### Required changes

- Generalize Actor resolution into a discriminated Human/Bot result. Validate every host-supplied Actor id and re-read the actual identity at execution time.
- Keep MetaApp-supplied Actor fields out of the trust boundary. The selected Actor comes only from trusted Browser state and the host adapter.
- Route Bot writes through the existing MetaBot path without behavioral regression.
- Route Human writes through a generic human identity writer built from the existing `createPinForIdentity` stack. Preserve serialized writes, spent-outpoint/change handling, fee/subsidy errors, and audit behavior.
- Extract shared human signing functionality rather than hard-coding preference paths or duplicating a second UTXO queue. Existing `createUserPreferenceWriter` behavior must remain equivalent after refactoring.
- Validate operation, path, payload, size, and target rules again in the host for both signer kinds.
- Bind two-phase confirmation and granted writes to the actual Actor and request payload. Switching Actors invalidates old authorization.
- The confirmation card and result must identify the actual signer. Human failure must never fall back to a Bot, and Bot failure must never fall back to a Human.
- Do not automatically grant persistent or unlimited writes for `/protocols/preference/feedback`. Existing exact-path, session-scoped grant policy and one-confirmation-per-batch semantics apply.
- For any other Actor-aware action that does not support the selected kind, return an explicit unsupported-actor/action error. Never silently execute the action as the default Bot.

### Privacy and key handling

- Human signing remains in the main process or existing trusted worker.
- No mnemonic, raw wallet record, arbitrary transaction builder, or private key crosses renderer/iframe boundaries.
- Audit records contain the action, resource, actual Actor/globalMetaId, path, pin id, and outcome without secret material.

## 5. Workstream C — Thin Arena Registration and Opening

The Arena is an independent static MetaApp, not an Electron React feature.

When the Arena implementation is ready:

- Place its source under `METAAPPs/motion-video-arena/` as specified in the Arena work order. Because the root `.gitignore` ignores `METAAPPs/*` except explicit bundled apps, add `!METAAPPs/motion-video-arena/` and `!METAAPPs/motion-video-arena/**` alongside the existing app exceptions and verify the actual source files are tracked; local directory scanning alone is not delivery evidence.
- Add an `APP.md` with an explicit entry, `source-type`, version, routes, public APIs, and produced pin path, following the Q&A registration pattern. Directory scanning plus this file performs registration; `METAAPPs/metaapps.config.json` is ignored runtime-generated state and must not be hand-authored as the source-of-truth registry.
- Open it through the existing MetaApp resolver/Bot Browser `metaapp://` and local `open_metaapp` paths. Do not invent a new URI scheme.
- A standard MetaApp deep link may use the Arena's documented hash route for a predefined pair. No special native pin-content resolver is required for the first milestone.
- Keep the bundled/reference app and its published chain app associated so `client.artifact` can use the published stable root in production feedback.
- The IDBots entry point only opens the MetaApp. Comparison UI, playback, forms, and queue state remain inside the MetaApp.

A later shortcut that opens a Motion Video artifact directly in a feedback client is a separate requirement and must not block the initial slice.

## 6. Workstream D — Preference Retrieval and Bot Learning

### API client and Agent tool

Extend the existing MetaSo client and `search_metaapps` flow compatibly:

- Add the MetaSo request parameters `sort`, `order`, `basis`, `minJudges`, and `learning` defined in the MetaSo contract; preference sorting also requires an explicit `chainName`.
- Preserve existing query/tag/chainName/publisher/since/forks behavior and cursor handling.
- Extend item normalization to retain the existing `currentPinId` and `prompt` fields that the current TypeScript client drops. Artifact identity mapping is `app = metaapp://<pinId>` and `version = metaapp://<currentPinId>`.
- Normalize the returned `motionVideo` and `preference` blocks without treating missing fields as zero.
- Add a read client for `GET /api/preference/comparisons` and expose preferred/rejected open contrasts with their reasons to builders.
- Expose preference ordering and evidence filters to builders in the Agent tool.
- Include evidence basis, comparison/judge counts, and publisher-declared learning status in tool output so a Bot can distinguish strong evidence from an unjudged or weakly judged item. Do not present `learning.status = declared` as MetaSo package verification.
- Map the stable `preference_validated_basis_unavailable` response to a readable “validated preference aggregation is not yet available” result; never silently fall back to open evidence or expose only a generic transport error.
- Do not replace the local sealed-round tally or lesson validation with a remote score.

### Builder workflow

Update the relevant MetaApp-building guidance and runtime integration so a Motion Video builder can:

1. Retrieve several high-preference learning-ready examples, not only one champion.
2. Retrieve rejected contrasts with concrete reasons and, where available, validated lessons.
3. Read the exact source package, APP.md, prompt, treatment, and reproduction checks before designing.
4. Record `learningMode` and `learnedFrom` in the new package metadata and log the actual retrieval/context delivery during controlled experiments.
5. Validate external lessons locally before promoting them into durable knowledge or procedures. Open feedback never auto-promotes a procedure.
6. Preserve exploratory/control assignments that forbid retrieval, and avoid turning preference guidance into a mandatory global style.

The existing knowledge/procedure, study, and local validation mechanisms should be reused rather than creating a second memory store.

## 7. Required Tests and Verification

Add focused tests for:

- Human/Bot Actor mapping, defaults, no-Bot fallback, identity replacement, and secret-field absence.
- Human and Bot generic write routing across create/modify/revoke and valid/invalid payloads, plus explicit pre-signing rejection of modify/revoke for `/protocols/preference/feedback`.
- Confirmation/result identity consistency, Actor-switch token/grant rejection, and no cross-signer fallback.
- Existing sealed user writer behavior after shared signer extraction.
- Unsupported Human/Bot action combinations failing explicitly.
- Thin Arena discovery/registration and normal MetaApp opening.
- MetaSo normalization, preference query parameters, missing evidence, and cursor propagation.
- Builder retrieval output, learning provenance, and control-group exclusion.

Run the relevant existing and new checks, at minimum:

```sh
pnpm run compile:electron
pnpm run build
pnpm run lint
pnpm run test:preference
pnpm run test:bot-browser
```

Run additional affected MetaApp, Browser bridge, knowledge, and integration tests named by the implementation plan. If ABC package pins or lockfiles change, use the required pnpm install/dependency checks and record the exact released versions.

## 8. Non-Goals

- No native Arena UI, preference-specific Browser write method, or new URI scheme.
- No private-key exposure, arbitrary signing API, or silent signer substitution.
- No local reimplementation of MetaSo as the long-term global read model.
- No direct promotion of open feedback into trusted procedures or claims of human verification.
- No production merge, deployment, ABC package upgrade, or chain publication without the required owner acceptance.

## 9. Handoff Evidence

The IDBots development agent must provide:

- Branch/head commit, scoped file list, exact pinned ABC version, and all verification results.
- Human/Bot Actor selection and actual-signer test evidence.
- Actor-switch authorization tests and proof that existing Bot-only behavior remains compatible.
- Real Arena open and generic PIN-write evidence when the integrated acceptance is authorized, including full pin ids and actual signer globalMetaIds.
- Real MetaSo preference retrieval output and an example of learning provenance.
- Deviations, remaining external dependencies, and mainline/release status.
