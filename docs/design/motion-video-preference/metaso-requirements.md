# MetaSo Motion Video Playback and Preference Read Models — Development Requirements

- **Target project:** `metaso-p2p` (Go/Gin/Pebble)
- **Status:** Ready for the dedicated MetaSo development agent after shared contract review
- **Shared contract:** [Protocol and data contract](protocol-and-data-contract.md)
- **Acceptance companion:** [Acceptance plan](acceptance-plan.md)

## 1. Objective

Extend MetaSo from a MetaApp manifest/feed indexer into the shared read layer for Motion Video discovery and preference learning:

1. Return the video playback and publisher-declared learning metadata already present in MetaApp pins.
2. Index lightweight comparison-feedback pins and produce deterministic, chain-scoped open-preference projections.
3. Add preference sorting, filtering, and positive/rejected evidence queries for MetaApps and bots.
4. Preserve existing sealed preference semantics and leave validated cross-round aggregation as a separately accepted later requirement.

MetaSo remains a read-side service. It does not sign feedback, download video/source packages, verify file bytes, or become a reward model.

## 2. Current-State Evidence and Constraints

- `internal/aggregator/publishedcontent/metaapp_api.go` registers `GET /api/metaapp/list`, `detail/:pinId`, and `forks/:pinId`.
- `metaapp_list.go` currently scans the MetaApp time index, filters, scores keywords, sorts, and uses offset cursors; `metaapp_types.go` defines a closed list-item shape.
- Full manifest JSON is retained in `Record.PayloadJSON`, but arbitrary fields are not projected into list items. `metadata.videoFile`, `videoSha256`, and related fields are therefore available from the indexed pin body but are not currently returned by `/list`.
- MetaSo currently has no `/protocols/preference` collector or projection. The `internal/metatask` pipeline indexes MetaTask events only and must not be repurposed for preference.
- MetaSo does not fetch `metafile://` content. It can validate that an ArtifactRef matches the indexed manifest fields, but it cannot independently prove the video bytes or source ZIP contents.
- Existing aggregation is chain-scoped. Preference aggregation must not silently merge identical identities across chains.
- API envelopes, error codes, rate limiting, and cursor conventions are shared and must remain compatible.

## 3. Workstream R1 — Motion Video List Projection

Extend `MetaAppItem` additively for Motion Video items:

```json5
{
  "motionVideo": {
    "videoFile": "metafile://<pin>[.optional-extension]",
    "videoUrl": "https://<optional-authoritative-content-url>",
    "videoSha256": "<64 lowercase hex>",
    "durationSec": 10,
    "fps": 24,
    "frames": 240,
    "resolution": "1920x1080",
    "hasAudio": false,
    "loudnessLufs": null,
    "engine": "lemo-opuscar",
    "style": "ukiyoe",
    "learning": {
      "sourceIncluded": true,
      "hasPrompt": true,
      "status": "declared"
    }
  }
}
```

Existing identity and visibility fields are normative and must not be renamed:

- `chainName` is the ArtifactRef `chainName`.
- `pinId` (also `sourcePinId`) is the stable app root; Arena builds `app` as `metaapp://<pinId>`.
- `currentPinId` is the exact latest folded package version; Arena builds `version` as `metaapp://<currentPinId>`.
- `disabled` is already part of the list item and is excluded by the Arena. `includeDisabled` does not make a disabled item eligible for judgment.
- `GET /api/metaapp/detail/:pinId?chainName=mvc` accepts a root or mid-chain version id, resolves the latest record, and returns these same identity fields. Deep-linked Arena candidates use this mapping rather than guessing root/version identities.

Rules:

- Read values from the current folded MetaApp manifest; do not duplicate them into a second manually maintained record.
- Preserve unknown/missing values as `null` or omission according to the existing item conventions. Missing `hasAudio` is unknown, not false; missing counts/scores are not zero.
- `videoUrl` is optional and must use configured authoritative content routing when supplied. `videoFile` remains the canonical reference.
- `learning.sourceIncluded` comes from `metadata.sourceIncluded`; `learning.hasPrompt` is true only when the root manifest `prompt` is non-empty after trimming.
- `learning.status = declared` exactly when the manifest contains every playback declaration named in the shared contract §2.2 (`series`, `videoFile`, `videoSha256`, `durationSec`, `fps`, `resolution`, `engine`, and `style`), `metadata.sourceIncluded === true`, and `hasPrompt === true`; otherwise it is `incomplete`. This is manifest completeness, not playback/package verification. The optional experiment fields in §2.4 do not affect this status.
- `declared` does not mean MetaSo inspected the ZIP. A `verified` status is reserved for a later, explicit verification-evidence contract and must not be emitted in this milestone.
- Bots must still download/read/validate the exact package locally before treating it as learning-ready.

Suggested implementation area: extend the existing `publishedcontent` MetaApp item/list projection rather than creating a duplicate Motion Video manifest index.

## 4. Workstream R2 — Open Comparison Feedback Aggregator

Create a focused `internal/aggregator/preference` module following existing aggregator registration, storage, route, and test patterns. Do not place preference-only projections into the closed generic MetaApp record and do not modify the MetaTask indexer.

Responsibilities:

- Consume confirmed and mempool `/protocols/preference/feedback` create pins. Reject host/client `modify` or `revoke` attempts for this path; ignore any that nevertheless appear on chain.
- Validate the shared `comparison-batch` schema atomically. The v1 projection accepts only batches whose category contains `motion-video`; other categories are recorded as unsupported rather than malformed.
- Exclude any batch containing a `test:` category tag from production scores, preference ordering, and default learning evidence. Store it for diagnostics and expose it only with `includeTest=1`.
- Resolve each ArtifactRef using `chainName`, app root, exact version, video reference, and video hash against the indexed MetaApp manifest.
- Mark an item invalid when its version is outside the app chain or its video fields disagree with the manifest.
- Keep open and validated evidence namespaces physically and logically separate. This workstream emits only `basis = open`.
- Record pin author, confirmed chain order, mempool state, client artifact/mode, reasons, dimensions, and conflict exclusions.
- Only confirmed feedback changes open scoring state. Apply latest-valid-per `(chainName, signer, unordered video-pair)` by confirmed chain order while retaining every event for audit.
- Exclude pairs where the signer published either compared app version and expose the exclusion in diagnostics.
- Store mempool feedback as pending with `isMempool: true`; expose it only with `includeMempool=1`. It does not affect latest-per-signer state, scores, judge counts, or ordering until confirmed. Confirmation replaces the pending record and then applies confirmed chain order.

Reusable implementation references include the generic `Aggregator` registry, `publishedcontent` backfill client, Q&A-style last-state-wins projections, and protocol-independent enumeration helpers. These are implementation aids, not permission to change existing MetaTask semantics.

## 5. Workstream R3 — Open Preference Score v1

Use a small, transparent cold-start score before considering Bradley–Terry/Elo or learned judges.

For each `(chainName, videoSha256)` in the open comparison graph:

```text
n = eligible open comparisons involving the video
wins = comparisons the video won
ties = comparisons tied
observedRate = (wins + 0.5 × ties) / n
score = (wins + 0.5 × ties + 1) / (n + 2)
```

- `score` is the neutral-prior smoothed pairwise rate, not an objective quality probability. `observedRate` is defined only when `n > 0`.
- `score` is `null` when `n = 0`; never emit a zero-quality score for an unjudged video. Its open summary is `{score: null, scoreVersion, state: "unjudged", comparisons: 0, judges: 0, lastComparedAt: null}`; these zero counts are actual measured counts, not defaults for missing data.
- `judges` counts distinct eligible signer identities; `comparisons` is `n`.
- `state = unjudged` when `n = 0`, `emerging` when `n > 0` and fewer than three distinct judges contributed, and `established` at three or more distinct judges. This is an evidence label, not a confidence guarantee.
- Return `scoreVersion = motion-video-open-pref-v1` and `lastComparedAt`.
- Opponent-strength correction is explicitly deferred. The score is a retrieval aid, not a public leaderboard or a sealed-round tally.
- Score computation is a read-model policy and never modifies chain pins or existing tally hashes.

## 6. Workstream R4 — MetaApp List Sorting and Filtering

Extend `GET /api/metaapp/list` additively. Existing calls without the new parameters retain their current behavior.

New parameters:

| Parameter | Values | Rule |
|---|---|---|
| `sort` | `preference` | Uses the selected preference basis instead of the existing feed/keyword order. |
| `order` | `desc` (default), `asc` | Descending returns stronger observed preference first; ascending is meaningful only for already judged items. |
| `basis` | `open` (default for this milestone), `validated` | Selects the evidence projection; never blends bases silently. |
| `minJudges` | integer ≥ 0 | Filters by distinct judges in the selected basis; zero imposes no filter. |
| `learning` | `declared`, `incomplete` | Filters publisher-declared learning metadata; not a MetaSo package verification claim. |

Additional rules:

- `sort=preference` requires an explicit `chainName` so scores from different chains are never blended. The reference clients use `chainName=mvc`.
- Before R7, `basis=validated` returns `code = 40000` with the stable message `preference_validated_basis_unavailable`. It must not return an empty or zero score masquerading as validated data. IDBots maps this exact response to its readable unavailable state.
- Null scores sort after every scored item in both directions. `minJudges > 0` naturally excludes null scores.
- Deterministic order: selected score in `order`, then comparisons descending, then existing update recency, then stable app root id ascending. Bind the cursor to all filters, basis, chain, score version, and the last sort key.
- Every item includes the `motionVideo` projection when present and both evidence summaries. Before R7, `preference.validated` is always exactly `{ "score": null, "state": "unavailable" }`; no zero counts or alternative state values are emitted.

```json5
{
  "preference": {
    "open": {
      "score": 0.73,
      "scoreVersion": "motion-video-open-pref-v1",
      "state": "established",
      "comparisons": 18,
      "judges": 5,
      "lastComparedAt": 1792832839
    },
    "validated": {
      "score": null,
      "state": "unavailable"
    }
  }
}
```

## 7. Workstream R5 — Comparison Evidence API

Add a read-only endpoint:

```text
GET /api/preference/comparisons
  ?chainName=mvc
  &category=motion-video
  &basis=open
  &subject=<videoSha256>
  &outcome=preferred|rejected|all
  &includeMempool=0
  &includeTest=0
  &includeExcluded=0
  &size=20
  &cursor=<opaque>
```

Parameters and response rules:

- `chainName`, `category`, and `basis=open` are required in this milestone. `basis=validated` returns the same `40000` / `preference_validated_basis_unavailable` response before R7.
- `includeMempool` defaults to false. Mempool items never affect scores; when explicitly included they appear only as pending evidence with `isMempool: true`.
- `includeTest` defaults to false. `test:` batches never enter production learning evidence and appear only when this flag is true for diagnostics.
- `includeExcluded` defaults to false. Normal responses contain scoring-eligible comparisons only; conflict-excluded pairs appear only in this diagnostic view and are marked `excluded` with a reason.
- `outcome=preferred` means the subject won; `rejected` means it lost. Ties belong to `all`, not either directional class. `outcome` other than `all` requires `subject`.

Response items contain:

- `feedbackPinId`, `chainName`, `basis`, `isMempool`, and confirmed/relay time.
- Exact `a` and `b` ArtifactRefs from the shared contract.
- `pick`, optional `reason`, optional `dims`, signer globalMetaId, and client artifact/mode.
- `subject` and the subject-relative outcome when that filter is used.
- `excluded` and an exclusion reason only in the diagnostic excluded view.

This endpoint supplies concrete contrasts and reasons for learning. It is not a global worst-list and must not be used to turn unjudged works into negative examples.

## 8. Workstream R6 — Backfill, Replay, and Conformance

- Add an idempotent backfill path for `/protocols/preference/feedback` using the existing enumerator/backfill primitives and a dedicated command when the target repository's pattern requires one.
- Do not modify the MetaTask indexer or its protocol path set.
- Keep projection storage rebuildable from chain. No hand-edited scores or manual SQL/Pebble fixes are valid recovery mechanisms.
- Use the existing `{code,data,message,processingTime}` envelope, business error conventions, rate limiting, and opaque cursors.
- Report backfill/index counts and errors by path and chain; do not advance a watermark past unread or malformed pages.

Required fixtures include both real sample manifests and all vectors in the shared contract, plus:

1. List projection with and without video filename extensions and audio metadata, plus exact `pinId` root / `currentPinId` version / `disabled` mapping.
2. Source/prompt declarations follow the exact manifest-completeness rule and are never promoted to `verified`.
3. Latest-per-signer/pair, conflict exclusion, malformed batch atomicity, and pre-signing modify/revoke rejection.
4. Mempool pins remain pending and score-neutral until confirmation; confirmation replaces pending state and applies confirmed chain order.
5. `test:` batches are excluded from production scoring/default evidence and appear only with `includeTest=1`; evidence APIs also exercise `includeMempool` and `includeExcluded`.
6. Null-score ordering in both directions and `minJudges` behavior.
7. Cursor invalidation when basis/chain/filters/scoreVersion change.
8. Same video hash on two chains remains chain-scoped.
9. `basis=validated` returns `40000` with `preference_validated_basis_unavailable`; every item's pre-R7 validated block is exactly `{score:null,state:"unavailable"}`.
10. Replaying the same confirmed chain input yields identical items and order for a fixed score version.

Run the target repository's standard checks after confirming its current instructions:

```sh
gofmt -w <changed-go-files>
go test ./...
go build ./cmd/metaso-p2p/
```

Also run the relevant preference backfill/replay tests and record their commands and results. Do not introduce npm/pnpm conventions into this Go repository.

## 9. Later Workstream R7 — Validated Preference Aggregation

R7 is not silently included in the first delivery estimate.

MetaSo currently has no sealed preference round/commit/reveal/lesson collector, tally implementation, or API. Before R7 starts, the coordination side must choose and document a verifiable source of validated evidence. The default requirement is a chain-replay implementation with conformance vectors against the existing IDBots tally engine.

Do not publish or consume a self-declared final score as if it were validated. Do not claim validated aggregation from lesson pins alone; they do not contain the full pairwise evidence needed for this read model.

R7 acceptance must show that:

- Open feedback never changes sealed tallies.
- Effective reveals, deciding Human judge classes, final decided status, and tally hashes are reproduced correctly.
- Validated scores use only eligible deciding Human evidence; AI shadow/public feedback remains separate.
- `basis=validated` becomes available only after the complete conformance gate passes.

Until then, IDBots may continue using its existing local `preference_lessons_search` for sealed lessons while global open-preference retrieval uses this MetaSo workstream.

## 10. Non-Goals

- No write API, wallet/signing, video/source download, byte hashing, ZIP verification, or reward-model training.
- No cross-chain score merging, public author leaderboard, global Elo, or opponent-strength model in v1.
- No treatment of publisher declarations as verified packages, unjudged works as negative, or open signers as proven humans.
- No production deployment or backfill against production without the target repository's review and owner authorization.

## 11. Handoff Evidence

The MetaSo development agent must return:

- Branch/head commit, changed aggregator/list/backfill files, and specification document references.
- Formatting, full test, build, and targeted replay/backfill results.
- Fixture responses for both reference Motion Videos and open-preference ordering/evidence queries.
- Proof that source/prompt declarations are not marked verified and validated-unavailable is reported honestly.
- Deployment/indexer state, any required backfill report, and remaining R7 dependencies.
