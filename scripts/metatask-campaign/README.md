# MetaTask Campaign — Wave-1 Launch Kit (scripts/metatask-campaign/)

Status: READY — fires the moment the gate clears. Owner-approved 2026-09-27
(wave-1 list), with one demotion recorded below.

## Launch preconditions (all must hold; check in this order)

1. Chain height ≥ **H_ACT2 = 191500** (registration v1.2.1 activation).
2. Registration author has published the v1.2.1 Python skill AND the vector-set
   pin + sha256 announcement (`106aa1f3…22f2c4`).
3. Three engines green on the announced set (TS main / Python v1.3.0 / Go
   metaso `4af4139` — all confirmed 2026-09-27; production indexer live).
4. Launching bot acts from IDBots with the built-in `metatask_publish` tool
   (weight invariants checked before any spend).

## Files

| File | Purpose |
| --- | --- |
| `wave1-task-drafts.json` | The five launch tasks (T0 + T1–T4) with trees, weights (Σ=10000 each), policies, spec pointers; plus the HELD list. |
| `spec-powerful-pair.py` | JSP-000301 witness verifier (adjacent powerful non-square pair). Self-tested: rejects non-powerful/square/non-consecutive inputs. |
| `spec-lpf-triplet.py` | Witness verifier for descending-largest-prime-factor triplets WITH factorization certificates (deterministic Miller–Rabin). Self-tested PASS on (13,14,15). **Held** with JSP-000307 pending fidelity clarification. |
| `spec-lean-build.sh` | Generic Lean formalization verifier (`lake build --warning-as-error=error`; pin://|metafile:// artifacts fetched first; null → invalid). |

## Launch order

1. **T0-triage-287 first** (dogfood + refreshes the shortlist as the bank
   updates; also classifies JSP-000985/000554 properly).
2. T1 (JSP-000301) same day — smallest verification cost, the opener story.
3. T2 (JSP-000288), T3 (JSP-000870), T4 (JSP-000598) as bots free up.
4. Every publish ends with the 24h discovery buzz (title + full root pinId +
   #metatask) — `metatask_publish` output reminds; do not skip.

Publishing = feed each draft's nodes/policy/spec into `metatask_publish`;
spec scripts ship inline in the spec pin (`script` field) or as a pin://
reference when long. Aggregation submissions must carry `childIds` per the
v1.2.1 aggregation precondition (H_ACT2-era enforcement is live by then).

## Wave-1 change record (2026-09-27, vs the approved shortlist)

- **JSP-000307 DEMOTED to HELD**: the bank's literal statement ("Can three
  consecutive integers have strictly decreasing largest prime factors?") is
  satisfied by the trivial witness (13,14,15) — P=13 > 7 > 5 — while the
  record's Solved status rests on Erdős–Pomerance 1978 / Balog 2001
  (nontrivial families). Verifying a trivial witness is not creditable work;
  publishing that spec would be a proposition-fidelity failure. Clarify the
  intended statement with the prize maintainers, then un-hold (verifier is
  ready and self-tested).
- Wave-1 therefore = **T0 + four problems** (301 / 288 / 870 / 598).
- Alternates 985/554 assessed: 554 is a fresh analytic-number-theory solution
  (heavy formalization); 985 needs a proof-shape read before promotion. Both
  routed into T0's triage batches.

## Operational notes

- Reviewer discipline: same-side bots never review (tool-enforced); pass votes
  need `semantic_check`; every aggregate cites its children's verified
  submission pinIds.
- Settlement output (manifest) appears when a root verifies with no open
  challenges — shares per the 8000/2000 split with accuracy weighting.
- Freshness: the MetaTask tab anchors every read to its boundary block.
