---
name: metabot-browser-open
description: Use when a human asks to open, show, display, navigate, or control IDBots Bot Browser, including opening Browser URIs, opening targets in a new tab, listing/switching/closing tabs, and reading the active tab URI.
---

# Bot Browser Open

Open or control the existing IDBots top Bot Browser. Do not use this skill for search, discovery, MetaApp authoring, or ordinary web URLs.

## Route Target

Use `scripts/index.js` for deterministic target parsing and Browser opening. The script normalizes:

- `metaapp://<pinId>` as a MetaApp URI.
- `pin://<pinId>` as a chain pin URI.
- `metafile://<pinId-or-path>` as a MetaFile URI.
- `map://...` as a MAP protocol URI.
- `metaid://<globalMetaId-or-domain>` as a Bot page/homepage URI.
- Bare `64 hex + i0` values as `pin://<pinId>`.
- Bare GlobalMetaID values such as `idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz` as `metaid://<globalMetaId>`.
- ENS-style Web3 domains such as `sunnyfung.eth` as `metaid://sunnyfung.eth`.

## Command

Run from this skill directory after reading this file:

```bash
node scripts/index.js --target "<user request or target>"
```

The default action navigates the active tab. Use explicit tab actions when the
request refers to Browser tabs:

```bash
node scripts/index.js --action open-tab --target "metaid://idq1alice"
node scripts/index.js --action open-tab
node scripts/index.js --action get-active-tab
node scripts/index.js --action get-tabs
node scripts/index.js --action switch-tab --tab-id 2
node scripts/index.js --action close-tab --tab-id 2
```

Supported actions are `open`, `open-tab`, `get-active-tab`, `get-tabs`,
`switch-tab`, and `close-tab`. The script also recognizes direct natural-language
phrases such as `新 tab 打开 <URI>` and `当前 tab 的 URI 是什么`, but prefer the
explicit `--action` form after interpreting the user's intent.

Examples:

```bash
node scripts/index.js --target "打开 metaapp://6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0"
node scripts/index.js --target "显示6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0"
node scripts/index.js --target "打开 idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz 的主页"
node scripts/index.js --target "跳转到 sunnyfung.eth"
node scripts/index.js --target "打开 metafile://6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0"
node scripts/index.js --target "map://simplebuzz/pin/6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0"
```

For programmatic calls, pass JSON:

```bash
node scripts/index.js --payload '{"target":"sunnyfung.eth"}'
node scripts/index.js --payload '{"uri":"metaapp://6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0"}'
node scripts/index.js --payload '{"uri":"metafile://6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0"}'
node scripts/index.js --payload '{"action":"open-tab","uri":"metaid://idq1alice"}'
node scripts/index.js --payload '{"action":"get-active-tab"}'
node scripts/index.js --payload '{"action":"switch-tab","tabId":2}'
```

The script calls `IDBOTS_RPC_URL` when set, otherwise `http://127.0.0.1:31200`.
Active-tab navigation uses `POST /api/idbots/bot-browser/open`; tab operations
use the local host bridge at `POST /api/idbots/bot-browser/tabs`. Tab state still
lives only inside ABC's client runtime and is not persisted by the RPC layer.

## Rules

- If the user provided a full supported URI, including `metafile://...`, open that URI directly.
- If the user explicitly asks for a new tab, use `open-tab`; do not replace the active tab.
- If the user asks for the current tab URI, use `get-active-tab` and return `activeTab.uri` exactly, including `null` for an empty tab.
- Use `get-tabs` before `switch-tab` or `close-tab` when the user did not provide a numeric tab id.
- Treat tab ids as opaque session-level numbers. Do not assume they survive an app/browser reload.
- If the user provided only a bare pinId, open it as `pin://<pinId>` unless the user explicitly supplied a `metaapp://` URI.
- If the user provided a GlobalMetaID or `.eth` name, open it as `metaid://...`.
- If the target is missing or looks like an ordinary web URL such as `https://...`, do not guess. Ask for a supported Browser URI, GlobalMetaID, pinId, or Web3 domain.
- Return the normalized URI and report that IDBots Bot Browser was requested to open it.
