# MetaID Impression System — Operations Guide

Status: implemented alongside the MetaID-anchored impression implementation plan.

This guide covers storage ownership, migration behavior, feature gates,
failure classification, diagnostics, and repair procedures for the MetaID
impression system. It is written for operators; the system design and the
commit-by-commit plan live in the sibling implementation-plan document.

## 1. Storage ownership

All cognition state lives in the user-directory SQLite database
(`idbots.sqlite`). The tables are additive and are never a second source of
truth for identities, relationships, or business records:

| Table | Owner | Purpose |
| --- | --- | --- |
| `metaid_experience_episodes` | local Bot (observer `owner_globalmetaid`) | Objective interaction ledger (private A2A, service order, group task, public pin observation). |
| `metaid_experience_participants` | local Bot | Participants and roles for each episode. |
| `metaid_experience_evidence` | local Bot | Evidence references (pin/tx/message IDs and hashes), never raw private message bodies. |
| `metaid_impression_observations` | local Bot (observer) | Append-only LLM-generated impressions with evidence links. |
| `metaid_impression_observation_evidence` | local Bot | Observation↔evidence association. |
| `metaid_impression_snapshots` | local Bot | Rebuildable current-impression read model. |
| `metaid_memory_grants` | resource owner | Explicit shared-read grants. |
| `metaid_memory_access_audit` | resource owner | Append-only allowed/denied shared-read decisions. |

Every row is scoped to a GlobalMetaID. Boss/Twin/Friend topology is resolved
from authoritative local state and is never stored as an implicit grant.

## 2. Migration behavior

- Schema creation uses `CREATE TABLE IF NOT EXISTS` plus idempotent indexes;
  reopening an upgraded database performs zero semantic changes.
- No migration deletes, resets, or rewrites existing user data. Historical
  `work_review` rows remain dream inputs; names or free text are never used to
  guess GlobalMetaIDs.
- Backfill is versioned and source-keyed, so live capture and backfill converge
  on one logical record per source.
- If the cognition schema/store fails to initialize, only the new cognition
  layer is disabled for that process. Dream, Cowork, A2A, Group Task, and order
  flows continue with prior behavior.

## 3. Feature gates

The rollout uses independent gates; default behavior is preserved until each
gate's acceptance tests pass:

1. Schema/store available — implicit when the stores construct successfully.
2. Objective capture enabled — recorder hooks are wired at A2A inbound,
   outbound, assistant reply, service-order lifecycle, and group-task message
   boundaries; capture failure never blocks delivery.
3. Dream impression generation — gated by the dream `DREAM_VERSION` and the
   presence of `metaidImpressionStore` in the dream service.
4. Private A2A projection — additionally gated by the existing
   `memoryEnabled` policy check in private chat.
5. Group Task projection — wired as an optional daemon dependency; absent or
   failing, group turns run without impression context.
6. Shared-memory reads — `MetaIDMemoryAccessService` is disabled by default
   (`enabled: false`) and returns audited `feature_disabled` denials until
   explicitly opted in.

To roll back any gate without data loss, disable the corresponding gate only;
the additive tables remain for forward recovery.

## 4. Failure taxonomy and diagnostics

Operators should be able to distinguish these failure classes from bounded log
lines. Diagnostics never include private message text, raw LLM output, or full
GlobalMetaIDs beyond the same bounded prefixes used elsewhere in the app.

| Class | Symptom | Diagnostic markers |
| --- | --- | --- |
| Schema failure | Cognition stores unavailable at startup | `[PrivateChat] MetaID cognition context unavailable`, `[DreamService] MetaID impression layer unavailable` |
| Capture failure | Ledger write fails at an interaction boundary | `[PrivateChat] * experience capture failed`, `[GroupTaskDaemon] experience capture failed`, `[ServiceOrder] Experience capture failed` |
| LLM rejection | Dream output fails to parse or validate | existing dream failure contract: `dream output unparseable after retry` |
| Impression consolidation failure | One subject fails to append or rebuild | `[DreamService] Impression updates ... accepted/rejected/rebuilt` and `[DreamService] MetaID impression consolidation failed` |
| Snapshot rebuild failure | Rebuild throws after observations are durable | caught per subject; observations remain and the prior snapshot is retained |
| Projection failure | A2A/Group Task context unavailable | `[PrivateChat] MetaID cognition context unavailable`, `[GroupTaskDaemon] MetaID group cognition projection unavailable` |
| Access denial | Shared read denied | `metaid_memory_access_audit` rows with bounded `reason_code`: `feature_disabled`, `no_grant`, `expired`, `revoked`, `missing_capability`, `scope_mismatch`, `not_yet_valid`, `no_snapshot`, `audit_failure` |

The audit table is the authoritative access-denial record; log lines are
diagnostics only.

## 5. Repair procedures

### Snapshot repair

Observations are append-only. To rebuild a snapshot after a failed rebuild:

```bash
# From the compiled main bundle (or via the store API in a maintenance tool):
MetaIDImpressionStore.rebuildSnapshot(observerGlobalMetaID, subjectGlobalMetaID)
```

The rebuild is deterministic from retained evidence and active observations;
it never invents a trust score.

### Backfill retry

Re-running backfill is safe: each source is version-keyed and each episode uses
the same idempotency key as live capture. Duplicate runs fill missing anchors
without overwriting existing facts.

### Grant management

- Only the resource owner can create or revoke grants.
- Revoking a grant takes effect immediately; subsequent reads produce audited
  `revoked` denials.
- Inspect access decisions with `listAudit({ resourceOwnerGlobalMetaID, readerGlobalMetaID, grantId })`.

### Feature disable

Turning off a gate (for example, disabling shared reads or removing the group
cognition dependency) restores prior prompt behavior without deleting data.
There is no downgrade path that discards user data.

## 6. Verification

Per-commit and final verification:

```bash
npm run compile:electron
node --test tests/metaidCognitionContext.test.mjs tests/metaidDreamImpressionService.test.mjs \
  tests/metaidExperienceStore.test.mjs tests/metaidExperienceRecorder.test.mjs \
  tests/metaidExperienceBackfillService.test.mjs tests/metaidImpressionStore.test.mjs \
  tests/metaidMemoryAccessService.test.mjs tests/groupTaskDaemon.test.mjs \
  tests/groupTaskStore.test.mjs tests/serviceOrderExperienceEvents.test.mjs \
  tests/privateChatLiveA2A.test.mjs tests/privateChatOutgoingA2ADisplay.test.mjs
npx eslint <changed-files> --report-unused-disable-directives --max-warnings 0
git diff --check
```

## 7. Explicitly out of scope

Public on-chain impression publication, Friend API transport integration,
project-anchored memory, reputation scores, automatic cross-device sync, and
the grant/audit UI remain deferred until their own design exists.
