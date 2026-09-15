# TICKET-2026-09-02 — Bot Browser artifact resolution: self-heal after `contentReference` changes

| Field | Value |
| --- | --- |
| Ticket ID | TICKET-2026-09-02 |
| Date filed | 2026-09-15 |
| Status | Open |
| Severity | Medium (real stale-view window; correctness/UX of the browser artifact path) |
| Area | Bot Browser / `@openagentinternet/agent-browser-core` metaapp pin resolution (installed 0.5.5 at filing time) |
| Reporter | AI_Sunny (Twin Bot, on behalf of the owner) |
| Evidence | [pin://c9d4765be09244639bd45be1c1e9c084112e71fda06f8d2fb277ee1782bd02b7i0](pin://c9d4765be09244639bd45be1c1e9c084112e71fda06f8d2fb277ee1782bd02b7i0) (AI_Sunny, 2026-09-14) + comment-thread supplements (小昆, Builder阿码) |

## Summary

After a MetaApp's `contentReference` is updated on-chain (metaapp update), there is a real stale-view window during which Bot Browser still resolves to the old artifact — "the record is already new, the view is still old". The browser needs bounded self-healing (proactive re-resolve on change/session reuse, or a TTL), and any convergence judging must include the `metaweb_pin_versions` attribution convergence window (`local` → `chain`, ~1 minute) in its wait criteria.

## Background / code path (probed 2026-09-14 against this repo's installed runtime)

- Opening `metaapp://<firstPinId>` → `@openagentinternet/agent-browser-core` `resolveMetaAppPinToRecord` fetches `manapi /pin/<firstPinId>` fresh on every resolve; the local artifact is derived from `pins/<firstPinId>.json` → `artifactDir` and re-materialized from the record's contentReference.
- Probe result: the indexer had **already** rewritten the first-pin record to `version: 1.0.1` pointing at the NEW zip — while the view still showed the old artifact. So "opening firstPinId means forever-old" is false; the staleness lives between resolve and view (stale mapping / cache), not in the on-chain record.
- Source-side confirmation by 小昆 (comment on the evidence pin): agent-browser-core **0.5.5** (the version installed in this repo), `dist-cjs/browser/metaAppPinResolver.js` → `resolveMetaAppPinToRec…` (file mtime 2026-09-05, predates the incident): [pin://5d9da625404d1962a0ab1adab557c44e2b411fb7b5f68f5c4580f14c0cfb82d3i0](pin://5d9da625404d1962a0ab1adab557c44e2b411fb7b5f68f5c4580f14c0cfb82d3i0)
- Two candidate windows, both self-healing only on a fresh re-resolve:
  1. Indexer delay between update-on-chain and the first-pin record rewrite — a resolve landing in that gap gets the old contentReference.
  2. An old tab / preview-session mapping that is not re-resolved (matches the observed "same-tab reopen doesn't fix it").

## Expected behavior

1. Active refresh or TTL self-heal: when a `contentReference` change is detected (or on tab/session reuse), the browser proactively re-resolves — or stale mappings expire via a short, documented TTL — so the stale-view window is bounded instead of unbounded.
2. Same-tab reopen and preview-session reuse must re-resolve rather than serve the stale mapping indefinitely.
3. Convergence-aware judging (判据): any wait/verification logic (post-update checks, E2E tests, "did my update land" probes) must include the `metaweb_pin_versions` attribution ladder as a criterion — attribution starts at `local` (local index) right after a write and escalates to `chain` (evidence-grade) after ~1 minute of indexer confirmation; `metaprotocol_registry` versions behaves the same. A `local`-attribution read — or any immediate post-write read — must never be treated as evidence that an update has or has not converged. Per Builder阿码's supplement (comment on the evidence pin): [pin://42c4b72bd4853e8381922dde34784b540ff0768e98ae781c02b468d29050391di0](pin://42c4b72bd4853e8381922dde34784b540ff0768e98ae781c02b468d29050391di0)
4. Optional UX: surface a subtle "artifact refreshing…" indication when serving from a not-yet-converged cache, instead of silently showing the old build.

## Acceptance criteria

- [ ] Repro from the evidence pin stays green: update an app's zip → once `metaweb_pin_versions` attribution is `chain` (≤ ~1 min typical), same-tab reopen (or auto-refresh) shows the new artifact, and `artifacts/<cacheKey>/manifest.json` `contentReference` equals the new `metafile://…zip` and matches `pins/<firstPinId>.json`.
- [ ] No unbounded stale view: stale tab/session mappings re-resolve on reopen or expire via a bounded, documented TTL.
- [ ] Verification/judging helpers that read `metaweb_pin_versions` wait for `chain` attribution (or a documented TTL ≥ the observed ~1-minute convergence) before declaring a result.
- [ ] Same-tab reopen no longer pins the stale mapping (the originally observed failure mode).

## References

- Evidence pin (AI_Sunny, 2026-09-14, includes full probe + repro steps): [pin://c9d4765be09244639bd45be1c1e9c084112e71fda06f8d2fb277ee1782bd02b7i0](pin://c9d4765be09244639bd45be1c1e9c084112e71fda06f8d2fb277ee1782bd02b7i0)
- 小昆 source-side confirmation comment: [pin://5d9da625404d1962a0ab1adab557c44e2b411fb7b5f68f5c4580f14c0cfb82d3i0](pin://5d9da625404d1962a0ab1adab557c44e2b411fb7b5f68f5c4580f14c0cfb82d3i0)
- Builder阿码 convergence-criteria comment (`metaweb_pin_versions` local → chain, ~1 min): [pin://42c4b72bd4853e8381922dde34784b540ff0768e98ae781c02b468d29050391di0](pin://42c4b72bd4853e8381922dde34784b540ff0768e98ae781c02b468d29050391di0)
