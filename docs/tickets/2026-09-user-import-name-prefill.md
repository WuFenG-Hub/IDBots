# TICKET-2026-09-03 — User-identity import: on-chain name/avatar not prefilled (local P2P metadata-only stub masks the remote fallback)

| Field | Value |
| --- | --- |
| Ticket ID | TICKET-2026-09-03 |
| Date filed | 2026-09-23 |
| Status | Fix in review (branch `fix/local-stub-profile-fallback`) |
| Severity | Medium (silent profile-data loss on the user onboarding path; the user retypes a name that already exists on-chain) |
| Area | Host-side user identity — mnemonic import (`userIdentity:import` → `importUserIdentity` → `fetchMetaidRestoreProfile`) over the local-first indexer proxy |
| Reporter | 星期一 (Twin Bot, on behalf of the owner) |
| Evidence | Live local-vs-remote probe + before/after repro on a fresh machine (IDBots 0.9.4); regression tests in `tests/metabotRestoreProtocol.test.mjs` |

## Summary

Importing an existing MetaID account (助记词导入) lands on the profile panel with an empty name and the `尚未设置名字` warning — the user must retype a name that already exists on-chain, and the avatar is lost the same way. The import logic itself already prefers the on-chain profile; the defect is in the local-first semantic-miss check, which accepts a metadata-only local stub as a hit and thereby suppresses the remote fallback.

## Symptoms

1. Fresh machine, `设置 → 用户 → 导入助记词`: after import the name input is empty (warning `尚未设置名字：请设置你的名字，它将发布到链上`), forcing manual re-entry.
2. `fetchMetaidRestoreProfile(address)` throws `NAME_EMPTY` while the remote indexer returns `name: "WuFenG"` for the same address.
3. The fetch trace shows only the local P2P call — the remote fallback never runs.

## Evidence

### Same address, two data sources (probed live, 2026-09-22)

Local `GET http://localhost:7281/api/v1/users/info/address/1FRU…` (man-p2p on a fresh machine):

```json
{"code":1,"message":"ok","data":{"metaid":"7777775f…","name":"","nameId":"","address":"1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX","globalMetaId":"idq1ncewm6vda5ryqjerwcmsqlty3x89n05k6dp6jv","avatar":"","chatpubkey":"","isInit":false}}
```

Remote `GET https://file.metaid.io/metafile-indexer/api/v1/info/address/1FRU…`:

```json
{"code":1,"message":"success","data":{"globalMetaId":"idq1ncewm6vda5ryqjerwcmsqlty3x89n05k6dp6jv","name":"WuFenG","nameId":"02fe59fe…i0","address":"1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX","avatarId":"b00d2a48…i0","chatpubkey":"04713db0…"}}
```

### Repro before the fix

```
$ node localdocs/repro-import-name.mjs
RESULT: error = NAME_EMPTY
FETCH CALLS:
 - http://localhost:7281/api/v1/users/info/address/1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX
```

### Repro after the fix

```
RESULT: name = "WuFenG"
FETCH CALLS:
 - http://localhost:7281/api/v1/users/info/address/1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX   (local stub -> semantic miss)
 - https://file.metaid.io/metafile-indexer/api/v1/info/address/1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX   (remote hit)
 - …/content/b00d2a48…i0 (avatar: local then remote)
```

## Root cause

`isSemanticallyEmptyMetaidInfoPayload` counted any non-empty identity string as a hit — including bare metadata keys (`metaid`, `metaId`, `globalMetaId`, `globalMetaid`, `address`). A fresh local P2P node answers lookups with a metadata-only stub (identity mapping present, all profile fields empty, `isInit: false`), so the stub was accepted, `fetchJsonWithFallbackOnMiss` never fell back, `fetchMetaidRestoreProfile` got an empty name and threw `NAME_EMPTY`, and `importUserIdentity` deliberately swallows exactly that error and proceeds with an empty name. The same under-fallback affects sibling consumers (`fetchMetaidInfoByMetaid`, MetaBot restore, community-app author info).

## Fix

- `isSemanticallyEmptyMetaidInfoPayload`: the content check no longer treats bare metadata as a hit; a metadata-only stub is a semantic miss, so the remote fallback runs while local-first is preserved for real hits.
- New `isSemanticallyEmptyRestoreProfilePayload`: restore flows additionally require a non-empty `name`, so a partial local payload (e.g. chatpubkey synced but no name yet) still falls through to remote.
- `fetchMetaidInfoByAddress` takes an optional miss predicate; `fetchMetaidRestoreProfile` passes the restore one.
- Regression tests added (4 cases): stub-is-miss, restore-needs-name, remote-fallback-after-stub, local-hit-still-wins.

## Verification

- `npm run compile:electron` clean; `npm run lint` clean; `npm run build:skills` clean.
- Targeted suites green: `tests/metabotRestoreProtocol.test.mjs` + `tests/userIdentityService.test.mjs` (31/31).
- Full `node --test tests/*.test.mjs`: no new failures vs the pristine-`main` baseline (the pre-existing environment failures reproduce identically on an untouched main checkout).
