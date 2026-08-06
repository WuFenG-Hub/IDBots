# MetaID-Anchored Impression System Implementation Plan

**Status:** Ready for implementation review
**Date:** 2026-08-07
**Design baseline:** `docs/design/2026-08-07-metaid-anchored-impression-and-experience-system.md`
**Target branch:** `codex/dream-memory-id`

## 1. Outcome

This plan turns the frozen MetaID-anchored cognition design into a sequence of independently testable changes. The first complete delivery will let each local MetaBot:

1. resolve its own GlobalMetaID and authoritative Boss/Twin relationships;
2. record objective interactions with known or unresolved participants in real time;
3. form append-only, evidence-backed impressions during dreaming;
4. maintain a derived current impression for each subject GlobalMetaID;
5. receive a bounded, provenance-labeled relationship and impression context in private A2A and Group Task prompts; and
6. keep every impression private by default while supporting explicit, revocable, auditable sharing grants.

The implementation will not publish impressions on-chain, invent a Friend API contract, replace the existing memory system, or turn impressions into authorization decisions.

## 2. Delivery principles

The implementation must preserve these rules throughout every phase:

- GlobalMetaID is the semantic identity anchor. `metabot_id` remains a local runtime foreign key only.
- Impression ownership is directional: `(observer_global_metaid, subject_global_metaid)`.
- Boss and Twin facts come from local authoritative Bot configuration. They are never inferred by an LLM and are not duplicated into a second source of truth.
- Friend state is tri-state: `confirmed`, `not_confirmed`, or `unknown`. Resolver failure is always `unknown`.
- Objective interaction facts are written at interaction time. Dreaming is responsible for semantic interpretation, not basic event capture.
- Impression observations are immutable semantic records. Retries deduplicate; algorithm repairs append a newer observation and retain the older one.
- Current impression snapshots are rebuildable read models, not primary evidence.
- Public PIN data is evidence, not trusted instructions and not proof of direct cooperation.
- Shared memory keeps the original owner and provenance. Reading another Bot's impression never turns it into the reader's own experience.
- Every database change is additive, idempotent, and safe for existing user databases.

## 3. Current repository anchors

The implementation will extend existing sources rather than create parallel identity or conversation systems.

| Existing source | Data already available | Planned use |
| --- | --- | --- |
| `src/main/sqliteStore.ts` / `metabots` | `globalmetaid`, `metabot_type`, `boss_global_metaid`, one-Twin migration | Authoritative local identity, Boss, and Twin resolution |
| `src/main/coworkStore.ts` | A2A session/thread/episode records, `peer_global_metaid`, external conversation mappings, message PIN metadata | Direct A2A episodes and evidence |
| `src/main/serviceOrderStore.ts` | `counterparty_global_metaid`, order role and lifecycle | Service-order episodes and roles |
| `src/main/groupTaskStore.ts` | member and deliverable GlobalMetaIDs | Multi-party task episodes and evidence |
| `src/main/dreamStore.ts` | dream runs, fragments, daily summaries, date/version idempotency | Dream selection and transaction boundary |
| `src/main/services/dreamService.ts` | retry, repair, model selection, LLM validation flow | Subject-level impression reflection |
| `src/main/libs/dreamPrompt.ts` | versioned structured dream output | Extended impression output contract |
| `src/main/services/privateChatDaemon.ts` | private A2A peer identity and `memoryContext` prompt slot | First impression-context consumer |
| `src/main/services/groupTaskPrompts.ts` / `groupTaskDaemon.ts` | roster, task roles, existing experience block | Multi-party impression-context consumer |
| Existing `work_review` memory records | historical LLM reflections without reliable GlobalMetaID mapping | Historical input only; no name-based migration |

## 4. Target module layout

The cognition layer will be split by responsibility so storage, policy, LLM interpretation, and prompt rendering do not become one coupled service.

### 4.1 Identity and relationship modules

- `src/main/libs/globalMetaId.ts`
  - centralize the existing GlobalMetaID trim, canonicalization, and validation behavior;
  - expose nullable parsing and throwing assertion APIs;
  - never accept display names or local IDs as substitutes.
- `src/main/services/metaidRelationshipResolver.ts`
  - resolve local Boss and Twin relationships from `metabots`;
  - define the Friend provider interface and tri-state result;
  - return authority facts separately from impression data;
  - default Friend resolution to `unknown` until a real API adapter exists.

### 4.2 Experience modules

- `src/main/metaidExperienceStore.ts`
  - own episode, participant, and evidence persistence;
  - enforce idempotency and identity constraints;
  - provide date, observer, subject, source, and episode queries.
- `src/main/services/metaidExperienceRecorder.ts`
  - translate A2A, service-order, Group Task, scheduled-task, and public-PIN events into the common ledger contract;
  - keep source-specific mapping outside the store.

### 4.3 Impression modules

- `src/main/metaidImpressionStore.ts`
  - append validated observations;
  - link observations to evidence;
  - rebuild and read current snapshots;
  - expose observer-owned history queries.
- `src/main/services/metaidImpressionService.ts`
  - validate dream output against known participants and evidence;
  - coordinate append plus snapshot rebuild;
  - never resolve or change hard relationships.

### 4.4 Projection and authorization modules

- `src/main/services/metaidCognitionContext.ts`
  - assemble first-contact state, hard relationships, the observer's snapshot, recent evidence summaries, and permitted shared context;
  - enforce size limits and provenance labels;
  - return structured data plus a prompt renderer.
- `src/main/metaidMemoryGrantStore.ts`
  - persist grants and access audit records.
- `src/main/services/metaidMemoryAccessService.ts`
  - enforce capability, scope, expiry, revocation, and ownership rules before any shared read or write.

No renderer UI is required for the first delivery. Store and service APIs will be ready for later IPC/UI work without exposing private records prematurely.

## 5. Database plan

All tables will be created in both the main SQLite initialization path and their owning store's idempotent `ensureSchema()` path. Fresh-database and upgrade-database tests must cover both paths.

### 5.1 `metaid_experience_episodes`

One observer-owned objective episode. Multi-party events remain one episode with multiple participants.

| Column | Contract |
| --- | --- |
| `id TEXT PRIMARY KEY` | Stable local episode ID |
| `owner_globalmetaid TEXT NOT NULL` | Bot whose private experience ledger owns this record |
| `episode_type TEXT NOT NULL` | `direct_interaction`, `task_participation`, `service_order`, `scheduled_task`, `public_pin_observation`, or `third_party_reference` |
| `source_channel TEXT NOT NULL` | Source adapter name such as `metaweb_private`, `group_task`, or `service_order` |
| `source_key TEXT NOT NULL` | Stable source identity, never a display name |
| `session_id TEXT` | Local Cowork session reference when available |
| `external_conversation_id TEXT` | Protocol conversation reference when available |
| `task_id TEXT` | Group/scheduled task reference when available |
| `order_id TEXT` | Service-order reference when available |
| `status TEXT NOT NULL` | `open`, `completed`, `failed`, or `abandoned` |
| `started_at INTEGER NOT NULL` | Objective lifecycle time |
| `ended_at INTEGER` | Objective lifecycle time |
| `metadata_json TEXT NOT NULL DEFAULT '{}'` | Non-authoritative source metadata |
| `created_at`, `updated_at INTEGER NOT NULL` | Local persistence times |

Constraints and indexes:

- unique `(owner_globalmetaid, source_channel, source_key)` idempotency anchor;
- index `(owner_globalmetaid, started_at DESC)`;
- index by `session_id`, `external_conversation_id`, `task_id`, and `order_id` where useful;
- no episode is created for an owner without a verified GlobalMetaID.

### 5.2 `metaid_experience_participants`

| Column | Contract |
| --- | --- |
| `episode_id TEXT NOT NULL` | Parent episode |
| `participant_key TEXT NOT NULL` | Deterministic `global:<id>` or `unresolved:<key>` key |
| `globalmetaid TEXT` | Verified identity when known |
| `unresolved_actor_key TEXT` | Stable local unresolved identity when GlobalMetaID is unknown |
| `identity_state TEXT NOT NULL` | `known` or `unknown` |
| `role TEXT NOT NULL` | Source role such as initiator, executor, reviewer, payer, recipient, sender, or publisher |
| `display_name TEXT` | Mutable presentation metadata only |
| `source TEXT NOT NULL` | Provenance of the identity/role binding |
| `created_at INTEGER NOT NULL` | Persistence time |

Constraints and indexes:

- exactly one of `globalmetaid` and `unresolved_actor_key` is present;
- primary key `(episode_id, participant_key, role)`;
- index `(globalmetaid, episode_id)`;
- an identity-link operation may add a known binding but must preserve the unresolved key and original provenance in history.

### 5.3 `metaid_experience_evidence`

| Column | Contract |
| --- | --- |
| `id TEXT PRIMARY KEY` | Evidence record ID |
| `episode_id TEXT NOT NULL` | Parent episode |
| `evidence_type TEXT NOT NULL` | Message, PIN, deliverable, task result, order transition, or compact source summary |
| `source_key TEXT NOT NULL` | Stable source idempotency key |
| `pin_id TEXT` | Immutable chain evidence reference |
| `publisher_globalmetaid TEXT` | Verified publisher when available |
| `message_id TEXT` | Local message reference |
| `content_hash TEXT` | Integrity/deduplication value; not raw private content |
| `occurred_at INTEGER NOT NULL` | Source event time |
| `retrieved_at INTEGER` | Public evidence retrieval time |
| `metadata_json TEXT NOT NULL DEFAULT '{}'` | Typed source metadata |
| `created_at INTEGER NOT NULL` | Persistence time |

Constraints and indexes:

- unique `(episode_id, evidence_type, source_key)`;
- indexes by `pin_id`, `message_id`, and `occurred_at`;
- raw conversation text remains in its existing source table. The cognition ledger stores references and bounded semantic metadata, avoiding a second private-message archive.

### 5.4 `metaid_impression_observations`

One immutable semantic update owned by the observer.

| Column | Contract |
| --- | --- |
| `id TEXT PRIMARY KEY` | Observation ID |
| `observer_globalmetaid TEXT NOT NULL` | Resource owner |
| `subject_globalmetaid TEXT NOT NULL` | Impression subject |
| `episode_id TEXT` | Primary episode, if one exists |
| `observation_text TEXT NOT NULL` | What was observed |
| `interpretation_text TEXT NOT NULL` | LLM's cautious interpretation |
| `dimensions_json TEXT NOT NULL DEFAULT '{}'` | Extensible descriptors, not a mandatory score vector |
| `communication_guidance TEXT` | Useful future interaction guidance |
| `confidence_json TEXT NOT NULL DEFAULT '{}'` | Structured uncertainty, not a global trust score |
| `dream_date TEXT NOT NULL` | Dream batch date |
| `dream_version INTEGER NOT NULL` | Algorithm version |
| `model_id TEXT` | LLM provenance |
| `source_hash TEXT NOT NULL` | Hash of the bounded source set |
| `idempotency_key TEXT NOT NULL UNIQUE` | Retry anchor |
| `supersedes_observation_id TEXT` | Prior logical observation replaced by a repair |
| `status TEXT NOT NULL` | `active`, `superseded`, or `rejected` |
| `created_at INTEGER NOT NULL` | Persistence time |

The content fields are never updated after insertion. A version repair inserts a new observation and may mark only the old lifecycle status as superseded.

### 5.5 `metaid_impression_observation_evidence`

| Column | Contract |
| --- | --- |
| `observation_id TEXT NOT NULL` | Parent observation |
| `evidence_id TEXT NOT NULL` | Existing evidence record |
| `relevance TEXT` | Optional bounded explanation |
| `created_at INTEGER NOT NULL` | Persistence time |

Primary key: `(observation_id, evidence_id)`. The host rejects an observation if a referenced evidence ID does not exist or is outside the observer's permitted source set.

### 5.6 `metaid_impression_snapshots`

A rebuildable, observer-owned read model.

| Column | Contract |
| --- | --- |
| `observer_globalmetaid TEXT NOT NULL` | Resource owner |
| `subject_globalmetaid TEXT NOT NULL` | Impression subject |
| `first_seen_at INTEGER NOT NULL` | Earliest eligible episode time |
| `last_seen_at INTEGER NOT NULL` | Latest eligible episode time |
| `interaction_count INTEGER NOT NULL` | Deterministic eligible episode count |
| `direct_interaction_count INTEGER NOT NULL` | Deterministic direct episode count |
| `summary_text TEXT NOT NULL` | Current high-level impression |
| `style_descriptors_json TEXT NOT NULL DEFAULT '[]'` | Current communication descriptors |
| `cooperation_context TEXT` | Narrative cooperation assessment |
| `relationship_temperature TEXT` | Optional qualitative state |
| `communication_guidance TEXT` | Current suggested interaction approach |
| `uncertainty_text TEXT` | Important uncertainty or contradictions |
| `latest_observation_id TEXT NOT NULL` | Reducer cursor |
| `snapshot_version INTEGER NOT NULL` | Read-model schema/reducer version |
| `source_hash TEXT NOT NULL` | Rebuild verification hash |
| `created_at`, `updated_at INTEGER NOT NULL` | Persistence times |

Primary key: `(observer_globalmetaid, subject_globalmetaid)`. There is no universal reputation row and no single numeric trust score.

### 5.7 `metaid_memory_grants`

| Column | Contract |
| --- | --- |
| `id TEXT PRIMARY KEY` | Grant ID |
| `resource_owner_globalmetaid TEXT NOT NULL` | Owner of the shared memory |
| `grantee_globalmetaid TEXT NOT NULL` | Reader or delegated writer |
| `subject_globalmetaid TEXT` | Optional subject scope |
| `resource_type TEXT NOT NULL` | Snapshot, observation index, raw evidence, or future resource |
| `capabilities_json TEXT NOT NULL` | Validated capability set |
| `scope_json TEXT NOT NULL DEFAULT '{}'` | Conversation/task/time constraints |
| `valid_from INTEGER NOT NULL` | Start time |
| `expires_at INTEGER` | Required for non-local templates unless policy explicitly allows otherwise |
| `revoked_at INTEGER` | Revocation time |
| `created_by_globalmetaid TEXT NOT NULL` | Grant author |
| `created_at`, `updated_at INTEGER NOT NULL` | Persistence times |

Capabilities are limited to `read_summary`, `read_evidence_index`, `read_raw_evidence`, `append_observation`, `update_snapshot`, and `manage_grant`. No implicit Twin/Worker inheritance is stored as a grant.

### 5.8 `metaid_memory_access_audit`

Every shared access decision records:

- request ID and time;
- resource owner, reader, subject, resource type, and requested capability;
- matched grant ID when allowed;
- `allowed` or `denied` outcome;
- bounded reason code and scope reference;
- no copied raw private content.

The audit table is append-only and indexed by owner/time, reader/time, and grant ID.

## 6. Dream output contract

The existing daily summary, important memory, value lesson, self-identity, and `work_review` outputs remain compatible. The dream JSON gains an optional `impressionUpdates` array so older or partial LLM responses do not break the existing dream pipeline.

Each proposed update contains:

```json
{
  "subjectGlobalMetaId": "id...",
  "episodeIds": ["..."],
  "evidenceIds": ["..."],
  "observation": "...",
  "interpretation": "...",
  "dimensions": {},
  "communicationGuidance": "...",
  "confidence": {
    "level": "low|medium|high",
    "uncertainty": "..."
  }
}
```

Host validation will:

1. accept only subject IDs present in the selected participant/evidence set;
2. reject self-impressions from this output path;
3. resolve every episode and evidence reference;
4. distinguish direct interaction, task participation, public observation, and third-party reference in the prompt;
5. reject any attempt to add or change Boss, Twin, Friend, authority, grant, or policy facts;
6. cap text and array sizes before persistence;
7. produce no impression update when output is empty, invalid, or unsupported; and
8. commit observations and snapshot rebuilds only after the existing dream artifacts have reached a consistent write boundary.

`DREAM_VERSION` will be bumped when this contract becomes active. Repair runs will use the existing bounded nightly version-repair mechanism.

## 7. Context projection contract

The context builder returns a bounded structured projection before rendering text. It does not let prompt callers query tables directly.

### 7.1 Projection order

1. authenticated local observer GlobalMetaID;
2. authenticated/verified subject GlobalMetaID or unresolved state;
3. authoritative relationship facts and their sources;
4. contact state: first contact, known without direct interaction, or prior direct interaction;
5. observer-owned current snapshot;
6. compact objective history counts and recent evidence references;
7. explicitly granted shared summaries, clearly labeled by owner;
8. uncertainty and staleness metadata.

### 7.2 Prompt safety

- Relationship and memory context is descriptive, not an instruction channel.
- Public PIN text and shared summaries are delimited as untrusted context.
- Hard relationships may affect policy only through the separate relationship/authority resolver.
- If any lookup fails, the prompt receives less context, never broader authority.
- A first contact is derived only when there is no eligible direct episode, not merely because no snapshot exists.
- Prompt blocks have independent character/token caps and include no raw private evidence by default.

### 7.3 Consumers

- Private A2A: append the block through the existing `memoryContext` path in `buildPrivateChatA2ASystemPrompt`.
- Group Tasks: build one participant-relative block for the responding Bot and relevant task members, then append it through the existing `experienceBlock` path.
- Service orders: initially contribute evidence; direct prompt projection is added only where the order execution already has an authenticated counterparty GlobalMetaID.
- Human Cowork sessions with no authoritative human GlobalMetaID remain unresolved and do not receive guessed identity bindings.

## 8. Migration and compatibility strategy

### 8.1 Additive schema migration

- Use `CREATE TABLE IF NOT EXISTS`, guarded `ALTER TABLE`, and idempotent indexes.
- Never reset, delete, or replace the user SQLite database.
- Reopening an already migrated database must make zero semantic changes.
- Schema initialization failure disables only the new cognition layer and leaves existing Dream, Cowork, A2A, Group Task, and order flows usable.

### 8.2 Historical backfill

Backfill is conservative and source-specific:

- A2A sessions may be backfilled only when both the local Bot GlobalMetaID and `peer_global_metaid` are present and valid.
- Service orders may be backfilled from `counterparty_global_metaid` plus the local Bot's GlobalMetaID.
- Group Task episodes may be backfilled from member GlobalMetaIDs and task IDs. Deliverable authors become evidence publishers, not automatically counterparties.
- Existing public PIN references may become evidence only when publisher/source metadata is authoritative.
- Existing `work_review` rows remain historical dream inputs. Names or free text are never used to guess GlobalMetaID.
- Unknown historical actors remain unresolved and can be linked later without rewriting their original evidence.

Each backfill uses a versioned migration key and the same source idempotency key as live capture. Running live capture before or after backfill therefore converges to one logical record.

### 8.3 Rollout switches

The rollout uses separate gates so capture can stabilize before behavior changes:

1. schema/store available;
2. objective capture enabled;
3. dream impression generation enabled;
4. private A2A projection enabled;
5. Group Task projection enabled;
6. shared-memory reads enabled.

The default path after each phase will preserve existing behavior until that phase's acceptance tests pass. Shared-memory reads remain disabled until the grant and audit layers are complete.

## 9. Commit-by-commit implementation sequence

Every item below is one independently verifiable commit with its own English development journal entry. No commit is pushed unless explicitly requested.

### Commit 1 — Identity kernel and relationship resolver

**Type:** `feat`

Changes:

- add centralized GlobalMetaID parsing/validation;
- replace duplicated A2A normalization only where behavior is proven equivalent;
- add Boss/Twin relationship resolution from `metabots`;
- define Friend provider and tri-state return contract, defaulting to `unknown`;
- add focused identity and relationship tests.

Acceptance:

- invalid or missing GlobalMetaID never becomes an empty semantic key;
- one local Twin is resolved consistently for all Workers;
- Boss/Twin facts cannot be written by the impression service;
- Friend provider timeout/error returns `unknown`;
- existing A2A identity tests remain green.

### Commit 2 — Experience schema and store

**Type:** `feat`

Changes:

- add episode, participant, and evidence tables;
- implement idempotent store APIs and query indexes;
- wire fresh and upgrade schema initialization;
- add a test helper for reopening persistent in-memory exports.

Acceptance:

- duplicate source events converge to one episode/evidence set;
- multi-role and multi-party participants remain one episode;
- unknown actors require a non-empty unresolved key;
- all constraints survive database reopen;
- existing user tables and memory data remain unchanged.

### Commit 3 — Live A2A experience capture

**Type:** `feat`

Changes:

- record private A2A conversation lifecycle and message/PIN evidence;
- reuse Cowork session, conversation mapping, and chain metadata;
- ensure inbound/outbound replay and daemon restart are idempotent.

Acceptance:

- one logical private conversation is not double-counted after sync/restart;
- both participant GlobalMetaIDs and message direction are correct;
- handshake/placeholders are not treated as meaningful cooperation evidence;
- failed ledger writes do not block private-chat delivery.

### Commit 4 — Service-order and Group Task experience capture

**Type:** `feat`

Changes:

- map service order buyer/seller roles and lifecycle transitions;
- map Group Task membership, chair/worker roles, task lifecycle, and deliverable evidence;
- keep public deliverable publisher distinct from semantic counterparty;
- add source-specific tests.

Acceptance:

- service retries do not duplicate episodes;
- one Group Task is a multi-party episode, not pairwise copies;
- deliverable authorship and reviewer/coordinator roles remain distinct;
- capture failure does not change task/order state machines.

### Commit 5 — Conservative historical backfill

**Type:** `feat`

Changes:

- add versioned, restart-safe A2A/order/Group Task backfill;
- preserve unresolved actors and provenance;
- explicitly skip name-only `work_review` mappings.

Acceptance:

- repeated backfill produces no extra logical records;
- live-before-backfill and backfill-before-live produce equivalent ledgers;
- malformed legacy metadata is skipped and reported without aborting migration;
- no existing memory row is deleted or rewritten.

### Commit 6 — Impression observation and snapshot store

**Type:** `feat`

Changes:

- add observation, observation-evidence, and snapshot tables;
- implement append validation and idempotency;
- implement deterministic snapshot rebuild and per-subject history reads.

Acceptance:

- observations cannot reference another observer's inaccessible evidence;
- retrying one source hash/version is a no-op;
- a repair appends and supersedes without deleting history;
- deleting and rebuilding a snapshot yields the same result;
- no numeric global trust score is introduced.

### Commit 7 — Dream impression generation

**Type:** `feat`

Changes:

- extend the optional dream JSON contract;
- select per-subject episodes/evidence within bounded prompt budgets;
- validate and append impression observations;
- rebuild snapshots in the dream completion flow;
- bump `DREAM_VERSION` and preserve existing `work_review` behavior.

Acceptance:

- legacy/partial dream JSON still writes existing dream artifacts;
- hallucinated subject/evidence IDs are rejected;
- public observation is labeled differently from direct cooperation;
- retry, stale-running recovery, and version repair remain idempotent;
- one subject failure does not corrupt other valid subject updates or the prior snapshot.

### Commit 8 — Private A2A impression projection

**Type:** `feat`

Changes:

- add the structured cognition-context builder and prompt renderer;
- integrate it through private chat's existing `memoryContext` slot;
- distinguish first contact, known public identity, and prior direct interaction;
- add bounded prompt and failure-degradation tests.

Acceptance:

- Bot A sees only Bot A's impression of Bot B by default;
- Bot B's reverse impression is never substituted;
- lookup failure omits context without blocking the reply;
- hard relationship labels and impression language remain separate;
- raw evidence and untrusted PIN content are not injected by default.

### Commit 9 — Group Task impression projection

**Type:** `feat`

Changes:

- build responder-relative impression summaries for relevant roster members;
- label direct experience versus task-only or shared context;
- integrate through the existing Group Task experience block with strict size caps.

Acceptance:

- each Bot receives its own perspective, not the chair's perspective by default;
- large groups remain within a deterministic prompt budget;
- task membership alone does not become a claim of successful cooperation;
- existing chair/worker playbook and authority behavior remain unchanged.

### Commit 10 — Sharing grants and access audit

**Type:** `feat`

Changes:

- add grants and access-audit tables;
- implement capability/scope/expiry/revocation enforcement;
- allow summary-only shared reads behind a disabled-by-default gate;
- label shared context with its resource owner.

Acceptance:

- no grant means no shared read;
- expired/revoked/wrong-scope grants deny access;
- every allowed and denied shared read creates an audit record;
- `read_summary` cannot read evidence or mutate snapshots;
- Twin/Worker/Boss relationships do not silently create grants;
- shared context never counts as the reader's direct interaction.

### Commit 11 — Operational hardening and documentation

**Type:** `docs` or `fix` depending on findings

Changes:

- document storage ownership, migration behavior, feature gates, and repair procedure;
- add diagnostics for capture/dream/projection failures without logging private content;
- run the full relevant regression matrix and fix only issues found within this feature scope.

Acceptance:

- operators can distinguish schema failure, capture failure, LLM rejection, snapshot rebuild failure, and access denial;
- disabling the feature returns the app to prior prompt behavior without deleting data;
- repository build and all relevant targeted tests pass from a clean worktree.

## 10. Verification matrix

### 10.1 Required for every implementation commit

- `git diff --check`;
- `npm run compile:electron`;
- focused tests for the changed module;
- confirmation that unrelated user files are untouched.

### 10.2 Storage and migration gate

- fresh SQLite initialization;
- upgrade from a database without cognition tables;
- reopen after export/save;
- double initialization;
- double backfill;
- partial legacy data and malformed JSON;
- constraint and index inspection.

### 10.3 Dream gate

- existing `tests/dreamPrompt.test.mjs`;
- existing `tests/dreamStore.test.mjs` and search tests;
- existing `tests/dreamService.test.mjs`;
- dream memory write tests;
- new subject validation, evidence validation, retry, repair, and snapshot rebuild tests.

### 10.4 Interaction gate

- existing A2A session/identity tests;
- private-chat replay and restart tests;
- Group Task store/service/daemon tests;
- service-order lifecycle and presentation tests affected by recorder hooks;
- new multi-party, unresolved identity, and source idempotency tests.

### 10.5 Final gate

- `npm run test:memory`;
- all directly affected `node --test` suites;
- `npm run compile:electron`;
- `npm run build`;
- lint for changed files, then the repository lint command if baseline permits;
- clean feature worktree with no generated or request files left behind.

## 11. Failure and rollback behavior

- Schema failure: log a bounded diagnostic and disable the new cognition stores for that process; do not reset the database.
- Capture failure: preserve the source interaction and retry through idempotent recorder hooks; never fail message/task/order delivery solely because cognition capture failed.
- Dream parse/validation failure: preserve the prior snapshot and existing dream records according to the current dream failure contract; never write partial unvalidated impressions.
- Snapshot rebuild failure: keep append-only observations, retain the prior snapshot, and expose a repair path.
- Relationship/Friend resolver failure: return `unknown`; never broaden authority or infer friendship.
- Shared access failure: deny by default and append an audit outcome when the audit store is available.
- Feature rollback: turn off generation/projection gates while retaining additive tables for forward recovery. No downgrade path deletes user data.

## 12. Explicitly deferred work

The following items require separate design or external contracts and are not blockers for the first complete delivery:

- a public MetaID protocol for publishing selected impression projections;
- historical Friend relationship reconstruction;
- Friend API transport integration before its endpoint/auth/cache contract exists;
- project-anchored memory and project-specific read models;
- a public/global reputation score;
- automatic cross-device private memory synchronization;
- UI for browsing impressions, managing grants, or approving publication;
- migrating name-only historical `work_review` records;
- letting impressions grant permissions or override platform safety policy.

## 13. Definition of done

The first complete delivery is done when a private A2A or Group Task turn can identify a verified subject by GlobalMetaID, resolve hard relationships, retrieve the responding Bot's own evidence-backed current impression, label uncertainty and shared provenance correctly, and inject a bounded context without changing authorization or exposing another Bot's private memory. The same interaction must be present in the real-time ledger before the next dream, and the next dream must be able to append an idempotent observation whose snapshot can be rebuilt entirely from retained evidence and observation history.
