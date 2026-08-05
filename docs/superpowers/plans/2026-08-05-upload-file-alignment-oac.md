# File Upload Alignment with OAC Implementation Plan (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align IDBots file upload capability (skill surface, on-chain semantics, sponsor path, verification, result shape, and post-upload handling) with the OAC file upload implementation in `/Users/tusm/Documents/MetaID_Projects/open-agent-connect` (`SKILLs/metabot-upload-file/SKILL.md`, `src/core/files/*`, `src/cli/commands/file.ts`, `src/daemon/defaultHandlers.ts`, `docs/superpowers/specs/2026-06-28-metafs-large-file-upload-design.md`). The skill is renamed `metabot-upload-largefile` -> `metabot-upload-file` so IDBots and OAC share one skill name and one set of semantics.

**Architecture:** Keep the current IDBots runtime architecture (skill script -> local HTTP RPC `:31200/api/idbots/files/upload-largefile` -> Electron main process upload services -> MetaFS uploader / Metalet wallet-api / `meta-contract`). IDBots does not ship the OAC `metabot` CLI, so the alignment happens in semantics, result shape, and runtime behavior rather than by adopting the CLI. The skill remains a thin RPC client; all logic stays in `src/main/services/metaFileUpload*.{js,ts}` and `src/main/libs/uploadLargeFile*.ts`.

**Tech Stack:** Electron main process, TypeScript, `meta-contract` TxComposer, Metalet wallet-api HTTP, MetaFS multipart uploader (`https://file.metaid.io/metafile-uploader`), Node test runner, `npm run compile:electron`.

**Repository note:** Current repo rules require IDBots edits to stay inside this repository. If a task adds plan or test files under ignored paths, use `git add -f` for those files. Each implementation commit must be followed by a Codex `metabot-post-buzz` development journal entry.

---

## Target Semantics (OAC, from open-agent-connect)

| Concern | OAC semantics |
| --- | --- |
| Skill name | `metabot-upload-file`; one skill for both small and large files |
| Direct threshold | `<= 5 MiB` -> direct binary `/file` pin write |
| Chunked | `> 5 MiB` and `<= 50 MiB` -> MetaFS chunked upload (1 MiB parts, multipart staging) |
| Hard cap | `> 50 MiB` rejected before upload (error `large_file_upload_too_large` / HTTP 413) |
| Chains (direct) | `mvc`, `btc`, `opcat` |
| Chains (chunked) | `mvc` only; explicit error for btc/opcat above 5 MiB |
| DOGE | Unsupported for file upload on every path; error message states MVC/BTC/OPCAT only |
| Default network | Profile config `chain.defaultWriteNetwork` (default `mvc`); explicit `--chain` wins; `config get/set` surface |
| Sponsor | MVC sponsor v2 for direct MVC uploads `<= 5 MiB` when gate `chain.mvcSponsorUploadEnabled` (default true) is on; self-paid fallback for `service_unavailable` / `no_user_utxo` / `insufficient_quota`; hard failure with `feeAssist` diagnostics for `pre_rejected` / `commit_failed` |
| Verification | Optional `--verify`: probe 3 content URLs (HEAD, GET fallback on 403/405), 3 attempts x 250 ms; result `{ok, url, attempts, error}`; absent when not requested; never invent a result |
| Result fields | `pinId`, `txids`, `totalCost`, `network`, `fileName`, `contentType`, `bytes`, `extension`, `metafileUri` (extension-bearing `metafile://<pinid>.ext`), `metawebUrl` (share link), `previewUrl`, `downloadUrl`, `globalMetaId`, `uploadMode` (`direct`/`chunked`), optional `feeAssist`, optional `verification` |
| URL semantics | `previewUrl` = content URL `https://file.metaid.io/metafile-indexer/api/v1/files/content/<pinId>`; `downloadUrl` = accelerate URL `.../files/accelerate/content/<pinId>`; `metawebUrl` = `https://openagentinternet.org/browser/metafile/<pinId>` (share to other people only) |
| Post-upload viewing | Local human views via local Bot Browser (`browser tab open --uri metafile://<pinId>.<ext>`, `browser link`); never the share URL for local viewing; `/browser/pin` is not the file viewer |
| Legacy compatibility | `--request-file <json>` accepts `{filePath, contentType, verify}` |
| Skill consumers | `metabot-post-buzz` (attachments), `metabot-metaapp` (ZIP + images), `metabot-post-skillservice` (icons), `metabot-create-wiki` all delegate uploads to the unified `file upload`/`file upload-large` flow; payloads reference `metafile://` URIs |

## Current IDBots State

| Concern | IDBots today |
| --- | --- |
| Skill name | `metabot-upload-largefile` (Chinese description, `official: true`) |
| Thresholds | `>= 5 MiB` -> chunked (off-by-one vs OAC `> 5 MiB`); `>= 50 MiB` rejected (`must be smaller than`) |
| Chains | Direct: mvc/doge/btc; chunked: mvc only (throws for doge/btc) |
| DOGE | Supported for direct upload |
| Sponsor | Absent (no sponsor code anywhere in the upload path) |
| Verification | Absent (worker only checks uploader `status === 'success'`) |
| Result fields | `success, pinId, metafileUri, previewUrl, fallbackUrl, fileName, size, contentType, uploadMode` (+`txId` for chunked) |
| URL semantics | `previewUrl` = accelerate URL, `fallbackUrl` = content URL (swapped vs OAC); no `metawebUrl`, no `downloadUrl` |
| SKILL.md preview doc | Documents the content URL while runtime returns the accelerate URL (doc/runtime discrepancy) |
| Post-upload handling | No local-browser/share-link guidance in skill; `metabot-post-buzz` and `metabot-post-skill` do their own base64 direct uploads via `/api/metaid/create-pin` instead of the unified flow |
| Upload service entry points | RPC route `metaidRpcServer.ts:843-882`, IPC `uploadMetabotHomepageFile`, bot-browser bridge, private-chat daemon, delivery artifacts |
| Network default | `--network` flag, defaults to `mvc`; no per-profile `chain.defaultWriteNetwork`-style config read |

## Gap Summary (IDBots -> OAC)

1. Skill name/identity mismatch (`metabot-upload-largefile` vs `metabot-upload-file`).
2. Threshold boundary semantics: `>= 5 MiB` vs `> 5 MiB`; `>= 50 MiB` rejected vs `> 50 MiB` rejected.
3. DOGE accepted for direct upload (must be rejected).
4. No MVC sponsor path (must add, with gate + fallback + `feeAssist`).
5. No `--verify` post-upload verification.
6. Result shape missing `txids`, `totalCost`, `network`, `bytes`, `extension`, `metawebUrl`, `downloadUrl`, `verification`, `feeAssist`; `previewUrl`/`downloadUrl` semantics swapped.
7. `metafileUri` must be extension-bearing when the type is inferable.
8. SKILL.md does not follow the OAC document structure (routing, actor selection, trigger guidance, privacy rule, success result, required semantics, in scope/out of scope, handoff) and documents the wrong preview URL.
9. Post-upload viewing flow (local Bot Browser vs share URL) not defined in the skill.
10. Other skills (`metabot-post-buzz`, `metabot-post-skill`, `metabot-omni-caster`) bypass the unified upload flow and have divergent semantics (base64 direct, 4 MiB cap, no preview/download URLs).

---

## Alignment Decisions

- **Skill rename:** `SKILLs/metabot-upload-largefile` -> `SKILLs/metabot-upload-file`, matching OAC. Script `upload-largefile.js` -> `upload-file.js` (single script, path-first, same RPC endpoint).
- **Threshold semantics:** direct when `size <= 5 MiB`; chunked when `5 MiB < size <= 50 MiB`; reject when `size > 50 MiB`.
- **Chain semantics:** direct supports `mvc`, `btc`, `opcat`; chunked supports `mvc` only; `doge` rejected with the OAC error message for all file uploads. `normalizeUploadNetwork` stops passing `doge` through.
- **Default network:** resolve upload network as explicit param first, else the metabot's configured default write network if IDBots exposes one, else `mvc`. Throw on `doge` in all cases. (Verify whether IDBots has a per-metabot chain default setting; if not, keep `mvc` default and note it in the plan follow-up.)
- **Sponsor:** add `MvcSponsorDirectUpload`-equivalent flow: gate config `chain.mvcSponsorUploadEnabled` (default true) stored per profile; only `mvc` + direct (`<= 5 MiB`); self-paid fallback for `service_unavailable`, `no_user_utxo`, `insufficient_quota`; hard failure with `feeAssist` payload for `pre_rejected` / `commit_failed`. Surface `feeAssist` in the result.
- **Verification:** add `verify: boolean` to the RPC contract and `--verify` to the skill script; probe content/accelerate/legacy URLs with HEAD-then-GET fallback, 3 attempts x 250 ms; include `verification` only when requested; never fabricate.
- **Result shape:** single canonical payload per OAC: `pinId`, `txids`, `totalCost`, `network`, `fileName`, `contentType`, `bytes`, `extension`, `metafileUri`, `metawebUrl`, `previewUrl`, `downloadUrl`, `globalMetaId`, `uploadMode`, optional `feeAssist`, optional `verification`. Keep `success: true` wrapper for the script stdout contract. `previewUrl` = content URL; `downloadUrl` = accelerate URL; `fallbackUrl` kept only as an internal verifier probe, not surfaced in the canonical result.
- **Post-upload handling:** SKILL.md must instruct local viewing through the IDBots Bot Browser equivalent (verify what IDBots' bot-browser bridge supports for `metafile://`; align with OAC `browser tab open`/`browser link` semantics) and restrict `metawebUrl` to sharing with other people.
- **Unified consumption:** `metabot-post-buzz` (attachments) and `metabot-post-skill` (ZIP) should route uploads through `uploadMetaFile` so payloads reference extension-bearing `metafile://` URIs and gain preview/download/verification semantics instead of bespoke base64 writes.
- **Installed-skill migration:** production sync (`syncBundledSkillsToUserData`) must remove the legacy `metabot-upload-largefile` folder from `userData/SKILLs` once `metabot-upload-file` is the official entry, so upgraded users do not end up with two competing skills.

## Rename Touchpoints

1. `SKILLs/metabot-upload-largefile/` -> `SKILLs/metabot-upload-file/` (SKILL.md, `scripts/upload-file.js`/`.ts`, `tsconfig.json`, `evals/evals.json`)
2. `SKILLs/skills.config.json` (entry name, version bump, order)
3. `SKILLs/metabot-create-wiki/assets/metabot-llm-wiki-runtime/scripts/index.js` (lines ~2585, 2587, 2641 resolve `metabot-upload-largefile/scripts/upload-largefile.js`)
4. `tests/metabotWikiMetafileUri.test.mjs` (line ~42 stub script path)
5. `tests/metabotUploadLargefile.test.mjs`, `tests/uploadLargeFileWorker.test.mjs`, `tests/metaFileUploadMvcSpend.test.mjs` (update expected result shape + threshold boundaries)
6. New plan doc (this file); update `docs/superpowers/plans/2026-04-10-metabot-upload-largefile.md` if it exists on the merge target at merge time (it exists on local `main` but not on `origin/main`; coordinate at merge).

## File Structure (target)

- `SKILLs/metabot-upload-file/SKILL.md` - rewritten in English following the OAC document structure (routing, actor selection, trigger guidance, privacy rule, default command, size/chain limits, success result, required semantics, in scope/out of scope, handoff). Describes the unified small+large upload, `--verify`, `--chain mvc|btc|opcat`, DOGE rejection, 5 MiB/50 MiB boundaries, and local-browser vs share-link viewing.
- `SKILLs/metabot-upload-file/scripts/upload-file.js` (+`.ts`) - rename; add `--verify`; keep `--file`, `--content-type`, `--network`; reject `doge` early; pass-through canonical result JSON.
- `src/main/services/metaFileUploadShared.js` - threshold boundary fixes (`> 5 MiB`, `> 50 MiB`), DOGE rejection, canonical URL builders (content = preview, accelerate = download), `metawebUrl` builder, extension-bearing `metafileUri`.
- `src/main/services/metaFileUploadService.ts` - wire network default resolution, sponsor attempt on direct MVC `<= 5 MiB`, post-upload verification when requested, canonical result assembly (`txids`, `totalCost`, `network`, `bytes`, `extension`, `globalMetaId`).
- `src/main/services/mvcSponsorUpload.ts` (new) - sponsor v2 client (address/info, challenge, pre, commit), self-paid fallback semantics, `feeAssist` payload; ported from OAC `src/core/files/mvcSponsorDirectUpload.ts` with the Metalet/meta-contract signing stack IDBots already uses.
- `src/main/services/metafileVerifier.ts` (new) - URL probe loop ported from OAC `src/core/files/metafileVerifier.ts`.
- `src/main/libs/uploadLargeFileWorker.ts` - align chunked result fields; keep MetaFS protocol as-is.
- `src/main/services/metaidRpcServer.ts` - extend upload RPC body with `verify`, `chain` alias, and canonical response passthrough.
- `src/main/skillManager.ts` - remove legacy `metabot-upload-largefile` from `userData/SKILLs` during sync.
- `src/main/services/botBrowserBridgeService.ts` (+ docs) - verify/align `metafile://` local viewing support with OAC `browser tab open`/`browser link`.
- `SKILLs/metabot-post-buzz/`, `SKILLs/metabot-post-skill/` (+ their runtime code) - delegate attachments/ZIP uploads to the unified flow.

## Tasks

- [x] T1: Rename `SKILLs/metabot-upload-largefile` to `SKILLs/metabot-upload-file`, rename script to `upload-file.js`/`.ts`, update `skills.config.json`, wiki runtime reference, and wiki test; fix stale "2M" eval reference.
- [x] T2: Threshold and chain semantics in `metaFileUploadShared.js`/`metaFileUploadService.ts`: `> 5 MiB` chunked, `> 50 MiB` reject, DOGE rejected everywhere, `opcat` accepted for direct.
- [x] T3: Canonical result shape: content preview URL, accelerate download URL, `metawebUrl` share link, extension-bearing `metafileUri`, plus `txids`/`totalCost`/`network`/`bytes`/`extension`/`globalMetaId`.
- [x] T4: `--verify` flow: RPC `verify` param, skill `--verify` flag, `metafileVerifier.ts` probe loop, `verification` result field.
- [x] T5: MVC sponsor path: config gate `chain.mvcSponsorUploadEnabled`, `mvcSponsorUpload.ts`, direct `<= 5 MiB` sponsor attempt, fallback semantics, `feeAssist` result field.
- [x] T6: Network default resolution from metabot profile config (`chain.defaultWriteNetwork`, default `mvc`).
- [x] T7: Rewrite `SKILLs/metabot-upload-file/SKILL.md` in English per OAC structure; include post-upload viewing (local Bot Browser vs share URL) and handoff sections.
- [x] T8: Align `metabot-post-buzz` / `metabot-post-skill` uploads to the unified flow; keep existing behavior covered by tests.
- [x] T9: Production sync cleanup of legacy `metabot-upload-largefile` in `userData/SKILLs`.
- [x] T10: Update/extend tests: `tests/metabotUploadLargefile.test.mjs` (boundaries, DOGE, new result fields), `tests/uploadLargeFileWorker.test.mjs` + `tests/metaFileUploadMvcSpend.test.mjs` (import-path fix), new `tests/metafileVerifier.test.mjs`, `tests/mvcSponsorUpload.test.mjs`, `tests/metabotSettings.test.mjs`, `tests/metabotPostBuzzSkill.test.mjs` (unified upload), `tests/skillManagerContentSync.test.mjs` (retirement), `tests/metabotWikiMetafileUri.test.mjs`.
- [x] T11: Update evals (`SKILLs/metabot-upload-file/evals/evals.json`) to cover: small PNG direct, PDF direct with `--verify`, > 5 MiB MP4 chunked, > 50 MiB rejection, DOGE rejection.
- [x] T12: Docs: record final semantics in this plan; mark OAC parity table complete.

## Final Status (implementation complete)

All 12 tasks are implemented on `feat/upload-file-align-oac`. Final behavior:

- **Skill identity**: `metabot-upload-file`; one skill for small and large files; path-first script `SKILLs/metabot-upload-file/scripts/upload-file.js` -> RPC `POST /api/idbots/files/upload-largefile` (endpoint kept, not renamed).
- **Thresholds**: direct `<= 5 MiB`; chunked `> 5 MiB` and `<= 50 MiB` (MVC only); reject `> 50 MiB`.
- **Chains**: direct `mvc`/`btc`/`opcat` (opcat via new `src/main/libs/opcatInscribe.ts`, dependency `@opcat-labs/scrypt-ts-opcat@^4.0.0`); DOGE rejected everywhere for file upload.
- **Sponsor**: MVC sponsor v2 for direct MVC file uploads, gated by per-metabot setting `chain.mvcSponsorUploadEnabled` (default true); self-paid fallback for `service_unavailable`/`no_user_utxo`; hard failure with `data.feeAssist` for `pre_rejected`/`commit_failed`; quota shortfall surfaces at `pre` as `insufficient_quota` hard failure (the address-info advisory estimate is 0 by draft construction, matching OAC).
- **Verification**: `--verify` probes accelerate/content/legacy URLs (HEAD, GET fallback), 3 attempts x 250 ms; `verification` field only when requested.
- **Result**: `success`, `pinId`, `metafileUri` (extension-bearing), `previewUrl` (content URL), `downloadUrl` (accelerate URL), `metawebUrl` (share link), `fileName`, `size` + `bytes` alias, `extension`, `contentType`, `uploadMode`, `network`, `txids`, optional `totalCost`, `globalMetaId`, optional `feeAssist`, optional `verification`. `fallbackUrl` removed from the payload.
- **Settings**: new idempotent `metabot_settings` table (per-metabot kv): `chain.defaultWriteNetwork` (default `mvc`) and `chain.mvcSponsorUploadEnabled` (default true). A config-set RPC/IPC surface is deferred.
- **Post-upload handling**: local viewing via `bot_browser_open_uri metafile://<pinId>.<ext>`; sharing via `metawebUrl` / `https://openagentinternet.org/browser/metafile/<pinId>`.
- **Consumers**: `metabot-post-buzz` attachments and `metabot-post-skill` ZIP uploads route through the unified flow; post-buzz maps DOGE to MVC for attachments while keeping DOGE for the buzz write; post-skill keeps its documented 4 MB product cap.
- **Upgrade path**: production skill sync removes the legacy `metabot-upload-largefile` folder and config entries from `userData/SKILLs`.

### Deviations from OAC (intentional)

- OAC's pending-UTXO tracking after sponsor commit is not ported; IDBots relies on its existing MVC spend coordinator and stale-input retry machinery.
- `chain.defaultWriteNetwork`/`chain.mvcSponsorUploadEnabled` live in the IDBots per-metabot `metabot_settings` table instead of a profile `config.json`; no `config get/set` CLI surface in this iteration.
- The RPC endpoint path `/api/idbots/files/upload-largefile` is unchanged to avoid breaking existing callers (`metabot-metaapp`, `metabot-post-metaapp`, wiki runtime).

## Verification

- `npm run compile:electron` passes.
- Test suite: `tests/metabotUploadLargefile.test.mjs tests/uploadLargeFileWorker.test.mjs tests/metaFileUploadMvcSpend.test.mjs tests/metabotWikiMetafileUri.test.mjs tests/metafileVerifier.test.mjs tests/mvcSponsorUpload.test.mjs tests/metabotSettings.test.mjs tests/metabotPostBuzzSkill.test.mjs tests/skillManagerContentSync.test.mjs` - all pass (28 tests).
- Manual (recommended before merge): upload a small PNG (expect `uploadMode: direct`, content preview URL, download URL, share link, optional verification); upload a > 5 MiB MP4 to MVC (expect `uploadMode: chunked`); upload > 50 MiB (expect hard-cap error); request DOGE (expect explicit rejection); run with `--verify` (expect `verification.ok` true and a probed URL); upload with `--network opcat` on a bot with OPCAT funds (expect direct opcat write).
- Skill name `metabot-upload-file` resolves in dev mode; production sync does not leave a stale `metabot-upload-largefile` folder.

## Out Of Scope (this iteration)

- Adopting the OAC `metabot` CLI (`file upload-large`) as the IDBots entry point; IDBots keeps its RPC script contract.
- BTC/OPCAT chunked upload support (OAC does not support it either).
- DOGE file upload support.
- Changes to the MetaFS uploader protocol itself (1 MiB parts, multipart staging) - shared server, keep as-is.
- The externally installed `~/.metabot/skills/metabot-upload-*` copies (these belong to the OAC `metabot` CLI installation, not IDBots).
- A per-metabot `config get/set` RPC surface for the new chain settings.
