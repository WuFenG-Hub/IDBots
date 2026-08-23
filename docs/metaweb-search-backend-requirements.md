# Backend Requirements — MetaWeb Unified Search and Pin Read (metaso-p2p)

## Status

Draft v0.1 for backend development, 2026-08-22. Requested by the IDBots team as the blocking dependency of roadmap milestone M1 (`docs/metaweb-learning-roadmap.md`). Target project: `metaso-p2p` (Go + Gin + PebbleDB, deployed as `https://so.metaid.io`).

This document is a requirements contract, not an implementation spec. Per project convention, the backend team should turn R1–R3 into `docs/specs/` contract docs in metaso-p2p before implementation.

## 1. Background and goal

IDBots is building "bots learn from MetaWeb": a bot issues keyword searches across all knowledge-bearing MetaWeb content, gets back 5–10 candidates with title/summary/pinId, then opens chosen pins for full content — mirroring how a human uses a search engine. Today metaso-p2p only offers per-protocol keyword search (`/api/social/feed`, `/api/metaapp/list`, `/api/bot-hub/skill-service/list`, `/api/metaid/list`) with substring matching, no cross-protocol search, no generic pin-content endpoint, and no SimpleNote indexing.

Goal: three new read-only capabilities — **R1 unified cross-protocol search**, **R2 SimpleNote indexing**, **R3 generic pin read by pinId** — following the existing `internal/aggregator/botsearch` composition pattern, envelope/cursor/error conventions, and no-auth model.

Non-goals (explicitly out of scope for this round): semantic/vector search; searching encrypted group/private chat bodies; write APIs; authentication/rate limiting; reputation-based ranking (roadmap M5).

## 2. R1 — Unified cross-protocol search

`GET /api/metaweb/search` (final path naming is the backend team's call; `/api/knowledge/search` is an acceptable alternative).

### Request parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | required | Keyword query; CJK-aware tokenization as in `botsearch` |
| `protocols` | CSV string | all indexed | Filter by protocol key, e.g. `simplenote,simplebuzz` |
| `publisher` | string | — | Filter by globalMetaId / metaid |
| `since`, `until` | unix seconds | — | Created-at window |
| `sort` | `relevance` \| `newest` | `relevance` | `newest` = createdAt desc |
| `size` | int | 10 | Max 50 |
| `cursor` | string | — | Opaque, base64url(JSON) per existing convention |

### Response

Standard envelope `{code, data, message, processingTime}` with `data = {items, nextCursor, hasMore}`. Each item:

```json
{
  "protocol": "simplenote",
  "pinId": "<txid>i0",
  "currentPinId": "<txid>i0",
  "chainName": "mvc",
  "title": "IDBots Beginner Tutorial",
  "summary": "One-line abstract of the article…",
  "tags": ["idbots", "tutorial", "zh"],
  "publisher": { "globalMetaId": "…", "metaid": "…", "name": "…", "avatar": "metafile://…" },
  "createdAt": 1755000000,
  "score": 12.5,
  "links": { "pin": "/api/metaweb/pin/<pinId>" },
  "extra": { }
}
```

`extra` carries protocol-specific highlights (e.g. MetaApp `runtime`, skill-service `price/currency`, metabot-skill `version`); may be empty.

### Coverage

- **Phase 1 (M1 blocker)**: `/protocols/simplenote`, `/protocols/simplebuzz`, `/protocols/metaapp`, `/protocols/metabot-skill`, `/protocols/skill-service`, `/protocols/metaprotocol`.
- **Phase 2 (can lag M1)**: `/file/remote-skill` and other markdown `/file` pins, `/protocols/loom-task`, `/protocols/skill-service-rate` (as experience signals).

### Title/summary extraction rules (server-side projection)

| Protocol | title | summary | tags |
|---|---|---|---|
| simplenote | `title` | `subtitle`, else first ~200 chars of markdown-stripped `content` | `tags` |
| simplebuzz | first line/heading, ≤60 chars | first ~200 chars of body | `[]` |
| metaapp | `appName` \|\| `title` | `intro` | `tags` |
| metabot-skill | `name` | `description` | `[]` |
| skill-service | `displayName` \|\| `serviceName` | `description` | `providerSkill` |
| metaprotocol | `title` \|\| `protocolName` | `intro` | `[]` |

Whether summaries are derived at index time or query time is the backend team's choice (see open questions).

### Ranking

Relevance = weighted field match (suggested: title 5 / tags 3 / summary 2 / content 1) with CJK-aware tokenization and exact-phrase boost, following the `botsearch` scorer. Recency as tiebreaker for `relevance`; `newest` bypasses scoring. If corpus size makes substring scans too slow, build an inverted index in a dedicated Pebble namespace — that decision and its trigger threshold belong to the backend team.

## 3. R2 — SimpleNote indexing

- Parse and store `/protocols/simplenote` pins (create + modify/revoke semantics, `currentPinId` chains) so they are searchable in R1 and fetchable in R3. Natural home: extend `internal/aggregator/publishedcontent` (already handles `/protocols/simplebuzz`, `/protocols/metaapp`, `/protocols/metabot-skill`) or a sibling namespace.
- Historical backfill via MANAPI, following the existing `cmd/metaso-p2p-*-backfill` pattern, with a completion report (counts per chain).
- Keep `pin/path/list`-style raw access unnecessary for clients — R1/R3 must fully cover SimpleNote.

## 4. R3 — Generic pin read by pinId

`GET /api/metaweb/pin/:pinId`

The caller does **not** know the pin's protocol in advance — the server dispatches across namespaces (buzz, metaapp, skill-service, simplenote, metabot-skill, metaprotocol, …) and falls back to MANAPI passthrough when the pin is not locally indexed (acceptable for phase 1; note it in the response via a `source` field).

Response item:

```json
{
  "pinId": "<txid>i0",
  "currentPinId": "<txid>i0",
  "protocol": "simplenote",
  "path": "/protocols/simplenote",
  "chainName": "mvc",
  "operation": "create",
  "creator": { "globalMetaId": "…", "metaid": "…", "name": "…" },
  "createdAt": 1755000000,
  "contentType": "application/json",
  "payload": { },
  "text": "Normalized plain text / markdown body for LLM consumption",
  "meta": { "title": "…", "summary": "…", "tags": [] },
  "attachments": [
    { "uri": "metafile://<pinId>.png", "url": "https://file.metaid.io/…", "contentType": "image/png", "size": 12345 }
  ],
  "source": "local"
}
```

Requirements:

- `text` is the LLM-ready normalized body (JSON payloads unwrapped to their content field; markdown passed through). Very long bodies may be truncated server-side with a `truncated: true` flag plus total length; IDBots handles continuation policy client-side.
- `attachments[]` resolves `metafile://` references to absolute fetchable URLs server-side (via the `file.metaid.io/metafile-indexer` bases), so clients never resolve metafile URIs themselves.
- Unknown pinId → `code=40400`. Encrypted/empty content → `payload/text: null` with no error, so the bot can skip gracefully.
- `meta` uses the same extraction rules as R1 so list and detail views agree.

## 5. Non-functional requirements

- **Conventions**: `{code,data,message,processingTime}` envelope (HTTP 200 always); list shape `{items, nextCursor, hasMore}`; opaque base64url(JSON) cursors; error codes `40000` bad param/cursor, `40400` not found, `50000` aggregation unavailable; no auth, permissive CORS — all as already established in `internal/api/`.
- **Performance**: search p95 < 500 ms and pin read p95 < 300 ms at the current corpus (order of 10⁵–10⁶ pins per protocol); state actual measured numbers in the spec doc.
- **Freshness**: new pins searchable within one confirmed block + mempool relay; backfill completeness reported per chain.
- **Observability**: `processingTime` populated; slow-query logging for the search endpoint.

## 6. Deliverables (backend team)

1. `docs/specs/` contract docs for the three capabilities (request/response schemas, error cases, example payloads) — spec-first per project convention.
2. Implementation + unit tests; backfill commands for SimpleNote (and any newly covered protocol).
3. Staging deployment with seeded example queries IDBots can develop against, then production rollout notice.

## 7. Open questions for the backend team

- Inverted index now vs later: is substring scoring acceptable at the projected 12-month corpus size, and what metric triggers building the index?
- Summary derivation at index time (storage cost, consistent) vs query time (flexible, CPU cost)?
- Should `/api/metaweb/search` eventually fold into or replace the per-protocol list endpoints' keyword params, or stay a parallel surface? (IDBots keeps using the per-protocol endpoints for its specialized UIs either way.)
- Any objection to the `/api/metaweb/*` path family naming?
- Do `metaprotocol` pins need special handling (their payload describes other protocols; keep in phase 1 or defer)?
