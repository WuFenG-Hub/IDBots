# MetaID Protocols: Preference Rounds (round / commit / reveal / lesson)

> Status: **IDBots-authored draft v1.0.0** (branch `docs/preference-loop`), not yet registered.
> Companion design: `docs/superpowers/specs/2026-10-14-ai-internet-preference-loop-design.md`.
> Source of truth for MetaID protocol docs is `open-agent-connect/docs/metaid_protocols`; sync this file upstream once the pilot confirms the mechanics.

**Scope**: A generic, artifact-agnostic way for identities on MetaWeb to judge *N competing candidates* (MetaApps first; any pin later) by sealed pairwise preference ballots, compute a deterministic winner, and publish the distilled lessons as machine-readable knowledge that future builders retrieve. The protocol family is independent of MetaTask; a MetaTask links to a round through `subject`, and MetaTask's own semantics are unchanged (see §7).

**Version rule**: the MetaID 7-tuple `version` field (`1.0.0`) versions every payload below. Payloads do not repeat the version.

## 0. Design principles

- **Compare, don't score.** Ballots are pairwise picks with a one-line reason; there are no absolute scores.
- **Sealed until close.** Ballots are committed as hashes and revealed only after the commit window closes, so later judges cannot herd on earlier ones and AI judges cannot copy humans.
- **Deterministic and content-only.** Validity, winner, and the tally hash are pure functions of confirmed pins and their block timestamps. No self-declared timestamps are trusted.
- **Publisher-attested judge classes.** Whether a judge is `human` or `ai` is declared by the round publisher; the protocol records the claim, it cannot prove it.
- **Rounds are immutable.** Only `create` operations are recognized for all four paths; `modify` / `revoke` pins are ignored. A mistaken round is replaced by a new round.

## 1. Paths

| Path | Purpose |
|---|---|
| `/protocols/preference/round` | Declares candidates, judges, decision policy, windows |
| `/protocols/preference/commit` | A judge's sealed ballot hash |
| `/protocols/preference/reveal` | The ballot + salt opening a commit |
| `/protocols/preference/lesson` | Distilled principles citing revealed ballots |

All payloads are `application/json`.

## 2. Round — `/protocols/preference/round`

```json5
{
  /** Plain text, 1..200 chars. */
  "title": "Q&A community UI v2 — which build should humans see by default?",
  /** Markdown, 0..4000 chars: what is judged, for whom, how to use the candidates. */
  "brief": "Judge as a reader who browses questions daily…",
  /** 1..8 tags, each ^[a-z0-9-]+(:[a-z0-9-]+)?$ — lesson retrieval keys. */
  "category": ["ui:qa-community", "audience:human"],
  /** Optional link to a MetaTask node (see §7). */
  "subject": { "taskid": "<metatask root pinId>", "node": "UI" },
  /** 2..8 candidates. */
  "candidates": [
    {
      /** ^[a-z0-9]{1,8}$, unique within the round. */
      "id": "c1",
      /** The judged object's stable reference (e.g. MetaTask submission pinId). Unique. */
      "ref": "<pinId>",
      /** Loadable artifact: metaapp:// | pin:// | metafile:// URI. */
      "artifact": "metaapp://<pinId>",
      /** globalMetaId of the candidate's author (conflict-of-interest exclusion). */
      "author": "idq1…"
    }
  ],
  /** 1..32 judges with publisher-attested classes. */
  "judges": [
    { "id": "idq1…", "kind": "human" },
    { "id": "idq1…", "kind": "ai" }
  ],
  /** Which judge kinds decide the winner, and the minimum deciding ballots. */
  "decision": { "kinds": ["human"], "minBallots": 3 },
  /** Optional, 0..6 rating dimensions: id ^[a-z][a-z0-9_]{0,23}$, label 1..48 chars. */
  "dimensions": [
    { "id": "visual", "label": "Visual quality" },
    { "id": "usability", "label": "Ease of use" },
    { "id": "density", "label": "Information density" }
  ],
  /** Optional, 0..5 concrete tasks a judge performs in each candidate before judging (1..300 chars each). */
  "tasks": ["Find the highest-ranked answer to any question about wallet recovery."],
  /** Unix seconds. commitCloseAt ≥ round block time + 3600; revealCloseAt ≥ commitCloseAt + 3600. */
  "commitCloseAt": 1792000000,
  "revealCloseAt": 1792086400
}
```

**Validity** (a round failing any rule is ignored, and so are all pins referencing it):

1. Schema and bounds above; `candidates[].id`, `candidates[].ref`, `judges[].id` each unique.
2. `kind ∈ {"human","ai"}`; `decision.kinds` is a non-empty subset of `{"human","ai"}`; `decision.minBallots` is an integer in `1..32`.
3. The round pin is confirmed, and `commitCloseAt ≥ floor(roundTimestampMs/1000) + 3600`, `revealCloseAt ≥ commitCloseAt + 3600`. Recommended reveal window: ≥ 24 h.
4. `subject`, when present, has string `taskid` (pinId pattern `^[0-9a-f]{64}i[0-9]+$`) and string `node` (1..64 chars).
5. `candidates[].ref` matches the pinId pattern; `candidates[].artifact` matches `^(metaapp|pin|metafile)://\S+$`; `candidates[].author` and `judges[].id` match `^idq1[0-9a-z]{20,80}$`.

## 3. Commit — `/protocols/preference/commit`

```json
{ "round": "<round pinId>", "hash": "<64 lowercase hex>" }
```

`hash = sha256Hex(canonJ({ "round": <round pinId>, "judge": <author globalMetaId>, "salt": <salt>, "ballot": <ballot> }))`, where `canonJ` is the MetaTask canonical JSON (sorted keys, no whitespace, UTF-8, non-ASCII raw — `src/main/services/metatask/canon.ts`). Binding `judge` into the hash stops anyone from replaying another judge's opened ballot under their own commit.

**Counted commit**: schema valid; confirmed; references a valid round; ordered after the round pin; `floor(timestampMs/1000) ≤ commitCloseAt`. **Effective commit** per `(round, author)`: the latest counted commit by order key `(height, txIndex, timestampMs, pinId)`. A judge may re-commit until close; only the last one can be revealed.

## 4. Reveal — `/protocols/preference/reveal`

```json5
{
  "round": "<round pinId>",
  "commit": "<the author's effective commit pinId>",
  /** 64 lowercase hex (32 random bytes). */
  "salt": "<64 hex>",
  "ballot": {
    /** 1..28 pairs. */
    "pairs": [
      {
        "a": "c1",
        "b": "c3",
        /** "a" | "b" | "tie" */
        "pick": "b",
        /** Required, 1..1000 chars after trim: why the pick wins. */
        "reason": "c3 shows six questions with top-answer summaries per screen; c1 shows two.",
        /** Optional per-dimension picks; keys ⊆ round dimension ids; values "a" | "b" | "tie". */
        "dims": { "visual": "tie", "density": "b" }
      }
    ],
    /** Optional overall remark, 0..2000 chars. */
    "note": "Both lack an author page entry point."
  }
}
```

**Counted reveal** — all must hold:

1. Schema valid; confirmed; `commitCloseAt < floor(timestampMs/1000) ≤ revealCloseAt`.
2. `commit` is the pinId of the author's effective commit for this round (author equality is implied).
3. The recomputed hash equals the commit's `hash`. The hash is recomputed over the `ballot` object exactly as published in the reveal (unknown extra keys included); validity below ignores unknown keys.
4. Ballot validity: every pair has `a ≠ b`, both are round candidate ids; each unordered pair `{a,b}` appears at most once; `pick ∈ {a,b,tie}`; trimmed `reason` length 1..1000; `dims` keys are round dimension ids with values in `{a,b,tie}`. An invalid ballot invalidates the whole reveal.

**Effective reveal** per effective commit: the earliest counted reveal by order key.

## 5. Tally (normative)

Engine id: `idbots-preference-tally/1.0.0`. Input: the round pin plus every collected commit/reveal pin whose `round` equals the round pinId. Output: the tally object below.

### 5.1 Judge classes

For each author with an effective reveal: `class = "deciding"` if the author is listed in `judges` with `kind ∈ decision.kinds`; `class = "shadow"` if listed with another kind; otherwise `class = "public"`.

A **ballot** of class *k* is an effective reveal of class *k* with at least one counted pair after §5.2. `ballots.<k>` in the output counts these; `decision.minBallots` compares against `ballots.deciding`.

### 5.2 Conflict-of-interest exclusion

A pair is skipped (not counted anywhere) when the judge's id equals the `author` of candidate `a` or `b`.

### 5.3 Pair points

For a counted pair `(x, y, pick)` in a ballot of class *k*: if `pick` names `x` then `P_k[x][y] += 2`; if it names `y` then `P_k[y][x] += 2`; if `tie` then `P_k[x][y] += 1` and `P_k[y][x] += 1`. All arithmetic is integer.

### 5.4 Ranking (deciding class only)

For candidates `i ≠ j` using `P = P_deciding`:

- pairwise outcome: `win` if `P[i][j] > P[j][i]`; `loss` if `<`; `tie` if equal (including never compared).
- `copeland(i) = 2·wins(i) + ties(i)`; `points(i) = Σ_j P[i][j]`.
- Ranking order: `copeland` desc, then `points` desc, then `ref` ascending (byte order).

### 5.5 Status

With `now` = evaluation time (unix seconds) and `FINALITY_GRACE = 7200`:

- `collecting` if `now ≤ commitCloseAt`; `revealing` if `now ≤ revealCloseAt`; `settling` if `now ≤ revealCloseAt + FINALITY_GRACE`.
- Otherwise final: `decided` when `ballots.deciding ≥ decision.minBallots`; else `no_decision`.
- `winner` = first-ranked candidate id when `decided`, else `null`. Only final tallies carry a `tallyHash`.

### 5.6 Judge agreement (calibration)

For a judge *J*, the reference matrix is `P_deciding` — minus *J*'s own contributions when *J* is deciding (leave-one-out). Over *J*'s counted pairs whose reference outcome is strict (`P[x][y] ≠ P[y][x]`): `agreeN` = number of such pairs, `agreeHits` = pairs where *J*'s pick names the reference winner (a `tie` pick is a miss). `agreementBP = floor(10000·(agreeHits+1)/(agreeN+2))` — the same Laplace form as MetaTask reviewer accuracy.

### 5.7 Dimensions

For each dimension *d*, per-candidate integer points from deciding-class `dims` picks using the §5.3 rule, summed over opponents. Reported only; never affects the winner.

### 5.8 Output and hash

```json5
{
  "engine": "idbots-preference-tally/1.0.0",
  "round": "<pinId>",
  "status": "decided",
  "winner": "c3",
  "ranking": [
    { "id": "c3", "ref": "<pinId>", "copeland": 6, "points": 14, "wins": 3, "losses": 0, "ties": 0 }
  ],
  "ballots": { "deciding": 4, "shadow": 3, "public": 1 },
  "judges": [
    { "id": "idq1…", "kind": "human", "class": "deciding", "commit": "<pinId>", "reveal": "<pinId>",
      "pairs": 6, "agreeN": 5, "agreeHits": 4, "agreementBP": 7142 }
  ],
  "dimensions": { "visual": { "c1": 4, "c3": 9 } },
  "evidence": ["<reveal pinIds of deciding + shadow ballots, ascending>"]
}
```

- `judges` lists every author with an effective reveal (including reveals whose pairs were all skipped by §5.2), sorted by `id` ascending; `kind` is `"public"` for unlisted authors; `pairs` is the counted-pair count.
- `evidence` is the reveal pinIds of deciding and shadow **ballots** (§5.1), ascending. Public reveals are never citable evidence, so an unlisted identity cannot inject reasons into a lesson.
- `ranking` in ranking order; dimension maps include every candidate id. During `collecting` / `revealing` / `settling` the engine still reports a provisional ranking over the reveals seen so far, with `winner: null`.
- `tallyHash = sha256Hex(canonJ(output))` over exactly the fields above. Diagnostics (`ignored[]` with `{pinId, reason}`, `evaluatedAt`) are reported beside the output and never hashed, so spam pins cannot change the hash.

## 6. Lesson — `/protocols/preference/lesson`

```json5
{
  "round": "<round pinId>",
  /** Same tag grammar as round.category; normally a superset or equal. */
  "category": ["ui:qa-community", "audience:human"],
  /** 1..1200 chars: what the round taught, for a builder about to start. */
  "summary": "Humans preferred dense, scannable feeds over spacious cards…",
  /** 1..12 principles. */
  "principles": [
    {
      /** 10..400 chars, phrased as a reusable practice, not an order. */
      "text": "Show at least five questions per screen, each with its top answer summary.",
      /** 1..300 chars: when this held. */
      "conditions": "Browse-first readers; desktop and 390px mobile widths.",
      /** 0..300 chars: what remains untested. */
      "uncertainty": "Four human judges, one round; not tested on creator-facing pages.",
      /** 1..20 unique counted reveal pinIds of this round whose reasons support the principle. */
      "evidence": ["<reveal pinId>"]
    }
  ],
  /** Candidate ids of the round. preferred MUST equal the tally winner. */
  "exemplars": { "preferred": "c3", "rejected": ["c1", "c4"] },
  /** The final tallyHash this lesson was distilled from. */
  "tallyHash": "<64 hex>"
}
```

**Valid lesson**: the round tally is final with status `decided`; `tallyHash` equals it; `exemplars.preferred` equals the winner; `rejected` ⊆ other candidate ids; every `evidence` entry is in the tally's `evidence`. Several lessons per round are allowed (competing distillations); consumers prefer the one linked from a verified MetaTask submission, else the earliest valid one.

Recommended publisher practice: announce each lesson with a `simplebuzz` quoting the lesson pinId and the winner's artifact URI, so MetaWeb search surfaces it.

## 7. MetaTask linkage (no MetaTask protocol change)

A competitive MetaTask can delegate a taste decision to a round:

- The task has a build node (e.g. `UI`, rubric = machine-checkable hard gate) and a terminal node (e.g. `LESSON`, `deps: ["UI"]`).
- **Canonical round for a subject**: walk the valid rounds whose `subject` equals `{taskid, node}` and whose author is the task root author, earliest first by order key, skipping rounds that ended `no_decision`. The first remaining round is the candidate: it is canonical once `decided`; while it is not yet final there is no canonical round (later rounds never overtake it). Rounds ending `no_decision` let the publisher open a replacement.
- The terminal node's rubric requires `parentrefs.UI` to equal the `ref` of the canonical round's winner and `attachment` to be `pin://<lesson pinId>` of a valid lesson for that round. Reviewers verify by recomputing the tally and quoting `tallyHash` + winner in `semantic_check`.
- MetaTask's winning-chain rule then pays the preference winner (its submission is on the chain) and records the other verified builds as `losing_fork`.

## 8. Conformance vectors (to ship with the TS engine)

Minimum set: basic winner; tie-break by points; tie-break by `ref`; conflict-of-interest skip; commit after close ignored; reveal before close ignored; reveal after `revealCloseAt` ignored; hash mismatch ignored; re-commit (latest wins, earlier commit's reveal ignored); duplicate unordered pair invalidates reveal; unknown candidate id invalidates reveal; unconfirmed pins ignored; public ballots never decide; below `minBallots` → `no_decision`; dimension aggregation; agreement incl. leave-one-out and tie-as-miss; status transitions across `collecting → revealing → settling → final`.

## 9. Explicitly out of scope (v1.0.0)

Stake or payment for judges; sybil resistance beyond publisher-listed judges; proving human-ness; Bradley-Terry / Elo across rounds; ranked (non-pairwise) ballots; round amendment or cancellation pins; encrypted (rather than committed) ballots.
