# NS0 Native Shell Foundation — Independent Review Delivery Note

## 1. Delivery State

NS0 code and Android/iOS emulator WebView evidence are complete. This is not a production release, a signed release candidate, or a claim of full native acceptance.

One inherited S2 verification blocker remains: the existing real-C2 Bot lifecycle E2E fails on both mobile profiles because it attempts to select `Default model` while the existing `Advanced options` section is collapsed. It reproduced independently on iPhone WebKit and Pixel Chromium, including a standalone rerun. The failed test and the UI code involved are unchanged by NS0. Full native acceptance remains blocked until the owner triages this baseline failure and the explicit NOT RUN items below.

No push, merge, deployment, production rollout, signing-key access, TestFlight upload, store submission, or owner-secret access was performed. Frozen contracts were not edited.

## 2. Provenance

| Item | Value |
|---|---|
| Branch | `feat/mobile-shell-foundation` |
| Worktree | `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/mobile-shell-foundation` |
| Base SHA | `6d95a10ac10d972596d9cd6fc9d0f05e758d01b3` |
| Implementation SHA | `ae6e8108096ea89184ce69d6e9a9c2e22003d65d` |
| Final SHA | This delivery-note commit; resolve with `git rev-parse HEAD`. The exact final SHA and both journal pins are recorded in `mobile-shell/artifacts/ns0-handoff.json` after the commit and in the independent-review handoff. |
| Native package version | `0.1.0` |
| Native bridge version | `1` |
| C2 / allowlist version | `1.0.0` / `1.0.0` |
| Default flavor | `staging` → `https://staging.idbots.world/` |
| Explicit production flavor | `production` → `https://app.idbots.world/` (configuration tested; WebView NOT RUN) |
| Application ID | `world.idbots.app` |

The remote `origin/main` could not be fetched because GitHub was unreachable. The branch was created directly from the then-current local `main` at the base SHA above. No feature branch was used as its parent.

## 3. Commits and Development Journals

| Commit | Subject | On-chain journal pin |
|---|---|---|
| `ae6e8108096ea89184ce69d6e9a9c2e22003d65d` | `feat: add native mobile shell foundation` | `f2807841ba3aca1990268ab740e5ff1597763637c3cb43dede83a91fd7e83660i0` |
| This delivery-note commit | `docs: add native shell foundation delivery note` | Recorded with the final SHA in `mobile-shell/artifacts/ns0-handoff.json` |

Journal entries were published through the required `metabot-post-buzz` skill on MVC. No GitHub push occurred.

## 4. Changed Files and Requirement Mapping

The implementation contains 106 files in the implementation commit, primarily the generated Android/iOS projects and their image resources.

- `mobile-shell/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`: independent native package and pinned toolchain (NS-A-01).
- `mobile-shell/android/`, `mobile-shell/ios/`: Capacitor 8.5.3 native projects, App plugin 8.1.2, platform build files, and local tests (NS-A-01, NS-A-15).
- `mobile-shell/scripts/flavors.mjs`, `select-flavor.mjs`, `build-android.mjs`, `build-ios.mjs`: reproducible staging/production selection and debug builds (NS-A-02).
- `mobile-shell/android/app/src/main/java/world/idbots/app/`: exact-origin policy, document-start bootstrap, WebView/navigation scaffolding, and debug-only sanitized evidence (NS-A-02 through NS-A-05).
- `mobile-shell/ios/App/App/Native*`: flavor validation, main-frame document-start injection, exact-origin navigation proxy, bundled-error handling, and DEBUG-only smoke support (NS-A-02 through NS-A-05).
- `mobile-shell/native/idbots-native-bootstrap.js`: shared versioned native surface and client facts (NS-A-04).
- `mobile-shell/www/`: small bilingual offline/error UI only; no cached online PWA or service worker (NS-A-05).
- `src/mobile/native/`, `src/mobile/app/main.tsx`, `src/mobile/login/main.tsx`: narrow typings and pre-React native validation with unchanged browser behavior (NS-A-04, NS-A-14).
- `tests/mobileNativeBootstrap.test.ts`, `mobile-shell/tests/`, `mobile-shell/android/app/src/test/`: bootstrap, configuration, external-origin, offline, and origin-policy coverage (NS-A-03 through NS-A-05, NS-A-14).
- `mobile-shell/scripts/android-webview-smoke.mjs`: real Android WebView bootstrap, external-navigation, offline, and retry proof (NS-A-03 through NS-A-05).
- `mobile-shell/README.md`: toolchain, flavors, commands, DEBUG smoke, capabilities, and secret-free operation.
- `AGENTS.md`, `CLAUDE.md`, `.gitignore`, root `package.json`: synchronized four-package guidance, test registration, and native test tracking (NS-A-01).
- `mobile-shell/DELIVERY-NOTE.md`: this review package.

No NS1 lifecycle/reconnect/route-back integration, NS2 media/system capabilities, push, NS3 signing/release work, native API client, or product business logic was added.

## 5. Toolchain and Dependency Provenance

| Component | Verified version |
|---|---|
| Node.js | 26.7.0 |
| pnpm | 11.24.0 |
| Capacitor core / CLI / Android / iOS | 8.5.3 |
| `@capacitor/app` | 8.1.2 |
| Android JDK | Azul Zulu 21.0.8; Microsoft JDK 21.0.8 was also checked during TLS diagnosis |
| Android Gradle Plugin | 8.13.0 |
| Gradle | 8.14.3, official SHA-256 verified |
| AndroidX WebKit | 1.14.0 |
| Android compile / target / minimum SDK | 36 / 36 / 26 (Android 8) |
| Android emulator | Android SDK built for arm64, Android 15, API 35 |
| Android System WebView | 124.0.6367.219 |
| Xcode | 27.1 (27A9275) |
| CocoaPods | 1.16.2 |
| iOS Simulator | iPhone 17, iOS 26.5, WKWebView |

The host's Java TLS connections to official Maven hosts failed. A local-only, ignored Gradle init script selected Aliyun Maven mirrors for dependency resolution. The final builds reused that cache with Gradle `--offline`; the init script is not committed and is not part of the product configuration. Playwright Chromium used the same pinned browser build from its binary mirror after the official CDN proved too slow.

A worktree-local Node 26 pnpm launcher was used because the host's default pnpm launcher belonged to an unsupported Node 20 installation. Build scripts now invoke the package's Capacitor CLI directly with the current Node process and do not depend on that launcher.

## 6. Verification Commands and Actual Results

All commands ran on the deliverable worktree unless noted.

| Command / lane | Result |
|---|---|
| `pnpm install --frozen-lockfile` (root and `mobile-shell/`) | PASS; root postinstall and kernel patches completed. `mobile-shell/` was not added to root postinstall. |
| `pnpm test` (native package) | PASS, 11/11 |
| `pnpm exec tsx --test tests/mobileNativeBootstrap.test.ts` | PASS, 6/6 |
| `pnpm run test:mobile` | PASS, 235/235 (178 + 6 + 51) |
| `pnpm test` (root) | PASS; every suite summary passed, 2,163 tests aggregated from the current output |
| `pnpm run lint` | PASS |
| `pnpm run build:mobile` | PASS; login 62.4 KB gzip and app initial JS 92.5 KB gzip, within 80 KB / 500 KB budgets |
| `pnpm run build:skills` | PASS |
| `pnpm run test:e2e:mobile` | PASS, 110/110 across iPhone WebKit and Pixel Chromium; 2 skipped |
| `pnpm run test:e2e:mobile:gateway` | PARTIAL/FAIL, 16/17 on iPhone; inherited Bot advanced-options failure |
| `pnpm run test:e2e:mobile:gateway --project=pixel7` | PARTIAL/FAIL, 16/17 on Pixel; same failure. Combined real-C2 result: 32/34 |
| `./gradlew --no-daemon --offline --init-script ../.tooling/init-mirrors.gradle assembleStagingDebug testStagingDebugUnitTest` (from `mobile-shell/android/`) | PASS; APK built and 4/4 JVM tests passed (3 origin-policy + 1 template test) |
| `pnpm run build:ios:staging` | PASS, `** BUILD SUCCEEDED **` |
| `git diff --check` / `git -c core.whitespace=cr-at-eol diff --cached --check` | PASS; standard `gradlew.bat` CRLF preserved |
| `git diff --name-only -- docs/cloud-mobile/01-interface-contracts.md docs/cloud-mobile/02-ipc-allowlist-v1.md` | No changes |

The Android online build with the same local mirror init script also passed before the final offline rebuild. No official Maven or deployment service was contacted during the final offline build.

## 7. Native Artifacts

| Artifact | Type / flavor | SHA-256 |
|---|---|---|
| `mobile-shell/artifacts/idbots-ns0-android-staging-debug.apk` | Android `stagingDebug`, version `0.1.0`, code `1`, minSdk 26, targetSdk 36 | `bb6712c2ee285a894902ea4576d68ffbb3caac5296f4c5dd9cd49e44386c7872` |
| `mobile-shell/artifacts/idbots-ns0-ios-staging-simulator.tar.gz` | iOS Simulator Debug, staging, version `0.1.0`, build `1` | `542b27db6e9e9fd0dc5b040c722b9ca09af7b843dbf86c4d91db82e81b2fcefb` |
| `ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app/App` | iOS Simulator executable | `2e12226e0c9f15da563f7dde36989e5711e86bf28b0d7bb73ed71b3a5ee597b2` |

`apksigner verify --verbose` passed for the standard Android DEBUG signature (v2 true, one signer). No owner signing material was used. The iOS build used `CODE_SIGNING_ALLOWED=NO` for Simulator only.

## 8. WebView Evidence

Evidence is stored outside git under `mobile-shell/artifacts/`. No test account or tenant identifier was used; staging was loaded only to its unauthenticated login screen.

### Android — Android 15 / WebView 124.0.6367.219

| Check | Evidence and result |
|---|---|
| Staging login loads | `android-staging-login.png`; `android-bootstrap.json` = PASS |
| Bootstrap and client facts | `android-native.log`: origin `https://staging.idbots.world`, `nativeBridgeVersion=1`, `document-start`, `platform=android`, `shell=capacitor`, `os=android` |
| Capability honesty | `android-bootstrap.json`: App state/back/external URLs true; camera/photos/files/share/secureScreen false |
| External content leaves privileged WebView | `android-external.json`, `android-external.png`, and `NS0_EXTERNAL_HANDOFF scheme=https host=example.com`; privileged WebView remains on staging |
| Offline/error UI | `android-offline.json` and `android-offline.png`: bundled page, retry present, no native surface, no cached online app |
| Retry | `android-offline.json` and `android-offline-retry.png`: network restored and staging bootstrap re-established |

Commands: `node scripts/android-webview-smoke.mjs bootstrap`, `external`, and `offline` against the forwarded real WebView CDP socket. The offline leg used CDP network emulation, not a cached PWA.

### iOS — iPhone 17 Simulator / iOS 26.5 / WKWebView

| Check | Evidence and result |
|---|---|
| Staging login loads | `ios-staging-login.png`; `ios-bootstrap.log` |
| Bootstrap and client facts | `ios-bootstrap.log`: `nativeBridgeVersion=1`, `document-start`, `platform=ios`, `shell=capacitor`, `os=ios` |
| External content leaves privileged WebView | `ios-external-handoff.log`: `NS0_EXTERNAL_HANDOFF scheme=https host=example.com`; `ios-external-handoff.png` shows Safari at `example.com` |
| Offline/error UI | `ios-offline.png` and `ios-offline.log`: bundled bilingual error UI and `NS0_OFFLINE page=bundled` |
| Retry | `ios-offline-retry.png` and `ios-offline-retry.log`: offline → retry → staging login and bootstrap again |

DEBUG-only smoke commands used `SIMCTL_CHILD_NS0_SMOKE=external`, `offline`, and `offline-retry`. Normal launches and Release builds do not execute these actions.

### PWA / browser

`tests/mobileNativeBootstrap.test.ts` proves the normal browser path needs no adapter and creates no native proof, while Android/iOS validate version, phase, origin, platform, and capabilities before client facts and React use. Mock browser E2E remains 110/110. The deployed staging PWA was not modified; its WebView evidence therefore has `pwaProof: null`, while the branch's new pre-React guard is covered by local tests and production builds.

## 9. Security, Storage, and Log Review

- Exact-origin checks cover HTTPS scheme, host, default/443 port, and userinfo. Lookalike hosts, embedded-userinfo hosts, arbitrary schemes, and external subframes are rejected.
- External main-frame HTTP(S) and Alipay links leave the privileged WebView. External pages do not receive `idbotsNative`.
- Android uses `usesCleartextTraffic=false`, `allowBackup=false`, and minSdk 26. iOS keeps default ATS behavior; no ATS relaxation was added.
- No custom native persistent storage was introduced. Capacitor may keep non-secret binary-version bookkeeping; existing WebView cookies remain in WebView storage and are not copied elsewhere.
- DEBUG logs were inspected. Final `NS0_*` records contain only origin, platform, bridge version, phase, capability booleans, and client facts. No cookie, token, phone number, message content, signed URL, QR payload, mnemonic, provider key, redeem code, or account identifier was logged.
- No keystore, certificate, provisioning profile, `.env`, private-key, or signing-secret files were added.
- Root Electron packaging excludes `mobile-shell/`; root postinstall does not install it.
- `docs/cloud-mobile/01-interface-contracts.md` and `02-ipc-allowlist-v1.md` are unchanged. No CSP, CORS, Origin, gateway, or IPC policy was weakened.

## 10. Explicit NOT RUN and Open Findings

| Item | State / owner |
|---|---|
| Authenticated login, returning login, two-device behavior, logout isolation, and cookie persistence | NOT RUN — owner/staging test account; NS1 acceptance, not claimed by the NS0 login-page proof |
| Physical Android/iOS hardware | NOT RUN — owner device matrix; NS0 evidence is emulator/Simulator only |
| Production-flavor WebView | NOT RUN — no production deployment or release was authorized |
| Signed Android release, TestFlight, store submission | NOT RUN — NS3 and owner credentials |
| Camera, photos, files, system share, permissions, secure screen | NOT RUN — NS2, capabilities correctly report false |
| App-state reconnect/resync, route-aware Android back, keyboard/theme/lifecycle recovery, iOS recharge policy | NOT RUN — NS1 |
| Push notifications | NOT RUN — explicitly outside NS0–NS3 |
| S1 | None found in NS0 scope |
| S2 | One inherited verification blocker: real-C2 Bot lifecycle E2E fails on iPhone and Pixel because `Default model` is selected while `Advanced options` is collapsed. Reproduced twice; 32/34 overall. Blocks full native acceptance until triaged. |
| S3 | No additional NS0 finding recorded |

## 11. Rollback and Next Step

There is no deployed artifact to roll back. Deleting the local APK, Simulator app, or feature branch does not affect staging or production. The remote PWA was not changed or deployed, so no remote-PWA rollback is required. Native-binary and remote-PWA rollback remain separate release concerns for NS3.

Stop for independent NS0 review. Do not start NS1 until the owner accepts and merges NS0 and resolves or explicitly triages the inherited S2 verification blocker.
