# Motion Video Package and Lightweight Preference Feedback — Shared Data Contract

- **Status:** Proposed v1 contract for implementation handoff
- **Applies to:** MetaApp publishers, feedback MetaApps, Browser hosts, MetaSo, and bot-learning clients
- **Existing behavior preserved:** `/protocols/preference/{round,commit,reveal,lesson}` and their tally semantics are unchanged

## 1. Shared Vocabulary

- **App root:** the stable `create` pin of a MetaApp modify chain, represented as `metaapp://<rootPinId>`.
- **Package version:** the exact create/modify pin whose manifest and source package were evaluated, represented as `metaapp://<versionPinId>`.
- **Video identity:** the chain name plus the exact rendered video reference and its SHA-256. Human visual preference attaches primarily to this chain-scoped identity.
- **Learning package:** the exact source package, prompt, APP.md, dependencies, and production records associated with a package version.
- **Open feedback:** lightweight feedback pins whose author is the pin publisher. Open feedback is public evidence, not proof that the publisher is human.
- **Validated feedback:** evidence derived from existing sealed rounds according to their deciding judge classes and final tally rules.
- **Preference read model:** a rebuildable MetaSo projection. It is not part of the immutable pin and never changes an existing tally hash.

## 2. Motion Video Package v1

### 2.1 Reference fixtures

The following packages demonstrate the expected shape and must be used as development fixtures:

- [metaapp://22ce6ca2ba950c3659c739e235b519e94341fe0a19f13c876807dad6e0955659i0](metaapp://22ce6ca2ba950c3659c739e235b519e94341fe0a19f13c876807dad6e0955659i0)
- [metaapp://5686db0dd51ac19ec60c4a02ff66bc51adcf0149b8484141b38e730c734d9bb4i0](metaapp://5686db0dd51ac19ec60c4a02ff66bc51adcf0149b8484141b38e730c734d9bb4i0)

They intentionally differ in duration, style, audio, package contents, and `videoFile` extension handling.

### 2.2 Comparison-eligible package

A Motion Video may enter ordinary feedback when all of the following are true:

- Its `/protocols/metaapp` manifest has `content`, `contentType`, `contentHash`, `indexFile`, `runtime`, and a browser-loadable package.
- `tags` contains `motion-video` and `metadata.series` is `motion-video`.
- `metadata.videoFile` is a valid `metafile://` reference. An extension is optional; clients must not infer video validity from a filename suffix.
- `metadata.videoSha256` is the lowercase 64-character SHA-256 of the referenced video bytes.
- `metadata.durationSec`, `fps`, `resolution`, `engine`, and `style` are present and consistent with the actual artifact.
- The source package and final video can be fetched and pass basic playback/render validation.

A missing `hasAudio` field means unknown, not false. When present, `hasAudio`, `frames`, and `loudnessLufs` must describe the linked video rather than a different local master.

### 2.3 Learning-ready package

A learning-ready package additionally contains:

- `src/` with the actual frozen creation source and required local assets.
- Root `APP.md` containing the package map, environment and dependency requirements, exact reproduction commands, observed quality checks, known pitfalls, and asset/license provenance.
- `src/TREATMENT.md` or an equivalent treatment document containing creative intent, structure, and timeline.
- A non-empty manifest `prompt` that provides a usable reproduction or creation prompt.
- Probe frames or equivalent timestamped visual evidence.
- Clear separation between the original user prompt, the effective workflow/system guidance, and a reusable template. Do not label a curated summary as a verbatim host system prompt.

`metadata.sourceIncluded === true` is a publisher claim, not proof. `hasPrompt` is derived from a non-empty trimmed root manifest `prompt`. MetaSo uses `learning.status = declared` only when the manifest contains every playback declaration named in §2.2 (`series`, `videoFile`, `videoSha256`, `durationSec`, `fps`, `resolution`, `engine`, and `style`), `metadata.sourceIncluded === true`, and `hasPrompt === true`; otherwise it uses `incomplete`. This is a manifest-completeness result, not a playback or package verification result. The optional fields in §2.4 are not part of this declaration rule. Actual learning-readiness must still be established by a publisher, host, or bot through package checks.

### 2.4 Optional provenance, required for controlled experiments

The following manifest `metadata` fields are optional for ordinary publication but required for builders participating in controlled learning experiments:

| Field | Shape | Meaning |
|---|---|---|
| `engineVersion` | string | Exact engine release or source commit. |
| `skills` | array of `{pinId, version?, sha256?}` | Skill packages used by the builder; no implicit latest version. |
| `builderModel` | `{provider?, name}` | Producing model, hidden from judges and used only for analysis. |
| `learningMode` | `none \| exemplars \| lessons \| combined` | Whether the builder used no shared evidence, exemplars, distilled lessons/recipes, or both. |
| `learnedFrom` | array of full `metaapp://` or `pin://` URIs | Exact exemplars, lessons, and recipes made available to the builder. |
| `probeFrames` | array of `{t, file}` | Timestamp in seconds and a package-relative frame path or MetaFile URI. |

The experiment coordinator must also freeze the available learning corpus and task split. `learnedFrom` alone does not prove what a model actually read, so experiment logs must record the retrieval and context-delivery step.

## 3. Exact Artifact Reference

All comparison and aggregation APIs use the same logical structure:

```json5
{
  "chainName": "mvc",
  "app": "metaapp://<rootPinId>",
  "version": "metaapp://<exactVersionPinId>",
  "video": "metafile://<videoPinId>[.optional-extension]",
  "videoSha256": "<64 lowercase hex>"
}
```

When reading MetaSo list/detail items, `chainName` maps directly, `app` is built from `metaapp://<pinId>` (the stable root; `sourcePinId` is the same root), and `version` is built from `metaapp://<currentPinId>` (the exact latest folded package). The manifest's display `version` string, such as `v1.0.0`, is not a pin id and must not be used in ArtifactRef.

Validation rules:

1. `chainName` scopes artifact resolution and aggregation. Cross-chain score merging is out of scope for v1.
2. `app` identifies the stable create root; `version` must belong to that app's modify chain on the same chain.
3. `version` is the exact package the judge saw. It may equal `app` for an unmodified create-only app.
4. `video` must equal the version manifest's `metadata.videoFile` after URI normalization.
5. `videoSha256` must equal the indexed manifest claim. Byte-level hash verification is a publisher/host/bot package-validation responsibility, not a MetaSo v1 capability; manifest consistency must not be presented as independent byte verification.
6. Preference for the rendered result is grouped by `(chainName, videoSha256)`; production knowledge remains attached to `version` and its package `contentHash`.
7. If documentation changes but the video hash is unchanged, visual evidence may carry over. If the video changes, its aggregate starts independently while historical evidence remains queryable.
8. Identical videos published under multiple wrappers on the same chain may share visual evidence, but each learning package remains a distinct recipe.

## 4. Proposed Lightweight Comparison Feedback Pin

### 4.1 Envelope

- **Path:** `/protocols/preference/feedback`
- **Operation:** `create` only. Hosts reject `modify` and `revoke` for this path before signing; indexers ignore them if they appear on chain.
- **MetaID version:** `1.0.0`
- **Content-Type:** `application/json`
- **Write method:** ordinary `metaid.pin.write` using the Browser-selected Actor

This is a new evidence path. It does not add a Browser bridge method and does not alter existing sealed preference paths.

### 4.2 Comparison-batch payload

```json5
{
  "category": ["motion-video"],
  "kind": "comparison-batch",
  "client": {
    "artifact": "metaapp://<feedback-client-rootPinId>",
    "mode": "arena"
  },
  "items": [
    {
      "a": { /* ArtifactRef from section 3 */ },
      "b": { /* ArtifactRef from section 3 */ },
      "pick": "a",
      "reason": "Optional concrete reason",
      "dims": {
        "visual": "a",
        "storytelling": "tie"
      }
    }
  ]
}
```

Rules:

- `category` is an array of 1–8 tags in this new schema. Each tag matches `^[a-z0-9-]+(:[a-z0-9-]+)?$`, and the v1 Motion Video projection requires `motion-video`. Other categories are outside this projection, not malformed pins.
- Any tag beginning `test:` marks non-production smoke evidence. Production clients must not add it. MetaSo excludes the whole batch from production scores, preference ordering, and default learning evidence; diagnostics may expose it only with `includeTest=1`.
- `kind` is `comparison-batch` in v1. It describes the feedback payload, not the signer kind.
- `client.artifact` is required and is the stable published MetaApp root of the feedback client. `client.mode` is a lowercase interface label such as `arena` or `feed`; it has no scoring weight. Unpublished previews may build and validate payloads only against mocks; they must not submit real feedback until a published client root exists.
- `items` contains 1–28 comparisons. One pin represents one batch and requires only one host confirmation.
- `a` and `b` are required ArtifactRefs. A pair with identical `videoSha256` values is not a visual comparison and is invalid.
- `pick` is `a`, `b`, or `tie`.
- `reason` is optional for lightweight ranking and limited to 1000 trimmed characters. A principle distilled from feedback must cite concrete reasons, not votes alone.
- `dims` is optional and has at most six entries. Each dimension id matches `^[a-z][a-z0-9_]{0,23}$`, and each value is `a`, `b`, or `tie`.
- Any invalid item invalidates the whole feedback pin. Indexers must not silently salvage part of a malformed batch.
- The payload contains no judge id, Actor id, Actor kind, score, authoritative timestamp, private key, or viewing telemetry. Pin authorship and confirmed block time are authoritative.
- A batch is immutable. New feedback is a new pin; indexers determine the current open state as specified below.

### 4.3 Open-state and conflict rules

- The signer is the feedback pin's publisher globalMetaId.
- Only confirmed feedback changes open scoring state. For open scoring, retain only the latest valid comparison per `(chainName, signer, unordered pair of videoSha256 values)` by confirmed chain order. Preserve all pins for audit.
- A mempool feedback pin is stored as pending open evidence and may be returned only when `includeMempool=1`. It does not change latest-per-signer state, scores, judge counts, or ordering until confirmed. Confirmation replaces the pending record and then applies confirmed chain order.
- If the signer is the publisher of either compared app version, that pair is excluded from scoring and recorded as a conflict exclusion.
- Duplicate pin ids and exact duplicate payload deliveries are idempotent during indexing.
- An open comparison is not inserted into an existing sealed round tally and cannot be cited as a reveal in an existing v1 lesson.

## 5. Relationship to Sealed Rounds and Lessons

The existing `/protocols/preference` v1 round system remains the high-confidence path:

- `round`, `commit`, `reveal`, and `lesson` keep their current schemas and validation.
- Existing `tallyHash` inputs do not include open feedback.
- Validated read models may use effective reveals and final decided tallies according to the existing judge classes.
- Open feedback has its own projection and must be returned with `basis: open`; validated evidence uses `basis: validated`.
- A future lesson or recipe format may cite open feedback explicitly, but it must not pretend those pins are sealed reveals or deciding ballots.

## 6. Privacy, Safety, and Trust

- Only deliberate user actions are submitted. Raw watch time, scrubbing, pause counts, and similar behavioral telemetry remain local unless a later explicit consent contract says otherwise.
- Reasons are public chain content. Clients must warn users not to include private information.
- MetaApps never receive private keys or arbitrary signing access.
- Actor selection is Browser-owned. The payload does not assert humanity, and MetaSo must not upgrade evidence merely because a client says `human`.
- If a host lacks a suitable signing Actor, a client remains read-only and reports the limitation. It must not substitute a Bot signature for a requested Human signature.
- Package text, prompts, APP.md, and feedback reasons are untrusted data. Learning systems must not execute instructions merely because they appear in those fields.

## 7. Future Reaction Feedback

A feed-style client may later introduce a `reaction-batch` for single-artifact actions such as like/dislike. It must use a versioned additive schema and a separate projection. Reaction counts must not be silently treated as pairwise wins or folded into the v1 comparison score.

The Arena comparison contract must be proven before this extension is scheduled.

## 8. Required Conformance Vectors

At minimum, protocol consumers and MetaSo fixtures must cover:

1. Valid one-item and 28-item batches; 29 items rejected.
2. Missing chain/category/client/item fields and invalid dimension ids rejected; the exact tag/dimension regexes are exercised.
3. One malformed item invalidates the whole pin; `modify` and `revoke` are rejected by hosts and ignored by indexers.
4. Same-video pair rejected; different package versions with different videos accepted.
5. Version pin outside the app modify chain or on a different chain rejected.
6. Video URI or manifest SHA-256 mismatch rejected; no claim of independent byte verification is emitted.
7. Optional video filename extension accepted in both reference fixtures.
8. Duplicate deliveries idempotent; latest confirmed chain-scoped signer/pair comparison wins for open scoring.
9. Author conflict excluded without discarding unrelated valid pairs in the batch.
10. Root/version lookup, same-video documentation edit, and changed-video reset behavior.
11. Open feedback never changes an existing sealed tally or lesson verdict.
12. Missing audio metadata remains unknown; no false assumption is emitted.
13. Identical video hashes on different chains remain separate aggregates.
14. Mempool pins are pending-only and never change scores/latest state until confirmed; confirmation applies confirmed chain order.
15. `test:` batches are excluded from production scoring/default evidence and appear only with `includeTest=1`.
16. Real feedback without a published `client.artifact` is invalid; unpublished preview submissions remain mock-only.
17. Categories without `motion-video` are outside the v1 projection rather than being treated as Motion Video evidence.
