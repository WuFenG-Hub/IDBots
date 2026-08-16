# IDBots Performance & Security Review

- **Date**: 2026-08-16
- **Branch**: `perf/performance-review` (worktree `.worktrees/performance-review`)
- **Base commit**: `b35a914d` (`main`, ahead 5 of `origin/main`)
- **Scope**: `src/main` (Electron main process + services/libs), `src/renderer` (React), `src/main/preload.ts`, `index.html`, `vite.config.ts`, dependency tree (`npm audit`)
- **Method**: static source review + dependency audit + build-output inspection. No code changes were made in this pass.
- **Goal**: identify performance and security issues that must be fixed **without changing system design/functionality**; produce an opinion report that can seed a later optimization-round implementation plan.

---

## 1. Executive summary

The app's Electron window hardening is already in good shape (context isolation, renderer sandbox, `nodeIntegration:false`, navigation/window-open allowlists) and the React renderer has **no** `dangerouslySetInnerHTML`/`innerHTML` sinks. The main release blockers are **security**, not performance:

1. **Critical — unauthenticated local wallet RPC server** (`127.0.0.1:31200`, `Access-Control-Allow-Origin: *`, no auth token, no origin check) exposed on every app start, including wallet transfer/signing/file-upload/group-task endpoints. Any webpage in any browser can drive the wallet and read data (classic localhost CSRF).
2. **Critical — dependency vulnerabilities**: `npm audit` reports 44 vulnerabilities (3 critical, 21 high), incl. `electron@40.2.1`, `adm-zip@0.5.16`, `elliptic`/`protobufjs`/`mvc-lib` critical chains.
3. **High — local OpenAI-compat proxy binds `0.0.0.0` with no auth** and forwards LLM calls using the user's API keys.
4. **High — no Content-Security-Policy** anywhere in the renderer HTML (defense-in-depth gap).
5. **High — MetaApp iframe sandbox relaxation** (`allow-same-origin` added to untrusted chain content, all MetaApps sharing one local-server origin → cross-app data leakage).
6. **High — wallet mnemonics stored in plaintext SQLite** (`metabot_wallets.mnemonic`).
7. **Medium — no IPC sender validation, `api:fetch`/`api:stream` are unrestricted http(s) proxies, hardcoded export password.**

Performance blockers are moderate and mostly localized:

1. **SQL.js fallback rewrites the entire DB file on every `set()`** (full export + atomic write, synchronous, on the main thread) — O(DB size) per write.
2. **Single 3 MB renderer bundle, no code splitting**; full-Prism `react-syntax-highlighter` and per-message `react-markdown` re-parsing in the chat view.
3. **Bot Browser runtime stays mounted (hidden) after first open** — ABC shell + bridge continue to consume CPU/memory while the user is in Cowork.
4. **`api:stream` forwards one IPC message per network chunk** (no batching).
5. Several main-process polling daemons (5–15 s intervals) — mostly guarded, but each tick still performs a DB query even when idle.

---

## 2. Security findings

### S1. CRITICAL — Unauthenticated local MetaID RPC server (wallet access, CSRF/SSRF)

- **Evidence**: `src/main/services/metaidRpcServer.ts`
  - Started on every app launch: `src/main/main.ts:13784` (`startMetaidRpcServer(...)`), no opt-in.
  - `Access-Control-Allow-Origin: *` + no auth/origin check: `metaidRpcServer.ts` (~line 230–243).
  - Endpoints (all POST, no authentication):
    - `/api/idbots/wallet/transfer` (line 785) → `executeTransfer` **signs and broadcasts** BTC/MVC/DOGE transfers directly from the wallet mnemonic (see `src/main/services/transferService.ts:687`).
    - `/api/idbots/wallet/btc/sign-message` (375), `/api/idbots/wallet/btc/sign-psbt` (420), `/api/idbots/wallet/mrc20/transfer` (495), `/api/idbots/wallet/mvc/build-transfer-rawtx` (922), `/api/idbots/wallet/mvc-ft/build-transfer-rawtx` (965), `/api/idbots/wallet/mvc/build-rawtx-bundle` (1033).
    - `/api/idbots/files/upload-largefile` (878) — arbitrary file upload to MetaWeb.
    - `/api/idbots/group-task/create|send|invite|kick|close|...` — drive group tasks.
    - `/api/idbots/metabot/homepage/set-metaapp` (292) — modify local Bot state.
    - `/api/idbots/metabot/account-summary` (670), `/api/idbots/address/balance` (695), `/api/idbots/group-task/list|show|export` (1281/1313/1889), `/api/idbots/list-metabots` (1924) — data reads.
- **Impact**: Any website the user visits in **any** browser can `fetch("http://127.0.0.1:31200/api/idbots/wallet/transfer", ...)` (ACAO `*` makes responses readable too). This can drain wallets (transfer/sign), exfiltrate balances/group-task data, upload files, and manipulate Bots — a critical release blocker.
- **Fix direction (no design change)**:
  - Generate a random per-launch bearer token; require `Authorization: Bearer <token>` on every endpoint.
  - Replace `Access-Control-Allow-Origin: *` with an explicit allowlist of app origins (dev server origin + `file://`/app origin) and reject requests whose `Origin` is not allowed; reject requests with no `Origin` header except from the app itself.
  - Keep binding to `127.0.0.1` only; add basic rate limiting.
  - Keep wallet operations behind the existing manual-confirmation path; read endpoints should also require the token.

### S2. CRITICAL — Dependency vulnerabilities (`npm audit`: 3 critical / 21 high / 18 moderate / 2 low)

- **Evidence**: `npm audit --omit=dev` on the lockfile. Highlights:
  - **Critical**: `elliptic` (ECDSA private-key extraction on malformed input; via `mvc-lib`), `protobufjs` (arbitrary code execution; ≤7.6.4), `mvc-lib`.
  - **High (direct)**: `electron@40.2.1` (AppleScript injection, context-isolation bypasses, use-after-free, protocol-handler header injection, etc.), `adm-zip@0.5.16` (crafted ZIP → 4 GB memory allocation), `@larksuiteoapi/node-sdk` (axios), `@opcat-labs/scrypt-ts-opcat` (valibot ReDoS), `@openagentinternet/agent-browser-name-resolvers` (viem/ws), `extract-zip` (symlink path traversal), `js-yaml` (quadratic DoS), `form-data` (CRLF injection), `lodash`/`lodash-es` (code injection/prototype pollution).
  - **High (transitive)**: `axios` (many advisories incl. SSRF, credential theft, prototype pollution), `socket.io-parser`, `undici`, `ws`, `brace-expansion`, `minimatch`, `picomatch`, `tmp`.
- **Impact**: Ship-blocking for a public release. `elliptic`/`protobufjs`/`electron` chains affect crypto and renderer security directly.
- **Fix direction**:
  - Upgrade `electron` to the latest patched 40.x/41.x and re-run the full build/test suite.
  - Upgrade `adm-zip` to `>=0.6.0` and verify extraction call sites (`botBrowserMetaAppCacheService.ts`, `metaAppChainService.ts`, `skillSyncService.ts`).
  - For `fixAvailable:false` chains (`@opcat-labs/scrypt-ts-opcat`, `viem`/`ws`, `elliptic` via `mvc-lib`): verify whether these code paths are reachable at runtime with untrusted input; if reachable, add input validation/mitigations or patch-package; otherwise document as accepted risk with the reachability argument.
  - Re-run `npm audit` after upgrades; consider `npm audit fix` in a dedicated commit with full test verification (never blindly).

### S3. HIGH — Local OpenAI-compat proxy binds `0.0.0.0` with no authentication

- **Evidence**: `src/main/libs/coworkOpenAICompatProxy.ts:120` (`const PROXY_BIND_HOST = '0.0.0.0'`); `server.listen(0, PROXY_BIND_HOST, ...)` (line 3655); `handleRequest` has **no auth check** — any POST to `/v1/messages/<session>` is forwarded to the configured upstream with the user's API key, and `/api/scheduled-tasks` (line ~3300) creates scheduled tasks.
- **Impact**: On a LAN (or via port-forwarding), any peer can consume the user's LLM quota/keys, read responses, and create scheduled tasks. The `0.0.0.0` bind exists so the cowork VM sandbox can reach the host via `10.0.2.2`, but it needs a shared secret.
- **Fix direction**: require a random token (sent by the sandbox via env/header); keep `0.0.0.0` only if the token is mandatory, otherwise bind `127.0.0.1` and give the VM a forwarded port; validate `Origin`/`Host` for browser contexts.

### S4. HIGH — No Content-Security-Policy in the renderer

- **Evidence**: `index.html` (and built `dist/index.html`) contain no CSP `<meta>`/header; `vite.config.ts` sets none.
- **Impact**: If any XSS or injected script ever occurs in the renderer, CSP is the main mitigation preventing script/`eval`/inline execution and data exfiltration. Especially relevant given the large remote-content surface (Bot Browser, MetaApps, markdown from Bots).
- **Fix direction**: add a strict CSP (default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: ws:; frame-src 'self' https: http://127.0.0.1:*) covering both dev (HMR needs ws + localhost) and prod, and verify the app still boots in both modes.

### S5. HIGH — MetaApp iframe sandbox relaxation (`allow-same-origin` on untrusted content)

- **Evidence**: `src/renderer/features/botBrowser/browserIframeBridge.ts:419` — `relaxMetaAppIframeSandbox` rewrites `<iframe ... sandbox="allow-scripts">` to `sandbox="allow-scripts allow-same-origin"` for `browser-html-frame` iframes. The inner iframe src is the resolved MetaApp URL; local MetaApps are served by `src/main/services/metaAppLocalServer.ts` from **one shared origin** `http://127.0.0.1:<port>/<appId>/...`.
- **Impact**: MetaApp HTML is untrusted chain content. `allow-scripts + allow-same-origin` lets it remove its own sandbox restrictions (top navigation, forms, popups) and, because all MetaApps share the single local-server origin, read/write each other's `localStorage`/cookies → cross-app data leakage (e.g., one malicious app stealing another app's stored data).
- **Fix direction**: keep `sandbox="allow-scripts"` only (drop `allow-same-origin`); if the app needs same-origin storage, serve each MetaApp under an isolated origin (unique port or subdomain per app) or move app state into the host via `postMessage` with a validated origin. Verify Bot Browser flows after the change.

### S6. HIGH — Wallet mnemonics stored in plaintext

- **Evidence**: `src/main/metabotStore.ts:71` (`mnemonic: string`), `metabotStore.ts:675` (INSERT into `metabot_wallets`), table `metabot_wallets.mnemonic` in the userData SQLite DB.
- **Impact**: Anyone with file access to the user data directory (or a successful local RCE/backup leak) can read all wallet seeds. Standard Electron practice is OS-keychain encryption.
- **Fix direction**: encrypt at rest with `safeStorage.encryptString` (keyed per user), keep the DB schema compatible via an idempotent migration (new encrypted column + legacy read path), and only decrypt in memory at signing time.

### S7. MEDIUM — No IPC sender validation

- **Evidence**: no `event.senderFrame`/`event.sender` URL validation exists anywhere in `src/main` IPC handlers (searched: zero hits). The preload exposes a broad API (`src/main/preload.ts`: store, skills, projects, wallet, file upload, pin write, shell open, bot-browser control, LLM streaming).
- **Impact**: mitigated by `contextIsolation:true` + `sandbox:true`, but any renderer compromise (XSS, compromised srcDoc bridge) immediately gets the full privileged API, including wallet and pin-write handlers.
- **Fix direction**: add a helper that verifies `event.senderFrame`/`event.sender` belongs to the app origin (file:// or the dev server origin) and apply it to sensitive handlers (wallet, file, pin, shell, group-task).

### S8. MEDIUM — `api:fetch` / `api:stream` unrestricted http(s) proxy

- **Evidence**: `src/main/main.ts:12815` (`api:fetch`) and `12870` (`api:stream`) — any http/https URL with caller-supplied headers/body; only a protocol+hostname check (`isAllowedRemoteFetchUrl`, line 2413).
- **Impact**: If the renderer is ever compromised, this is a free SSRF/HTTP proxy. Today it is the CORS-bypass mechanism for LLM providers (needed for the design), so keep it but harden it.
- **Fix direction**: allowlist the provider base URLs (from config) plus known API hosts; reject redirects to `file:`/`http://127.0.0.1` targets (Electron `fetch` follows redirects); validate that no sensitive headers (e.g., other providers' keys) leak.

### S9. MEDIUM — Hardcoded export password

- **Evidence**: `src/renderer/constants/app.ts` — `EXPORT_PASSWORD = 'idbots-APP'` used for providers export/import encryption.
- **Impact**: a fixed, published password provides only obfuscation for exported provider configs.
- **Fix direction**: require a user-chosen password at export/import time (the password-based PBKDF2/AES-GCM path already exists in `src/renderer/services/encryption.ts`).

### S10. LOW/MEDIUM — Misc

- `browserIframeBridge.ts` posts to `window.parent` with `targetOrigin: '*'` (drag deltas, tab-command responses, endpoint responses). Restrict to the actual parent origin.
- `shell:openPath` / `shell:showItemInFolder` accept arbitrary renderer-supplied paths (expected for a desktop app, but validate they exist under known roots where possible).
- `coworkUtil.ts` `execSync`/`spawnSync` calls use **static** commands (`where bash/git/node`, `reg query` with a fixed key list, `$SHELL -ilc 'echo __PATH__=$PATH'`); no user-controlled shell strings were found and no `shell: true` is used anywhere — good. Keep it that way (never pass agent/user text into a shell command string).
- `metaAppLocalServer.ts` has solid path-traversal defenses (realpath + prefix check, dot-segment rejection) — positive.
- Linux: `app.commandLine.appendSwitch('no-sandbox')` is applied only when `disableLinuxSandbox` is set (`main.ts:2341`, `2515-2517`) — verify the default is false in production packaging and that Linux builds ship with the sandbox enabled.

---

## 3. Performance findings

### P1. HIGH — SQL.js fallback rewrites the whole DB file on every `set()`

- **Evidence**: `src/main/sqliteStore.ts:2943-2953` — `save()` does `this.db.export()` (full in-memory DB) + `writeFileAtomicSync` (synchronous) on every write; `set()` (line 3015) calls `save()` on each call; `optimize()` (line 2957) also calls `save()`.
- **Context**: the native `node:sqlite` backend (WAL) is preferred and skips `save()`; the sqljs path is the fallback (and the recovery path after WASM bounds errors) — but when active, DB size grows with every message, so each write cost grows to O(DB size) on the main thread.
- **Fix direction (no design change)**: keep the native path primary; for the sqljs fallback, debounce/coalesce saves (dirty flag + `setTimeout`/idle flush + flush on quit), move the export/write to a worker or `setImmediate`, and cap write frequency. Add a size guard that warns when DB exceeds a threshold.

### P2. HIGH — Single 3 MB renderer bundle, no code splitting; heavy chat rendering

- **Evidence**: `dist/assets/index-*.js` ≈ 3.0 MB (single chunk, no `manualChunks`, no lazy `React.lazy` in `vite.config.ts`); `src/renderer/components/MarkdownContent.tsx:6` imports the **full Prism** `react-syntax-highlighter` (bundles all languages); every chat message renders `ReactMarkdown` (parse on every render) with no `memo()` on `AssistantMessageItem`/`A2AMessageItem`; long sessions render the entire message list without virtualization.
- **Impact**: slower first paint/startup, janky scrolling on long Cowork/A2A sessions, higher memory.
- **Fix direction**:
  - Add `manualChunks` (vendor/react/markdown/ui) and `React.lazy` for heavyweight views (Settings, GigSquare, MetaApps, Bot Browser surface).
  - Switch to `react-syntax-highlighter/dist/esm/prism-light` with an explicit small language subset (ts/js/json/bash/md/html/css) used in `MarkdownContent.tsx`.
  - `memo()` the message item components and memoize parsed markdown by content hash; virtualize the message list (windowing) for sessions > N messages.
  - Audit whether `mermaid` (in deps) is only type-referenced (`src/renderer/types/artifact.ts`) and tree-shaken; if imported anywhere at runtime, lazy-load it.

### P3. MEDIUM — Bot Browser runtime stays mounted (hidden) after first open

- **Evidence**: `src/renderer/features/botBrowser/useBotBrowserShell.ts:29` (`hasMountedBrowser` initializes `true`); `App.tsx:1199-1217` keeps `<BotBrowserSurface>` mounted with `display:hidden` when `surfaceMode==='home'`; once the ABC shell srcDoc is built (first visibility), it stays alive for the whole session, including the injected bridge + runtime (`BotBrowserSurface.tsx:274-291`).
- **Impact**: after the user opens the Bot Browser once, the full ABC runtime + bridge iframe keeps running while they chat in Cowork — idle CPU and memory.
- **Fix direction**: unmount the surface when returning to home mode (or gate the heavy iframe with `visible`, teardown on hide), preserving state via the existing refs/pending-URI mechanism.

### P4. MEDIUM — `api:stream` sends one IPC message per network chunk

- **Evidence**: `src/main/main.ts:12912-12927` — `readStream()` does `event.sender.send('api:stream:...:data', chunk)` per `reader.read()` chunk; fetch chunks can be small, producing many tiny IPC messages for large responses.
- **Impact**: CPU/IPC overhead during long LLM streams.
- **Fix direction**: batch chunks by time (e.g., ≤30 ms) or accumulated bytes, with a final flush; keep the same event contract so the renderer is unchanged.

### P5. MEDIUM — `backgroundThrottling: false` + renderer polling

- **Evidence**: `main.ts:13359` (`backgroundThrottling: false` in `webPreferences`); renderer polls: `OpenTeamCollabsSection.tsx:219` (15 s), `GroupTaskDetailView.tsx:311` (5 s), `OpenTeamCollabDetailView.tsx:72`, `P2PStatusBadge.tsx:29`.
- **Impact**: hidden/minimized windows keep timers and layout work running (battery/CPU).
- **Fix direction**: when the document is hidden, pause non-critical polls (visibilitychange) instead of relying on Chromium throttling.

### P6. LOW/MEDIUM — Main-process polling daemons

- **Evidence**: `privateChatDaemon.ts:110` (5 s; each tick queries `private_chat_messages WHERE is_processed=0`), `groupTaskDaemon.ts:254` (5 s), `openTeamGuestDaemon.ts:61` (5 s), `cognitiveOrchestrator.ts:24` (10 s; `SELECT * FROM group_chat_tasks WHERE is_active=1` per tick), `dreamService.ts:49` (60 s), `groupChatBackfillService.ts:40` (15 s), `privateChatBackfillService.ts:69` (15 s), `p2pIndexerService.ts:40` (30 s).
- **Impact**: mostly guarded (skip when no work; some `timer.unref()`), but each tick still hits the DB even when idle; with many daemons the aggregate can matter on low-end machines.
- **Fix direction**: make every tick first check a cheap "any work?" condition (e.g., `is_processed=0` count, active-task count) before doing heavier queries; ensure timers are `unref()`'d; consider backoff when idle.

### P7. LOW — Misc

- `broadcastStoreChanged` (`main.ts:6892-6904`) sends `store:changed` to **all** windows on every `store:set` — fine at current write frequency (renderer uses `store.set` once), but keep an eye on O(windows) fan-out if high-frequency keys are added.
- `i18n.ts` (4,270 lines) is bundled into the single chunk; acceptable, but could be split per language later.
- `prewarmClaudeSdk()` at startup is intentional; measure whether it delays `ready-to-show`.

---

## 4. Positive observations (keep as-is)

- `BrowserWindow` hardening: `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`, `navigateOnDragDrop:false`, `enableWebSQL:false`, `devTools:false` in prod, spellcheck off (`main.ts:13349-13361`).
- `setWindowOpenHandler` + `will-navigate` guarded by a protocol allowlist (`main.ts:2393-2401`, `13417-13442`).
- No `dangerouslySetInnerHTML` / `innerHTML` in the renderer; markdown is rendered via `react-markdown` with an explicit safe-URL protocol set (`MarkdownContent.tsx:14`).
- `metaAppLocalServer` path-traversal defenses (realpath + prefix + dot-segment checks).
- No `shell: true` in any `child_process` call; shell command strings are static.
- Local HTTP servers otherwise bind `127.0.0.1`; `metaidRpcServer` uses parameterized SQL (no SQL injection seen in stores).
- The renderer AES-GCM secret encryption and PBKDF2 export encryption are correctly implemented (`src/renderer/services/encryption.ts`).

---

## 5. Suggested priority order for the optimization rounds

| # | Area | Priority | Effort | Round |
|---|------|----------|--------|-------|
| S1 | MetaID RPC server auth + origin allowlist | Critical | M | Round 1 (pre-release, must) |
| S2 | Dependency upgrade (electron, adm-zip, audit chains) | Critical | M | Round 1 (must) |
| S3 | Proxy `0.0.0.0` + token | High | S | Round 1 |
| S4 | CSP | High | S | Round 1 |
| S5 | MetaApp iframe sandbox | High | M | Round 1 |
| S6 | Mnemonic encryption at rest | High | M | Round 1/2 |
| S7 | IPC sender validation | Medium | M | Round 2 |
| S8 | `api:fetch` allowlist | Medium | S | Round 2 |
| S9/S10 | Export password, bridge origin, misc | Low-Med | S | Round 2 |
| P1 | sqljs save coalescing | High | M | Round 1/2 |
| P2 | Bundle splitting + chat rendering | High | M/L | Round 2 |
| P3 | Bot Browser unmount on hide | Medium | S | Round 2 |
| P4 | Stream batching | Medium | S | Round 2 |
| P5/P6/P7 | Polling/background throttling | Low-Med | S | Round 3 |

Each round should: implement in this branch → run the project's real verification (`npm run lint`, `npm run compile:electron`, targeted `node --test` suites, `npm run build`, `npm audit`) → one commit per change → manual smoke of affected flows before release.

---

## 6. Verification notes

- Findings were verified by direct source inspection with file:line references above.
- `npm audit --omit=dev` (44 total: 3 critical / 21 high / 18 moderate / 2 low) was run against `package-lock.json`.
- `dist/` bundle size verified from a previous production build in the main worktree (`index-*.js` ≈ 3,028,542 bytes, single chunk).
- No runtime profiling was performed in this pass; the report is opinion-level and each fix should be validated with a before/after measurement (startup time, idle CPU, long-session scroll, stream latency).

---

## 7. S2 execution log (2026-08-17) — dependency vulnerability upgrade

Executed on `perf/performance-review` (`6aed20ce` → `chore(deps)`).

**Result**: `npm audit --omit=dev` went from **44 → 15** (3 critical + 21 high → **0 critical**, 6 high, 1 moderate, 8 low).

### Upgraded direct dependencies
| Package | From | To |
|---|---|---|
| electron (dev) | 40.2.1 | 41.10.5 |
| adm-zip | 0.5.16 | 0.6.0 |
| js-yaml | 4.1.1 | 4.3.1 |
| form-data | 4.0.5 | 4.0.6 |
| uuid | 11.1.0 | 11.1.1 |
| dompurify | 3.3.1 | 3.4.13 |
| mermaid | 10.9.5 | 10.9.8 |
| react-syntax-highlighter | 15.6.6 | 16.1.1 |
| @larksuiteoapi/node-sdk | 1.59.0 | 1.73.0 |
| discord.js | 14.25.1 | 14.27.0 |
| @opcat-labs/scrypt-ts-opcat | 4.1.0 | 4.1.1 |

### `overrides` added (transitive, same-major patches)
`elliptic@6.6.1`, `bn.js@4.12.5`, `axios@1.19.0`, `ws@8.21.3`, `undici@6.28.0`, `protobufjs@7.6.5`, `lodash@4.18.1`, `lodash-es@4.18.1`, `follow-redirects@1.16.0`, `socket.io-parser@4.2.7`, `@protobufjs/utf8@1.1.2`, `mvc-scrypt.tmp@0.2.7`. These eliminated the 3 critical chains (elliptic/protobufjs/mvc-lib), the axios advisory chain, undici/ws DoS advisories, and the tmp path-traversal advisory.

### Remaining 15 (accepted, documented)
- **High ×6**
  - `@opcat-labs/scrypt-ts-opcat` / `valibot` (fixAvailable=false): scrypt-ts-opcat pins `valibot@^0.38.0`; a 0→1 override is a breaking change. ReDoS needs attacker-controlled schema input (local contract code) — low real reachability. Revisit when upstream moves off valibot 0.x.
  - `extract-zip` (fixAvailable=false, range `*`): no patched release exists (2.0.1 is latest). Used in `skillManager.ts` to unpack skill zips into a controlled temp dir; source is app-managed. Mitigation: keep zip sources trusted/validated.
  - `minimatch@3.1.3` / `brace-expansion@1.1.12` / `picomatch@2.3.1`: all instances sit in **build-time dev chains** (electron-builder, eslint). They do not ship in the app bundle. Forcing 3.x→9.x/10.x via overrides risks breaking the build toolchain; accepted as dev-only.
- **Moderate ×1**
  - `yaml@1.10.2` (via `mvc-scrypt` → vendored `patch-package@6.5.1`): pinned old major, no compatible fix; input is local patch files. Accepted.
- **Low ×8**
  - `elliptic`/`bitcore-lib`/`@metalet/utxo-wallet-*`/`@opcat-labs/opcat`/`meta-contract`/`mvc-lib`/`mvc-scrypt`: "risky cryptographic primitive" advisories with no patched release (npm's suggested fix downgrades `@metalet/utxo-wallet-service` to 0.2.4 / `meta-contract` to 0.0.8, which is not applicable). Accepted; monitor upstream.

### Verification
- `npm run compile:electron` ✅ (Electron 41 types)
- `npm run build` (renderer + main + preload) ✅
- Targeted suites: RPC (19) + skill (19) + wallet/metaidCore + runtime contracts — all pass except 4 pre-existing failures that also fail on un-upgraded `main` (`metaidCoreMvcRecovery.test.mjs` ×2, `metabotLimit.test.mjs` + `runtimePaths.test.mjs` ×2, worktree/environment-related, unrelated to S2).
