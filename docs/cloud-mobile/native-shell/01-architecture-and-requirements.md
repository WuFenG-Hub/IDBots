# Native Shell Architecture and Requirements

## 1. Product Outcome

Android and iOS users can choose a native IDBots app while retaining the same account, Twin Bot, sessions, tasks, files, wallets, and cloud execution as the PWA. The PWA remains available in browsers and as an installable home-screen app.

The native app is a **thin system shell around the remote PWA**, not a new product backend and not a second feature implementation. Most PWA UI and cloud fixes must reach native users through normal tenant/control-plane deployment without rebuilding the native apps.

## 2. Why the Code Stays in IDBots

`mobile-shell/` is a separate pnpm package inside this repository, not a separate product repository.

| Reason | Requirement |
|---|---|
| One compatibility surface | Native-capability types and their PWA consumer can be reviewed and changed in the same commit. |
| One release source | C2, PWA, tenant, control plane, and native-shell source revisions remain traceable to one `main` SHA. |
| Independent build isolation | `mobile-shell/` has its own `package.json`, `pnpm-workspace.yaml`, lockfile, Android/iOS projects, and toolchain. It is not packaged into Electron. |
| No duplicate product logic | Shared mobile adapter code lives under `src/mobile/`; native-only code lives under `mobile-shell/`. |
| Safe parallel development | PWA and shell changes merge independently in small packages while retaining one review and acceptance history. |

When the package is introduced, update the Package Manager section of root `AGENTS.md` and the byte-synchronized `CLAUDE.md` in the same commit. The root `postinstall` must not silently install the native mobile toolchain.

## 3. Runtime Ownership

```text
Android / iOS native shell
  ├─ Native plugins and platform navigation/security
  ├─ Local typed native-capability adapter
  └─ WebView → remote PWA
                    ↓ window.electron shim / C2
                 Control plane
                    ↓
                 Headless IDBots tenant
                    ├─ Agent, LLM, skills, memory
                    ├─ Wallet and chain writes
                    └─ Sessions, tasks, files, and workspaces
```

The desktop and tenant continue to share the IDBots main-process cores. The shell must not implement model calls, prompt construction, wallet operations, chain signing, Agent orchestration, memory, skills, or durable task state. The control plane must not acquire those responsibilities either.

## 4. Current Code to Reuse

| Existing code | Native-shell use |
|---|---|
| `src/mobile/bridge/installShim.ts` | Installs the C2-backed `window.electron` surface and already detects `pwa`, `capacitor`, and `browser`. |
| `src/mobile/bridge/idbotsMobile.d.ts` | Existing client facts: `isMobile`, `os`, and `shell`. Keep these facts separate from native capabilities. |
| `src/mobile/app/appBridge.ts` | Existing connection facade, `reconnectNow`, and reconnect notifications for app-state recovery. |
| `src/mobile/bridge/gatewayClient.ts` | Existing C2 connection, backoff, version guard, in-flight uncertainty, and resync behavior. Do not create a native HTTP/WebSocket client. |
| `src/mobile/bridge/installShim.ts` upload handling | `dialog.selectFile` currently turns selected files into the existing upload flow. Native selection must feed this path rather than upload separately. |
| `src/mobile/app/hooks/useChatAttachments.ts` | Existing attachment state, progress, ordering, failure, and session binding. Preserve it unchanged except for adapter integration where necessary. |
| `src/mobile/app/artifacts.ts` | Existing `ArtifactShareDriver`, signed-URL sharing, cancellation, and clipboard fallback. |
| `src/mobile/app/components/MobileArtifactPreview.tsx` | Existing preview/share UI. It must consume an adapter rather than call Capacitor directly. |
| `vite.mobile.config.ts` | Produces `dist-mobile/` for the tenant and `dist-mobile-login/` for the control plane. Native apps consume the deployed outputs, not a forked build. |
| `deploy/tenant-image/` and `cloud/control-plane/` | Serve the version-matched PWA and login bundle. No native-only business endpoints are required for NS0–NS2. |

There is currently no `mobile-shell/` implementation. Existing Capacitor detection is preparation, not evidence that native integration already works.

## 5. Remote Loading and Update Rules

1. Provide explicit staging and production flavors:
   - staging: `https://staging.idbots.world/`
   - production: `https://app.idbots.world/`
2. The initial route may be `/`; login then enters `/app/` through the existing product flow. Do not hard-code a bypass around login.
3. Restrict WebView navigation to the intended HTTPS origin. Open Alipay, QR payment, and approved external HTTP(S) links through the system browser/application as appropriate.
4. Never allow arbitrary web content to acquire the native bridge. Any external page must leave the privileged WebView context.
5. Keep normal network traffic in the PWA's existing `fetch` and WebSocket paths so C3 cookies, C2 semantics, and existing uncertainty handling remain identical. Do not reimplement those calls with a separate native HTTP stack.
6. Bundle only a small offline/error experience. No service worker or second cached online PWA is introduced in this release.
7. Ordinary PWA changes deploy without an APK/TestFlight update. Native releases are required only for native plugin, adapter, security, navigation, or platform changes.

## 6. Local Native Adapter v1

Introduce a typed **local** adapter under `src/mobile/` with a shell-owned implementation and a complete web fallback. It is not a C2 channel and must not be added to the frozen IPC allowlist.

Use a distinct versioned surface, for example `window.idbotsNative`, while retaining `window.idbotsMobile` for client facts. The exact implementation may use Capacitor plugin proxies or a custom plugin, but NS0 must prove that the chosen surface is installed before the remote React app mounts on both Android and iOS.

Required capability areas:

```ts
interface MobileNativeBridge {
  nativeBridgeVersion: 1;
  getCapabilities(): {
    camera: boolean;
    photos: boolean;
    files: boolean;
    share: boolean;
    appState: boolean;
    backButton: boolean;
    externalUrls: boolean;
    secureScreen: boolean;
  };
  pickPhoto?(): Promise<File | null>;
  pickFiles?(): Promise<File[]>;
  shareArtifact?(input: { url: string; filename: string }): Promise<'shared' | 'cancelled'>;
  openExternal?(url: string): Promise<void>;
  onAppStateChange?(callback: (active: boolean) => void): () => void;
  onBackButton?(callback: () => boolean): () => void;
  setSecureScreen?(enabled: boolean): Promise<void>;
}
```

This is a local TypeScript contract illustration, not permission to paste Capacitor calls throughout components. The implementation may refine names/types when the platform requires it, but it must preserve these semantics:

- `File`/`Blob` objects cross the PWA adapter; tenant container paths never cross into native pickers.
- Native files continue through the existing size checks, image re-encoding, ordered upload progress, attachment drafts, and C2 `/upload` route.
- Sharing consumes current signed artifact URLs and preserves cancellation, failure, clipboard, and web-share fallbacks. Never expose raw `/data` paths.
- Distinguish `cancelled`, `permission-denied`, `unavailable`, and `failed`. Cancellation is not a red error and unsupported capabilities degrade honestly.
- App-state activation invokes the existing reconnect/resync flow. It must not blindly retry session starts, submissions, orders, or chain writes.
- Android back maps to existing UI navigation and returns whether the event was handled.
- Components use the adapter, not `window.Capacitor` or plugin imports directly.
- `nativeBridgeVersion` and capability detection are independent of the C2 contract version. Unknown capabilities fall back instead of crashing.

Do not add Capacitor runtime dependencies to desktop renderer/main code. Keep plugin ownership in `mobile-shell/`; if the PWA consumes globals, provide narrow local typings and a bootstrap proof rather than assuming an injection mechanism works on a remote `server.url`.

## 7. Authentication and Data Rules

- Reuse the existing HttpOnly session cookie inside the WebView. Do not copy it into native preferences, files, logs, JavaScript bridges, or analytics.
- Logout must clear the relevant WebView session state without affecting another device. Verify returning-login behavior on both platforms.
- No mnemonic, provider key, redeem code, payment QR payload, signed file token, phone number, or message content in native logs or persistent native storage.
- Native preferences may contain only non-secret flavor/UI state explicitly justified in the delivery note.
- Sensitive mnemonic export is outside NS0–NS2. When later enabled, Android screenshot blocking and iOS background/app-switcher masking are required; do not claim iOS can reliably prevent screenshots.
- Preserve existing CSP, CORS, Origin, and gateway restrictions. Do not weaken them to make the WebView work.

## 8. Platform Requirements

- Android minimum version 8; version code increases for every release candidate.
- iOS TestFlight uses the same remote-PWA shell. Hide recharge in the iOS native shell while keeping it in the web app; the existing `os` and `shell` facts should drive that policy.
- Support camera/photo permissions with useful denial copy and no crashes when the user cancels.
- Support system share, app state, Android back, external URL launch, safe areas, keyboard behavior, and an offline error page.
- No public App Store or Android market submission in this program. Signing credentials and TestFlight access come from the owner/operations checklist.

## 9. Frozen Boundaries and Later Push

Do not edit `01-interface-contracts.md` or `02-ipc-allowlist-v1.md` for local shell capabilities. If a requirement needs a new server/API behavior, file a change request.

Reliable APNs/FCM push is a separate server-plus-shell work package involving device-token lifecycle, event routing, privacy, deep links, and real provider credentials. Do not represent WebSocket activity while the app happens to be alive as reliable closed-phone push.
