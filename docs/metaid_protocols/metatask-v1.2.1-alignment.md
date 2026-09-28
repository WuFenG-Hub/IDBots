# MetaTask v1.2.1 Alignment — Published Registration vs rev 2 and the Engines

Status: authoritative alignment record for the IDBots side, 2026-09-27.
The published registration body is the sole authority; this repo's earlier
`metatask-protocol-v1.2-registration-draft.md` (rev 2) is superseded and kept
only as history. Nothing in this repo publishes registration pins.

## 1. Authoritative sources

- **v1.2.1 (current, effective)**: pin://cbae49e09697182b076652ae9bded629388a0dafc9048b01c6a7c8766247fc55i0
- v1.2.0 (superseded, diff only): pin://44ff49f5587bb48de2c539498f48c8d6235aead60f3e7da046eca28b43ff8232i0
- Activation announcements: v1.2.0 pin://3f68074d3498acf793a46027adb5f4c99f1ce8d4d33c39da3cb225ba5b23c2dei0 ·
  correction pin://1e12669be9dd561f6398c11e57e10c2fa2e45e8384291f0644c9997ec5b9d9i0 ·
  **H_ACT2=191500** pin://c9ded4938bfe1b7ca92c18b113a7cbae2c0bc7942993ad0e4f1512245bbe27d9i0
- Local chain-fetched copies (owner journal): `metatask-v1.2.1-chain-authoritative.json`,
  `metatask-v1.2.0-chain-authoritative.json`; clause reviews r1/r2.

## 2. The four differences rev 2 → published, and how this repo covers them

| # | Published clause (verbatim authority) | rev 2 said | IDBots coverage |
| --- | --- | --- | --- |
| 1 | `paths.aggregationPrecondition`: parent verified = all children verified + own submission passes; aggregate childids hashes must match the children's submissions; **enforced by replay from H_ACT2, pre-H_ACT2 grandfathered**; `disclosedDivergence` honestly records that the reference engine never implemented it (pilot #01 root verified while child 3 merely claimed) | Text existed but did not state forward enforcement or the divergence | **Implemented** in the TS engine: bottom-up final-verified pass anchored on the parent's effective-submission height vs H_ACT2; childids compared as the set of children's effective VERIFIED submission pinIds; vote-level verified still feeds the amend fold (documented approximation). Vectors r10–r13 |
| 2 | `settlement.eventSetHash.membership`: per-path membership table — task = root pin; tree/spec by task.treeid/task.specid; claim/release/submission/amend by taskid; verify/challenge via targetid → submission's taskid; broken reference chains excluded | Recipe without the per-path table | **Already matched** for verify/challenge (target-scoping) and taskid paths; **fixed** the one divergence: spec pins now enter ONLY via task.specid (node-level specid overrides are not members) |
| 3 | H_ACT2 = **191500** (v1.2.1 lowered from 192000; ≥52h notice at published chain cadence) | `<announced at publish>` | **Set**: `H_ACT2 = 191_500` in `constants.ts`; engine version bumped to `1.2.1` |
| 4 | `activation.noticeFloor` 48h first / 72h subsequent; and the factual correction that **H_ACT=190000 has been passed** (chain 191207 at publish) — #8/#9 are LIVE for new votes, zero retroactive (all 310 historical votes max height 189988) | rev 2 narrated H_ACT as "not yet reached" | Engine behavior was already height-correct (no change needed); **docs corrected** here and in the draft banner |

## 3. Implementation readings flagged for v1.2.2 (not silent changes)

The registration body is implemented as written; two places required an
interpretation we record explicitly rather than edit:

1. **Precondition gate anchoring** — the body gates the precondition "自 H_ACT2
   起…不追判存量件" without naming the anchoring event. We anchor on the
   PARENT's effective-submission height (consistent with supersede's
   both-ends gating). Alternative readings (vote-event anchor) would change
   borderline cases. Suggest v1.2.2 names the anchor explicitly.
2. **childids equality shape** — "各项 hash 与对应子 submission 一致" is
   implemented as SET equality between the aggregate's childids and the
   children's effective verified submission pinIds (order-insensitive). A
   positional reading is stricter. Suggest v1.2.2 states set-vs-order.
3. **Amend fold inputs** — the fold consumes the vote-level verified set
   (precondition not yet applied). A vote-verified-but-precondition-demoted
   parent therefore still refuses add_node children (conservative). Harmless
   but worth one sentence in v1.2.2.
4. **Task completion** — the body says "任务根完成 = 根节点 verified" (root
   only). Implemented root-based; with the precondition this equals
   all-verified for H_ACT2-era trees, and grandfathered trees keep the
   recorded divergence (pilot #01: root verified, all_verified=false — its
   settlement would be produced under legacy uniform weights, which is the
   literal reading).

## 4. The two unreadable reference pins (question ④-6)

- pin://1547beab3c4c0a81ff31f35547da67d7b1d6bd494944912fcf6565546b8f7b29i0
  ("引擎裁定②") and
  pin://112d80f00d5c8a70105256559d21bc9a42bff4308665bfefd0a1415fd05a3906i0
  ("同侧名单先例")
- **Independently re-checked from this side**: `GET
  https://manapi.metaid.io/content/<pinId>` returns **HTTP 404 for both** on
  MVC — consistent with the publisher's finding. Not readable via the MVC
  content endpoint.
- **Where our citations came from**: both pinIds entered the rev-2 draft from
  AI_Sunny-authored material — 1547beab… is cited in the metatask-replay
  v1.2.2 skill package (`SKILL.md`, "v1.2.1 修复" note: 出处 chair「#8 开放项
  裁定②」) and in the 现状盘点 §2.3; 112d80f0… is cited in 现状盘点 §7.3
  ("Sunny 侧 8 枚 bot 名册声明") and §11. They are the protocol author's own
  citations propagated verbatim; whether they were mis-transcribed, live on
  another chain, or were never pinned as claimed cannot be determined from
  MVC reads alone. Recommendation: the original author re-publishes both
  texts as fresh pins and a future revision's references point there —
  exactly what v1.2.1 did by dropping them.

## 5. Conformance vector set (deliverable ④-5 — files + hash only, no pins from this repo)

- File: `tests/fixtures/metatask/conformance-vectors.json` (16 vectors:
  Appendix-A hash pair, baseline replay states, TTL, release-no-resurrection,
  #9 gate + H_ACT boundary pair (exempt/gated), last-valid-vote, aggregation
  precondition ×4 [blocked / grandfathered / all-green-settles / childids
  mismatch], legacy residue settlement).
- Reproducible runner: `scripts/metatask-vectors.mjs` (`pnpm run
  metatask:vectors`) — PASS/FAIL per vector + the canonical hash.
- **canonical-JSON sha256 (canonJ of the parsed set):
  `106aa1f3bee8ebd48339ceb65f97a12e54247e1e831296a394a974c9cb22f2c4`**
- Status on the TS engine: **16/16 green**. The pinned copy + this hash are
  to be announced on chain by the registration publisher.

## 6. Three-engine v1.2.1 coverage (deliverable ④-1, per-path)

| paths item | IDBots TS | metaso Go | Python skill (v1.2.2 pkg) |
| --- | --- | --- | --- |
| tree.weight invariant | ✅ | ❌ | ❌ |
| policy.split settlement (σ/pool/accuracy/manifest) | ✅ | ⚠️ settle only, no split/weights | ❌ |
| supersedeid (six predicates + height gate) | ✅ | ⚠️ partial | ❌ |
| /amend (fold, version chain, frozen-on-start) | ✅ | ❌ | ❌ |
| /challenge (gates, holdout, TTL, closed loop) | ✅ | ❌ | ❌ |
| aggregationPrecondition + childids | ✅ (this change) | ❌ | ❌ |
| #8/#9 gates (H_ACT, live) | ✅ | ✅ (per audit) | ✅ |
| eventSetHash membership table | ✅ | ❌ (per audit) | ❌ |

Python/Go updates are **not deliverable from this repo** (project boundary:
IDBots edits stay inside this repository; the skill package and metaso-p2p
are owned elsewhere). The vector file + sha256 above are the shared artifact
for those teams.

## 7. If not three-green by 191500 (deliverable ④-3)

Per the registration's own activation discipline (writer-side first; no
instant activation; the H_ACT zero-compliance precedent), the honest options
in order of preference:

1. **Postpone the gate** (recommended): the publisher announces a new, later
   round H_ACT2 (≥72h after three-green). No partial activation, no second
   gate class in flight. v1.2.1's own downward revision of the height set the
   precedent that the height is the adjustable variable.
2. **Split activation** only if a campaign deadline is hard: a new
   registration would activate the campaign-critical subset (weight + split
   settlement + aggregation precondition) at H_ACT2a and defer amend /
   challenge / supersede / roster to a later height. Coherent but costs
   another registration cycle and a second vector-green gate — do not choose
   this casually.
3. Never: silently shipping a half-covered gate ("不要静默上线半成品") —
   agreed and explicitly rejected.
