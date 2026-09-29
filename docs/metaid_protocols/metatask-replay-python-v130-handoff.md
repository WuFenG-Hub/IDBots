# metatask-replay v1.3.0 (Python) — Delivery & Handoff Record

Status: delivered 2026-09-27, awaiting registration-author review and on-chain
publishing (AI_Sunny). The package itself lives OUTSIDE this repo (IDBots app
skill directory, next to the installed v1.2.2 package) — this document is the
repo-side record so the three-engine consistency trail is traceable from one
place.

- Package: `~/Library/Application Support/IDBots/SKILLs/metatask-replay-v130/`
  — `metatask_replay.py` (engine 1.3.0 = protocol v1.2.1 semantics, zero
  deps, `--events/--root/--now/--guard` CLI), `run_vectors.py` (canonical
  vector-set runner), `SKILL.md`, `HANDOFF.md` (review points for the
  registration author).

## Verification (both paths reproducible)

1. **Vector set**: 16/16 PASS on the same file the TS engine runs green on,
   canonical-JSON sha256 verified equal to
   `106aa1f3bee8ebd48339ceb65f97a12e54247e1e831296a394a974c9cb22f2c4`.
2. **Real chain data**: all nine pools fetched with cursor pagination to the
   empty page (652 events; pool counts match the clause-review audits:
   task 2 / tree 2 / spec 23 / claim 151 / release 12 / submission 152 /
   verify 310 / amend 0 / challenge 0).
   - Pilot #01 (`9eb98787…`): 4/5 verified, root node verified (grandfathered
     root-author submission, v1.1 semantics), **taskComplete=true** per the
     v1.2.1 "completion = root node verified" reading, legacy uniform-weight
     settlement produced (Σ 7997 bp, 3 bp residue discarded).
   - Pilot #02 (`08cac496…`): 91 verified / 14 claimed / 6 open, root open,
     no settlement — verbatim match with the clause-review real-data runs.

## Implementation readings flagged for the registration author (not silent)

Same three as the TS engine (see `metatask-v1.2.1-alignment.md` §3), plus the
pilot-#01 completion flip is now demonstrated on real data — recommend the
author either endorses it (the task WAS announced complete on chain) or adds
a v1.2.2 clause restricting settlement to tasks published at/after H_ACT2.

## Chain-side next steps (owner/publisher side)

1. AI_Sunny reviews + publishes the skill package via `/protocols/metabot-skill`
   (v1.3.0) and pins the vector set + sha256 announcement.
2. metaso Go side reaches the same vector green (in progress separately).
3. Three-green confirmed → publisher keeps or postpones H_ACT2=191500.

## Closure addendum (2026-09-27, evening) — DELIVERED & PUBLISHED

- **Published on chain** (verified by direct registry read): pin
  `c9c34a414a063ac472dd758bb9e1b26cc9cbeaf321ea3311ca5b04941a4321c8i0` under
  `/protocols/metabot-skill`, author = registration author (idq14hmv…):
  name `metatask-replay`, **version 1.3.0**, skill-file
  `metafile://8274dec1…i0.zip`.
- **Review feedback adopted** (valid): no machine-absolute paths in
  distributed artifacts — the vector set ships WITH the package and
  `run_vectors.py` prefers the package-local copy (argv still overrides; the
  canonical-sha256 assertion `106aa1f3…` remains the anti-drift anchor). The
  author patched and republished (patched package hash relayed as
  `ff484eda…`); the local delivery copy in the app skill directory carries
  the same convention and re-verified 16/16 with the unchanged canonical
  sha256. Repo-side runner (`scripts/metatask-vectors.mjs`) already used
  repo-relative paths — no change needed there.
- metaso Go: in production since chain height 191232 (see launch-kit runbook).
- Remaining before wave-1 launch: chain reaches H_ACT2=191500.

## v1.3.1 closure (2026-09-29) — REVIEWER B1/B2/B3 FIXED & PUBLISHED

- **Reviewer findings (all valid, all fixed by the IDBots side)**: B1
  ghost-node weight poisoning (claims/submissions on node ids outside the
  effective post-amend tree → `unknown_node`; no node state / progress
  inflation / weight-table entry; ignored pins REMAIN in eventSetHash); B2
  reviewer-accuracy identity filter (reviewTerminal/reviewCorrect exclude
  voter==submitter/root-author, matching settlement R(n); reviewVotes stays
  a display counter); B3 roster pins travel in the event set
  (`path=metatask-roster` auto-builds rosterPins by pinId; post-H_ACT2
  same-side votes ignored, pre-gate untouched). Plus the manifest
  engineAlgoVersion pinned to `idbots-metatask-engine/1.2.1` for three-
  engine byte parity. TS reference = main `de3f704e` (+`e7104c18`,
  `5d76b0c9`); Go = metaso v121.go.
- **Verification**: canonical vector set frozen and green 16/16 (sha256
  `106aa1f3…22f2c4` unchanged); `regressions_b1_b2_b3.py` **10/10**
  (B1×4 / B2×3 / B3×3 — the delivery note initially miscounted "12/12";
  the registration author caught it and, under an explicit owner
  authorization, fixed the three display layers to a dynamic count with
  zero bytes changed in engine or vectors); both on-chain pilots replay
  identically to pre-fix readings (654 events incl. the two fresh
  post-deploy pins — a late conflicting claim on t118 correctly inert).
- **Published on chain** (verified by direct registry read): registration
  pin `cd78ab4ede4c6be77cf774736672651d25446305e06106b91c3cf3f61d250ebei0`
  → name `metatask-replay`, **version 1.3.1**, skill-file
  `metafile://dbcbdba4…i0.zip` (28538 B, sha256
  `a746577d98b3c35a79b8ee24ef6c5fc1dfd5ce978385546baebb96c9efd9fe98`),
  announcement buzz
  `56ed617ffc51c234e15e929d84f779d263e1e76044803d9757456ebacf8bbcd7i0`;
  supersedes v1.3.0 (`c9c34a41…`). The v1.3.0 "roster on-chain fetch"
  known-gap is closed by B3.
- Side note logged by the author: manapi now truncates list-row
  `contentSummary` to 4096 B — both the IDBots collector (main `ef05a2a8`)
  and the skill's fetch path follow the content URL for full bodies.
- v1.2.2 owner rulings (seven items incl. point-in-time amend, fail-vote
  identity gate at a new H_ACT3, settlement scoped to post-H_ACT2 tasks,
  implementation-neutral engineAlgoVersion string) ride the next
  registration update via the #10 process — NOT in this package.
- **Three-engine status**: TS main / Python v1.3.1 on chain / Go in
  production. Remaining before wave-1 launch: chain reaches H_ACT2=191500
  (newest observed event ≈ 191388 on 2026-09-29; ≈112 blocks ≈ 1 day).
