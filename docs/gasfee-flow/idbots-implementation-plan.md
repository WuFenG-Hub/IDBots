# IDBots Implementation Plan — Traffic-ized Gas Fee (Client Side)

All work happens on branch `feat/gasfee-flow` (worktree `.worktrees/gasfee-flow`).
Companion docs: `README.md` (vision/decisions), `architecture.md`,
`backend-spec.md` (what the backend team builds), `roadmap.md`.

Client-side phases map to roadmap Phase 2 (M2.x) and Phase 3 (M3.x). Phase 2 can
start before the backend ships, because the sponsor v2 protocol is already live
in production (file-upload path proves it).

---

## Phase A — Reusable Sponsor Protocol Client (M2.1)

**Goal**: extract the challenge→pre→sign→commit protocol out of the file-upload
special case into a generic client usable by any pin type.

**Current state**: `src/main/services/mvcSponsorUpload.ts` (1193 lines) contains
the full protocol but entangled with `/file` inscription draft building.

**Steps**:

1. New `src/main/services/mvcSponsorClient.ts`:
   - `getSponsorAddressInfo(address)` ← from `mvcSponsorUpload.ts:590`
   - `requestSponsorChallenge(address)` ← `:605`
   - `submitSponsorPre(...)` ← `:615` — generalized: accepts any unsigned rawTx
     hex + address (+ `trafficAccount` auth field once backend ships)
   - `signUserInputs(unsignedDraft, preparedTx, wallet)` ← `signMvcPreparedUserInputs:861`
   - `submitSponsorCommit(...)` ← `:637`; `getSponsorOrder(orderId)` ← `:578`
   - error taxonomy preserved: `service_unavailable / no_user_utxo /
     insufficient_quota / pre_rejected / commit_failed` (+ `insufficient_traffic`
     when backend lands)
2. Refactor `mvcSponsorUpload.ts` to consume `mvcSponsorClient.ts`; keep its
   public API and metadata shape (`MvcSponsorFeeAssistMetadata`) unchanged —
   file-upload behavior must not regress.
3. Tests: extend `tests/mvcSponsorUpload.test.mjs` patterns into
   `tests/mvcSponsorClient.test.mjs` (mocked HTTP); run existing sponsor tests.

**Done when**: file upload sponsor path passes existing tests using the new
client; protocol code has zero file-specific logic.

## Phase B — Draft Mode for createPinWorker (M2.2)

**Goal**: build unsigned pin transactions (hex + accurate size estimate) without
broadcasting, so the sponsor `pre` can be called for any pin.

**Current state**: `src/main/libs/createPinWorker.ts` builds, signs, and
broadcasts in one pass (MVC flow at :383-505); size estimation helpers exist
(`getEstimatedTxSizeWithoutInputs:272`, `P2PKH_INPUT_SIZE` in `mvcSpend.ts`).

**Steps**:

1. Add `mode: 'broadcast' | 'draft'` to worker options (`metaidCore.ts:436`
   `spawnCreatePinWorker`).
2. In draft mode: build the full TxComposer tx exactly as today, but skip
   signing and broadcast; return `{ unsignedTxHex, estimatedTxSize, usedUtxos }`.
   The unsigned tx must match what the sponsor `pre` expects (user inputs
   present, empty unlocking scripts — same contract as
   `buildMvcFileInscriptionDraft` in `mvcSponsorUpload.ts:804`).
3. Wire through `createPin()` (`metaidCore.ts:582`): when traffic mode applies,
   run draft → sponsor pre → sign → sponsor commit, all inside the existing
   `runMvcSpendJob` serialization to preserve UTXO double-spend protection;
   mark used UTXOs in `mvcSpendSessionState` the same way the broadcast path does.
4. Fallback policy on `service_unavailable / insufficient_*`: fall back to the
   existing broadcast path (self-pay) when `traffic.fallbackPolicy === 'selfpay'`
   (default during transition), else throw a typed `TrafficInsufficientError`.
5. Tests: `tests/createPinSponsor.test.mjs` — draft-mode tx equals broadcast-mode
   tx modulo signatures; sponsor-mock end-to-end for a chat pin; fallback matrix.

## Phase C — Traffic Mode Wiring & Toggle (M2.3, M2.4)

**Goal**: one setting controls how every on-chain write is paid.

**Steps**:

1. Settings store: `traffic.mode = 'traffic' | 'selfpay'`,
   `traffic.fallbackPolicy = 'selfpay' | 'strict'` — persist in SQLite kvStore,
   following the `feeRateStore.ts` pattern (`getRate`, IPC `getTiers/select`).
2. `createPin()` reads the mode (no per-call options needed for the common case);
   per-call override stays possible via `options`.
3. **Fee-rate unification (M2.4)**: today most `createPin` callers rely on
   `FALLBACK_FEE_RATES` (`metaidCore.ts:484`). Thread `getGlobalFeeRate(network)`
   from `feeRateStore.ts` into all call sites (`groupChatTransport.ts`,
   `privateChatDaemon.ts`, `main.ts` ~20 sites, etc.) so byte estimates and real
   fees are consistent everywhere. Do this as its own commit — it touches many
   files but is mechanical.
4. Coverage check: every `createPin` caller listed in the exploration report
   (chat transports, metaAppOwnerService, gigSquareService, botBrowserBridge,
   providerPing, userIdentity pins, RPC `metaidRpcServer.ts:1916`) goes through
   the same traffic-aware path. File uploads already have their sponsor branch
   in `metaFileUploadService.ts:320` — align its fallback semantics with the new
   toggle.
5. Low-balance UX hooks: typed errors surface to renderers so chat send can show
   "traffic exhausted → recharge" instead of a generic failure.

## Phase D — Traffic Account Service Client (M3.1, M3.5)

**Goal**: IDBots talks to the backend traffic APIs and manages bindings.

**New**: `src/main/services/trafficAccountService.ts`

- `ensureTrafficAccount()` — identity-signed `POST /v1/traffic/accounts`;
  identity key from `userIdentityStore.ts` (single-row `user_identity`).
- `bindAllLocalBots()` — for each row in `metabot_wallets`
  (`metabotStore.ts:718`) plus the identity address: build both signatures,
  `POST /v1/traffic/accounts/bindings`. Lazy trigger: first traffic-mode use;
  batch trigger: when the toggle switches to traffic. Idempotent on 409.
- `getBalance()`, `getLedger(cursor)`, `getDailyUsage(range)` — cached locally
  (new small table or kvStore keys; cache TTL ~30s; invalidated after each
  local spend using locally known `txSize` for instant UI feedback).
- Local spend journal: record `{ txId, botAddress, txSize, ts }` per successful
  sponsored commit so the UI is useful even before backend usage APIs land.
- IPC surface `traffic:*` for the renderer, mirroring existing IPC patterns.

## Phase E — Recharge Entry & Traffic Center UI (M3.2–M3.4)

**Where**: new `traffic` tab in Settings (`Settings.tsx` sidebar at :2263-2276;
fee-rate UI precedent at :3570-3650). Entry point also from
`MetaBotWalletAssetsModal` (balance context) and from insufficient-traffic errors.

**Screens**:

1. **Pricing & recharge**:
   - rate table from `GET /v1/traffic/pricing` (plan cards: ¥X → Y MB);
   - recharge flow: create order → mock-pay dialog (dev-labeled) → poll
     order/balance → success state;
   - copy in English per project convention; user never sees "sats/SPACE/gas"
     in this flow.
2. **Traffic center**:
   - headline: remaining MB, reserved, lifetime used;
   - table: per-MetaBot per-day consumption (date × bot → MB, tx count) from
     `usage/daily` (+ local journal as fallback);
   - ledger list: recharges and deductions.
3. **Toggle**: traffic vs self-pay radio + fallback policy; when switching to
   traffic, run `bindAllLocalBots()` with progress.
4. **Empty/low states**: zero-balance CTA to recharge; low-balance banner
   threshold (e.g. < 5 MB, configurable).

**i18n**: follow existing renderer i18n conventions; default copy English.

## Phase F — Real Payment (Phase 4, later)

Swap the mock-pay dialog for Stripe/Alipay flows once backend adapters land.
Keep the order/poll model unchanged.

---

## Test Plan

| Layer | Tests |
|---|---|
| Protocol client | `tests/mvcSponsorClient.test.mjs` (mocked HTTP, error taxonomy) |
| Worker draft mode | unsigned draft == broadcast tx mod signatures; size estimate within tolerance |
| createPin traffic path | sponsor-mock e2e chat pin; fallback on each error class; UTXO session state consistency |
| Fee-rate unification | existing test suite green; spot-check call sites pass explicit rate |
| Traffic service | account/binding/balance with mocked backend; local journal correctness |
| UI | manual QA script: fresh user → pricing → mock recharge → chat → usage table updates |

## Sequencing & Dependencies

```
A (client extract) ──┐
                     ├─► B (draft mode) ─► C (toggle + fee rates) ─► D (account svc) ─► E (UI)
Backend Phase 1 ─────┴──────────────────────────────────────────────► D needs backend APIs
```

- A–C deliver value alone: all-pin sponsorship against the existing
  permissionless quota (free traffic), plus the toggle and unified fee rates.
- D–E need the backend traffic APIs; until then, D can run against a local
  mock server implementing `backend-spec.md` §3 to unblock UI work.

## Risk Notes

- **UTXO ownership in draft mode**: the sponsor flow requires the tx's first
  input to belong to the bot address and the bot must have at least one usable
  UTXO (any tiny amount). New bots still need address-init (`address-init-v2`
  exists). Traffic mode does not remove the need for a dust UTXO per bot.
- **Concurrent spend**: `runMvcSpendJob` serializes per-bot; sponsor reservations
  add a second serialization server-side — watch for open-order caps (3/address)
  under bursty chat.
- **Estimate vs actual**: reserve uses an upper-bound estimate; refund happens
  at commit. Keep estimates tight to avoid false "insufficient traffic".
