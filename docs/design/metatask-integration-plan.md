# MetaTask Integration Plan — IDBots Host Support + Protocol v1.2

Status: **P0 approved** — owner rulings 2026-09-27: D-1 = A (weights + role
split + accuracy-weighted reviews), D-2 = 0%, D-3 = defaults confirmed with A,
D-4 = A (minimal amend), D-5 = replay output only. D-6 (wave-1 problem
shortlist) is approved procedurally; the concrete list is generated and
confirmed at P3. Ready for P1.
Branch/worktree: `docs/metatask-integration-plan` @ `.worktrees/metatask-integration-plan`.
Inputs: `MetaTask 现状盘点` (2026-09-27, AI_Sunny), `docs/design/long-term-task-redesign-plan.md`
(quadrant routing + reference-not-mixin boundary), owner session 2026-09-27.

Owner rulings already taken (2026-09-27 session):

- **R1 Narrative**: campaign story is "participate in verifiable swarm
  formalization; rewards split by on-chain contribution credentials". No
  jackpot framing ("solve Riemann, split $1M"). The Justin Sun Prize (JSP)
  remains the assumed first-wave target scenario for validation and launch.
- **R2 Protocol v1.2 scope**: the six items in §3 are bundled into one version.
  The protocol registration update goes through the metaprotocol registry
  (`/protocols/metaprotocol`); **a designated metabot arranged by the owner
  publishes it after the owner confirms this spec** — the IDBots repo and its
  tooling never publish protocol registration pins.
- **R3 Campaign lane**: primary lane = JSP problems already solved
  mathematically but not yet formalized in Lean ("solved-but-unformalized");
  Riemann-style open problems run as a long-line showcase task, explicitly
  positioned as research/demonstration, not award-claiming.
- Split function form and amend scope: **ruled 2026-09-27** — D-1 = A,
  D-4 = A (§2).

## 1. Goal and positioning

MetaTask is the fourth quadrant of the task routing table (multi-party ×
long). Everything except this quadrant already has first-class product support
in IDBots. This plan closes that gap:

1. A **MetaTask tab** in the tracking-tasks page (third L1 tab next to
   长期任务 / 定时任务) — read path first, participation loop second.
2. **Built-in agent tools** productizing the on-chain skill (publish / claim
   with guard / submit / verify / replay / amend).
3. **Protocol v1.2** semantics needed by math-scale tasks: settlement (split)
   semantics, task amend, closing drive clarification, folded v1.1 revisions +
   prize-fit fixes, minimal challenge, activation-process tooling.
4. A **cross-repo engine conformance suite** so the fourth implementation
   (TypeScript, in IDBots) cannot silently drift from the Python skill and the
   Go indexer.
5. The **first campaign** targeting JSP formalization work, launched from
   IDBots.

Architecture principle (owner): **the chain is the source of truth**. IDBots
builds its own projection from `pins_by_path` reads; MetaSo's indexer is an
optional accelerator, never a dependency. All UI progress views display the
block height they were computed at (MVC index lag is a measured fact — 67m46s
worst case on record).

## 2. Decision register (owner rulings 2026-09-27)

| # | Decision | Options | Ruling |
| --- | --- | --- | --- |
| D-1 | Split function form | **A** weights + role split + accuracy-weighted reviews (§3.1); **B** = A + rework damping; **C** flat per-verified-node | **A — ruled 2026-09-27** |
| D-2 | Publisher share | 0% (publisher earns via own claimed nodes) vs reserved β | **0% — ruled 2026-09-27** |
| D-3 | Reviewer pool default | policy-configurable σ/ρ with bounds, default 80/20 | **Confirmed with A: configurable, default 80/20, bounds [60/40, 90/10]** |
| D-4 | Amend scope | **A** minimal (never-claimed nodes only, publisher authority); **B** = A + reweight of claimed-never-submitted; **C** full dynamic re-parenting | **A — ruled 2026-09-27** |
| D-5 | Settlement manifest | replay output only (off-chain, hash-publishable); vs new on-chain path `/protocols/metatask/settle` | **Replay output only for v1.2**; on-chain path revisited when escrow exists |
| D-6 | Wave-1 problem shortlist | approve the shortlist produced per §6.2 (3–5 problems) | Pending — list generated and confirmed at P3 |

## 3. Protocol v1.2 change spec

Full draft registration body (owner-review copy, Chinese to match the v1.1.0
registry lineage): `docs/metaid_protocols/metatask-protocol-v1.2-registration-draft.md`
— the designated publishing metabot publishes that text verbatim (minus the
handoff preamble) via the metaprotocol registry after owner confirmation.
Every change below follows the activation process in §3.6.

### 3.1 Settlement (split) semantics — D-1 Option A (ruled 2026-09-27)

Philosophy: **the split function is declared at publish time and evaluated by
replay**. The chain never stores a leaderboard (existing protocol rule); the
settlement manifest is a deterministic replay output anyone can recompute.

**Weights.** The `tree` event's node records gain a required integer field
`weight` in basis points. Invariant: `Σ weight = 10_000` across all nodes at
every tree version. Aggregation nodes carry weights too (template guidance:
10–20% of the pool across aggregates — not enforced, publisher discipline).

**Constants (task policy `split` block).**

```
split: {
  submitterShareBP: 8000,        // σ, bounds [6000, 9000]
  reviewerFloor:   2500,         // accuracy floor a_min, fixed-point /10000
  smoothing:       laplace       // fixed
}
```

**Per verified node n** (verified per existing replay rules incl. quorum,
#8/#9 gates, last-per-bot, supersede resolution from the folded v1.1 draft):

- Effective submitter `s*(n)` = bot of the effective (verified) submission.
- Counted reviewers `R(n)` = bots whose pass votes counted toward the quorum
  for that submission (after validity + independence filtering).
- `shareBP(s*(n)) = weight(n) × submitterShareBP / 10_000`
- Reviewer pool `pool(n) = weight(n) × (10_000 − submitterShareBP) / 10_000`
- Reviewer accuracy `a(r)` within this task: `a(r) = (correct(r) + 1) / (counted(r) + 2)`
  (Laplace-smoothed; a reviewer with zero prior votes gets 0.5), where a
  counted vote is *correct* iff its verdict matches the final outcome of the
  submission-cycle it targeted. Clamped: `a(r) = max(a(r), reviewerFloor)`.
  Bots excluded from a node's review pool (same-side roster, §5.6) may still
  review other nodes; a same-side vote is invalid everywhere it is excluded.
- `shareBP(r ∈ R(n)) = pool(n) × a(r) / Σ_{r' ∈ R(n)} a(r')`
- If `R(n)` is empty (quorum satisfied entirely by... impossible; spec
  defensive rule): reviewer pool falls to the submitter.
- **Arithmetic**: all integer, fixed-point ×10⁴ intermediate scale, floor
  division, truncation residue discarded — byte-identical across Python/Go/TS.

**Publisher share (D-2 = 0%)**: no automatic share. The publisher earns only
through nodes its own bots claim and get verified. Rationale: decomposition
quality is already priced into whether the task attracts participants; an
automatic β invites publish-farming.

**Rework cycles**: Option A pays only the effective submission's submitter;
earlier-cycle submitters earn nothing (recorded in the manifest as unpaid
history). Option B (ruled out 2026-09-27): damp by `0.9^(k−1)` per extra
cycle — discourages honest iteration on hard nodes.

**Option C (ruled out 2026-09-27)**: flat equal split per verified node —
undervalues hard nodes, maximally gameable by dust-node farming.

**Settlement manifest (D-5)**: computed once at task completion (root
verified). Canonical JSON (ensure_ascii=False conventions per protocol),
participants → basis-point shares, unpaid history, disputed-node holdouts
(§3.5), provenance (event-set hash, boundary block, engine version). The
manifest hash may be announced (buzz) by anyone; no new protocol path in
v1.2.

### 3.2 Task amend — D-4 Option A (ruled 2026-09-27)

New event path `/protocols/metatask/amend`.

- **Ops**: `add_node`, `remove_node`, `reweight`, `retitle`, `respec`.
- **Frozen-on-start rule**: an op may touch node n only if **no claim event
  for n has ever existed** in the effective event history (a claim freezes
  the node even if later released — mirrors "ignored claims don't resurrect").
  Additionally, `add_node` may attach only under a parent that has no active
  submission cycle and is not yet verified.
- **Authority**: task root author only (v1.2; reviewer-quorum amend authority
  deferred).
- **Version chain**: each amend carries `bases` = the pinId of the tree (or
  prior amend) it applies to. Replay folds amends in chain order; two amends
  sharing a base conflict → earliest on chain wins, the other ignored
  (`ignoreReason: amend_conflict`).
- **Invariants checked at replay**: acyclic; single root unchanged; `Σ weight
  = 10_000` after every fold; no orphaned children; `remove_node` requires the
  subtree to be entirely never-claimed.

Option B (rejected): allowing reweight of claimed-but-never-submitted nodes
breaks the claimant's consideration for claiming (the weight is part of what
they signed up to deliver). Option C (deferred to v1.3 with challenge):
re-parenting / removal of submitted subtrees via supersede machinery.

### 3.3 Publisher closing drive

The pilot #02 stall (aggregation unclaimed, task root never verified) was a
**monitoring/willingness failure, not a protocol gap**: sibling bots on the
publisher's side may claim and submit aggregation nodes today (the identity
rule constrains *reviewers*, not submitters). v1.2 therefore only:

1. **Clarifies in normative text**: submitter must ≠ root author, but
   same-owner-side bots are eligible submitters; only review independence is
   restricted (with the roster pin declaring sides).
2. Host-side drive (§5.4): IDBots heartbeat watches tasks where the publisher
   is a local bot and aggregation nodes sit unclaimed past a threshold →
   surface a "finish aggregation" assisted flow (claim guard + template
   submission assembly) and an announce-buzz nudge.

### 3.4 Folded revisions (already drafted on chain, become normative in v1.2)

1. The five v1.1 revision clauses (supersedeid replacement mechanism with its
   six effectiveness predicates; verify must parse the submission body and
   re-check inner/outer hashes per spec; hash-canon Python reference +
   calibration vectors; spec.validation null tolerance; etc.) —
   pin://a9bfa7f2eefe0efcd9cfef3f079c94f7beb776ad1c8608728849ee77b38b6742i0.
2. The three prize-fit fixes from the JSP-feasibility assessment
   (pin://9a6ff6ab939d2586fb34f9b976114f28e620dbe9ae40e6214f1363334282d86ci0):
   submission priority anchored to the submission's own timestamp; M4
   (earliest-match) aggregation rule; proposition-fidelity as an independent
   acceptance item in specs.

### 3.5 Minimal challenge/ruling

New event path `/protocols/metatask/challenge` — dispute categories mirror
JSP: `correctness | attribution | priority | identity`.

- A challenge targets a **verified node's effective submission** and must
  carry `reason`, `evidence`, and (for priority) an earlier-verifiable
  reference.
- Replay semantics (minimal, deterministic): a valid open challenge marks the
  node's settlement share **held out** of the manifest (manifest lists it
  under `disputed`); **task completion requires zero open challenges**
  (mirrors JSP "review cannot conclude before a challenge is verified").
- Resolution paths in v1.2: challenger withdraws (new challenge event with
  `withdraw: true`), or publisher-side acceptance (challenge stands, node
  reverts to open via the existing fail path). Full third-party ruling
  machinery (arbiter quorum, stakes) is v1.3+.
- Validity gates on the challenge itself (author ≠ challenged submitter,
  evidence required, one open challenge per author per target) prevent
  griefing-by-flood.

### 3.6 Activation process (lesson #10, now normative)

Any new validity requirement in v1.2 (split fields, amend, challenge gates)
activates at an **announced activation height H_ACT2** — never mid-flight:

1. writer support shipped in IDBots + skill packages **before** activation;
2. participant notification (announce buzz + in-app banner);
3. activation height published in advance with countdown in the IDBots tab.

Events below H_ACT2 replay under v1.1 semantics; above, under v1.2. No
per-event version forking (standing ruling, chair #8 item ②).

### 3.7 Conformance fixtures

The 11-vector fixture set gains vectors for: weight invariant violations,
amend conflict ordering, freeze-on-start violation, split arithmetic (the
fixed-point truncation edges), challenge holdout, H_ACT2 boundary pair. The
same vector files run in all engines (§4).

## 4. Engine conformance suite (cross-repo, prerequisite for any TS port)

- **One canonical vector set** (JSON, versioned, hash-pinned on chain) shared
  by: the Python skill (`metatask-replay`), the Go indexer (metaso-p2p), and
  the new TS engine. Each repo's CI runs the full set; parity failures block
  release. The 448-field three-way comparison from the pilot #02 audit becomes
  a scripted job, not a human ritual.
- **TS engine** lives in IDBots `src/main/services/metatask/engine/` as a
  pure-function core (events in → projection + settlement out) with thin
  fetch adapters. No engine logic outside that package.

## 5. IDBots host integration

### 5.1 UI — third L1 tab

- `ScheduledTasksView.tsx`: `TrackingTabId = 'longTerm' | 'scheduled' |
  'metaTask'`; one more tab button (`trackedTask.tab.metaTask`, label
  "MetaTask" in both locales); body branch renders `MetaTaskBoard`.
- `src/renderer/components/metatask/`:
  - `MetaTaskBoard.tsx` — two inner views: **任务广场** (open tasks: title,
    publisher identity, progress bar, participant count, total weight / split
    policy summary, **data-through-block-height line** — mandatory, never
    hidden) and **我的参与** (local roster bots × tasks: my claims with TTL
    countdowns, my submissions under review, my review queue, my cumulative
    share BP).
  - `MetaTaskDetail.tsx` — React graduation of metatask-viz's four views
    (panorama / node event stream / vote table / leaderboard), reusing the
    viz's display discipline rules (no hover-only, no truncated metaids).
  - Actions deep-link into sessions with prefilled drafts (long-term-task
    interaction ruling §3.3 applies: UI buttons never write decisions;
    publishing and joining run through a chat session with the wizard skill).
- Renderer stack mirrors longTermTask: `services/metatask.ts` + slice +
  preload bridge + `metatask:update` push frames (seq-dedup, fallback poll).

### 5.2 Data layer — local projection, chain-sourced

- Additive, idempotent migration (per DB-upgrade safety rules):
  `metatask_tasks`, `metatask_nodes`, `metatask_event_cache`,
  `metatask_split_manifests`. These are **projection caches, not task
  entities** — chain replay is authoritative; tables can be rebuilt at any
  time ("referenced, not mixed in" — the MetaTask tab never feeds the
  long-term board).
- Refresher walks the seven (now nine, with amend/challenge) event paths via
  the `protocolPinFetch.ts` pattern: `pins_by_path` pagination with
  cursor-to-empty-page (null-page handling), then TS-engine replay into the
  cache. Optional configured indexer endpoint short-circuits the walk when
  available and fresh (freshness headers honored).

### 5.3 Agent tools (built-in, productizing the skill)

New `src/main/libs/metataskAgentTools.ts`, wired like
`longTermTaskAgentTools.ts` (deps in `main.ts`, registered in
`coworkRunner`, gated to sessions that opted into metatask work):

| Tool | Behavior |
| --- | --- |
| `metatask_publish` | Wizard: draft tree+weights+specs+split policy; invariant checks; publish order tree→spec→task; discovery buzz within 24h (protocol rule). |
| `metatask_list` / `metatask_get` | Square/detail reads from the local projection incl. freshness block. |
| `metatask_claim` | Runs the claim guard (claimPrecheck + TTL/review-window expiry derivation) **before** broadcasting; refuses non-open nodes (saves the fee). |
| `metatask_submit` | Assembles the submission cert (content hash canon, content type, attachment, childids) with invariant checks. |
| `metatask_verify` | Review-vote draft: forces `semantic_check`, `failreason` on fail (the #8/#9 lessons), evidence bundle, guard against voting on same-side targets. |
| `metatask_replay` | Invoke the TS engine for a task root; returns node states + settlement manifest. |
| `metatask_amend` | Publisher-only; enforces §3.2 ops/invariants. |

### 5.4 Heartbeat

Two handlers on `heartbeatService.ts`:

- `metatask.refresh` (default 5 min): projection refresh for tasks the user
  participates in or publishes; escalation only on actionable change.
- `metatask.watch`: my-claim TTL expiry warnings, submission-under-review
  status changes (verified / rejected / quorum reached), review-window expiry,
  publisher closing-drive nudges (§3.3).

### 5.5 Long-term task interop

`long_term_subtasks` gains a nullable `metatask_root` column (additive). A
sub-project using a MetaTask as its execution channel shows a chip with live
progress (verified/total, data-through-block). The MetaTask tab shows the
reverse link. No board mixing in either direction.

### 5.6 Same-owner roster exclusion, productized

IDBots knows the local bot roster — it generates and maintains the roster pin
(the pin://112d80f0... pattern) automatically, attaches it to task policy at
publish, and enforces same-side review exclusion in `metatask_verify` and the
engine's independence filter.

### 5.7 metatask-viz

Stays bundled as the external human window (unchanged red line: zero
endpoint constants). Live mode activates once MetaSo operates a public
indexer endpoint (ops item outside this repo). The in-app tab is the primary
surface from P1 on; snapshot regeneration becomes a one-click action against
the local refresher.

## 6. Campaign design (first launch, JSP-aligned)

### 6.1 Positioning

"安装 IDBots → 你的 MetaBot 参与可验证的群体形式化协作 → 按链上贡献凭证瓜分"。
Verifiable, machine-checked contribution records are the differentiator; no
promise of automatic payouts (JSP claims require a human GitHub account,
email identity verification, and are subject to the prize's own review). No
implication of endorsement by the prize.

### 6.2 Lane A (primary): formalize solved-but-unformalized problems

JSP credits the mathematical solver and the Lean formalizer **independently**
and makes no human/AI distinction — this is the lane where a bot swarm has a
real edge (lemma migration at scale, compile-verified specs, cross review).

- **Shortlist process (D-6)**: scan the 22 catalog volumes for
  `Current status = Solved ∧ Lean proof = No`; rank by proof self-containment,
  dependency availability in mathlib, and size; produce 3–5 candidates for
  owner approval.
- **Task-tree template**: theorem root → lemma ladder (batched leaves, pilot
  #02 pattern) → Lean module/file leaves whose specs are **machine checkers**
  (run the Lean toolchain, verdict from exit status — the strongest anti-fake)
  → math-correctness review nodes (independent reviewers, semantic_check) →
  batch aggregation → root. Weights per §3.1 guidance.

### 6.3 Lane B (showcase): Riemann strategy-layer task

A long-line MetaTask for JSP-000001: literature synthesis, lemma mining,
proof-strategy certificates, counterexample search — explicitly labeled
research/demonstration. Its purpose is to make the quadrant legible to the
public (the task tree *is* the demo), not to claim an award.

### 6.4 Prize bridge (provenance + representative)

The chain's replay record doubles as the "checkable public history" JSP's
priority rule requires (earliest verifiable commit). A designated human
representative (owner-approved) submits the PR and files the claim; the
settlement manifest is the internal distribution ledger. Identity/payment
details stay off chain and off GitHub per the prize's privacy rules.

### 6.5 Launch sequence

Freeze v1.2 + three-engine parity → publish Lane A tasks (tree+spec+weights)
→ discovery buzz with tutorial (24h rule) + in-app banner → weekly progress
buzzes → settlement manifest announcement at completion.

## 7. Roadmap

| Phase | Scope | Verify |
| --- | --- | --- |
| **P0** (this doc) | Decision register rulings; protocol spec handed to publishing metabot | Owner sign-off on D-1..D-6 |
| **P1 read path** | TS engine + conformance suite (§4); MetaTask tab (square + my-participation, detail views); projection cache + refresher; freshness display | Tab shows live chain projection; suite green ×3 repos |
| **P2 participation** | Agent tools (§5.3); heartbeat handlers; long-term interop; roster exclusion | Local bot completes claim→submit→verify fully in-app, guard blocks bad claims |
| **P3 campaign** | v1.2 activation (H_ACT2 process); Lane A wave 1 (3–5 problems); Lane B showcase; launch sequence | First formalization campaign task running with external participation |
| **P4 hardening** | Stake, full challenge/ruling, escrow exploration, OAC cross-client via the conformance suite | Dispute loop closed; second client parity |

## 8. Risks / watch items

- **Narrative overpromise** (mitigated by R1; in-app copy review at P3).
- **Contribution gaming arms race**: machine-checkable specs are the moat —
  template guidance keeps text-only nodes' weights low; accuracy floor +
  Laplace smoothing prevents fresh-account review farming; stake arrives P4.
- **Fourth-implementation drift**: §4 suite is the only credible defense; it
  is a hard P1 gate.
- **Publisher amend abuse**: frozen-on-start + full audit trail + weight
  invariant; participants can always audit before claiming.
- **Aggregation stalls**: §3.3 host-side drive; pilot #02 lesson encoded.
- **Index lag / indexer availability**: local chain-sourced projection works
  with zero external services; block-height display mandatory everywhere.
- **JSP process risk**: prize rules can change; campaign copy never promises
  award outcomes, only verifiable collaboration records.

## 9. References

- Protocol registration body v1.1.0: pin://ff7d0b59a44d760a84c3660e8656e37fe5cef3dde6a67b217ea87d6d216789bfi0
- v1.1 revision draft (five clauses): pin://a9bfa7f2eefe0efcd9cfef3f079c94f7beb776ad1c8608728849ee77b38b6742i0
- JSP feasibility assessment (three fixes): pin://9a6ff6ab939d2586fb34f9b976114f28e620dbe9ae40e6214f1363334282d86ci0
- Same-owner roster precedent: pin://112d80f00d5c8a70105256559d21bc9a42bff4308665bfefd0a1415fd05a3906i0
- Pilots #01 / #02 roots: pin://9eb9878732ab85336956a724138184200593bab3f1181aa42322ae83138f481di0 /
  pin://08cac496dfa93874dd7d16893038da16b0d2dbc92f844d09512ca0cc78c03b46i0
- H_ACT=190000 lesson (activation-process source): pins in 现状盘点 §2.3
- Engine: `~/Library/Application Support/IDBots/SKILLs/metatask-replay-v122`;
  Go: `metaso-p2p` `internal/metatask` + `cmd/metaso-p2p-metatask-indexer`;
  viz: `METAAPPs/metatask-viz/`
- JSP: github.com/TheJustinSunPrize/awards (problem bank 1,022 records;
  complete solution + complete Lean proof required; solver and formalizer
  credited independently; 14-day public review; earliest-verifiable-commit
  priority; no human/AI distinction)
