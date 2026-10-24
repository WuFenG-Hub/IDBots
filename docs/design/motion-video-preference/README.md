# Motion Video Preference Learning — Master Requirements and Handoff Plan

- **Status:** Requirements for external development handoff; not an implementation or deployment record
- **Coordination project:** IDBots
- **First vertical:** `motion-video`
- **Reference clients:** Motion Video Arena first; additional feed-style clients later
- **Shared write primitive:** existing `metaid.pin.write`

## 1. Goal

Build an open learning loop in which humans can enjoy and compare code-rendered Motion Videos through portable MetaApps, their explicit feedback is written as ordinary MetaID pins, MetaSo turns those pins into queryable preference evidence, and MetaBots use high-preference examples, rejected contrasts, lessons, source, prompts, and production recipes to improve their own next creations.

The first measurable hypothesis is not “a small model already equals a top model.” It is:

> The same ordinary model, given shared preference evidence and production knowledge, should outperform its own no-learning control on unseen Motion Video tasks and narrow the gap against a stronger-model baseline.

No model-weight training is required for this milestone.

## 2. Current Assets and Missing Links

### Already available

- Two inspected Motion Video packages provide rendered videos, source, prompts, production notes, treatment documents, probe frames, hashes, and reproduction instructions:
  - [metaapp://22ce6ca2ba950c3659c739e235b519e94341fe0a19f13c876807dad6e0955659i0](metaapp://22ce6ca2ba950c3659c739e235b519e94341fe0a19f13c876807dad6e0955659i0) — 10-second silent Ukiyo-e example.
  - [metaapp://5686db0dd51ac19ec60c4a02ff66bc51adcf0149b8484141b38e730c734d9bb4i0](metaapp://5686db0dd51ac19ec60c4a02ff66bc51adcf0149b8484141b38e730c734d9bb4i0) — approximately 47-second silent-film example with music.
- IDBots already implements sealed preference rounds, pairwise ballots with reasons, deterministic tallies, lesson validation, and lesson retrieval under `/protocols/preference/{round,commit,reveal,lesson}`.
- ABC already provides host-supplied Actor lists, per-tab Actor selection, identity-disclosure consent, generic `browser.actor.current`, and generic `metaid.pin.write`.
- IDBots already has both MetaBot signing and a separate human `user_identity` signing stack.
- MetaSo already aggregates MetaApps and generic pins. Its `/api/metaapp/list` supports `tag` filtering.

### Missing or unproven

- IDBots currently injects only MetaBots into the Browser Actor list and its Browser pin-write path resolves only MetaBot signers.
- There is no lightweight, artifact-level Motion Video feedback pin or cross-work preference read model.
- `/api/metaapp/list` currently returns neither playback metadata nor preference evidence; MetaSo has no sealed-preference collector/tally projection, so validated cross-round aggregation requires a separate later gate.
- There is no Arena MetaApp, batch human feedback flow, or second-host acceptance record.
- Lesson retrieval is not yet an automatic, validated local-learning pipeline for Motion Video.
- Existing mainnet preference runs are smoke evidence, not proof that lessons improve ordinary-model output.

## 3. Architecture

```text
Motion Video MetaApps + seed corpus
              │
              ▼
MetaSo candidate and playback APIs ─────────────────────┐
              │                                         │
              ▼                                         │
Portable feedback MetaApps                              │
  Arena first; feed and third-party clients later       │
              │ explicit comparison/reaction feedback   │
              ▼                                         │
Browser chrome: user selects Human or Bot Actor         │
              │ ordinary metaid.pin.write               │
              ▼                                         │
Host adapter: selected identity signs and broadcasts    │
              │                                         │
              ▼                                         │
Chain pins: /protocols/preference/feedback (proposed)   │
              │                                         │
              ▼                                         │
MetaSo rebuildable preference projections               │
  open and validated evidence kept separate             │
              │                                         │
              ▼                                         │
Preference-sorted candidates + contrasts + lessons      │
              │                                         │
              ▼                                         │
Bot retrieval → local validation → knowledge/procedures │
              │                                         │
              ▼                                         │
New Motion Video packages with learning provenance ─────┘
```

## 4. Locked Product and Protocol Decisions

| ID | Decision |
|---|---|
| D1 | Ordinary feedback uses one broad `motion-video` category. Topic, style, duration, audio, and resolution are not comparison gates. |
| D2 | The two referenced packages are format and acceptance fixtures. They are candidates for human judgment, not predeclared winners. |
| D3 | Multiple feedback MetaApps are encouraged. The shared contracts are the pin schema, artifact references, Actor model, and MetaSo read APIs—not one mandatory UI. |
| D4 | The first reference client is a side-by-side Arena. A feed-style client is a later workstream using the same backend and protocol family. |
| D5 | Do not add `preference.feedback.write`. All business pins use generic `metaid.pin.write`. |
| D6 | Human and Bot identities are parallel Browser Actors. Reuse existing kinds such as `idbots-account`, `idbots-agent`, `oac-bot`, and `wallet` where appropriate. |
| D7 | Browser chrome owns Actor selection. MetaApps cannot choose or forge the signer. Hosts re-read the actual Actor at execution time. |
| D8 | Existing sealed round/commit/reveal/lesson behavior and tally hashes remain unchanged. Open lightweight feedback is a separate evidence class. |
| D9 | Visual preference is attached to the chain-scoped video hash and exact package version. Stable app roots support discovery; a new video under an old root does not automatically inherit the old video's score, and v1 does not merge scores across chains. |
| D10 | MetaSo owns global aggregation and preference ordering. Scores are derived read-model values with explicit versions and evidence counts, not chain truth or public author rankings. |
| D11 | Open and validated evidence remain distinguishable. An Actor kind or a MetaApp claim is not cryptographic proof of humanity. |
| D12 | Unjudged works are not negative examples. Low-evidence works must be labelled, and exploration must remain possible. |
| D13 | Bot learning retrieves several positive examples plus rejected contrasts and reasons. It must not mandate one champion style. Local validation precedes promotion into durable procedures. |
| D14 | The Arena reference implementation belongs in `METAAPPs/motion-video-arena/` in IDBots. IDBots supplies thin registration/entry and host adaptation only; no native Arena UI and no new URI scheme. |
| D15 | Explicit feedback may be public on chain. Raw watch time, detailed viewing behavior, private prompts, secrets, and unpublished local telemetry remain local by default. |
| D16 | A result is not accepted or deployed merely because a feature branch passed tests. Production acceptance follows each repository's merge-to-main and release rules; full cross-host acceptance requires a real second-host run. |

## 5. Requirements Document Map

| Document | Primary owner | What it fixes |
|---|---|---|
| [Protocol and data contract](protocol-and-data-contract.md) | Shared protocol owners | Motion Video package fields, exact artifact references, comparison-batch pins, evidence classes, validation and privacy. |
| [ABC Actor requirements](abc-actor-requirements.md) | `agent-browser-core` development agent | Host-neutral Actor behavior, UI/documentation/tests, unchanged generic pin write, grant isolation. |
| [IDBots requirements](idbots-requirements.md) | IDBots development agent | Human/Bot Actor injection and signing, thin registration, retrieval and local-learning integration. |
| [MetaSo requirements](metaso-requirements.md) | `metaso-p2p` development agent | Playback projection, feedback indexing, preference scores, sorting, evidence APIs, replay tests. |
| [Arena MetaApp requirements](arena-metaapp-requirements.md) | MetaApp development agent | Portable Arena UI, candidate loading, playback, batch feedback, errors, accessibility, APP.md. |
| [Acceptance plan](acceptance-plan.md) | Coordination and acceptance agents | Component gates, real cross-project E2E, security, learning experiments, required evidence. |

## 6. Workstreams and Dependencies

| Workstream | Depends on | May proceed in parallel? | Integration gate |
|---|---|---|---|
| WS1 ABC generic Human/Bot Actor completion | This requirements package | Yes | ABC build, tests, package conformance and release checks. The ABC owner cuts any integration release through the ABC repository process; the coordination side only records its version. |
| WS2 IDBots Actor injection and generic Human/Bot signing | WS1 contract; the ABC-owner-published integration release for final integration | Adapter work may start against existing contracts | Actual Human and Bot writes, isolation tests, no fallback, existing behavior unchanged. |
| WS3 MetaSo playback and preference read models | Shared protocol/data contract | Yes | Deterministic replay, backfill, API and cursor conformance on fixtures. |
| WS4 Arena MetaApp | Shared protocol plus mocked MetaSo responses | Yes | Two real sample packages load and play; batch write uses generic pin write; no native fallback. |
| WS5 IDBots bot retrieval and learning | WS3 API contract | Yes, against mocks | Real MetaSo results, positive/rejected retrieval, provenance and local validation. |
| WS6 OAC host adapter | WS1 host-neutral contract | Yes | Real OAC Human/Bot selection and writes; no claim based only on shared UI parity. |
| WS7 Cross-project acceptance and learning experiments | Integrated WS2–WS5; WS6 for full cross-host sign-off | No | Evidence in the acceptance plan, including mainline/release state and full pin ids. |

## 7. Delivery Phases

### Phase 0 — Requirements freeze

- Review this package with the dedicated development agents.
- Resolve contradictions in this coordination repository before implementation starts.
- Convert each work order into the target repository's local plan without changing shared field names silently.

### Phase 1 — Component implementation with mocks

- ABC, MetaSo, Arena, and IDBots adapters run their own conformance tests.
- No component waits for a production dependency merely to test its local contract.
- Any required contract change returns to this package before implementation continues.

### Phase 2 — Real IDBots end-to-end slice

- Open the Arena through the normal MetaApp/Bot Browser path.
- Load and play both reference videos.
- Select the human Actor and submit one explicit comparison batch through `metaid.pin.write`.
- Verify the pin author, payload, exact artifact versions, and confirmation/audit behavior.
- Reindex in MetaSo, retrieve preference-sorted candidates and evidence, and verify them in IDBots.

### Phase 3 — Learning loop

- Bots retrieve multiple positive examples, rejected contrasts, available lessons, source, prompts, and recipes.
- Each builder records its learning mode and source pins.
- New works enter the same feedback and aggregation pipeline.

### Phase 4 — Measured generalization and wider hosting

- Run fresh-Bot reproduction and learning-vs-control experiments on unseen tasks.
- Run the second-host OAC acceptance gate when an adapter is available.
- Only after the shared contracts are stable, add a feed-style client and additional reaction types.

## 8. Handoff and Acceptance Rules

- Each development agent works in its own target repository and follows that repository's branch, worktree, package-manager, commit, test, and release rules.
- A handoff must include branch and head commit, changed files, exact verification commands and results, deviations, unresolved issues, and any real pin ids used during acceptance.
- Do not push, merge, publish packages, deploy, or write acceptance pins without the explicit authority and confirmations required by the target project and owner.
- A successful branch is not an accepted production delivery until the corresponding mainline/release step is complete. Any deployment from an unaccepted branch is a blocker, not a shortcut.
- MetaSo and OAC are external projects. Their completion cannot be claimed from IDBots tests alone.
- Requirement changes are made here first, then propagated to the affected work orders.
- No success claim about ordinary-model improvement is allowed without the controlled evidence defined in the acceptance plan.

## 9. Initial Status

| Workstream | Status at requirements handoff |
|---|---|
| WS1 ABC | Not started |
| WS2 IDBots | Not started |
| WS3 MetaSo | Not started |
| WS4 Arena MetaApp | Not started |
| WS5 Bot retrieval/learning | Not started |
| WS6 OAC adapter | Not started; repository and owner to be supplied by its development side |
| WS7 Acceptance | Requirements ready; implementation evidence pending |
