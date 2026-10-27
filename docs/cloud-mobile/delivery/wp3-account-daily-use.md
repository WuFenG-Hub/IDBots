# Delivery Note — WP3 Account and Daily-Use Breadth

- **Date:** 2026-10-27
- **Branch:** `feat/cloud-mobile-wp3-account-daily-use`
- **Base:** local `main` at `f19de10d` (WP2 merged)
- **Status:** implementation and deterministic verification complete on branch; real-environment acceptance pending
- **Acceptance:** not accepted, not merged, not deployed

## Scope and Architecture

WP3 hardens the existing cloud host and closes account/daily-use journeys without moving Agent, skill, memory, or chat business logic into the PWA or control plane. The tenant remains the same IDBots host used by desktop: CoworkRunner, MetaBotStore, SkillManager, MemoryBackend, sessions, tasks, files, and workspaces stay in the main process. The PWA uses the existing `window.electron`-compatible bridge and C2 transport.

The frozen files `01-interface-contracts.md` and `02-ipc-allowlist-v1.md` were not edited. `cloud/control-plane/` was not changed. No native shell, social square, knowledge base, dream, surf, group task, per-Bot memory policy, or memory-entry management was added.

## Commits and Development Journals

| Commit | Change | On-chain journal pin |
|---|---|---|
| `f2e9156e` | Harden cloud settings and relay catalog | `fd8becef64ae9a11b350ad2267c733899c61fc949d68664c266a05a1725cffdci0` |
| `5fc7a171` | Make mobile recharge recoverable and order-safe | `ef0675af0309f3f2281bc12697457fef70523f46f54d198237cfdb32ad4c131ci0` |
| `bc8f70a4` | Complete mobile Bot lifecycle and configuration | `2ebf82ed08c8853ef04ede50829f427abcb0623dd74186a4590c62ad8fd54b89i0` |
| `70315a3b` | Show in-flight Bot synchronization state | `2f979edd95407d61d4b51810742da33cb417292f05d656bad0ff2f51483febd0i0` |
| `44cd2513` | Harden real gateway account coverage | `7bbb4eb7357e36f02a1101b2a2ccda15a11a740c8466550e2a75101b62ca4bffi0` |

Each journal was published with the required `metabot-post-buzz` flow in English. The journals are development records, not product acceptance evidence.

## Requirement Mapping

### 1. Cloud runtime and configuration safety — deterministic implementation complete

- Mobile `app_config` writes are serialized in the main process and merged against the latest stored value. Field-scoped language/theme writes cannot erase provider credentials, bootstrap fields, or concurrent preferences. Desktop `store:set` replacement behavior is unchanged.
- Language and theme are applied locally only after persistence and readback confirmation. Saving, success, failure, and offline/uncertain states are visible; previous silent catches were removed from user-initiated writes.
- The main process refreshes the relay model catalog without reissuing credentials. It preserves concurrent writes and rotated credentials, refuses empty replacement catalogs, and does not rebind existing sessions. A failed refresh keeps the last good catalog and logs a warning.
- Only the redacted read-only catalog reaches the PWA. No provider-key management was exposed.
- Global cowork memory switches use the existing P1 `cowork:config:get/set` path. Per-Bot memory policies and memory entries remain P2 and were not exposed.
- Twin runtime-context tests verify persona, brain, skills, memory scope, and per-Bot workspace inheritance. Bootstrap migration/resume tests preserve existing user data and are additive/idempotent.

### 2. Recharge, orders, and quota recovery — deterministic implementation complete; real payment NOT RUN

- QR handoff is strictly bound to the current order. A new order with no QR never inherits the previous order's QR.
- Terminal updates require both the expected order ID and operation generation, so an old poll cannot complete a newer order.
- The current order, plan, QR, expiry, and status recover after close/reload. Foreground and reconnect paths resynchronize plans, meters, and order state. Leaving the payment page does not cancel the order.
- Active orders block duplicate creation. An uncertain create is persisted and blocks blind retries for the unpaid-order recovery window. No automatic retry follows a lost create result.
- Polling has degraded and timeout states. Meters bypass cached traffic snapshots. Repeated order polls are verified not to credit again in the deterministic services and gateway journeys.
- Mock and real-C2 browser journeys cover quota exhaustion, credited meters, and a successful next message. This does not prove a real Alipay payment or the external backend's exactly-once transaction.
- `CR-WP3-001-bundle-order-recovery.md` proposes server-side `clientRequestId` idempotency and authoritative order/QR/expiry recovery. It is a proposal only, not an approved contract change.

### 3. Bot lifecycle and configuration — deterministic implementation complete; real chain creation NOT RUN

- Mobile creation now uses `idbots:createMetaBotOnChain`; it no longer uses local-only `metabot:create`. Resume, full sync, enable/disable, persona, brain/model/effort, and per-Bot skill configuration reuse existing P1 channels and shared main-process cores.
- Creation shows an honest in-flight state. Results distinguish fully confirmed, local-only, partial sync, explicit failure, and uncertain outcomes. Incomplete/unknown results keep the form open and do not trigger blind retries.
- Roster state uses the main process's `chain_sync_state`, pending steps, and subsidy state. Manual actions expose an updating/checking-chain-state message, resume/sync actions, and fee/wallet-balance hints.
- Existing sessions keep their model bindings. New sessions resolve the updated Bot default brain; deterministic tests cover the next-session execution context rather than only field persistence.
- Real C2 scenarios cover creation, editing, per-Bot skills, enable/disable, reload persistence, and new/old session model bindings through the actual gateway and shim. These use deterministic tenant handlers, not a real chain or model.

### 4. Skills, memory, and WP0–WP2 boundaries — deterministic regression complete; real tenant/model quality NOT RUN

- Existing skill assignment, memory, long-term task, bootstrap, and Twin runtime suites pass. Global memory controls are exposed only where P1 already allows them.
- No full skill or memory administration backend was built for WP3. Knowledge base, dream, surf, and per-Bot memory management remain outside this package.
- Full mock and real-C2 matrices cover WP0–WP2 chat, attachments, image/PDF/Markdown artifacts, link refresh, permissions, scheduled work, long-term work, and closed-browser result navigation.

### 5. Acceptance scenarios

| Scenario | Deterministic evidence | Real-environment status |
|---|---|---|
| P2-12 Bot creation, persistence, and effect | Mock and real-C2 creation/configuration journeys, chain-state/resume coverage, next-session brain checks, desktop MetaBot/skill suites | Real chain creation, fees, chain confirmation, and real-model effect **NOT RUN** |
| P2-13 Recharge and exactly-once recovery | QR/order guards, reload/foreground/reconnect recovery, repeated-poll checks, meters and next-chat journeys on both profiles | Real Alipay, real backend credit transaction, and drained real identity quota **NOT RUN** |
| P2-14 Settings and memory | Concurrent gateway writes, readback confirmation, global memory persistence, provider/bootstrap preservation, secret redaction | Real tenant restart and real relay catalog freshness **NOT RUN** |
| Original A-09 | Deterministic bundle purchase and meters | Real ¥0.01 Alipay plan **NOT RUN** |
| Original A-10 | Deterministic quota card → recharge → meters → next message | Real identity drain and paid recovery **NOT RUN** |
| Original A-12 | Deterministic worker create/persona/skill/model and task-capable session binding | Real worker chain write, traffic accounting, and long-term real-model progress **NOT RUN** |
| WP0–WP2 flows | Full mock 90/90 and real-C2 15/15 per profile | Physical devices and public staging **NOT RUN** |

## Verification

### Environment and dependency gates

- Node `v26.7.0`, pnpm `11.24.0`; supported engine range `>=24 <27`.
- `pnpm install --frozen-lockfile`: passed, including nested packages and patch application.
- `pnpm run check:dsh-deps`: passed.
- `node scripts/apply-dsh-kernel-patches.cjs --check`: passed; 8 fingerprints verified on macOS.
- Frozen `01/02` and `cloud/control-plane/` diff: empty. Control-plane code was not touched, so its Node 24 test/build was not applicable to this branch.

### Automated and browser evidence

| Check | Result |
|---|---|
| Full standard `pnpm test` | Completed with exit code 0; the entire standard chain passed |
| `pnpm run test:mobile` | Passed: 161 TypeScript tests, 3 static tests, and 47 additional tests |
| `pnpm run lint` | Passed |
| `pnpm run build:mobile` | Passed; app initial JS 90.2 KB gzip (limit 500), login 60.8 KB gzip (limit 80); production no-mock check passed |
| `pnpm run build:skills` | Passed |
| Desktop renderer build via `test:memory` | Passed |
| Desktop Electron compile | Passed |
| Memory/model/config suite | 235/235 passed |
| MetaBot and skill assignment suite | 164/164 passed |
| Long-term task suite | 89/89 passed |
| Twin/bootstrap/workspace focused suite | 30/30 passed |
| Model binding focused suite | 7/7 passed |
| Bundle service and relay/gateway focused tests | Passed |
| Mock mobile E2E, iPhone WebKit + Pixel Chromium | 90/90 passed across both profiles |
| Real-C2 E2E, iPhone WebKit | 15/15 passed |
| Real-C2 E2E, Pixel Chromium | 15/15 passed |
| `git diff --check` | Passed; no `MERGE_HEAD` |

Real C2 means the real gateway server, C2 WebSocket, allowlist/restrictions, and mobile shim with deterministic tenant handlers. It is not a real tenant/model or public staging result.

## NOT RUN / Not Accepted Here

- Real tenant sign-in, real chain Bot creation/fees/confirmation, real model responses, and real skill/memory task-quality evaluation.
- Real Alipay payment, real payment-backend exactly-once credit, real identity quota drain, and real ¥0.01 acceptance plan.
- Physical iPhone Safari/home-screen PWA, physical Android devices, mainland network measurements, and staging/production deployment or health checks.
- Public control-plane/Caddy/staging acceptance and operator verification of deployed image provenance.
- Packaged macOS/Windows application smoke tests. Desktop renderer/Electron builds and relevant regression suites were run instead.
- Any push, merge into `main`, deployment, or unauthorized remote state change. No real payment or product chain-creation call was made by this work.

## Remaining Risks and Follow-Up

1. **Order idempotency is not server-authoritative yet.** CR-WP3-001 needs WS-A/WS-D/owner review. Local unresolved-create blocking is a compatibility guard, not proof that an unknown server order can be reconciled.
2. **QR/expiry recovery depends on the current client's persisted order handoff.** Clearing that state can strand a created order until the additive recovery contract exists. No new order is blindly created to hide this limitation.
3. **Relay freshness depends on relay availability.** A failed refresh keeps the last good catalog and logs a warning; real relay freshness and availability remain staging acceptance items.
4. **Real chain/payment effects remain unverified.** Deterministic tests deliberately avoid claiming real fees, chain confirmation, model quality, or external exactly-once payment behavior.
5. **Branch delivery is not acceptance.** The branch must be reviewed by the acceptance session, merged only with owner approval, and rebuilt from `main` before staging or production verification.
