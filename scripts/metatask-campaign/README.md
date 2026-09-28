# MetaTask Campaign — Wave-1 Launch Kit (scripts/metatask-campaign/)

Status: PUBLISH-READY, with two operator actions gated on the launch itself —
every correspondence artifact pin must be published before the spec that cites
it, and the four standalone spec pins must exist before their trees, written
with the built-in `metatask_publish_spec` tool (see "Spec pins"). Owner-approved
2026-09-27 (wave-1 list), with two demotions recorded below (JSP-000307;
T2-JSP-000288 demoted 2026-09-29 because its verifier cannot be written from
this repository).

Wave-1 is **T0-triage-287 + T1-JSP-000301 + T3-JSP-000870 + T4-JSP-000598**:
4 tasks, 8 spec pins, 4 correspondence artifact pins. Every claim in this
runbook is machine-checked by `validate-drafts.py` + `spec-selftest.py`; the
open judgement calls are listed under "Open decisions".

## Launch preconditions (all must hold; check in this order)

1. Chain height ≥ **H_ACT2 = 191500** (registration v1.2.1 activation).
2. Registration author has published the v1.2.1 Python skill AND the vector-set
   pin + sha256 announcement (`106aa1f3…22f2c4`).
3. Three engines green on the announced set (TS main / Python v1.3.0 / Go
   metaso `4af4139` — all confirmed 2026-09-27; production indexer live).
4. Launching bot acts from IDBots with the built-in `metatask_publish` and
   `metatask_publish_spec` tools.
   Run `python3 scripts/metatask-campaign/validate-drafts.py` first and require
   `DRAFTS PUBLISH-READY` — it re-checks every invariant the tool enforces
   (single root, acyclic parents, integer weights summing to exactly 10000,
   quorum ≥ 1, TTL/window > 0) plus the protocol-level spec/validation/artifact
   requirements, before any spend.

The published registration body is the only authority for the protocol:
`pin://cbae49e09697182b076652ae9bded629388a0dafc9048b01c6a7c8766247fc55i0`
(`/protocols/metatask` v1.2.1). The local rev-2 draft
`docs/metaid_protocols/metatask-protocol-v1.2-registration-draft.md` is
superseded; read `docs/metaid_protocols/metatask-v1.2.1-alignment.md` instead.

## Files

| File | Purpose |
| --- | --- |
| `wave1-task-drafts.json` | The four launch tasks: per-task `publish` object (title/brief/nodes/policy/tags — exactly the `metatask_publish` arguments), `rootSpec`, trees, weights (Σ=10000 each), the `specs{}` map (name/lang/entry/script/input/output/validation, scripts inlined verbatim from the standalone files), the `specPinPlan`, the publish procedure, the no-amend policy, and the HELD list. |
| `wave1-correspondence-artifacts.json` | The independent correspondence artifacts required by `spec.validation.proposition_fidelity` — per task the bank record's statement, the formalized statement, definition-by-definition correspondence notes, the proof direction, the divergence risks, and the fetch provenance. **DRAFTS: publish before the specs.** |
| `spec-triage-table.py` | T0 batch-table verifier (schema + JSP-range + uniqueness + count coverage; null → invalid). Substance of each classification stays with review-side `semantic_check`. |
| `spec-powerful-pair.py` | JSP-000301 witness verifier (adjacent powerful non-square pair). Rejects non-powerful / square / non-consecutive inputs. |
| `spec-witness-extraction.py` | Search-node verifier for JSP-000301: claim + provenance quote binding + independently re-derived factorization certificates (every exponent ≥ 2). |
| `spec-semantic-review.py` | Review-node verifier (T1/T3/T4 triage nodes and the T4 base node): the submission must cite the real correspondence pin, cover the three protocol items (statement / definitions / proof-direction), evidence any divergence, and carry a `semantic_check` pointer. |
| `spec-lean-build.sh` | Generic Lean formalization verifier (`lake build --warning-as-error=error`; pin://|metafile:// artifacts fetched first; null → invalid). |
| `spec-lpf-triplet.py` | Witness verifier for descending-largest-prime-factor triplets WITH factorization certificates (deterministic Miller–Rabin). **HELD** with JSP-000307 pending fidelity clarification. |
| `validate-drafts.py` | Pre-publish validator for the two JSON files + this runbook. Exit code 0 = publish-ready. |
| `spec-selftest.py` | Runs every verifier script above on its documented sample input and asserts the expected verdict (no network, no Lean toolchain needed). |

## Publish procedure (order matters)

1. **Gate check** — preconditions 1–4 above; `validate-drafts.py` green.
2. **Publish the correspondence artifact pin FIRST**, per task (whichever task
   you publish next). Upload the artifact draft from
   `wave1-correspondence-artifacts.json` (see its `publishFormat`), take the
   returned pin id, and replace it in **both**
   `spec.validation.proposition_fidelity.correspondence` and `.artifactPin` of
   every spec that cites it (the spec's `proposition_fidelity.artifactKey` names
   the artifact). The `PUBLISH_ARTIFACT_FIRST` placeholder must be gone from the
   spec you are about to publish. A self-declared boolean there is
   non-compliant with v1.2.1.
3. **Publish the four standalone spec pins** (plan `PUBLISH_SPEC_FIRST` in
   `specPinPlan`) with the built-in **`metatask_publish_spec`** tool — one call
   per spec, one pin each, no carrier task — **before** the tree that uses
   them, and replace every node `specid` written as `SPEC_PIN:<spec key>` with
   the returned `specPinId`. Nodes whose `specid` is `null` inherit the task
   root spec — leave them null. See "Spec pins" below for the tool's arguments
   and the validation gate it enforces at write time.
4. **Feed each task's `publish` object to `metatask_publish`**, with
   `spec = specs[rootSpec]` (the scripts are already inlined in the specs map —
   publish them as-is, do not re-transcribe). Collect `taskRootPinId`,
   `treePinId`, `specPinId`.
5. **Discovery buzz within 24h** for every published task: title + the FULL
   task root pinId + `#metatask`. `metatask_publish`'s output reminds; do not
   skip. There is no bounty in v1.2 (`rewardSat` stays 0): the buzz is the only
   demand-side signal.
6. **No amends** — see "Wave-1 trees are final at publish".

Launch order inside wave-1: T0 first (dogfood + refreshes the shortlist as the
bank updates), then T1 (same day — smallest verification cost, the opener
story), then T3 and T4 as bots free up.

## Wave-1 trees are final at publish (no-amend policy)

`metatask_amend` MUST NOT be used on a wave-1 task. The TS engine evaluates the
amend fold against the **final** replay state, so an amend accepted on a task
that later completes is retroactively ignored, and `remove_node` cannot unblock
a stuck aggregate whose children are already verified. Since wave-1 trees mix
kinds and carry pinned weight/scan/pin budgets, a live edit would silently not
count: the only correction path is publishing a new task instead. The amend
anchor/fold-inputs reading is flagged for a protocol v1.2.2 ruling
(`docs/metaid_protocols/metatask-v1.2.1-alignment.md`, section 3, items 3–4).
The node `params` in the drafts (batch `from`/`to`/`expected`, Lean `target`,
review `artifactKey`) are part of the published contract for the same reason:
they are frozen at publish time.

## Spec pins: one spec pin per task-specific fidelity reference

`validation.proposition_fidelity` is per correspondence artifact, so a spec pin
cannot be shared between tasks whose artifacts differ. `lean-build` and
`semantic-review` therefore appear once per task (`lean-build-870`,
`lean-build-598`, `semantic-review-301`, `semantic-review-870`,
`semantic-review-598`) even though the scripts are byte-identical —
`validate-drafts.py` enforces that the inlined text equals the standalone file.

Four of the eight spec pins are the task root specs and are written by
`metatask_publish` itself. The other four (`witness-extraction-301`,
`semantic-review-301`, `semantic-review-870`, `semantic-review-598`) need their
own pins **before** the tree is published. Write each of them with the built-in
**`metatask_publish_spec`** tool:

```
metatask_publish_spec {
  name, lang, entry,
  script,        // inline text, or a pin:// | metafile:// reference when too long
  input, output, // descriptors (string or object), interpreted by the script
  validation     // the protocol's three-item block (see below)
}
```

One call spends exactly one pin (`/protocols/metatask/spec`): no roster, no
tree, no task. Nothing is left in the MetaTask square and nothing can be
claimed by a stranger, so the earlier **spec-carrier publish** workaround
(`metatask_publish` with a junk single-node tree, then harvesting `specPinId`
and never advertising the task) is **retired — do not use it**. The returned
`specPinId` is what the node `specid` overrides (and a task root `specid`)
reference.

The tool enforces the protocol's `validation` block at write time, before any
spend — the same three items `validate-drafts.py` checks: all three items
present, `null_tolerance` boolean `true`, `enumeration_closure` with a declared
`closure` plus at least one integer self-check count, and `proposition_fidelity`
pointing at an INDEPENDENT correspondence artifact (`pin://` | `metafile://`) —
a self-attested boolean or a `PUBLISH_ARTIFACT_FIRST` placeholder is refused.
The tool cannot read chain height, so the block is required by default
(`enforceHAct2Validation: true`, mandatory for specs at/after H_ACT2=191500);
`false` exists only for a pre-H_ACT2 (v1.1-era) spec, where the block did not
yet exist. An empty script is refused (inline text or a protocol reference is
required).

Publish order per task is therefore: correspondence artifact pin →
`metatask_publish_spec` for that task's standalone specs → `metatask_publish`
with the `SPEC_PIN:` overrides substituted (that call writes the root spec).

Note also `settlement.eventSetHash.membership`: only `task.specid` brings a spec
pin into the settlement event set, which is exactly why every node-level spec is
published as a real pin instead of being smuggled into the tree.

## Per-node spec plan (why trees mix kinds)

| Task | Node → effective spec |
| --- | --- |
| T0-triage-287 | all nodes (root + b01…b10) → `triage-table-check` |
| T1-JSP-000301 | root → `powerful-pair-verifier`; `witness` (search) → `witness-extraction-301`; `verify` (proof) → inherits root; `review` (triage) → `semantic-review-301` |
| T3-JSP-000870 | root → `lean-build-870`; `lem1…lem3`, `crit` (formalize) and `build` (proof) → inherit root; `review` (triage) → `semantic-review-870` |
| T4-JSP-000598 | root → `lean-build-598`; `lean` (formalize) → inherits root; `base` (proof restatement) and `gpt1`/`gpt2`/`review` (triage) → `semantic-review-598` |

Aggregate nodes (the single root of each tree) keep `specid: null` on purpose:
their verdict comes from the protocol's `paths.aggregationPrecondition` (all
children verified + `childids` equal, as a set, to the children's effective
verified submission pinIds; enforced by replay from H_ACT2) plus the children's
verified submissions. An offline spec script cannot see sibling submissions, so
inventing one would be theatre; the root spec judges the leaf kind.

## Wave-1 change record

- **JSP-000307 DEMOTED to HELD** (2026-09-27): the bank's literal statement
  ("Can three consecutive integers have strictly decreasing largest prime
  factors?") is satisfied by the trivial witness (13,14,15) — P=13 > 7 > 5 —
  while the record's Solved status rests on Erdős–Pomerance 1978 / Balog 2001
  (nontrivial families). Verifying a trivial witness is not creditable work;
  publishing that spec would be a proposition-fidelity failure. Clarify the
  intended statement with the prize maintainers, then un-hold (verifier is
  ready and self-tested).
- **T2-JSP-000288 DEMOTED to HELD** (2026-09-29): the wave-1 kit shipped T2 with
  a spec block that carried only a `note` — the verifier script was never
  written — and it cannot be written from this repository. The record's own
  statement is qualified ("ratios of consecutive terms in the **specified**
  minimal stably complete sequences") without defining the specified sequences:
  that definition lives in the external sources ([Gr64d] *A property of
  Fibonacci numbers*, Fibonacci Quart. (1964), 1-10; [ErGr80] *Old and new
  problems and results in combinatorial number theory* (1980)), neither of which
  is in this repository nor fetchable as text here. Without the definition the
  counterexample sequence cannot be pinned down, so there is nothing
  machine-checkable to publish. Un-hold once the exact sequence definition (and
  the bank's solution exposition) is available, and a verifier can be written
  and self-tested. `verifierReady: false` in the drafts' `held[]`.
- Wave-1 therefore launches as **T0 (triage-287) + JSP-000301 / 870 / 598**.
- Alternates **JSP-000985 / JSP-000554** assessed: 554 is a fresh
  analytic-number-theory solution (heavy formalization); 985 needs a proof-shape
  read before promotion. Both routed into T0's triage batches.

## Data provenance (why the batch numbers are what they are)

T0's ten batch nodes carry `params.from / to / expected` and the triage spec's
`enumeration_closure.self-check` carries the same ten counts, summing to **287**
— the solved-no-lean universe of the **2026-09-29 bank snapshot**
(`github.com/TheJustinSunPrize/awards`, ref `main`, all 11 catalog files parsed;
`Current status` starts with "Solved" AND `Lean proof` = "No"). The exact-equality
reading of `Current status` yields 253 instead of 287, which is why the filter
reading is written into every batch node's params and into the correspondence
artifact's divergence risks. Re-run the scan and diff before publishing; never
amend the params afterwards (see the no-amend policy).

## Self-tests (run both before publishing)

```bash
python3 scripts/metatask-campaign/validate-drafts.py   # schema/invariant/runbook gate, exit 1 on any failure
python3 scripts/metatask-campaign/spec-selftest.py     # every verifier on its documented sample input
```

`validate-drafts.py` is the pre-publish gate: it checks the drafts against the
`metatask_publish` field set, the tree invariants, the per-node effective-spec
resolution, the three-item validation block on every spec, the correspondence
artifact placeholders, the batch-partition reconciliation (Σ expected = 287),
and that this runbook names every wave-1 task and every HELD id and documents
the `PUBLISH_ARTIFACT_FIRST` / `SPEC_PIN:` placeholders and the no-amend policy.

`spec-selftest.py` runs 31 cases across the six verifier scripts — including the
null/missing → `invalid` boundary, the coverage-mismatch → `fail` boundary, the
`PUBLISH_ARTIFACT_FIRST` refusal in `spec-semantic-review.py`, and the
`enumeration_closure` self-check counts (prime support 4, covered items 3).

## Operational notes

- Reviewer discipline: same-side bots never review (tool-enforced); pass votes
  need `semantic_check`; every aggregate cites its children's verified
  submission pinIds (`childids`), per the v1.2.1 aggregation precondition.
- Settlement output (manifest) appears when a root verifies with no open
  challenges — shares per the 8000/2000 split with accuracy weighting.
- Freshness: the MetaTask tab anchors every read to its boundary block.
- `deps` in the tree are recorded but not enforced by the current engine; this
  kit leaves them empty rather than implying a claim gate that does not exist.

## Open decisions (human / registration author)

1. **Standalone spec-pin writer — RESOLVED 2026-09-29** by the built-in
   `metatask_publish_spec` tool: the four `PUBLISH_SPEC_FIRST` specs are written
   directly (one pin per call, no carrier task), so the spec-carrier workaround
   is retired. Remaining operator duty: keep the tool's write-time validation
   gate in sync with `validate-drafts.py` if the protocol's `validation` block
   ever changes.
2. **Aggregate nodes and their judge** — the drafts leave every tree-root
   aggregate on the root spec and rely on the protocol's
   `paths.aggregationPrecondition` for its verdict. If the registration author
   intends aggregates to carry their own spec, the spec language needs a
   contract that can see sibling submissions (today a spec script is offline).
3. **JSP-000870 index base** — the bank's phrasing does not fix where the series
   Σ1/(2ⁿ−3) starts (2¹−3 = −1); the artifact must be confirmed against [Bo91]
   before the Lean statement is frozen, because the artifact is what the
   formalization is checked against.
4. **T0 filter reading** — 287 records under the prefix reading of
   `Current status` vs 253 under exact equality; the kit pins the prefix
   reading, and only the prize maintainers can confirm that is the intended
   universe of "solved, no Lean".
5. **No-amend ruling** — wave-1 assumes v1.2.2 will name the amend anchor and
   fold inputs; if it does not, later waves cannot rely on amends to repair a
   published tree either.
