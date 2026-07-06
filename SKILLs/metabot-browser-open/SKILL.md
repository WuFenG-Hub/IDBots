---
name: metabot-browser-open
description: Use when a human asks to open, show, display, or navigate IDBots Bot Browser to a Browser URI or known Web3 target, including metaapp://, pin://, metafile://, map://, metaid://, bare GlobalMetaID, bare 64hex+i0 pinId, and ENS-style .eth domains.
---

# Bot Browser Open

Open the existing IDBots top Bot Browser with a known Browser target. Do not use this skill for search, discovery, MetaApp authoring, or ordinary web URLs.

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
```

The script calls `IDBOTS_RPC_URL` when set, otherwise `http://127.0.0.1:31200`, using `POST /api/idbots/bot-browser/open`.

## Rules

- If the user provided a full supported URI, including `metafile://...`, open that URI directly.
- If the user provided only a bare pinId, open it as `pin://<pinId>` unless the user explicitly supplied a `metaapp://` URI.
- If the user provided a GlobalMetaID or `.eth` name, open it as `metaid://...`.
- If the target is missing or looks like an ordinary web URL such as `https://...`, do not guess. Ask for a supported Browser URI, GlobalMetaID, pinId, or Web3 domain.
- Return the normalized URI and report that IDBots Bot Browser was requested to open it.
