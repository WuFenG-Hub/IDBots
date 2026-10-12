# OAC Requirements: Import IDBots Chain Backups

Date: 2026-10-11
Audience: OAC development agent / maintainers
Author side: IDBots (`feat/chain-backup-mvp`, design: `docs/design/2026-10-10-chain-backup-restore-design.md`)

## 1. Goal

A user who backed up their Bot fleet to chain from IDBots can migrate into OAC
with nothing but their **owner mnemonic**:

```
metabot user import --mnemonic-stdin      # already exists
metabot user restore-from-chain           # NEW — this document
```

The new command (name is a suggestion) discovers every Bot owned by the
imported identity, decrypts their on-chain backups, recreates each Bot profile
(including its wallet), and imports the Bot's soul data (memories,
self-identity, dream diaries, distilled knowledge) into OAC's file-based
profile layout. The flow is **import-only**: OAC does not need to implement
backup publishing.

## 2. Format guarantee

The on-chain backup format is **platform-independent by design**: encrypted
JSON over MetaID pins. No SQLite, no IDBots runtime dependency. Anything that
can (a) read MANAPI indexers, (b) derive a key from a BIP39 mnemonic, and
(c) do AES-256-GCM can restore it. OAC already has all three primitives in
its dependency tree — **zero new dependencies are required**.

One honest caveat: the object payloads mirror IDBots' table-column naming
(snake_case). The transport is neutral; the schema is IDBots-shaped, so the
importer owns a small field-mapping layer (§6).

## 3. Crypto spec (must match bit-for-bit)

```
seed      = bip39.mnemonicToSeedSync(ownerMnemonic.trim().toLowerCase().replace(/\s+/g, ' '))
backupKey = HKDF-SHA256(ikm = seed,
                        salt = "idbots-backup-v1" + ownerGlobalMetaId,   // no separator
                        info = "backup-key",
                        len  = 32)
cipher    = AES-256-GCM, random 12-byte nonce per object
wire      = nonce(12) || tag(16) || ciphertext
```

- `ownerGlobalMetaId` is derived from the owner mnemonic
  (`m/44'/10001'/0'/0/0` → MVC address → `convertToGlobalMetaId`). OAC's
  `src/core/identity/deriveIdentity.ts` produces the identical value; **verify
  it matches the imported owner identity before attempting decryption**, and
  fail with a clear error otherwise.
- Available primitives in OAC today: `@scure/bip39` (`mnemonicToSeedSync`),
  `node:crypto` (`hkdfSync`, `createDecipheriv`, `createHash`).
- Object id: `sha256(canonicalJSON)` where canonicalJSON = JSON.stringify with
  object keys sorted recursively and `undefined` fields dropped. Segments must
  be hash-verified after decryption (`sha256(plaintext) === manifest segment
  hash`).

## 4. On-chain layout

### 4.1 Discovery: `/info/bots` (existing protocol)

Published by the owner identity. Find the owner's newest pin at path
`/info/bots` (`GET manapi/api/pin/path/list?path=/info/bots`, filter
`address === ownerMvcAddress`, newest first), then fetch
`GET manapi/content/{pinId}` and parse:

```jsonc
{
  "version": 1,
  "updatedAt": 1760000000,
  "bots": [
    { "globalMetaId": "idq…", "name": "…", "type": "twin|worker",
      "role": "…", "mvcAddress": "…", "chatPublicKey": "…",
      "ownerBindingPinId": "…" }
  ]
}
```

### 4.2 Per-Bot manifest: `/protocols/metabot-backup/manifest`

Published by **each Bot's own MetaID**. Query
`GET manapi/api/metaid/pin/list/{botGlobalMetaId}?path=/protocols/metabot-backup/manifest`
(newest first; take the first entry whose content parses — older entries are
superseded versions). Public, no secrets:

```jsonc
{
  "version": 1,
  "bot": "<botGlobalMetaId>",
  "botName": "…",
  "keyCustody": "envelope",
  "updatedAt": 1760000000,
  "segments": [
    { "pinId": "…i0", "segment": "<sha256-of-plaintext>", "bytes": 12345,
      "kinds": ["memory", "dream_daily"], "objectIds": ["<sha256>", …] }
  ],
  "stats": { "objects": 123, "bytes": 234567 }
}
```

### 4.3 Segments: `/protocols/metabot-backup/object`

Each manifest segment pin's content is a JSON envelope:

```jsonc
{
  "version": 1,
  "bot": "<botGlobalMetaId>",
  "segment": "<sha256-of-plaintext>",
  "cipher": "aes-256-gcm",
  "kdf": "hkdf-sha256:user-globalmetaid",
  "payload": "<base64 nonce||tag||ciphertext>"
}
```

Reject anything where `cipher`/`kdf` differ (forward-compat hook). Decrypted
plaintext:

```jsonc
{
  "version": 1,
  "bot": "<botGlobalMetaId>",
  "createdAt": 1760000000,
  "objects": [ { "id": "<sha256>", "kind": "…", "data": { … } }, … ]
}
```

### 4.4 Object kinds and payload schemas (MVP)

`data` mirrors the IDBots source-table row verbatim (snake_case columns).

| kind | source table | notable columns |
|---|---|---|
| `memory` | `user_memories` | `id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at, last_used_at, archived_at`, plus embedded `sources: [{ memory_id, source_type, dream_date, source_id, … }]` |
| `dream_daily` | `metabot_daily_summaries` | `id, summary_date, summary_text, sections_json, stats_json, session_refs_json, llm_id, created_at, updated_at` |
| `dream_weekly` | `metabot_weekly_summaries` | `id, week_start, week_end, summary_text, patterns_json, llm_id, …` |
| `knowledge` | `metaid_knowledge_entries` | `id, topic, topic_fingerprint, summary, kind, category, tags_json, confidence, status, origin, source_dream_date, version, …`, plus embedded `revisions: [{ version, summary, kind, origin, source_dream_date, created_at, … }]` |
| `knowledge_procedure` | `metaid_knowledge_procedures` | `id, title, title_fingerprint, trigger_text, steps_json, pitfalls_json, confidence, status, origin, use_count, …` |
| `key_envelope` | — | `{ mnemonic, path }` — the Bot's wallet mnemonic. **Never write to disk as plaintext data; feed only into the identity-restore step (§5.3).** |

`usage_class` enum: `profile_fact | preference | operational_preference |
self_identity | work_review | value_boundary`. `scope_kind`:
`owner | contact | conversation`. These match OAC's
`src/core/memory/memoryScope.ts` enums exactly (same lineage).

### 4.5 Semantics that matter

- **Latest manifest wins.** Never enumerate all historical object pins; old
  segments stay on-chain but are superseded.
- Object `id` is content-addressed; treat it as the idempotency key.
- `metabot_id` (integer) inside payloads is IDBots-local and **meaningless in
  OAC** — always drop/remap it.

## 5. Import flow requirements

### R1. Pre-flight

- Owner identity must already exist locally (`metabot user import` done).
- Verify derived `ownerGlobalMetaId` is non-empty; this is the HKDF salt
  component, so a mismatched owner can never decrypt — fail fast with a clear
  message.

### R2. Discovery

- Resolve `/info/bots` (§4.1). If absent: report "no bot list on-chain; run
  one-click sync/backup from IDBots first" and exit gracefully.
- For each entry: fetch the newest valid backup manifest (§4.2). Bots without
  a manifest are reported as `NO_BACKUP_MANIFEST` and skipped (not fatal).

### R3. Bot identity restore (currently missing in OAC)

- Find the `key_envelope` object in the decrypted segments; it carries the
  Bot's mnemonic.
- Derive the Bot wallet from it (`@metalet/utxo-wallet-service`, path from the
  envelope) and assert the derived `globalMetaId` equals the manifest's `bot`
  field — mismatch = corrupted/tampered backup, abort that Bot.
- Create the profile via the existing
  `createMetabotProfileFromIdentity(...)` seam **and persist the wallet** by
  writing `.runtime/identity-secrets.json` through
  `FileSecretStore.writeIdentitySecrets` (0600 perms). This is OAC's analogue
  of IDBots' `restoreMetaBotFromMnemonic`; today `metabot bot create` only
  generates fresh mnemonics, so this step is new code.
- If a profile with the same `globalMetaId` already exists locally, skip
  identity creation and import into the existing profile.

### R4. Data import (see mapping table §6)

- Idempotent by object id: keep a per-profile import journal (suggested:
  `.runtime/memory/backup-import.json` holding the set of imported object ids +
  the manifest pinId/updatedAt). Re-running the command must import nothing
  twice. The journal also gives OAC a "last chain backup seen" timestamp for
  status display.
- Respect OAC's store semantics: use the existing store APIs where they carry
  invariants (`memoryStore.createOrRevive` for fingerprint dedup/revive,
  `knowledgeStore.upsertKnowledge`), except where noted in §6 (self-identity
  needs the protected-write escape hatch; timestamps should be preserved from
  the payload rather than re-stamped).

### R5. Reporting

Per Bot: `restored | imported | skipped | error`. Exit non-zero only when
discovery itself fails; per-Bot failures are collected and reported.

## 6. Field mapping table (IDBots payload → OAC profile)

| Payload | OAC target | Mapping notes |
|---|---|---|
| `memory` (general) | `.runtime/memory/memories.json` (`MemoryEntry`) | snake→camel: `scope_kind→scopeKind`, `scope_key→scopeKey`, `usage_class→usageClass`, `is_explicit→isExplicit`, `last_used_at→lastUsedAt`, `archived_at→archivedAt`; `text` stays `text`; regenerate `id` as `mem_<uuid>`; keep `fingerprint` verbatim (dedup key); keep `origin`/`visibility`/`importance`/`confidence`; embedded `sources[]` map to `MemoryEntry.sources[]` with regenerated `src_<uuid>` ids |
| `memory` with `usage_class='self_identity'` | same, **plus** rebuild `memory/self-identity.md` from the newest such entry | Must go through the protected-write escape (`allowProtected`); OAC's UI must not treat the imported entry as user-editable |
| `dream_daily` | `.runtime/memory/dream-summaries.json` (`DailySummary`) + rebuild `memory/YYYY-MM-DD.md` mirror | `summary_date→date`, `summary_text→summaryText`, `sections_json`/`stats_json` parse to objects; keyed by `(date)` |
| `dream_weekly` | — | **No OAC counterpart.** Fold into nothing; report as `skipped (unsupported kind)`. Keep in journal so future OAC versions can pick it up |
| `knowledge` | `.runtime/memory/knowledge.json` | `topic_fingerprint→topicFingerprint`; **verify** against OAC's `sha256(normalizeTopicKey(topic))` — if it differs, recompute; `revisions[]` embed with regenerated `kr_<uuid>` ids; preserve `status`, `version`, `confidence`, `source_dream_date→sourceDreamDate` |
| `knowledge_procedure` | same store (procedures section) | `title_fingerprint→titleFingerprint`, parse `steps_json`/`pitfalls_json`; regenerate `id` |
| timestamps (`created_at` etc.) | camelCase equivalents | IDBots stores **milliseconds**; preserve values verbatim (decay/hygiene logic depends on them) |

Do **not** import: `metabot_id`, IDBots `id` values (regenerate), and never
persist the `key_envelope` payload anywhere except the secrets file.

## 7. Pitfalls (verified against current OAC code)

1. **`omniRead` truncates at 20,000 chars** (`OMNI_READ_MAX_RESULT_CHARS`) —
   segments target up to 256 KB. Fetch segment content via direct
   `GET manapi/content/{pinId}` or `metawebPinsBatch` (never truncated), not
   `omniRead pin_content`.
2. **Latest-manifest semantics** (§4.5): do not crawl historical object pins.
3. **Group-chat "AES" is not encryption** (key derivable from public groupId).
   Never reuse `src/core/appSession/groupChat.ts` crypto for this feature.
4. `metabot bot backup` is a mnemonic-only export — unrelated to this feature;
   do not extend it.
5. Manifest/manifest-pin reads should follow OAC's existing multi-gateway
   fallback pattern (local P2P → file.metaid.io → manapi) used in
   `src/daemon/routes/file.ts`.

## 8. Acceptance criteria

- [ ] Given only the owner mnemonic on a fresh OAC install, one command
      restores every Bot that has a chain backup: profile + wallet + memories
      + self-identity (incl. markdown mirror) + dream diaries + knowledge.
- [ ] Re-running the command imports zero new objects (journal idempotency).
- [ ] A Bot whose envelope-derived globalMetaId mismatches the manifest is
      aborted with a clear tamper error; other Bots continue.
- [ ] Wrong owner mnemonic fails at pre-flight with a clear error (not a
      decryption garbage dump).
- [ ] Unit tests: HKDF/AES round-trip against a known test vector produced by
      IDBots' `chainBackupCrypto` (vector below); mapping layer field tests;
      journal idempotency.
- [ ] No new runtime dependencies.

### Test vector (from IDBots `tests/chainBackupCrypto.test.mjs`)

```
mnemonic  = "legal winner thank year wave sausage worth useful legal winner thank yellow"
globalMetaId salt input = "idqtestglobalmetaid00000000000000000000001"
```
Deriving the key and round-tripping AES-256-GCM must succeed cross-repo; IDBots
can additionally publish a fixed `{ key, ciphertext }` fixture on request.

## 9. Out of scope (for this document)

- OAC-side backup publishing (IDBots owns the writer).
- Conversations (rolling 60-day window), impressions/episodes, schedules,
  KB raw documents — planned in IDBots V2; the format has room for new
  `kind` values, and unknown kinds must be skipped + reported, never fatal.

## 10. Coordination

The writer-side reference implementation lives in IDBots
(`src/main/services/chainBackup{Crypto,Data,Service,RestoreService}.ts` on
`feat/chain-backup-mvp`). Any schema change will bump `version` in both the
envelope and the manifest; importers should reject unknown `version > 1` with
a clear "upgrade OAC" message rather than guessing.
