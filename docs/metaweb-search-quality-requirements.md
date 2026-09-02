# Backend Requirements — MetaWeb Search Quality: Deduplication & Ranking Hardening (metaso-p2p)

## Status

Draft v0.1 for backend development, 2026-09-02. Requested by the IDBots team as a quality follow-up to `docs/metaweb-search-backend-requirements.md` (R1 unified search / R2 SimpleNote indexing / R3 generic pin read — all delivered and verified live 2026-09-02). Target project: `metaso-p2p` (Go + Gin + PebbleDB, deployed as `https://so.metaid.io`).

**This is a quality-improvement round, not a blocker.** The IDBots autonomous-study feature (roadmap M4, `docs/metaweb-learning-roadmap.md`) works against the current API; every requirement here has a client-side mitigation already in place. Suggested sequencing: fold into the roadmap M5 backend work (reputation ranking touches the same scorer), or ship independently — either is fine.

This document is a requirements contract, not an implementation spec. Per project convention, the backend team should turn Q1–Q3 into `docs/specs/` contract docs in metaso-p2p before implementation.

## 1. Background

IDBots bots now search MetaWeb nightly in unattended study sessions: derive keywords → `GET /api/metaweb/search` → judge by title/summary → `GET /api/metaweb/pin/:pinId` for the promising ones → save worthwhile bodies into local knowledge bases. Two costs make result quality matter more than it did for interactive use:

- **Each duplicate result burns real budget twice.** A duplicated pin consumes a slot in the 10-result page, a pin read, LLM judge tokens, and one unit of the per-night pin budget before client-side dedupe (processed-pinId list + content-hash filenames) throws the copy away. The bot's effective nightly coverage shrinks by the duplicate rate.
- **No human is in the loop to skim past duplicates.** Interactive users ignore a repeated hit; an unattended session treats every returned row as a candidate.

On 2026-09-02 we measured the live API from the IDBots side and found a consistent duplicate pattern across queries (full evidence in §7). The important nuance: **in every observed duplicate set, each copy is a separate `create` pin with `pinId == currentPinId` — these are NOT modify-chain versions of one document.** Publishers are re-posting identical or near-identical content as brand-new pins (same publisher, sometimes the exact same `createdAt` second), so modify-chain collapse alone would fix nothing we observed; the dedupe must be content-level. (Separately, this violates the publisher convention in roadmap §8 — "updates use pin modify semantics" — which IDBots will relay to the content workstream. That is not the backend's problem to fix, but it explains the data.)

## 2. Q1 — Result deduplication (new requirement)

`GET /api/metaweb/search` must suppress duplicate results so that one logical document occupies one result row.

### Q1a — Modify-chain collapse (baseline hygiene)

When several versions of one document exist as a `currentPinId` chain, only the latest version may appear in results. We observed no instance of this in the wild today (every returned pin is its own chain head), so this is cheap correctness insurance, not the main fix.

### Q1b — Content-level near-duplicate suppression (the main fix)

Suppress duplicates across separate chains. Required behavior on the evidence sets in §7:

- **Exact duplicates**: same publisher + same normalized body (whitespace/punctuation-normalized hash; simhash or similar for near-identical) → keep exactly one representative (highest score, then newest), suppress the rest. Evidence set A (byte-identical 72-char buzz, two create pins) and set B (identical title, same publisher, same `createdAt` second, three pins) must collapse to one row each.
- **Near-duplicates**: same publisher + identical normalized title (body may differ slightly) → same treatment. Evidence set C must collapse.
- **Deliberate versions must survive**: titles differing by an explicit version marker (`v1`/`v2`/`v3`, `勘误版`, …) are intentional distinct publications — keep them, or group them under one row with a `versions` list. Evidence set D must NOT lose information. If grouping is chosen, the representative must be the newest.

Cross-publisher identical bodies (quote-buzz / citation conventions) are out of scope — see §6 open questions.

### Response contract

Additive only, envelope unchanged. When a group is collapsed, the representative item SHOULD carry `extra.duplicateCount: <n>` so clients can render "N similar results collapsed". Dedupe applies to `sort=relevance`; whether `sort=newest` dedupes is the backend team's call — state it in the spec doc. Cursor semantics must stay consistent (page sizes may shrink after suppression; `hasMore` must still terminate correctly).

## 3. Q2 — Ranking hardening (already queued in roadmap §9; this formalizes it)

The roadmap's 2026-08-23 field report documented that generic English queries land on substring noise, and our 2026-09-02 measurements show score saturation (many simplenote hits share an identical score of 184 — see §7). Requested scorer improvements, in priority order:

1. **IDF or equivalent down-weighting of corpus-common tokens.** Tokens like `MetaWeb`/`IDBots` appear in a large share of the corpus; a document should not outrank others merely for containing them. This is the single highest-value ranking fix for both languages.
2. **Word-boundary matching for Latin tokens** so `skill` does not substring-match inside unrelated words, and CJK tokenization keeps behaving as in `botsearch`.
3. **Stopword filtering** (Chinese function words + common English stopwords) so they contribute no score.
4. **Tie-break determinism**: after scoring, order ties by `createdAt` desc then `pinId` asc, so equal-scored pages are stable across identical queries.

No response-schema changes; this is scorer-internal.

## 4. Q3 — Inverted-index decision checkpoint (follow-up on the original open question)

The original requirements doc (§7, open question 1) left "inverted index now vs later" to the backend team with the trigger metric TBD. Please close that loop with current numbers:

- Corpus size per indexed protocol (pins counted, and growth rate if tracked).
- Measured search p95 on production (the original non-functional section asked for measured numbers in the spec doc; we could not find them).
- The team's current answer: is substring scoring still acceptable at the projected 12-month corpus size, and what metric triggers building the index?

A short written answer in the spec doc or issue tracker is sufficient — no code required for Q3.

## 5. Non-functional requirements

- All conventions from the original requirements doc §5 still apply (envelope, cursors, error codes, no auth).
- Dedupe/scoring changes must not regress the contracted performance: search p95 < 500 ms at the then-current corpus; state new measured numbers in the spec doc.
- Acceptance: the §7 evidence queries return one row per duplicate group (or a grouped row per Q1b versioning policy), with `extra.duplicateCount` populated; the `skill`/`metaweb` English queries no longer produce pages dominated by corpus-common-token matches.

## 6. Open questions for the backend team

- Version-marker policy: keep, collapse, or group-with-`versions`? (Our vote: group, representative = newest.)
- Should dedupe consider cross-publisher identical bodies later, given quote/citation conventions are legitimate reposts? (Our vote: not now.)
- Does dedupe apply inside `protocols`-filtered and `publisher`-filtered queries identically? (Our assumption: yes.)
- For Q2.1, is there per-token corpus statistics already, or does IDF require a counting pass at index time?

## 7. Appendix — evidence captured 2026-09-02 (production `so.metaid.io`)

All rows verified via `GET /api/metaweb/search` / `GET /api/metaweb/pin/:pinId`. In every set, every pin has `pinId == currentPinId` (separate chains, all `create` operations).

**Set A — byte-identical buzz, two create pins, same publisher** (`q=视频制作`):

| pinId | publisher | createdAt | body |
|---|---|---|---|
| `64f03acb5665b883f7c9535cecba0d79cbdf9090b08e274ad8abf7e2abd34bbei0` | `idq18x8zm89zrmdf5sus` | 1785527226 | 72 chars, sha256 `f36e2bb33988f0fe…` |
| `69b7f12fb48e8cc603d1cd0f2c6d837aa4b914e30144b955a6c958cc86a0e27di0` | `idq18x8zm89zrmdf5sus` | 1785524234 | 72 chars, sha256 `f36e2bb33988f0fe…` (identical) |

**Set B — identical title, same publisher, same createdAt second, three pins** (`q=视频制作`): title "一天一个新Skill 第21期 · taste-skill 配图 Prompt 与视频脚本（供 eleven）", publisher `idq1k8rd76nx2e7x0u9a`, createdAt 1788321974, identical score 21:

- `543e454b3b0aa6793eee5e5deaa7d345f710a0b36787ba76b9b6df3f28a78468i0`
- `6421893479b03071456d7d97de2727b94ee26a25d4e6f73818f14a12677d85b9i0`
- `de43b8ae9ebfbe070ec05a45b6c456b615827862b8bd52f28422cdb87a3fcba4i0`

**Set C — near-identical title pairs, same publisher** (`q=skill`, `q=metaweb`):

- "一天一个新Skill 第21期 · taste-skill APP.md 素材（供 Builder阿码）": `13ce1eec7ab6250dfa40d3ae92abd071c817a5f941253f002e163a13541d81e9i0` and `4bfa29e5718612d08a6864f8404aa0c12e215b802ac3383f68e9d176961cc599i0` — same publisher, same createdAt 1788321974.
- "游戏创作类目落地研究——Roblox 范式 × 普通人入口 × MetaWeb 最小可行形态": `7eefa7f4ab64636ffb5f881d4dc956829b8a83bb07b7e81ef3eb64547686615bi0` and `11fcdc1639a006ca7a9f014ee68ca03505209c6b9b7ac9fc31f80d6f3677e4d8i0` — same publisher `idq1l7fz6v96qn64kpq8`, createdAt ~10 min apart.

**Set D — deliberate version markers that must NOT be hard-collapsed** (`q=skill`, `q=metaweb`):

- "一天一个新Skill 第22期 · lieflat-charts 亲测介绍文案（v2）" `ee3a682e6028061334bea3516b930ae793cccef810aafd7f120e40f7ccc270a4i0` vs "（v1）" `fc785757acd59aa5de78ef4be5d45fb2a26739bf247eac2e9ee4baf18b239a80i0`.
- "「向 Sunny 团队学习」终版调研清单 v1.2（勘误版）" `1e68291d190c8a2c1f9604c4a0436d2d753e419643a2bbc0a5736ca3891aeb92i0` vs "v1.1" `522be1463f43af0384f847562d99fc8b4860bba9b8afc4713416322d2ad0372fi0`.

**Ranking observations** (`q=skill`, `q=metaweb`): seven of eight `q=skill` hits share score 184; four of eight `q=metaweb` hits share score 184 — substring scoring saturates and cannot order the page. Roadmap §9 field report (2026-08-23): generic English queries land on corpus-common-token noise instead of the strong Chinese articles.
