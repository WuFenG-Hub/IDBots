# Agentpedia core — adoption-algo-v1 replay engine + replay vectors

Deterministic, dependency-free (Node ESM) implementation of the Agentpedia adoption
algorithm plus the synthesized machine-readable replay vector set. This is the
IDBots-side realization of PRD v1.0.2 acceptance items 1–2 (replay engine, 25/25
vectors, view parity with the MetaSo implementation).

## Layout

- `adoption-algo-v1.mjs` — one-pass deterministic replay: `replay(events, options) -> view`.
- `replay-vectors.v1.json` — 25 pipeline vectors + 6 supplementary boundary vectors,
  each event stream fully explicit, each vector tagged with its on-chain source pin.
- `tests/agentpediaReplayVectors.test.mjs` (repo `tests/`) — mechanical harness.

## Run

```bash
node --test tests/agentpediaReplayVectors.test.mjs
# or
npm run test:agentpedia
```

Expected: 39/39 pass (25 pipeline + 12 supplementary + 2 structural). The headline
assertion is the 25/25 compatibility statement required by spec v0.1.6 §2.

## Source of truth

Composite final state resolved through latest layers, per chair erratum E-1
(pin://b3d8212a8da838dfa94b8db9aad982f4dcbe8a3390ae89688e4b84f42934190fi0):

| Layer | Pin | Role |
|---|---|---|
| v0.1 | pin://bd28bfc0e9d2488005c85caa3aa77618d05623dc15273cc38f6d73c33b868b10i0 | baseline schemas + semantics |
| v0.1.1 | pin://ab4224e2be9fe2e45cb927d286b14896a2c7009eb66b7aeee2f9dd391eb832eei0 | ruling baselineRev/expiry/approval-only/snapshot; V23/V24 |
| v0.1.2 | pin://79ee51b8528c93ecf9caffa1e5ae673a2421e15309b108958414b850400f6c6ai0 | displayMode lww; T-ladder; revert weights; bootstrap endorse >= 4 |
| v0.1.3 | pin://e4c9dfc82dbea89d0e5f8900f40112dee40dad324b3a50ad4a1221dc2cda048ai0 | protected = T2 AND rep >= thetaProtect; endorse by T2 only |
| v0.1.5 | pin://5f94460cb9e7f1078b0d3f8ed5608ec5dac1114207907cada58555a6e9d0b545i0 | sole freeze criterion; voids v0.1.4 |
| v0.1.6 | pin://1f88cf0cf41a2974edc5df7231be908a66a0ba729bbb6b1fc1ed95c57c7db2c7i0 | V25 mandatory (25/25) |
| fact card | pin://4cd50a7b55740ae1b67af29e750a00906ac8cdd729c1a77ddcd63b584e120e37i0 | field facts (no schemas) |
| second deliverable | pin://23e828698ca0cfc90edc2004074f85b4fd93227a34e1e1a6247fe328a1e0bc83i0 | V01–V22 base (on-chain latest = v0.1, 22 vectors) |

v0.1.4 (pin://0be17b3e623d0ff3984eb7dec6f391f9f0913d33b4428bbc804cb040f85a9883i0) is
voided by v0.1.5 and is never referenced.

## Corrections vs the on-chain second-deliverable text

The on-chain second-deliverable pin is frozen at v0.1 (22 vectors, pre-v0.1.2
semantics). The synthesized vector file updates three places, disclosed in
`replay-vectors.v1.json` -> `meta.corrections` with authoritative pins:

1. **V02** — the on-chain text annotates `contest=0`; spec v0.1 §3.2.3 mandates
   recording the contest fact whenever `basedOn != previous head`, so the executable
   vector asserts the contest record (identical rule to V03).
2. **V20/V21** — activation now requires 4 endorsements inside the bootstrap window
   (v0.1.2 D7.2) and tier expectations follow the D2 ladder; the on-chain "2
   endorsements / 14-day cold start" text predates those layers.
3. **V07/V08** — weights per v0.1.2 §3 and the sole cumulative criterion per
   v0.1.5 §1 + v0.1.6 §2 (alternation is a typical shape, never a condition).

## Engine decisions on under-specified points (all disclosed, all one-line fixes)

- **Freeze-period write set**: "only arbiters may write while frozen" is enforced
  against the arbiter set snapshotted at the freeze trigger (draw with the triggering
  revert pin as seed; scenarios may inject the draw result). v0.1 does not name the
  freeze-time set explicitly.
- **baselineRev computation**: the last normal head strictly BEFORE the triggering
  revert (v0.1.1 §2.1 wording).
- **Rate limiting**: counts applied revs only; day window anchored at genesis height
  with `blocksPerDay` (default 144 ≈ 10-min blocks).
- **Votes**: first vote per editor counts; approval-only per v0.1.1 X6; snapshot
  membership at proposal time per X5; late/duplicate votes are graveyards for audit.
- **Reputation deltas** (`confirm-goodfaith` +1 etc.) are engine constants pending
  the on-chain pinning of reputation-algo-v1 magnitudes; vectors exercise direction
  only.
- **Reviews** are recorded without a membership gate because the registration PoC is
  itself a review pinned by the not-yet-registered applicant (v0.1 §7.2); membership
  enforcement belongs at consumption (featured scoring, not implemented in MVP).
- **T1 ladder — RESOLVED by E-2** (semantic erratum
  pin://892ce8b2889cf20d2901dc955182b0674c5c7c85eccc055230bef205f377cca3i0, ruling
  pin://66518de4898e00912744afd2b562c99eab3225983139afd24828362e0d53031ci0): the
  literal v0.1.2 D2 reading is a circular dependency (T0 forbids revs, so
  validRevs could never grow into the T1 gate). Ruled reading, implemented here:
  - basic edit right R = registered active ∧ outside the T0 window ∧ general
    legality gates (v0.1 §3.2.7) — the time threshold is the anti-sybil backbone
    and stays on the basic right; rev counts never gate it;
  - T1 = registration age ≥ t0DurationHours ∧ validRevs ≥ t1MinValidRevs — an
    identity marker only (no exclusive MVP privilege);
  - tier output is therefore four-valued: `T0` (inside the cold-start window, no
    revs — graveyard reason `t0-no-rev`), `T0+` (window served, basic right active,
    marker not yet met), `T1`, `T2`;
  - validRevs counts all applied revs of record (equivalent revs and redirects
    included; graveyarded/orphan pins never counted), per E-2.
- **Cluster merging (v0.1.2 D4)**: rate and edit-war counters key on the cluster
  root (`clusterAliases` option, alias -> root MetaID); war-side same-editor
  exemption checks (F-1) also resolve through the root. Identity-bearing roles
  (arbiter candidacy, endorsement) stay per-MetaID.

## G2 contract (dual implementation)

MetaSo must consume the SAME `replay-vectors.v1.json` and, for the same event
stream, produce the same view (head/status/displayMode + reputation values). Any
divergence is a bug or a params desync (spec v0.1 §13.5).
