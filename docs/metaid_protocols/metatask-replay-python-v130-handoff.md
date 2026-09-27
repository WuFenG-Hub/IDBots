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
