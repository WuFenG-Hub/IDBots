# ABC Generic Human/Bot Actor and PIN Write — Development Requirements

- **Target project:** `agent-browser-core`
- **Baseline inspected:** local `main` at `a8c75e5`; rebase requirements onto the actual current main before implementation
- **Status:** Ready for the dedicated ABC development agent after contract review
- **Shared contract:** [Protocol and data contract](protocol-and-data-contract.md)
- **Acceptance companion:** [Acceptance plan](acceptance-plan.md)

## 1. Objective

Complete ABC's host-neutral Actor model so a Browser host can offer both Human and Bot MetaID identities in the existing Actor chip, let the user select one per tab, and continue using the existing `metaid.pin.write` flow with the selected identity.

Do not add a preference-specific Browser method, do not let MetaApps select the signer, and do not move host wallet or identity implementations into ABC.

## 2. Current-State Evidence

- `packages/host-contract/src/index.ts` already defines `BrowserActorKind = 'wallet' | 'oac-bot' | 'idbots-agent' | 'idbots-account'` and a generic `BrowserActor` list shape.
- `BrowserRuntimeSnapshot` already exposes `actors` and `defaultActor`.
- `packages/ui/src/browser/app.ts` already renders every host-supplied Actor in `openUsingIdentitySelector` and stores selection per tab in `selectUsingIdentity`.
- `browser.actor.current` already has per-resource identity-disclosure consent and emits `browser.actor.changed` only when disclosure is allowed.
- `metaid.pin.write` already forwards through trusted Browser actions with two-phase host confirmation. The Actor is carried outside the MetaApp payload.
- Existing grant semantics bind resource, Actor, operation, path, and page session. `packages/host-standalone/src/adapter.ts` implements that binding; `packages/host-standalone/src/memoryHost.ts` currently omits `actorId` when checking a granted PIN write and must be brought into conformance for safe Actor switching.

These are reusable capabilities, not reasons to build a parallel identity system.

## 3. Required Behavior

### A1 — Reuse the existing Actor contract

- IDBots maps its human identity to `idbots-account` and its Bots to `idbots-agent`.
- OAC maps its Bot identities to `oac-bot` and uses the appropriate existing or additively extended kind for its human identity.
- Standalone may continue using `wallet` for its wallet-backed identity.
- No new `human` kind is required for the IDBots milestone. If another host genuinely needs a new kind, add it compatibly and document the semantic mapping rather than overloading an unrelated kind.
- `actorId` remains a stable host-local identifier. It is not supplied by a MetaApp and is not a global protocol identifier.
- `globalMetaId`, label, avatar, and default behavior retain their existing meanings.
- Do not add Actor kind, signer details, wallet data, or capabilities to the sanitized `BrowserMetaAppBridgeActor` merely for this milestone.

### A2 — Make the selector clearly generic

- The existing selector must display every runtime Actor without Bot-only filtering.
- Before selection, the user must be able to distinguish Human from Bot identities. This may be implemented through known-kind badges or equivalent host-provided presentation; do not invent a second identity list. An unrecognized kind must remain neutral rather than being guessed as Human or Bot; host labels may supply the missing presentation.
- Support generic Browser chrome labels such as `Actor` rather than hard-coded Bot-only wording. Host-specific labels remain supported through `runtime.labels`.
- Keep `browser.actor.current` and identity-disclosure consent unchanged for both kinds.
- Keep selection scoped to the current tab. Selecting an Actor must not navigate the tab, mutate the host default, or change another tab.
- Do not change the current default Actor merely because a human Actor was added.
- A host with no Human Actor simply omits it from `runtime.actors`; no new feature flag is required.

### A3 — Keep generic `metaid.pin.write` unchanged

- MetaApp request fields, protocol path handling, two-phase confirmation, and success result shape remain compatible.
- MetaApp parameters must not gain an Actor id, signer kind, private key, or “human” flag.
- The trusted Browser page continues to attach the selected Actor id to host action requests.
- The host remains responsible for re-reading and validating the selected Actor, constructing the confirmation, signing, broadcasting, auditing, and returning the actual Actor used.
- Unsupported signing states return explicit errors. There must be no silent fallback to another Actor.

### A4 — Enforce authorization isolation

- Confirmation requests and granted writes remain bound to `(resourceUri, actorId, operation, exactPath, sessionId)`.
- After an Actor switch, an earlier Actor's confirmation token or grant must not authorize a write as the newly selected Actor.
- The confirmation UI must show the same identity that the host will actually use. A stale or mismatched host confirmation is an error, not a cosmetic issue.
- Navigation, resource changes, page refresh, and session revocation retain their existing invalidation behavior.
- Identity disclosure consent remains scoped by resource and globalMetaId and must not become a blanket cross-app grant.
- Correct the memory-host grant lookup so it checks `actorId` as well as resource, path, operation, and session. Add a regression test that would fail without the correction.

### A5 — Document the host contract

Update the current host-integration and MetaApp bridge documentation, including `docs/metaapp-host-bridge-v1-host-requirements.md` and the relevant integration guide, so they say “selected Actor” rather than assuming an Actor Bot wherever both Human and Bot signers are possible.

The documentation must explicitly state:

- Hosts inject available identities and their signing capabilities.
- ABC does not access host wallets or private keys.
- Actor kind is UI/host context, not cryptographic proof of humanity.
- Host adapters must re-read the selected Actor at execution time.
- Human identity replacement or removal invalidates stale Actor state and authorizations before further writes.
- Unsupported host/Actor/action combinations return explicit errors without fallback.

Do not extend the legacy parity-only UI stack identified by ABC AGENTS.md.

## 4. Backward Compatibility

- A runtime containing only Bots behaves as before, including default selection, labels supplied by the host, consent, confirmation, and grants.
- Existing MetaApps using `browser.actor.current` or `metaid.pin.write` require no request changes.
- Existing standalone behavior remains honest: if standalone cannot broadcast a PIN write, it reports that state rather than presenting a successful signature.
- No persistent granted writes are introduced.
- No package is published and no host is forced onto an unreleased local ABC path as part of the source change.

## 5. Required Tests

Add or update host-contract, UI, standalone, and test-harness coverage for:

1. A runtime with one Human and one Bot Actor renders both and distinguishes their kinds.
2. Default Actor remains unchanged when a Human Actor is introduced.
3. Actor selection is per-tab; another tab retains its Actor.
4. `browser.actor.current` works for either kind only after per-resource consent; denial does not leak the identity.
5. `browser.actor.changed` after a switch is emitted only when disclosure is authorized.
6. PIN-write confirmation displays the selected identity and the success result returns the actual signer.
7. Replaying Actor A's confirmation or grant after switching to Actor B fails closed.
8. A forged or missing Actor id cannot select a signer.
9. Memory-host grant lookup enforces Actor binding.
10. Bot-only legacy fixtures and existing standalone failure behavior remain unchanged.

Run the target repository's standard verification, using its npm workspace conventions:

```sh
npm run build
npm test
npm run verify:packages
npm run verify:release-version
```

If the implementation changes release metadata, also run the relevant package publish dry-run; do not publish without owner authorization.

## 6. Non-Goals

- No preference protocol parsing, MetaSo aggregation, Motion Video UI, or Arena implementation in ABC.
- No IDBots/OAC wallet, SQLite, account, or signing imports.
- No generic arbitrary-signature or raw transaction API.
- No new URI scheme, preference-specific write method, or production deployment.
- No claim that standalone or OAC signing works until its own host acceptance demonstrates it.

## 7. Handoff Evidence

The ABC development agent must return:

- Branch, head commit, and the exact files changed.
- Results of all verification commands above.
- Human/Bot selector and confirmation evidence from the test harness.
- The Actor-switch authorization regression test and its failure mode before the memory-host fix.
- Release version and package dry-run results when applicable.
- Any contract deviation returned to the coordination documents before implementation.
