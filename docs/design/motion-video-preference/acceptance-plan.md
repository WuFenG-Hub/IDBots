# Motion Video Preference Learning — Cross-Project Acceptance and Experiment Plan

- **Status:** Acceptance requirements; no implementation result is implied by this document
- **Coordination:** IDBots requirements and acceptance center
- **Companion documents:** [Master plan](README.md), [Data contract](protocol-and-data-contract.md), [ABC](abc-actor-requirements.md), [IDBots](idbots-requirements.md), [MetaSo](metaso-requirements.md), [Arena](arena-metaapp-requirements.md)

## 1. Acceptance Levels

Keep four claims separate:

| Level | What must be demonstrated | What it does not prove |
|---|---|---|
| L1 Component conformance | Each repository implements its contract and passes its own tests. | Cross-project integration or user value. |
| L2 IDBots end-to-end loop | Real videos load in the Arena, a Human/Bot-selected identity writes an ordinary pin, MetaSo aggregates it, and bots can retrieve the resulting evidence. | OAC compatibility or improved video quality. |
| L3 Cross-host portability | The same published Arena and shared ABC contract work in a real second host with its own Human/Bot identities. | Model improvement or network-wide adoption. |
| L4 Learning effectiveness | Controlled experiments show that shared evidence improves ordinary-model outcomes on unseen tasks without unacceptable quality, diversity, cost, or safety regressions. | Universal superiority or permanent parity with top models. |

A branch passing local tests is not production acceptance. Record each target repository's mainline and release state. Any production or staging deployment must follow the repository's main-only deployment rule; an accepted-but-unmerged branch must not remain live.

## 2. Fixtures and Evidence Handling

### Real Motion Video fixtures

- Fixture A: [metaapp://22ce6ca2ba950c3659c739e235b519e94341fe0a19f13c876807dad6e0955659i0](metaapp://22ce6ca2ba950c3659c739e235b519e94341fe0a19f13c876807dad6e0955659i0)
  - 10 seconds, silent, Ukiyo-e, `videoSha256 = b8113ccc77c592466f8c67b7ff775cb9c57927a516c34989e8611a1d09f81674`.
- Fixture B: [metaapp://5686db0dd51ac19ec60c4a02ff66bc51adcf0149b8484141b38e730c734d9bb4i0](metaapp://5686db0dd51ac19ec60c4a02ff66bc51adcf0149b8484141b38e730c734d9bb4i0)
  - Approximately 47 seconds, music-backed silent film, `videoSha256 = 39c9c6c9b2a035568a07273b92b3f426d383a5ab5c1d98dfb7bd760faf0e1860`.

Use these as format and compatibility fixtures, not as predetermined winners. The human tester's actual choice determines the test feedback.

### Evidence record for every real run

Record:

- Repository, branch, head commit, build/release version, and mainline deployment state.
- Host and version, ABC package version, selected Actor kind and globalMetaId.
- Exact command or user flow, time, environment, and dependency versions relevant to reproduction.
- Full pin ids and transaction ids for authorized writes; never abbreviate them.
- Raw API request/response evidence, indexer status, score version, and evidence counts.
- Screenshots or recordings for UI behavior when useful.
- Deviations, failures, retries, and unresolved external dependencies.

Real chain writes require explicit owner authorization and the normal confirmation flow. Do not manufacture preferences merely to make a test pass. Protocol smoke tests use `category: ["motion-video", "test:motion-video-smoke"]`; MetaSo stores them for diagnostics but excludes every category containing a `test:` tag from production scores, preference ordering, and default learning evidence. Production feedback clients must never attach `test:` tags.

## 3. L1 — Component Conformance Gates

### G1 ABC

- All required ABC tests and standard npm verification commands pass.
- One Human and one Bot appear in the selector; defaults and per-tab selection remain compatible.
- Identity disclosure consent applies equally to both kinds.
- Actor-switch confirmation/grant replay fails closed, including the corrected memory host.
- Existing Bot-only and standalone fixtures retain their expected behavior.

### G2 IDBots host adapter

- Runtime contains the sanitized Human Actor and available Bots without exposing secrets.
- Existing Bot default is preserved; no-Bot Human fallback behaves as specified.
- Generic create/modify/revoke writes route to the actual selected signer.
- Human/Bot failure never substitutes the other identity.
- Existing sealed preference tests and Browser tests remain green.
- Unsupported Actor/action combinations fail explicitly.
- The integration records the released ABC package version rather than a local source path.

### G3 Arena MetaApp

- All package references are relative and the static app works without a dedicated backend. `git ls-files` confirms the Arena source is actually tracked under the `.gitignore` exception rather than merely present in a local ignored directory.
- Mocked candidates with different durations/audio and optional video filename extensions normalize correctly.
- Pair selection, blindness, queue limits, exact payload, batch submission, and failure recovery pass component tests.
- No Actor id appears in MetaApp write parameters and no private telemetry appears in payloads.
- Keyboard and narrow-screen checks pass.

### G4 MetaSo

- Motion Video playback metadata is projected without treating absent fields as false or zero or presenting publisher declarations as package verification.
- Feedback schema, artifact/version resolution, duplicate handling, conflict exclusions, and open-evidence fixtures pass; the unavailable validated basis is reported explicitly rather than as zero.
- Replaying the same chain input produces the same read model and ordering for a fixed `scoreVersion`.
- Open projection storage is physically and logically isolated from any future sealed-preference namespace; existing IDBots sealed tally fixtures remain covered by G2 rather than being attributed to MetaSo.
- Cursor, low-evidence, unjudged, ascending/descending, chain-scoping, smoke-tag exclusion, mempool deferral, and min-judges cases pass.
- Backfill is idempotent and reports counts/errors honestly.

## 4. L2 — Real IDBots End-to-End Gate

Run this gate against a release candidate first and repeat the required smoke path after the accepted changes reach their intended mainline/release state.

### E1 Open and play

1. Start the intended IDBots build and open the Arena through its normal registered MetaApp path.
2. Load Fixture A and Fixture B through the MetaSo candidate API.
3. Confirm from the candidate response and normalized queued ArtifactRefs that `app = metaapp://<pinId>`, `version = metaapp://<currentPinId>`, and the video reference/hash are correct; do not infer identity from titles.
4. Play both videos, exercise independent seeking/replay, and verify that audible playback never overlaps.
5. Confirm that author, builder model, learning mode, and preference score are hidden before the vote.

### E2 Human selection and generic write

1. Preview and component-test any unpublished Arena only with mock writes. Before the real write, publish the Arena through the normal owner-reviewed publication flow and record its stable root for `client.artifact`; an unpublished preview must not submit a real pin.
2. Queue at least one genuine comparison and an optional concrete reason. For a smoke run, use the documented `test:motion-video-smoke` tag and verify that production retrieval excludes it.
3. Select the local human MetaID using the Browser Actor chip.
4. Submit the batch and inspect the Browser confirmation before approving.
5. Verify that the confirmation identity, actual signer, result Actor, and host audit agree.
6. Verify exactly one `/protocols/preference/feedback` create pin with `kind = comparison-batch`, valid ArtifactRefs, the published client root, and no viewing telemetry.
7. Verify no `preference.feedback.write` method or direct chain broadcast was used.

### E3 Authorization isolation and Bot shadow separation

- Attempt to reuse an earlier Actor's confirmation/grant after switching identities; it must fail.
- If a Bot-shadow write is authorized, perform it separately and verify the Bot globalMetaId and open evidence treatment. Never count it as validated human evidence.
- Remove or replace the Human identity in a test environment and verify that stale Actor/grant state cannot write.

### E4 MetaSo aggregation and retrieval

- Index the new feedback pin and verify open-state deduplication, conflict checks, exact chain-scoped video identity, and evidence counts. Verify the smoke pin is visible only with `includeTest=1`, and that an unconfirmed pin is pending-only until confirmation and does not affect scores or latest-per-signer state.
- Query `/api/metaapp/list?tag=motion-video&chainName=mvc&sort=preference&basis=open&order=desc`; before R7, also verify that `basis=validated` returns the documented unavailable error rather than an empty/zero score.
- Verify that unjudged works remain unjudged, open and validated scores are not blended silently, and cursor order is stable for a fixed dataset.
- Retrieve positive and rejected open contrasts with reasons through the evidence API.
- Verify IDBots `search_metaapps` exposes the same evidence without replacing local sealed tally validation.

### E5 Version boundaries

Using synthetic fixtures or authorized test versions:

- A documentation-only package update with the same video hash may retain visual evidence while preserving the new package version as a distinct recipe.
- A package update with a new video hash starts a new visual aggregate and never inherits the old video's score automatically.
- Re-wrapping the same video under another app does not duplicate or erase its learning-package provenance.

## 5. L3 — Second-Host / OAC Gate

When an OAC adapter is available, repeat the essential path in the real OAC host:

- The same published Arena loads and resolves public MetaSo/MetaFile resources.
- OAC supplies its registered Human and Bot Actors to the shared selector.
- Per-tab selection, disclosure consent, and Actor-switch isolation work.
- Human and Bot generic `metaid.pin.write` calls use the actual selected OAC identities.
- The resulting pins and MetaSo projections are indistinguishable in schema from IDBots-produced evidence apart from their actual authors/clients.
- An unsupported identity or signer fails visibly without substitution.

Shared ABC UI tests alone do not satisfy L3. Record the OAC repository, adapter commit, host version, and real acceptance evidence. L3 remains open until then.

## 6. L4A — Fresh-Bot Reproduction Experiment

Before measuring preference improvement, verify that a learning-ready package is actually usable:

1. Give a fresh ordinary Bot only the package and its documented environment requirements.
2. Record whether it can install dependencies, reproduce the video, and complete probe-frame checks without hidden operator guidance.
3. Run Fixture A as the baseline reproduction. Run Fixture B when validating the audio/timeline path and its larger sampling dependencies.
4. Record elapsed time, human interventions, failed commands and root causes, final media specifications, and visual/audio probe results.
5. Do not require byte-identical video hashes across different Chromium/platform rendering paths when the package documents legitimate anti-aliasing differences; require the documented structural and media checks instead.

Success shows package sufficiency, not aesthetic improvement.

## 7. L4B — Controlled Learning Experiment

### Experimental units and isolation

- Use multiple unseen Motion Video briefs. Ordinary feedback remains broad-category, but each controlled brief is assigned identically across experimental arms.
- Freeze the learning corpus, task split, engine/skill versions, tool permissions, and runtime budget before generation.
- Keep a holdout set of anchor works and tasks out of every learning arm's retrieval context.
- Record actual retrieval results and delivered context; manifest `learnedFrom` alone is insufficient evidence.

### Arms

| Arm | Builder |
|---|---|
| A Control | Ordinary model with no shared preference examples, lessons, or recipes. |
| B Exemplars | The same ordinary model with selected high-preference packages only. |
| C Combined | The same ordinary model with positive/rejected exemplars, lessons, recipes, and quality-check guidance. |
| D Strong baseline | The stronger model baseline under the equivalent tool/environment conditions, without the ordinary model's shared learning pack. |

Randomize assignment where practical, conceal arm/model/learning labels from judges, and randomize comparison sides. Apply the same technical eligibility gates to every arm.

### Measurements

- Primary: human pairwise outcome of C versus A across multiple unseen briefs.
- Secondary: B versus A, C versus D, technical pass rate, human correction time, generation cost/latency, and reproduction success.
- Report per-brief and per-model results, number of comparisons and independent judges, and uncertainty/confidence intervals. Do not rely on one pooled vote or one task.
- Pre-register the analysis and minimum meaningful effect before seeing judge results. A single result slightly above 50% is not proof of improvement.
- Check source/content similarity and creative diversity so copying a seed's story, composition, or style does not count as generalized learning.
- Track negative results and regressions; do not delete failed candidates from the evidence record.

### Iteration measurements

For each generation, retain the corpus snapshot and compare:

- New work against the same Bot's previous work where a revision task exists.
- New work against fixed hidden anchors for cross-generation context.
- Distribution changes, not only the best work, while keeping open and validated bases separate.
- Evidence coverage, unique judges, judge time, exploration exposure, and diversity.

L4 is supported only when the pre-registered criteria are met on unseen tasks and the result repeats sufficiently to rule out a single-example artifact. Otherwise record “not yet demonstrated” and iterate on the knowledge or toolchain rather than claiming parity.

## 8. Security, Abuse, and Honesty Matrix

| Case | Required outcome |
|---|---|
| MetaApp supplies or forges an Actor id | Host ignores/rejects it; trusted Browser selection remains authoritative. |
| Actor A's token/grant replayed as Actor B | Fail closed with audit evidence. |
| Human signing unavailable | Read-only or explicit error; never silently sign as a Bot. |
| Candidate publisher judges own work | Pair excluded as conflict and visible in diagnostics. |
| Duplicate pin/index delivery | Idempotent; no extra score weight. |
| Same signer repeatedly judges same pair | Latest valid open comparison only for open state. |
| Unjudged or one-vote work | Label evidence honestly; never present as established bad/good. |
| Open feedback injected into sealed tally | Existing tally/lesson validation rejects or ignores it. |
| Malformed item inside a batch | Whole feedback pin invalid according to contract. |
| Changed video under an old app root | New visual aggregate; no score laundering. |
| Prompt/APP.md/feedback contains agent instructions | Treated as untrusted data, never executed automatically. |
| Reason contains private data | UI warned before submission; no hidden telemetry added by host. |
| Branch passes but is not merged/released | Not production accepted; no main-only deployment violation. |

## 9. Handoff Decision Template

Each workstream returns:

```text
Workstream:
Target repository and branch/head commit:
Mainline/release status:
Requirements version and deviations:
Files/components delivered:
Verification commands and outcomes:
Real pin ids / API evidence (when authorized):
Security and regression evidence:
Remaining blockers:
Next recommended acceptance action:
```

The coordination center reviews evidence against L1–L4 independently, records accepted and rejected items in the master README, and returns implementation changes to the responsible development agent rather than silently patching cross-project contract mismatches.
