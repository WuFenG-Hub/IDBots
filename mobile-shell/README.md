# IDBots Native Mobile Shell — NS0

This package contains the Android and iOS Capacitor shells for the deployed IDBots PWA. It is an independent pnpm package: the repository root `postinstall` does not install it, and Electron does not package it.

NS0 provides only the native foundation:

- staging and production remote-PWA flavors;
- exact-origin privileged navigation and system handoff for approved external links;
- a bundled bilingual offline/error page with retry;
- a versioned native bootstrap installed at document start, before React use;
- Android App/Back plugin scaffolding and iOS shell scaffolding;
- focused static, bootstrap, origin-policy, build, and WebView evidence.

NS1 lifecycle/reconnect/navigation integration, NS2 camera/photos/files/share, push notifications, signing, TestFlight, and release rollout are intentionally not implemented.

## Architecture

Normal use loads `https://staging.idbots.world/` or `https://app.idbots.world/` in the privileged WebView. Existing PWA `fetch`, WebSocket, HttpOnly cookie, and `window.electron`/C2 paths remain unchanged. The shell has no native API client, Agent, LLM, wallet, chain, memory, skill, session, or task implementation.

The bundled `www/` directory contains only the offline/error experience. It is not a cached PWA and has no service worker or offline Agent execution.

The shell installs `window.idbotsNative` at document start on the exact remote origin. The PWA entry guard in `src/mobile/native/` validates its version, origin, platform, phase, and capabilities before React mounts. `window.idbotsMobile` remains a separate client-fact surface. External pages leave the privileged WebView and do not receive the native surface.

## Toolchain

Verified NS0 versions:

| Component | Version / requirement |
|---|---|
| Node.js | `>=24 <27` (verified with 26.7.0) |
| pnpm | 11.24.0 |
| Capacitor core / CLI / Android / iOS | 8.5.3 |
| `@capacitor/app` | 8.1.2 |
| Android JDK | 21 |
| Android Gradle Plugin | 8.13.0 |
| Gradle | 8.14.3 |
| AndroidX WebKit | 1.14.0 |
| Android compile / target SDK | 36 |
| Android minimum SDK | 26 (Android 8) |
| Xcode | 26.0 or later (verified with 27.1) |
| CocoaPods | 1.16.x |
| iOS deployment target | 15.0 or later |

Install this package explicitly:

```bash
cd mobile-shell
pnpm install --frozen-lockfile
```

Set `JAVA_HOME` to a JDK 21 installation and `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) to the Android SDK. Android builds use `mobile-shell/.tooling/gradle` as `GRADLE_USER_HOME`, keeping generated caches inside this package. The build script also recognizes the optional local JDK at `.tooling/jdk-home/Home`; `.tooling/` is ignored and never committed.

If the host uses an HTTP(S) proxy, Java does not necessarily inherit the desktop setting. Supply standard non-secret Java proxy properties through `JAVA_TOOL_OPTIONS` and `GRADLE_OPTS`, for example `-Dhttps.proxyHost=<host> -Dhttps.proxyPort=<port>`. Do not place proxy credentials in this repository or delivery notes.

CocoaPods commands require UTF-8 locale settings. The iOS build script supplies `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8`.

## Flavors

Staging is the default. Production is always an explicit command.

| Flavor | Remote origin | Android variant |
|---|---|---|
| `staging` | `https://staging.idbots.world/` | `stagingDebug` |
| `production` | `https://app.idbots.world/` | `productionDebug` |

`scripts/select-flavor.mjs` updates `capacitor.config.json`, copies the shared bootstrap template into both native projects, and writes the iOS `NativeShellFlavor.plist`. Android also has native `staging` and `production` product flavors whose `BuildConfig.NATIVE_REMOTE_ORIGIN` is authoritative for navigation and bootstrap. Production selection does not deploy anything.

```bash
pnpm run sync                 # staging, both platforms
pnpm run sync:staging
pnpm run sync:production      # explicit production selection

pnpm run build:android        # staging debug APK
pnpm run build:android:staging
pnpm run build:android:production

pnpm run build:ios            # staging Simulator debug app
pnpm run build:ios:staging
pnpm run build:ios:production
```

NS0 iOS builds are Simulator Debug builds with `CODE_SIGNING_ALLOWED=NO`. Production-flavor debug builds are not production releases. No signing key, Apple credential, store submission, TestFlight upload, staging deployment, or production deployment is used.

For a particular iOS Simulator, set `IDBOTS_IOS_DESTINATION`, for example `platform=iOS Simulator,id=<device-udid>`.

## Verification

```bash
pnpm test
cd android && ./gradlew --no-daemon testStagingDebugUnitTest
```

Run the repository regression checks from the root after changing `src/mobile/`:

```bash
pnpm test
pnpm run test:mobile
pnpm run lint
pnpm run build:mobile
pnpm run build:skills
pnpm run test:e2e:mobile
pnpm run test:e2e:mobile:gateway
```

## NS0 Native Surface

`nativeBridgeVersion` is `1`. `getCapabilities()` returns a fresh object with these values:

| Capability | NS0 value | Meaning |
|---|---|---|
| `camera`, `photos`, `files`, `share` | `false` | NS2 is not implemented |
| `appState` | `true` | `@capacitor/app` is present; reconnect/resync wiring is NS1 |
| `backButton` | Android only | App plugin scaffolding exists; existing-route integration is NS1 |
| `externalUrls` | `true` | Native exact-origin policy and system handoff are implemented |
| `secureScreen` | `false` | No secure-screen claim is made |

The bootstrap also records `phase: 'document-start'`, the expected origin, and the platform. The PWA adds a separate `before-react` proof after validation. Browser and PWA execution do not require or synthesize `window.idbotsNative`.

## DEBUG WebView Smoke

DEBUG builds log only non-secret bootstrap fields: origin, platform, bridge version, phase, capability booleans, and client facts. They do not log cookies, query strings, account identifiers, phone numbers, message content, signed URLs, or native storage.

For iOS Simulator smoke runs, `NS0_SMOKE` is honored only in DEBUG and only when explicitly supplied:

```bash
SIMCTL_CHILD_NS0_SMOKE=external xcrun simctl launch booted world.idbots.app
SIMCTL_CHILD_NS0_SMOKE=offline xcrun simctl launch booted world.idbots.app
SIMCTL_CHILD_NS0_SMOKE=offline-retry xcrun simctl launch booted world.idbots.app
```

- `external` asks the privileged WebView to navigate to `https://example.com/`; native policy cancels it and hands it to the system browser.
- `offline` presents the bundled error page.
- `offline-retry` presents the bundled page and activates its retry button, returning to the staging login page.

For Android, enable WebView debugging in the DEBUG build, forward its DevTools socket, then run the CDP smoke script:

```bash
adb forward tcp:9222 "localabstract:webview_devtools_remote_$(adb shell pidof world.idbots.app | tr -d '\r')"
node scripts/android-webview-smoke.mjs bootstrap
node scripts/android-webview-smoke.mjs external
node scripts/android-webview-smoke.mjs offline
```

The Android smoke checks the actual staging bootstrap, verifies that external navigation leaves the privileged WebView, emulates an unreachable network, captures the bundled offline page, and restores the network before activating retry.

Normal launches and Release builds do not run these actions. Screenshots and logs belong in `mobile-shell/artifacts/`, which is ignored and outside git.

## Storage and Secrets

NS0 adds no custom native persistent storage and no native preferences for account or product data. Capacitor may keep non-secret binary-version bookkeeping; the WebView owns the existing HttpOnly session cookie. No session cookie is copied into native preferences, files, logs, JavaScript bridge values, or analytics.

Do not place signing keys, Apple credentials, device tokens, phone numbers, message contents, mnemonics, provider keys, redeem codes, payment QR payloads, signed file URLs, or session tokens in this package or its evidence.
