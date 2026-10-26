# Chain Backup & Restore — Design

Date: 2026-10-10
Status: Approved direction; L0/L1/L2 cross-device backup and restore implemented with v1-backup compatibility

## 1. Goal

Let a user move their entire Bot fleet to a new device (or a future cloud
version of IDBots) with nothing but their **user mnemonic**. One-click backup
publishes each Bot's soul data to the chain, encrypted; restore re-derives
everything from the mnemonic alone. This is the concrete foundation for the
"on-chain immortality" claim: at minimum, **memory is permanently preserved
on-chain**.

Non-goals: backing up rebuildable caches, sandbox images, node_modules,
browser caches, raw DSH transcripts, or any data that is already
authoritative on-chain (private/group chat, MetaTask, service orders, persona
`/info/*` pins).

## 2. Owner decisions (2026-10-10)

1. **Bot key custody: A+B in parallel.** A: key envelope — every Bot mnemonic
   is encrypted with the user-mnemonic-derived backup key and published inside
   the backup (covers all existing Bots). B: going forward, new Bot wallets
   are **derived from the user mnemonic** (dedicated derivation path), making
   them natively recoverable; the envelope remains as the fallback for legacy
   Bots.
2. **Conversation window: 60 days.** Only the last 60 days of local-only
   conversations (in-app owner↔bot, IM gateway) are backed up, on a rolling
   basis. Older conversations are already distilled into memories/dreams.
3. **No extra backup passphrase.** The backup key is derived from the user
   mnemonic alone (mnemonic loss is strictly rarer than a forgotten
   passphrase).
4. **Fee mode follows the global setting.** All backup chain writes use the
   same traffic (sponsored) vs selfpay choice the user selected globally; no
   backup-specific fee logic.
5. **Indexer dependence is acceptable.** Restore reads through indexers
   (manapi / file.metaid.io); user-switchable indexers are planned separately.

## 3. Why the envelope is new code (correction)

The existing "sync bots to mobile" (`userBotsPinService.ts`) publishes an
`/info/bots` manifest that contains **only already-public data** (addresses,
GlobalMetaIDs, chat pubkeys) — see the header comment: "The manifest contains
only data that is already public on-chain". No mnemonic or private material is
encrypted anywhere in that flow, and no self-encryption facility exists in the
codebase (the only real crypto is the point-to-point ECDH of `simplemsg`).
So the key envelope must be built fresh, but it **reuses the same trust
pattern**: `/info/bots` (discovery) + `/info/owner` (owner-signed binding) +
a new encrypted payload pin family.

## 4. Data classification

Volumes measured on the dev machine (20 Bots, main DB 2.3 GB total).

| Tier | Content | On-chain already? | Full-backup size | Policy |
|---|---|---|---|---|
| **L0 Soul** | `user_memories` (incl. `self_identity`), `user_memory_sources`, `metabot_daily_summaries`, `metabot_weekly_summaries`, `metaid_knowledge_entries`(+revisions/procedures) | No | ~2.5 MB total | Encrypted, full + daily incremental |
| **L1 Continuity** | `metaid_impression_snapshots` + recent observations, `metaid_experience_episodes` (+participants; evidence trimmed to recent), `team_culture_entries`, `metabot_memory_policies`, `cowork_config.memoryHygiene`, `scheduled_tasks`, `long_term_*`, `orchestration_*` (active only), `metabot_settings` | No | ~5–20 MB | Encrypted, full + incremental |
| **L2 Recent conversations** | `cowork_sessions`/`cowork_messages` last 60 days, channels `cowork_ui` + `im:*` only | No | usage-dependent | Encrypted, rolling window, expired objects not re-published |
| **L3 Key envelope** | `metabot_wallets.mnemonic` per Bot | No | ~100 B per Bot | Encrypted, on Bot create/change only |
| **Excluded (rebuildable / already on-chain)** | persona `/info/*`, `private_chat_messages`, `group_chat_messages`, `metatask_*`, `service_orders` anchors, `remote_skill_service`, KB index (`kb.sqlite`), MetaApps, official SKILLs, sandbox/caches/node_modules, logs, `metabot_chain_reads/writes` ledgers | Yes or derivable | — | Re-pulled / rebuilt on restore |
| **Excluded (secrets / hygiene)** | `user_identity.mnemonic` (it IS the key), `kv.app_config` API keys, IM credentials (`im_config`) | — | — | Never leave the device inside backups; user re-enters on the new device |
| **Optional (user opt-in)** | KB raw documents of Web2/manual origin (MetaWeb-sourced docs are re-fetched from chain) | Partial | up to 218 MB | Per-KB toggle, MetaFile upload, user bears traffic |

**Hard rule:** extraction is a **whitelist of tables**, never a DB dump.
`user_identity.mnemonic`, 28 Bot mnemonics, and plaintext LLM API keys all
live in the same `idbots.sqlite`; any whole-file upload would broadcast the
keys. Extraction runs against a consistent snapshot (`VACUUM INTO` or
WAL-aware read).

## 5. Encryption scheme

- **Backup key**: `HKDF-SHA256(ikm = user-mnemonic entropy, salt = "idbots-backup-v1" + userGlobalMetaId, info = "backup-key", len = 32)`.
  Deterministic from the mnemonic alone; any device that imports the mnemonic
  re-derives it. No passphrase (decision 3).
- **Cipher**: AES-256-GCM, random 12-byte nonce per object, nonce prepended to
  ciphertext. Plaintext is canonical JSON (`UTF-8`, sorted keys) so object
  hashes are stable.
- **Object id**: `sha256(canonicalJson({kind,data}))` after normalizing
  device-local numeric Bot references and including the owner's stable
  GlobalMetaID. The encrypted payload retains those local references for ID
  remapping, while the same logical row keeps its identity across devices.
  Restore also accepts legacy v1 object hashes created before this rule.
- **Key envelope (scheme A)**: each Bot mnemonic is a normal backup object of
  `kind: "key_envelope"`, encrypted with the same backup key. The chain never
  sees plaintext key material.
- **Scheme B (future Bots)**: Bot wallets derived from the user mnemonic at
  `m/44'/10001'/0'/0/N` (N = next free index, tracked in the manifest).
  Such Bots need no envelope; their identity is recoverable by derivation.
  `restoreMetaBotFromMnemonic` already covers the rest of the restore path.

## 6. Protocol: `/protocols/metabot-backup`

Registered through `/protocols/metaprotocol` (existing
`metaProtocolService.ts`). Two pin families.

**Publisher (amended 2026-10-10, implementation):** pins are published by
**each Bot's own wallet** via `createPin()`, not by the user identity.
Rationale: `createPinForIdentity` has no sponsor branch, so identity
pins always self-pay; only `createPin` honors the global traffic/selfpay
setting (owner decision 4) and auto-records the write ledger. Discovery on
restore: the user's `/info/bots` pin → per-Bot `pins_by_metaid` lookup of the
manifest. Decision 4 applies to every backup write.

### 6.1 Object pins — `/protocols/metabot-backup/object`

One encrypted segment per pin. A segment packs many small objects (memory
items, diary entries) into one JSON container to keep pin count low.

```jsonc
{
  "version": 1,
  "bot": "<botGlobalMetaId>",
  "segment": "<sha256 of plaintext segment>",
  "encoding": "base64",
  "cipher": "aes-256-gcm",
  "kdf": "hkdf-sha256:user-globalmetaid",
  "payload": "<base64 nonce||ciphertext>"
}
```

Segment plaintext (before encryption):

```jsonc
{
  "version": 1,
  "bot": "<botGlobalMetaId>",
  "createdAt": 1760000000,
  "objects": [
    { "id": "<sha256>", "kind": "memory" | "self_identity" | "dream_daily"
      | "dream_weekly" | "knowledge" | "impression" | "episode" | "culture"
      | "policy" | "schedule" | "longterm" | "orchestration" | "conversation"
      | "key_envelope" | "kb_raw_ref",
      "createdAt": 1760000000,
      "data": { /* kind-specific payload, table-row shaped */ } }
  ]
}
```

Size target: ≤ 256 KB plaintext per segment → a few KB to ~0.003 SPACE per
segment at 1 sat/byte. Segments above 5 MiB must not occur (that is the
`/file` direct-upload ceiling; MetaFS chunking is intentionally avoided for
backup because its reads depend on centralized acceleration).

### 6.2 Manifest pin — `/protocols/metabot-backup/manifest`

One per Bot, re-published (`operation: modify` supersede chain) on every
backup run. This is the only pin restore needs to find per Bot.

```jsonc
{
  "version": 1,
  "bot": "<botGlobalMetaId>",
  "botName": "...",
  "updatedAt": 1760000000,
  "keyCustody": "envelope" | "derived",
  "derivedIndex": null,                 // scheme B index when applicable
  "segments": [
    { "pinId": "...", "segment": "<sha256>", "bytes": 12345,
      "kinds": ["memory", "dream_daily"], "objectIds": ["<sha256>", ...] }
  ],
  "conversationWindow": { "from": 1757000000, "to": 1760000000 },
  "stats": { "objects": 1234, "plaintextBytes": 2345678 }
}
```

The manifest itself is **public** (no secrets: only hashes, pinIds, sizes) —
mirroring the `/info/bots` discovery philosophy. All sensitive bytes live
inside encrypted object pins.

### 6.3 Incremental semantics

- Every backup run extracts the whitelist rows, computes object ids, and
  uploads **only objects not already listed in the current manifest**.
- Unchanged objects are re-referenced from their old segments — nothing is
  re-uploaded.
- The 60-day conversation window rolls forward; objects that fall out of the
  window are simply dropped from the next manifest (chain data is immutable
  and stays, which is fine and even desirable for "immortality" — the manifest
  just stops advertising them).
- **Checkpoint rule**: when a manifest's referenced segment count exceeds a
  threshold (e.g. 200) or total bytes double since the last checkpoint, the
  next run re-packs the live set into fresh full segments (a new baseline), so
  restore read amplification stays bounded.

### 6.4 Durable resume and idempotent publication

- `chain_backup_runs` records an active plan, its stable `planHash`, progress,
  manifest target/hash, attempts, and terminal state. `chain_backup_segment_uploads`
  records each segment's `pending` / `uploading` / `published` state, pin ID,
  attempt count, and error. Both are created idempotently on first backup use;
  existing user databases are never reset.
- A deterministic `segmentKey` identifies the same logical segment independent
  of run timestamps. Resumed runs keep their original `createdAt` and manifest
  `updatedAt`, so hashes are stable across process restarts. Changed source data
  starts a new plan without invalidating reusable published segments.
- Every upload state transition is saved immediately, not only after the whole
  Bot completes. Before any retry with prior attempts, the publisher reconciles
  by `segmentKey` (or legacy segment hash) and adopts an already accepted pin.
  A second reconciliation with backoff is required before republishing a miss,
  so an indexer that merely lags the chain is not treated as proof of absence.
  A network read failure is never treated as proof that a new pin is needed.
- Manifest writes use a deterministic content hash. A retry adopts the current
  head when its content already matches; otherwise it advances the modify
  target to the actual head rather than forking the revision chain.
- Transient transport/rate-limit/server errors use bounded exponential backoff
  with jitter. Exhaustion returns a resumable paused result, not an unrecoverable
  failure. Permanent input, identity, permission, and funding errors do not
  retry. The next click on the same backup button resumes pending plans.

### 6.5 Oversized objects

Objects that cannot fit the 256 KiB plaintext segment budget, including its
framing allowance, are split into deterministic indexed `object_chunk` records.
The manifest carries both original and chunk IDs. Restore reassembles chunks in
order, verifies the original object hash, and only then selects latest versions
and imports rows. This preserves byte-for-byte content and incremental dedup.

## 7. Backup flow

1. User panel button **"一键备份 / Backup to chain"** (plus an opt-in nightly
   auto-backup right after the dream window, reusing the hygiene scheduler's
   time slot discipline).
2. **Refresh the public `/info/bots` discovery manifest first** (reusing
   `syncUserBotsToMobile`): without it a new device cannot find the per-Bot
   backup manifests at restore time. Object publication may continue so the
   run can be inspected or retried, but a discovery-refresh failure marks the
   overall backup unsuccessful; it is never presented as a completed backup.
3. Pre-flight: identity present, subsidy/fee mode per global setting
   (decision 4), indexer reachable.
4. For every non-`welcome` Bot, including disabled Bots: extract whitelist rows
   → build objects → diff against the local journal (`chain_backup_state`) →
   create/resume a durable run → pack/chunk segments by UTF-8 byte size →
   reconcile before each attempted pin → publish and checkpoint each segment
   (published by each Bot's own wallet, serialized through the existing spend
   coordinator) → reconcile/publish manifest. Disabled state is preserved in
   the encrypted Bot profile and the public discovery entry.
5. Progress + cost report in the UI (new objects/segments, resumed segments,
  network retries, bytes, and SPACE spent); paused runs offer Continue Backup.

## 8. Restore flow (new device / cloud)

1. Import user mnemonic → identity restored (existing
   `userIdentityService.restore`).
2. Read `/info/bots` through the production address-scoped endpoint
   (`/api/address/pin/list/{mvcAddress}?path=...`) → Bot list. A bounded global
   path scan remains only as a legacy fallback; the unavailable
   `/api/metaid/pin/list/{globalMetaId}` route is not used.
3. For each Bot: list its manifest by MVC address, follow `modify_history` to
   the head revision → fetch object pins → decrypt with the re-derived backup
   key → verify Bot identity, segment hashes, and object hashes. The head pin ID
   is retained in the restored journal so the next backup cannot fork history.
4. Bot identity: scheme-B Bots re-derived from the mnemonic; scheme-A Bots via
   their decrypted envelope mnemonic. New backups supply the encrypted Bot
   profile directly, so skeleton restoration does not depend on a separate
   `/info/name` lookup; old backups keep the chain-profile fallback. All local
   Bot IDs are mapped before boss/worker references and the original Twin are
   finalized.
5. Whitelist importers write L0/L1/L2 rows into `idbots.sqlite`
   (idempotent upserts keyed by object id / natural keys; memory rows keep
   `fingerprint` dedup). Conversation sessions and individual messages are
   separate objects to bound segment size. Import errors fail the affected Bot,
   and imported rows plus the journal are saved after every Bot and at the end.
6. Chain-native data self-heals: private/group chat backfill services,
   MetaTask replay (`metatask/collector.ts`), service-order anchors. The
   scheduler is rescheduled and skill/quota consumers are notified after restore.
7. **V3, planned**: re-fetch MetaWeb-sourced KB docs from chain, restore opt-in
   Web2 docs from MetaFile, then full relearn rebuilds `kb.sqlite`
   (deterministic, no LLM).
8. First dream on the new device resumes the nightly cycle; `self_identity`
   continues from the restored row (dream only overwrites with newer dates, so
   a stale local row can never clobber a newer restored one).

## 9. Cost model (dev machine, 20 Bots, 1 sat/byte)

| Scenario | Bytes (encrypted) | Cost |
|---|---|---|
| First full L0+L1 | ~25 MB | ~0.26 SPACE |
| First full L0+L1+L2 (60-day conversations) | ~50–100 MB | ~0.5–1 SPACE |
| Daily incremental (memories + diary) | KBs | <0.001 SPACE/day |
| Yearly steady state | ~10 MB/year | ~0.1 SPACE/year |

## 10. Security notes

- Whitelist extraction only; secrets in §4 stay off-chain. The backup key is
  never stored — re-derived from the mnemonic per session.
- `visibility` on `user_memories` (`local_only` / `external_safe`) is **not**
  used as an upload filter: backup is encrypted-to-self, so `local_only` rows
  are still backed up (they must be — they are the soul). The flag keeps its
  original meaning (prompt/injection scope).
- Group-chat "AES" is public-key-in-the-clear obfuscation; never reuse it here.
- Manifest leaks metadata only (object counts, sizes, cadence). Acceptable.
- Mnemonic compromise = full backup compromise. Documented; accepted per
  decision 3.

## 11. Phasing

- **MVP, implemented**: L0 + L3 envelope (scheme A) + manifest/object protocol
  + restore importer + one-click button.
- **V2 data coverage and reliability, implemented**: Bot profiles/settings/
  capabilities, L1 continuity, L2 rolling 60-day conversations, disabled-Bot
  preservation, cross-device incremental identity, durable restore, resumable
  idempotent backup, and oversized-object chunking. Nightly automatic
  incremental backup and checkpoint re-packing remain future work.
- **V3**: scheme-B derived Bot wallets for new Bots, KB raw opt-in upload,
  cloud-version restore (no userData — consumes chain state only), user-
  selectable indexers.

## 12. Open questions

- Segment size target (256 KB, measured in UTF-8 bytes) vs pin-count trade-off
  — continue validating against production indexer fetch limits.
- Whether restore should auto-run on first launch after mnemonic import, or
  stay an explicit user action per Bot.
- Cloud version's write path: who pays for backups when there is no local
  wallet UX (still the user identity, but UX needs design).
