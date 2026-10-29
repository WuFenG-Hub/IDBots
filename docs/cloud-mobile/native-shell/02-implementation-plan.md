# Native Shell Implementation Plan

## 1. Execution Rules

Implement NS0–NS3 in order. Each package uses a new branch and same-named worktree from current `main`; never branch from another feature branch. Keep PWA fixes and native-shell packages independently mergeable.

The development Agent starts at NS0 and stops for owner review/merge before starting NS1. Do not turn the whole native program into one large branch.

For every package:

1. Read `AGENTS.md`, `docs/cloud-mobile/HANDOFF.md`, and this native-shell package.
2. Confirm current `main` and create the branch/worktree using the name below.
3. Use pnpm only. Keep `mobile-shell/` dependencies and lockfile separate; do not add the native package to root `postinstall` or Electron packaging.
4. Keep code, UI copy, documentation, and commit messages in English; user-facing mobile strings support English and Chinese through the existing i18n pattern.
5. Add focused tests to the existing test conventions and run the relevant root/mobile regression gates.
6. Commit independently verifiable units and publish the required English `metabot-post-buzz` journal for every commit.
7. Supply a delivery note with exact commits, commands/results, device/build evidence, and explicit NOT RUN items.
8. Do not push, merge, deploy, access owner secrets, submit to a store, or release to users without explicit owner authorization.

## 2. NS0 — Native Shell Foundation

**Branch:** `feat/mobile-shell-foundation`
**Worktree:** `.worktrees/mobile-shell-foundation`

### Build

- Create `mobile-shell/` as a separate pnpm package with its own `package.json`, `pnpm-workspace.yaml`, and lockfile.
- Add the Capacitor Android and iOS projects using versions compatible with the repository's supported Node range and the available Android/Xcode toolchains. Confirm the selected plugin/toolchain versions rather than assuming them.
- Add staging and production flavors for the remote origins in `01`. The default development flavor is staging; production must be an explicit build choice.
- Configure exact-origin navigation restrictions, HTTPS-only remote loading, system handoff for Alipay/QR/external links, and a bundled offline/error page.
- Add Android app/back scaffolding and iOS shell scaffolding without adding product business logic.
- Establish a minimal versioned native-adapter bootstrap. Prove on both WebViews that the adapter/capability surface exists before remote React mounts and that the existing `window.idbotsMobile.shell` resolves to `capacitor`.
- Add debug build commands and a `mobile-shell/README.md` covering toolchain setup, flavors, build commands, and secret-free operation.
- Update root `AGENTS.md` and `CLAUDE.md` package-manager guidance together.

### Required NS0 Proof

A WebView screenshot alone is insufficient. Demonstrate:

- the staging login/PWA loads inside Android and iOS;
- the privileged native surface is unavailable to an external page;
- the offline/error page appears when the remote origin cannot be reached;
- `shell === 'capacitor'`, OS detection is correct, and adapter bootstrap happens before application use;
- the normal browser/PWA path still works with no native adapter.

### Verification

- `mobile-shell` install, static/config tests, and Android/iOS debug builds where the toolchain exists.
- Existing `pnpm test`, `pnpm run test:mobile`, lint, mobile/skills builds, and both mobile E2E profiles for any root-code change.
- Real Android/iOS WebView smoke evidence; an unavailable SDK/device is NOT RUN and blocks native acceptance, not something to mark as passed.

### Exit

NS0 is a small reviewable foundation with reproducible builds and the two-platform bootstrap proof. No camera, share, push, or broad lifecycle refactor is pulled into this branch.

## 3. NS1 — Native Lifecycle and Navigation

**Branch:** `feat/mobile-native-lifecycle`
**Worktree:** `.worktrees/mobile-native-lifecycle`

### Build

- Implement the typed local adapter and web fallback from `01`, with `nativeBridgeVersion` and capability detection.
- Connect native foreground/background events to the existing gateway `reconnectNow()` and resync flow without duplicating non-idempotent actions.
- Wire Android back into the existing mobile route/sheet/navigation state; do not maintain a second navigation history.
- Route approved external links and Alipay handoff through native system capabilities while preserving PWA behavior.
- Verify WebView login cookie persistence, returning login, logout isolation, and no token in native storage/logs.
- Handle keyboard, safe areas, dark/light themes, offline/reconnect banners, and OS eviction through the existing authoritative session recovery.
- Hide recharge in the iOS native shell only; keep it in PWA/Android as currently specified.

### Verification and Exit

- Unit coverage for adapter presence/absence, version/capability fallback, app-state subscriptions, back handling, and iOS recharge policy.
- Existing mock and real-C2 suites on iPhone WebKit and Pixel Chromium.
- Android and iOS shell runs covering login, ordinary chat, older-session restore, background/foreground, network recovery, back, and logout.
- No duplicate/lost messages, blind retries, new native API client, or business logic moved into the shell.

## 4. NS2 — Native Media and System Capabilities

**Branch:** `feat/mobile-native-capabilities`
**Worktree:** `.worktrees/mobile-native-capabilities`

### Build

- Implement native camera/photo/file selection through the adapter. Return `File`/`Blob` values into the existing attachment pipeline.
- Preserve multi-file ordering, per-session drafts, 25 MB refusal, image re-encoding, progress, cancellation, typed errors, and refusal rollback.
- Implement native system artifact sharing with current signed URLs. Use native file sharing only where URL sharing is insufficient; never persist or log signed tokens unnecessarily.
- Keep Web Share, clipboard, browser picker, download, and open-new-tab fallbacks working.
- Add permission-denied, cancellation, unsupported-capability, expired-link, and native-failure states without duplicate effects.
- Exercise safe areas, photo permission prompts, external payment handoff, and app backgrounding during selection/share.

### Verification and Exit

- Adapter tests for all result/error categories and browser fallbacks.
- Existing attachment/artifact tests plus native integration coverage.
- On physical devices where available: camera photo, gallery photo, a 20 MB PDF, a rejected 26 MB file, image/PDF/Markdown/other artifact preview/download/share, and expired-link refresh.
- Chat remains mounted and the correct session/upload/artifact identity survives every path.

## 5. NS3 — Native Release Candidate and Device Acceptance

**Branch:** `feat/mobile-shell-release`
**Worktree:** `.worktrees/mobile-shell-release`

### Build and Verify

- Add reproducible Android version-name/version-code handling and release build instructions. Signing keys stay with owner/operations.
- Prepare signed APK and TestFlight candidates only when the owner supplies the authorized signing path. Otherwise report signing/TestFlight as NOT RUN.
- Add or update CI checks for the independent package without making root Electron or tenant builds depend on Xcode/Android SDK.
- Complete `03-acceptance-and-handoff.md`, including the required physical-device and PWA regression matrix.
- Record application source SHA, native package version, native bridge version, remote origin, C2 contract version, plugin versions, and build artifact hashes.
- Supply a native release/rollback runbook. A remote-PWA rollback and a native-binary rollback are separate actions and must both be described.

### Exit

No open S1/S2 in the native scope, core staging journeys accepted, physical-device evidence complete, and owner sign-off. A successful debug build is not a production release.

## 6. Standard Verification Matrix

Run the applicable layers for every package and record actual counts, not historical results.

| Layer | Required checks |
|---|---|
| Native package | Frozen pnpm install, type/static tests, adapter tests, configuration/origin tests, Android build, iOS build |
| Root/mobile | `pnpm test`, `pnpm run test:mobile`, lint, `build:mobile`, `build:skills`, DSH checks when root runtime code changes |
| Browser regression | Existing Mock and real-C2 E2E on iPhone WebKit and Pixel Chromium for shared PWA changes |
| WebView integration | Login, adapter bootstrap, navigation restrictions, offline page, app-state recovery, back, and logout |
| Physical devices | Camera/files/share/keyboard/safe areas, OS eviction, real network, and core A-scenarios applicable to the package |
| Security | No secrets/tokens in native storage or logs, no arbitrary-origin bridge, no weakened CSP/CORS/gateway policy |

## 7. Reference Material

- Existing native requirements: `docs/cloud-mobile/50-ws-e-mobile-client.md` REQ-E-22–24 and AC-E-8/9.
- Original shell sequence: `docs/cloud-mobile/51-ws-e-implementation-plan.md` T5.
- Current PWA/staging acceptance: `docs/cloud-mobile/delivery/internal-test-release.md`.
- Procurement and owner credentials: `docs/cloud-mobile/15-ops-procurement.md`.
- Main mobile implementation: `src/mobile/` and `vite.mobile.config.ts`.
- Capacitor official documentation for the exact version selected during NS0; record that version and any platform-specific behavior in the delivery note.
