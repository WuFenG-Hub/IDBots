# Native Shell Acceptance and Handoff

## 1. Acceptance Rules

Accept each NS package independently against its implementation-plan scope and this matrix. Review actual code and run evidence; do not accept from a delivery note alone.

- S1: blocked core scenario, security exposure, duplicate financial/chain effect, or user-data loss. Always blocks.
- S2: incorrect behavior with a workaround, missing required native behavior, or unverified core recovery. Blocks.
- S3: minor/cosmetic issue with no material correctness or security impact. May be scheduled explicitly.
- Missing SDK, credentials, physical device, account, or provider access is **NOT RUN**, never a pass. Marking required evidence NOT RUN blocks the corresponding native acceptance.
- Code completion, native acceptance, and production release are different states. Production/staging deployment uses reviewed `main`, never a feature branch.

## 2. Acceptance Matrix

| ID | Scope | Pass condition |
|---|---|---|
| NS-A-01 | Independent package | `mobile-shell/` has its own frozen lockfile and builds without entering root `postinstall` or Electron packaging. Root package guidance is synchronized. |
| NS-A-02 | Flavors and provenance | Staging loads `staging.idbots.world`; production is an explicit flavor using `app.idbots.world`. Source SHA, native bridge version, C2 version, plugin versions, and artifact hashes are recorded. |
| NS-A-03 | Navigation and bridge security | Exact-origin navigation works; arbitrary external content cannot access native capabilities; Alipay/approved external links leave the privileged WebView. |
| NS-A-04 | Adapter bootstrap | Android and iOS expose the expected version/capabilities before React use; `shell=capacitor` and OS detection are correct. Browser/PWA works without the adapter. |
| NS-A-05 | Offline/error behavior | Unreachable origin produces the bundled error UI and a usable retry path; no stale cached online UI or false offline execution is presented. |
| NS-A-06 | Authentication | Test login, returning login, two-device behavior, and logout match PWA semantics. No session token appears in native storage, logs, or crash reports. |
| NS-A-07 | Core chat | NS1 onward runs A-03: correct Twin, smooth stream, stop within 2 s, complete history, and no duplicate/lost accepted messages. |
| NS-A-08 | Lifecycle and recovery | Background/foreground, airplane mode, OS eviction, and control-plane restart use existing reconnect/resync; no blind retry, duplicate session/order, or tenant restart. |
| NS-A-09 | Navigation and platform UI | Android back, sheets/routes, keyboard, safe areas, both themes, and external navigation work without trapping the user. |
| NS-A-10 | Attachments | Camera/photo and a 20 MB PDF enter the existing upload/attachment flow; a 26 MB file is refused before upload; ordering, progress, cancellation, denial, and draft recovery work. |
| NS-A-11 | Artifacts | Real image/PDF/Markdown/other files preview or download; system share/copy fallbacks work; expired links refresh; raw tenant paths never appear. |
| NS-A-12 | Skills and background work | Applicable A-04/A-07 scenarios pass in the shell; real files open, citations work, phone-closed scheduled results return to the correct session. |
| NS-A-13 | Recharge policy | Recharge is hidden in the iOS native shell and remains available in the PWA/Android as specified. Any payment test uses owner-approved staging configuration and never duplicates an order/credit. |
| NS-A-14 | PWA/shared regression | Existing standard, mobile unit/static, desktop-shared, Mock, and real-C2 checks pass for the changed surface. PWA keeps its full fallback behavior. |
| NS-A-15 | Native builds | Android debug/release builds and iOS Simulator/TestFlight builds as applicable succeed. Android version code increases; signing/TestFlight without authorized credentials remains NOT RUN. |
| NS-A-16 | Security/privacy | No secrets, phone/message contents, QR payloads, mnemonics, or signed tokens in logs/storage; no weakened CSP/CORS/gateway rules; secure-screen claims match actual platform capability. |

## 3. Device Matrix

Use staging and synthetic/test identities unless the owner explicitly approves another configuration.

| Client | Required coverage |
|---|---|
| iPhone Safari | Existing core PWA regression and home-screen behavior must not regress. |
| Android Chrome | Existing core PWA regression and web fallbacks must not regress. |
| Android native shell | NS0 bootstrap on one device/emulator; NS1/NS2 capabilities on physical hardware; release pass on Xiaomi, Huawei (HarmonyOS 4 or earlier), and OPPO or vivo as required by REQ-E-27. |
| iOS native shell | Simulator for build/bootstrap and at least one physical iPhone for lifecycle/camera/share; TestFlight when the owner account is available. Recharge remains hidden. |

HarmonyOS NEXT cannot install the Android APK and continues to use the web app. No push-notification claim is made in NS0–NS3.

## 4. Evidence Required per Package

The delivery note must contain:

- branch, base SHA, final SHA, and commits with their on-chain development-journal pins;
- changed files and requirement mapping;
- exact install/build/test commands and current counts/results;
- Android/iOS build type, flavor, remote origin, SDK/toolchain versions, and artifact hashes when produced;
- device model, OS version, WebView/browser where relevant, and sanitized test account/tenant identifiers;
- screenshots or recordings for the NS0 bootstrap and native-only interactions, stored outside git;
- security/storage/log checks with no secret values;
- failed and partial results plus every NOT RUN item and its owner;
- unresolved S1/S2/S3 findings and rollback implications.

Do not put signing keys, Apple credentials, device tokens, phone numbers, message contents, mnemonics, provider keys, redeem codes, payment QR payloads, or signed file URLs in git or the delivery note.

## 5. Release Blockers

Do not approve a native release candidate for any of the following:

- a new native Agent/LLM/wallet/chain/task implementation or duplicated product backend;
- arbitrary-origin native bridge access or authentication tokens in native storage;
- unavailable adapter bootstrap on either platform;
- lost/duplicated messages, sessions, uploads, orders, or chain effects;
- missing web fallback or a PWA regression;
- missing required physical-device evidence for native-only behavior;
- open S1/S2, a skipped required test leg, or an unrecorded NOT RUN;
- a build made from an unreviewed feature branch for staging/production release.

## 6. Rollout and Rollback

1. Merge the accepted package to `main` only with owner approval.
2. Build and sign the native candidate from the reviewed `main` SHA.
3. Test the staging flavor first with a small internal group.
4. Keep the previous known-good Android/iOS binary and the previous remote-PWA deployment path.
5. A remote-PWA rollback fixes compatible shells without a native-binary downgrade; a native plugin/navigation/security regression may require a native-binary rollback.
6. Production rollout follows owner sign-off and the existing cloud/mobile release gates. No public store submission is included.
