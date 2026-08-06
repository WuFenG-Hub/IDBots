# MetaID-Anchored Impression and Experience System

**Status:** Design baseline frozen for implementation planning
**Date:** 2026-08-07
**Scope:** IDBots local runtime, MetaID ecosystem identity, Bot-to-Bot interaction, and future Group Tasks

## 1. Summary

IDBots treats a MetaBot as a persistent, human-like agent living on MetaWeb. The model is the agent's brain; it is not the agent's identity. The durable identity is its chain-based GlobalMetaID, and the agent's behavior should be shaped by experiences and impressions accumulated by that identity.

This design adds an ID-anchored cognition layer on top of the existing experience and dream systems:

~~~text
GlobalMetaID identity
  -> authoritative relationships
  -> interaction episodes and evidence
  -> observer-owned impression observations
  -> current impression snapshot
  -> scoped context projection for the next interaction
~~~

The system is observer-relative. Bot A's impression of Bot B is not a global reputation record and is not automatically equal to Bot B's impression of A. Storage and reads are private to the observing Bot by default. Future sharing is supported through explicit grants without transferring ownership or merging perspectives.

## 2. Goals

### 2.1 Primary goals

1. Use GlobalMetaID as the ecosystem-wide identity anchor for people, Bots, and other agents.
2. Give each Bot a durable, private, incrementally updated model of the IDs it encounters.
3. Preserve the evidence behind every meaningful impression update.
4. Let the dream system perform open-ended semantic reflection with the Bot's LLM.
5. Keep hard relationships and authority outside of LLM inference.
6. Support direct conversations, A2A interactions, service orders, scheduled tasks, and future Group Tasks.
7. Provide a future-ready sharing and authorization layer for Twin, Worker, Boss, team, or task-scoped memory.
8. Keep the design idempotent, repairable, and compatible with existing local experience storage.

### 2.2 Non-goals for the first implementation

1. A global public reputation score.
2. Automatic publication of private impressions on-chain.
3. A one-dimensional trust score that replaces richer observations.
4. Letting an LLM create or alter Boss, Twin, Friend, or other authoritative relationships.
5. Making a shared impression identical to the reader's own experience.
6. Migrating existing work_review records immediately.
7. Project-anchored memory. Project memory can be added later as another perspective.

## 3. Identity rules

### 3.1 Canonical identity

GlobalMetaID is an opaque, immutable, ecosystem-wide identifier derived from a private key. It is the only identity key used by this design for cross-session and cross-agent semantics.

Local identifiers remain valid for local concerns:

| Identifier | Meaning | Allowed role |
| --- | --- | --- |
| GlobalMetaID | Chain identity of a person, Bot, or agent | Ecosystem identity and primary anchor |
| PinID | Unique chain data item | Immutable evidence reference |
| metabot_id | Local SQLite Bot row | Runtime/configuration foreign key only |
| session_id | Local conversation/session | Experience evidence reference |
| message_id | Local message | Fine-grained evidence reference |
| external_conversation_id | Remote or protocol conversation | Cross-process evidence reference |

Names, nicknames, avatars, and roles are display metadata. They may change and must never be used as identity keys.

### 3.2 Unknown identity

An interaction may occur before the other party's GlobalMetaID is known. Such data must be stored as unresolved, not assigned an empty or guessed ID.

The unresolved record carries a stable local unresolved_actor_key and identity_state=unknown. When an authoritative identity binding becomes available, the system may link old evidence to the known GlobalMetaID while preserving the original unknown state and provenance.

### 3.3 Observer-relative semantics

An impression is always directional:

~~~text
observer_global_metaid = the Bot/person that formed the impression
subject_global_metaid  = the Bot/person being described
~~~

The same subject may have different snapshots for different observers. No observer's snapshot is a universal truth.

## 4. Relationship layer

Relationships are explicit facts resolved from authoritative sources. They are separate from learned impressions.

### 4.1 Relationship types

The initial vocabulary is:

~~~text
boss
twin
friend
represents
owns
peer
~~~

Each type must define whether it is directional, symmetric, authoritative, and whether it carries authority semantics.

### 4.2 Twin and Worker topology

The local deployment constraint is:

~~~text
one Twin Bot per computer
N Worker Bots per computer
each Worker has exactly one Twin
each Worker has exactly one Boss
~~~

The twin and boss edges are directional. The Twin represents the user's digital persona but remains a distinct MetaID with its own history and personality. A Worker may have a different personal impression of the Twin or Boss than the Twin has of the Worker.

The one-Twin-per-computer rule is a deployment invariant. It does not by itself establish a global one-Twin-per-human rule across the ecosystem.

### 4.3 Friend API semantics

The Friend API is a current-state resolver, not a historical event source. Its result is tri-state:

~~~text
confirmed
not_confirmed
unknown
~~~

Every cached result records checked_at, expires_at, and the source. An API failure, timeout, or unavailable indexer must produce unknown, never not_confirmed.

The system must not reconstruct a historical Friend relationship for an old dream date when the API provides no snapshot. Historical cooperation can still be remembered as experience, but it must not be labeled as historical friendship without evidence.

### 4.4 Authority boundary

Identity and hard relationships may raise priority and expand capabilities within an explicit policy, but they do not remove platform safety controls. A GlobalMetaID authenticates who sent a request; it does not prove that the request is safe, correctly scoped, or uncompromised.

Boss/Twin policies may provide the highest configured authority while still respecting destructive-action confirmation, wallet and financial limits, secret isolation, operating-system permissions, and protocol safety restrictions.

LLM impressions never grant or revoke authority.

## 5. Experience layer

### 5.1 Real-time interaction ledger

Objective interaction facts are recorded as soon as an interaction or task round completes. Nightly dreaming must not be the only path by which an interaction becomes available to the next turn.

The logical model is:

~~~text
InteractionEpisode
  ├── participants
  ├── session/conversation references
  ├── task/order references
  ├── public PIN references
  ├── objective metadata
  └── lifecycle status
~~~

An episode may be open, completed, failed, abandoned, or otherwise protocol-defined. A multi-party episode uses participant roles instead of duplicating the whole event for every pair.

### 5.2 Participant roles

An episode participant may be recorded as:

~~~text
publisher
sender
initiator
coordinator
executor
reviewer
payer
recipient
counterparty
~~~

The chain publisher is not automatically the semantic counterparty. The episode stores known roles and leaves unknown roles unset instead of guessing.

### 5.3 Evidence sources

Evidence is typed because not all observations mean the same thing:

~~~text
direct_interaction
task_participation
service_order
scheduled_task
public_pin_observation
third_party_reference
~~~

Direct interaction and task participation may support a cooperation judgment. A public PIN may support a topic, capability, or style observation, but it must not be treated as proof of a direct collaboration that never happened.

Every evidence reference should preserve, where available:

~~~text
pin_id
publisher_global_metaid
session_id
message_id
external_conversation_id
source_channel
occurred_at
retrieved_at
content_hash
~~~

## 6. Impression cognition layer

### 6.1 Append-only observations

The LLM produces incremental observations. It does not directly overwrite the current snapshot.

An observation contains:

~~~text
observer_global_metaid
subject_global_metaid
episode_id
observation_text
interpretation_text
observed_dimensions
confidence
evidence_refs
dream_date
dream_version
model_id
source_hash
status
~~~

observed_dimensions is extensible and must not force every judgment into a rigid taxonomy. Possible dimensions include communication style, reliability, initiative, cooperation pattern, and relationship temperature. The LLM may leave a dimension unset when evidence is insufficient.

### 6.2 Current snapshot

The snapshot is a derived, observer-owned read model keyed by:

~~~text
observer_global_metaid + subject_global_metaid
~~~

It may contain:

~~~text
first_seen_at
last_seen_at
interaction_count
current_summary
current_style_descriptors
current_cooperation_assessment
current_temperature
confidence
latest_observation_id
updated_at
~~~

The snapshot is allowed to change, but observation history remains available for reconstruction and audit. The system should not begin with an automatic numeric decay formula. Recency and contradiction are provided to the dream prompt, and the Bot's LLM determines whether the current interpretation should change.

### 6.3 LLM responsibility

The LLM decides semantic questions such as whether a collaboration was successful, whether a behavior is stable or one-off, whether the relationship became warmer or cooler, what communication style is useful, and what uncertainty should remain.

The host enforces only structural and safety invariants:

- the subject must be a verified participant or evidence subject;
- evidence references must resolve to known records;
- hard relationships are read-only to the dream pipeline;
- empty or unparseable output produces no cognition update;
- retries and version repairs are idempotent.

## 7. Sharing and authorization layer

Private impression data is a resource owned by the observer. Future sharing is implemented through grants, not by merging snapshots.

### 7.1 Resource ownership

Every shareable resource has:

~~~text
resource_owner_global_metaid
subject_global_metaid
resource_type
visibility
source_refs
~~~

The owner is the observer that formed the memory, not the subject being described.

### 7.2 Grant capabilities

Access is capability-based:

~~~text
read_summary
read_evidence_index
read_raw_evidence
append_observation
update_snapshot
manage_grant
~~~

The default grant is summary-only and time-limited. Reading a Twin's impression does not give a Worker permission to rewrite it. A Worker that directly interacts with the same subject may form an independent observation under its own observer GlobalMetaID.

### 7.3 Grant constraints

A grant can be limited by:

~~~text
grantee_global_metaid
subject_global_metaid
resource_type
conversation_id
task_id
time window
capability set
~~~

All grants must be explicit, revocable, and auditable. A hard relationship may provide a default policy template, but the actual readable scope remains a policy decision.

### 7.4 Shared context provenance

When shared data is injected into a prompt, it must be labeled as shared experience and identify its owner. The reader must not mistake it for direct experience:

~~~text
This is a shared impression owned by Twin A.
It is not your own direct experience.
Use it as context, and update your own impression only after direct evidence.
~~~

## 8. Public PIN access and future publication

Public chain data may be freely read according to the MetaID protocol. The local impression remains private by default.

Future publication is an explicit transformation:

~~~text
private impression
  → owner selects a public projection
  → new MetaID PIN is created
  → public record has its own schema, version, and visibility semantics
~~~

The private database must never be treated as an automatically synchronized public reputation store.

Public PIN content is external data. It must be escaped and treated as evidence, not system instructions. The system should inject compact summaries and references by default and retrieve full content only when the current task requires it.

## 9. Dream integration

The end-to-end flow is:

~~~text
real-time interaction completion
  → append objective episode/evidence

nightly dream consolidation
  → select recent participant GlobalMetaIDs
  → retrieve prior private snapshot and relevant observations
  → retrieve permitted public PIN evidence
  → ask the Bot LLM for incremental impression updates
  → validate subjects and evidence
  → append observations
  → rebuild current snapshots

next A2A or Group Task turn
  → resolve hard relationships
  → resolve private/shared impression scope
  → inject a bounded context block
~~~

The existing work_review records remain historical inputs. They are not forcibly migrated into the new model until a stable GlobalMetaID mapping is available.

## 10. Privacy and failure invariants

The implementation must preserve these invariants:

1. A Bot's private impression is not visible to another Bot without a valid grant.
2. A grant failure or unavailable resolver does not broaden access.
3. Friend API failure is unknown, not not_confirmed.
4. The dream LLM cannot create or alter hard relationship facts.
5. The dream LLM cannot invent a subject GlobalMetaID.
6. A public PIN does not prove direct interaction.
7. A shared summary does not become the reader's own experience.
8. Re-running a dream date cannot duplicate counts or observations.
9. Every current impression can be traced to observations and evidence.
10. Historical evidence is retained even when the current snapshot changes.
11. Local runtime IDs are never used as ecosystem identity keys.
12. Authority policies remain separate from impression semantics.

## 11. Implementation phases

### Phase 1: Identity and relationship adapter

Resolve and validate GlobalMetaIDs, map local Bot rows to canonical IDs, and expose Twin/Boss/Friend facts without changing prompt behavior.

### Phase 2: Interaction and evidence ledger

Record direct interactions, participants, task roles, session references, and public PIN references. Add idempotent episode keys.

### Phase 3: Impression observations and snapshots

Add the append-only observation layer, deterministic reducer, and current snapshot query API.

### Phase 4: Dream integration

Extend the existing nightly dream pipeline to produce validated subject-level impression updates and rebuild snapshots safely on retry or algorithm repair.

### Phase 5: Private A2A projection

Inject the observer's own snapshot and recent evidence into A2A contexts, with clear first-contact and uncertainty behavior.

### Phase 6: Shared memory authorization

Add grants, capability checks, expiration, revocation, audit records, and Twin/Worker/Group Task sharing templates.

### Phase 7: Optional public protocol

Define a separate MetaID PIN schema for explicitly published impression projections. This phase must not make local private impressions public by default.

This document is the design baseline for the next implementation-planning pass. It intentionally leaves the existing work_review data intact and treats shared memory as an authorization layer over observer-owned resources.
