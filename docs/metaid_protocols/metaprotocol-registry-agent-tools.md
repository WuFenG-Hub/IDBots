# MetaID Protocols: Metaprotocol Registry Agent Tools

**Scope**: Built-in Cowork agent tools for the MetaID protocol registry (`/protocols/metaprotocol`) — the on-chain catalog where every public MetaID protocol is registered. Two tools: the read-only `metaprotocol_registry` and the writer `post_metaprotocol`. They give any cowork session's Agent native access to the registry without a UI: browse the authoritative catalog, read a protocol's full latest-version definition, list its version history, publish a new protocol, and publish a new version of an existing one.

**Source of truth**: The product requirements live in `protocol-registry-docs/01-IDBots-需求-metaprotocol内置工具.md` (IDBots side) and the mirrored MetaSo spec §5 (registry projection). The tools write pins **isomorphic with the human protocol square** (MetaWeb.world / MetaProtocolSquare MetaApp): same 7-tuple, same body fields, same JSON5 serialization — registrations published by humans and Agents are mutually visible and editable.

**Version rule**: The MetaID 7-tuple `version` field carries protocol-level semantics: `1.0.0` for the outer create pin, and for modify pins the body version of the version being replaced (aligned with the human square's EditProtocolModal). The payload's own `version` field is the human-readable protocol version (`1.0.9` → `1.1.0` auto-increment on update).

## 1. Tool 1: `metaprotocol_registry` (read-only)

- **Actions**: `list` (enumerate registered protocols: current version, path, title, intro, publisher; keyword filter + cursor pagination), `read` (one protocol's full authoritative latest-version body, `protocolContent` JSON5 verbatim), `versions` (full version history: pinId, version, timestamp, author).
- **Resolution order** (read/versions): `protocolPath` → `protocolName` (exact display-name match; multiple hits list candidates for the model to disambiguate) → `pinId` (any pinId in the version chain).
- **Trust posture**: `protocolContent` is wrapped in `<metaweb_protocol_content>` and marked as untrusted on-chain data (same convention as `read_metaweb_pin`). Every deep `read` is recorded in the chain-read ledger (`metabot_chain_reads`).
- **Degraded fallback**: when the MetaSo projection is unreachable, the tool degrades to a read-only MANAPI scan (`GET https://manapi.metaid.io/pin/path/list?path=/protocols/metaprotocol`, payload parsed client-side from `contentSummary`); the output's first line is `(degraded: registry fallback)`. Degraded `versions` resolves the source pin's `modify_history` from MANAPI.
- **Allowlist**: registered on every cowork surface; additionally allowlisted for unattended study / qa-surf / surf sessions (read-only, no fees).

## 2. Tool 2: `post_metaprotocol` (write)

- **Actions**: `publish` (register a NEW protocol under `/protocols/<protocolName-lowercase>`), `update` (publish a new version of an existing protocol; only the original registrant may update).
- **Gate order** (spec §5.4):
  1. Acting MetaBot must be selected (no wallet/identity otherwise).
  2. Payload validated against the metaprotocol draft-07 schema **before anything reaches the wallet** — `body` and `protocolContent` are mutually exclusive (exactly one required).
  3. MetaSo precheck: `GET /api/metaweb/protocols/check` for publish (path occupancy; unconfirmed mempool registrations count as occupied); `GET /api/metaweb/protocols/detail` for update (target resolution). MetaSo failure degrades to the MANAPI scan; **both down → the write is refused** (`Protocol registry check is unavailable (registry and fallback both failed). Refusing to publish to avoid duplicate registration — try again later.`).
  4. Conflict / authorization: an occupied path returns the current registrant info (name, first-registration date, current version, `pin://` link) and **never writes**; a non-registrant update is refused with the registrant's name and the acting bot's name and **never writes**.
  5. Pass → `createPin` with the local MetaBot wallet (`origin: 'tool:post_metaprotocol'`).
- **Identity cascade** (update authorization): the acting MetaBot's identity is compared against `record.author` at the highest layer where both sides are non-empty — `globalMetaId → metaId → address`.
- **Receipt**: `Protocol published/updated: pin://<pinId> (tx <txid>)` + cost / fee-assist lines + `The indexer may take ~1 minute to confirm; verify with metaprotocol_registry (action "read").`
- **Allowlist**: NOT allowlisted for any unattended session — it registers only where a chain-write control exists.

## 3. On-chain pin construction

Publish (create) and update (modify) share the human square's body JSON:

| Field | Value |
|---|---|
| `title` | tool param `title` |
| `path` | publish: `/protocols/${protocolName.toLowerCase()}`; update: the registered path |
| `version` | publish: param (default `1.0.0`); update: param or auto-incremented |
| `authors` | acting MetaBot display name (metaId prefix fallback) |
| `intro` | param (may be empty) |
| `protocolName` | param |
| `protocolAttachments` | param (default `[]`) |
| `metadata` | param (default `''`; strings are `JSON.parse`-ed when possible) |
| `protocolContent` | JSON5 serialization of `body`, or the raw `protocolContent` param |
| `protocolContentType` | param (default `application/json`) |

**Body → JSON5** (human square semantics): a field shaped `{value, description}` emits a `/** description */` comment line (1-space base indent, the on-chain convention) followed by the unwrapped value; plain values serialize directly; nested objects/arrays use 2-space-per-level multiline JSON.

**Version auto-increment** (update, version omitted): `patch+1`; patch ≥ 10 rolls to 0 and bumps minor; minor ≥ 10 rolls to 0 and bumps major (`1.0.9 → 1.1.0`, `1.9.9 → 2.0.0`).

**7-tuple**:

| | publish | update |
|---|---|---|
| `operation` | `create` | `modify` |
| `path` | `/protocols/metaprotocol` | `@<source pinId>` |
| `contentType` | `application/json` | `application/json` |
| `encoding` | `utf-8` | `utf-8` |
| `encryption` | `0` | `0` |
| outer `version` | `1.0.0` | body version of the version being replaced |
| payload | body JSON above | body JSON above (`version` = new version) |

## 4. MetaSo API contract (§3 mirror)

Base URL `https://so.metaid.io` (overridable via `IDBOTS_METAWEB_API_BASE_URL`). Envelope `{code, data, message}` with HTTP always 200; business error codes `40000 / 40400 / 50000`.

- `GET /api/metaweb/protocols` — registry list (v2): `q` / `publisher` / `path` / `includeConflicts` / `size` (1–100) / `cursor`; `createdAt` desc.
- `GET /api/metaweb/protocols/check?path=…` — precheck; `path` must match `^/protocols/[a-z0-9_]+(/[a-z0-9_]+)*$`; `available=true` ⇒ `existing=null`; unconfirmed registrations count as occupied.
- `GET /api/metaweb/protocols/detail?path=…` or `?pinId=…` — record (with payload) + versions (oldest → newest, `chain`/`local` attribution) + conflicts/invalidModifies.
- `GET /api/metaweb/pin/:pinId/versions` — modify-chain versions.

The thin client lives in `src/main/services/metaProtocolService.ts`; the tools in `src/main/libs/metaProtocolAgentTools.ts`; wiring in `src/main/libs/coworkRunner.ts` + `src/main/main.ts`. Tests: `tests/metaProtocolAgentTools.test.mjs` (`npm run test:metaprotocol`).

**Out of scope**: ownership transfer / revoke, registry folding logic client-side (the MetaSo projection is the single authority), changes to the human protocol square MetaApp.
