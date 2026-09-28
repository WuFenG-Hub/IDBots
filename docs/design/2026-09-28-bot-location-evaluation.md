# Host Location Capability for MetaBot — Evaluation

Date: 2026-09-28
Branch: `feat/bot-location`
Status: v1 implemented — coarse IP layer + consent-gated precise OS layer
(`get_host_location` tool; see `src/main/services/hostLocationService.ts`,
`src/main/libs/locationAgentTools.ts`). The address-book layer is deferred and
will be planned together with other user-profile features.

## 1. Background and problem

Origin: an online conversation (`IDBots://e38b5e18-8dcf-43f1-bb88-255151188b96`) in which a
local bot tried to order coffee from a Luckin-style service. The bot had no idea where the
user's machine was, so it invented a delivery address ("Hangzhou, West Lake") while the user
was actually in Zhongshan, Guangdong. Any real-world service booked through the Agent
Internet — coffee, food delivery, movie tickets, shopping — needs the user's location, and
delivery additionally needs a recipient address and phone number.

Today the only location signal that reaches a bot is the machine timezone
(`src/main/libs/dshKernel/clientTimeZone.ts` → `timeContext`), plus whatever the `weather`
skill infers from IP via wttr.in. There is no explicit location capability: zero matches for
`geolocation` / `getCurrentPosition` / `NSLocation` in `src/`, `build/`, or
`electron-builder.json`.

## 2. Field tests (run on the target machine, Zhongshan, Guangdong, 2026-09-28)

### 2.1 IP-based geolocation over HTTP

| Provider | Key needed | Result | Verdict |
|---|---|---|---|
| BigDataCloud `api.bigdatacloud.net/data/reverse-geocode-client` | No (HTTPS, keyless) | **广东省 / 中山市 / 东区街道** — correct down to the district/street level, plus timezone and admin codes | Best keyless option measured |
| ip-api.com `/json/?lang=zh-CN` | No (free tier is **HTTP only**) | 中国 / 广东 / 中山, lat/lon at city center | Solid fallback; city-level only |
| ipinfo.io | No | Reported **Guangzhou** — wrong city for this IP | Not reliable enough for CN IPs |
| ipapi.co | No | Cloudflare bot challenge, unusable server-side | Rejected |
| Baidu `qifu-api.baidubce.com/ip/local/geo/v1/district` | No | `Resource not found` — endpoint appears dead | Rejected |
| AMap (高德) `restapi.amap.com/v3/ip` / Tencent (腾讯) `apis.map.qq.com/ws/location/v1/ip` | Free API key | Not tested (needs key signup) | Best long-term CN option; district-level with Tencent |

Conclusion: keyless IP geolocation already delivers city-level accuracy reliably and
district-level accuracy in the best case (BigDataCloud correctly returned 东区街道, matching
the user's actual location). Good enough for "find coffee near me", **not** good enough for
a delivery address.

### 2.2 OS-native precise geolocation (macOS CoreLocation)

A Swift script using `CLLocationManager` was run directly on this machine:

```
locationServicesEnabled: true
AUTH_STATUS: 0 (notDetermined)
ERROR: The operation couldn't be completed. (kCLErrorDomain error 1.)
```

Location services are enabled on the machine, but a bare CLI process has no app bundle with
`NSLocationWhenInUseUsageDescription`, so CoreLocation refuses the request. **Conclusion:
precise location must be acquired from inside the bundled IDBots Electron app** (which can
declare the usage description and trigger the TCC prompt), not from a spawned helper process.

## 3. Options considered

### A. IP geolocation (coarse, no consent) — recommended as the default layer

- Works today from the Electron main process with a plain `fetch`; the app's system-proxy
  handling (`src/main/main.ts:585` `applySystemProxyWithLoopbackBypass`) already applies.
- No OS permission, no user interaction, works identically on macOS and Windows.
- Accuracy: city (always) to district (provider-dependent). Lat/lon is the IP's registered
  point, not the machine.
- Provider strategy: BigDataCloud keyless client API as primary, ip-api.com as fallback;
  allow plugging in a keyed AMap/Tencent provider later for CN users.

### B. OS-native precise geolocation (opt-in) — recommended as the consent-gated layer

- Electron renderers expose `navigator.geolocation`. On macOS Chromium calls CoreLocation
  (Wi-Fi positioning, tens-to-hundreds of meters); on Windows 10+ it uses the Windows
  Location service. No Google API key needed on these two desktop platforms.
- Required changes: add `NSLocationWhenInUseUsageDescription` to `mac.extendInfo` in
  `electron-builder.json` (currently absent — confirmed both in config and in the shipped
  `release/mac-arm64/IDBots.app/Contents/Info.plist`). The macOS location entitlement
  (`com.apple.security.personal-information.location`) is only needed if sandbox is ever
  enabled; the current entitlements file is a non-sandboxed set.
- Implementation: a hidden `BrowserWindow` (or the main window's renderer) calls
  `navigator.geolocation.getCurrentPosition`, the main process receives the fix over IPC and
  reverse-geocodes it.
- **Coordinate caveat for China**: CoreLocation/Windows return WGS-84; AMap/Tencent maps use
  GCJ-02. Reverse-geocoding a WGS-84 fix against a GCJ-02 provider without conversion shifts
  the address by ~100–600 m. Either convert (well-known public algorithm) or reverse-geocode
  with a WGS-84-friendly provider (BigDataCloud / OSM Nominatim).

### C. Wi-Fi SSID lookup — rejected

macOS 14+ redacts the current SSID unless the process already holds location permission, and
there is no maintained keyless SSID→location database. It also fails on desktops without
Wi-Fi.

### D. User-managed address book (delivery-grade) — recommended as the address source of truth

No automated method can produce the recipient name, phone number, building/floor, or campus
gate that a delivery order actually needs. Add an address book to user settings (labels like
"home"/"office", recipient, phone, full address, optional coordinates, default flag). The
bot's job becomes: confirm which saved address to use, or ask the user to dictate one. This
aligns with the user's own suggestion of a settings-based address and is the only layer that
is accurate enough to order against.

## 4. Recommended architecture (three layers, one tool)

```
get_host_location(granularity: "coarse" | "precise")
        │
        ├─ coarse (default, no prompt)
        │    1. default address from the address book (if set)  → source: "address-book"
        │    2. cached IP geolocation (TTL ~6h)                 → source: "ip"
        │
        └─ precise (consent-gated)
             1. in-app permission request (existing permission flow)
             2. OS geolocation via hidden renderer (macOS CoreLocation / Windows Location)
             3. reverse-geocode → street-level address
             4. fall back to coarse on denial/failure
```

Codebase mapping (all precedents verified in `main` @ `fffba251`):

| Piece | Where | Precedent to copy |
|---|---|---|
| New host tool `get_host_location` | new `src/main/libs/locationAgentTools.ts`, registered in `buildSessionInlineTools` (`src/main/libs/coworkRunner.ts:9371`, next to `buildScreenshotAgentTools` at `:10195`) | `src/main/libs/screenshotAgentTools.ts`, `browserOpenAgentTools.ts` |
| Host capability | `LocationHost` control interface implemented in `main.ts`, injected via `new CoworkRunner(store, {...})` (`src/main/main.ts:5209`) | `screenshotHost` injection |
| Location resolution + cache | new `src/main/services/hostLocationService.ts` | timeout-bounded fetch: `src/main/services/localIndexerProxy.ts:48`; retry classification: `src/main/services/llmFetch.ts` |
| Consent for `precise` | existing permission-request flow `requestSafetyApproval` (`src/main/libs/coworkRunner.ts:6155`); fail closed for unattended sessions (precedent `withSkillInstallApproval`, `:6234`) | delete-confirmation and skill-install approval consumers |
| Address book storage | new table or kv entry in `userData/idbots.sqlite` with an idempotent first-run migration (per the Database Upgrade Safety rules in AGENTS.md) | `user_identity` store `src/main/userIdentityStore.ts` |
| Address book UI | new section in `src/renderer/components/user/UserSettings.tsx` | existing profile editors |
| macOS permission declaration | `electron-builder.json` → `mac.extendInfo` → `NSLocationWhenInUseUsageDescription` | existing `NSCalendarsUsageDescription` entry |
| Optional skill access | one route on the local RPC gateway `src/main/services/metaidRpcServer.ts` (`/api/idbots/host/location`) so skill scripts can reuse the same service | existing `*_PATH` route constants at `:106-154` |

No `dsh-runtime/` change and no runtime restart is needed: host tools ride `session/ensure`
and are bridged over the existing JSON-RPC host-tool channel
(`dsh-runtime/plugins/idbots-sdk-server.mjs` ↔ `src/main/libs/dshKernel/dshKernel.ts`).

## 5. Privacy and product rules (proposed)

- `coarse` never prompts; `precise` always requires explicit user consent in the app, in
  addition to the OS prompt. A settings toggle ("Allow bots to request precise location")
  can pre-authorize trusted sessions; unattended/A2A sessions (e.g. service-order profile)
  fail closed to `coarse`.
- Results are cached, never logged beyond the session, and the tool response always includes
  `source` and `accuracy` so the model can judge how much to trust it (and must not present
  an IP-based city as a delivery address).
- Delivery flows must prefer the address book; automated location is context, not an address.

## 6. Open questions

1. Sign up for keyed CN providers (AMap/Tencent) or stay keyless (BigDataCloud + ip-api) for
   v1? Keyless is zero-friction but rate-limited and ToS-bound.
2. Reverse-geocoding provider for the precise layer: BigDataCloud (keyless, WGS-84-safe)
   vs AMap (better CN addresses, needs GCJ-02 conversion).
3. Should the address book live on-chain (MetaID profile) later, or stay local-only?
4. Address book schema: single default address vs multiple labeled addresses for v1.
5. i18n of provider responses (BigDataCloud supports `localityLanguage=zh`; ip-api supports
   `lang=zh-CN`) — pick by app language.

## 7. Suggested next steps

1. v1: `hostLocationService` (IP layer only) + `get_host_location` tool + `source`/`accuracy`
   reporting — shippable without any OS permission work.
2. v2: address book in user settings + prompt the bot to prefer it in delivery scenarios.
3. v3: precise layer (hidden-renderer geolocation, `NSLocationWhenInUseUsageDescription`,
   consent flow, WGS-84→GCJ-02 conversion, reverse geocoding).
