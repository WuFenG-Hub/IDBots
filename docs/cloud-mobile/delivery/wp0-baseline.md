# Delivery Note — WP0 Baseline

- **Date:** 2026-10-26
- **Branch:** `feat/cloud-mobile-wp0-baseline`
- **Base:** local `main` at `846316ed530be5d58eca0c323ccd4694567b375d`
- **Status:** implementation complete on branch; not merged, not deployed

## Scope

WP0 establishes the foundation required before WP1:

- real C3 mobile login and production mock elimination;
- complete IPC contract/test coverage with no silent permission change;
- mandatory file-enabled real-gateway coverage;
- deterministic reproductions of the critical Twin/session/permission defects;
- an honest CI/public-environment baseline and explicit NOT RUN items.

The frozen files `01-interface-contracts.md` and `02-ipc-allowlist-v1.md` were not edited. No production system was deployed or modified, and no cloud credentials or user secrets were accessed.

## Commits

| Commit | Change | Evidence |
|---|---|---|
| `a1e3f3d3` | Integrate the existing real C3 login implementation | Real API/error mapping, production mock guard, all current tests preserved |
| `b6ca8892` | Fix real Vite-dev mock detection, quota assertion, and default file matrix | Real dev no longer blanks on `process is not defined`; default file suite runs |
| `9866b129` | Classify four `standingPages:*` channels as explicit N | Exact contract coverage without changing runtime permissions |
| `b6db529f` | Align the long-term immediate-begin test and preserve bound-session quiet behavior | New fallback and quiet-rule tests both pass |
| `6531b51b` | Add 14 expected-defect reproductions and isolated gateway recovery harness | Node/PWA/real-gateway defects reproduce deterministically |

Every commit has a corresponding English on-chain development journal.

## WP0 Requirement Mapping

### 1. Real login and release baseline — DONE on branch

- Real SMS send/verify, `me`, logout, and deletion-request now use C3 with same-origin cookies and typed errors.
- Mock mode is restricted to development/test use. The production build runs `check-mobile-no-mock-notice.mjs`.
- The separate Docker Content-Type change was not duplicated; that behavior already existed on `main`.
- The `package.json` conflict preserved all current mobile/E2E scripts and added real-C3 and mock-notice coverage.
- Real Vite development is safe when `process` is absent: Vite `import.meta.env.PROD`, Node fallbacks, and `typeof process` guards cover all three environments.

### 2. Contract and standard-test baseline — DONE on branch

- Generated contract: 426 methods (`invoke=368`, `on=48`, `value=2`, `send=8`).
- All four unclassified invoke channels (`standingPages:create/list/remove/restore`) are explicit N. No unclassified event channels remain.
- `standingPages:*` was not enabled merely to satisfy a test. Any future enablement requires a CR.
- The old long-term quiet-rule test was updated for the intentional immediate-begin fallback, with a separate bound-session quiet guard.

### 3. Gateway file matrix — DONE on branch

- File delivery is enabled by default. `GW_FIXTURE_FILE=0` is only a deliberate debugging opt-out.
- The file spec uses the same semantics, so the default run cannot silently skip the file case.
- The gateway stream interval is configurable for recovery tests while the acceptance default remains 40 ms.
- The WP0 gateway reproduction runs independently from the original suite to avoid shared-fixture state contamination.

### 4. Critical deterministic reproductions — DONE on branch

There are 14 expected-defect proofs. They pass only while the known defect exists and must become ordinary regression tests as WP1 fixes each behavior.

| Area | Reproduction |
|---|---|
| Twin identity | First chat binds the actual Twin instead of `metabotId=null` |
| Event isolation | Other sessions cannot append, complete, or raise permissions in the visible chat |
| Permission resolution | Unknown remote resolution is not displayed as approval |
| Message projection | `tool_use` and raw thinking are not ordinary Assistant answers |
| Clarification | `AskUserQuestion` renders actual options rather than only JSON allow/deny |
| Send failure | Start failure has a visible recovery state |
| Resync correctness | Older snapshots cannot overwrite newer streamed text |
| Optimistic sends | Identical text alone is not an identity/dedupe key; optimistic order stays correct |
| Active-stream recovery | Running-session status drives live-content recovery without a local streaming flag |
| Reload | Original session title and running state are restored after a full reload |

### 5. Environment and artifact baseline — PARTIAL, explicitly bounded

#### Public staging evidence (read-only)

- `https://staging.idbots.world/health` returned HTTP 200 with `{"ok":true,"db":true,"docker":true}` and HSTS.
- The public login bundle serves `/assets/index-NB9Tw4Xd.js`. It contains the real C3 endpoint and no mock notice/progression.
- This confirms public health and real login wiring. It does not prove the exact app commit, tenant image, gateway tier, or Metaso release.

#### Latest successful CI candidate (not proof of deployment)

GitHub Actions run [`40087718418`](https://github.com/metaid-developers/IDBots/actions/runs/40087718418), on `main` at `1da927ae1a0370a6af58928abfb8837859b70c5d` (2026-10-24), completed build, Trivy, conformance, and push:

- tenant image: `1.0.4-1da927a`;
- control-plane image: `0.1.0-1da927a`;
- contract: `1.0.0`;
- `/readyz` reported `commit=dev`, so build-time commit provenance still needs correction.

This is the latest successful CI candidate found during the review. It is not asserted to be the currently deployed artifact.

#### Production and operator confirmation

- `https://app.idbots.world/health` failed at the TLS handshake. Production health is **NOT VERIFIED**; no bypass was attempted.
- Exact currently deployed tenant/control-plane images, gateway tier, Metaso release, and staging/production parity are not publicly provable. They must be confirmed by an operator before any WP1 deployment.
- No remote state was changed.

## Verification

### Automated checks

| Check | Result |
|---|---|
| Frozen root/nested/control-plane installs | Passed; DSH/MVC patches applied |
| Real-C3 tests | 22/22 passed |
| Main mobile TypeScript group | 128/128 passed |
| i18n/static tests | 3/3 passed |
| `pnpm run build:mobile` | Both bundles, budgets, and production mock elimination passed |
| Control-plane phone loop | 19/19 steps passed, including same-phone return and no tenant recreation during CP restart |
| IPC contract tests | 7/7 passed; generator fresh |
| Long-term baseline tests | 46/46 passed |
| Full `pnpm test` after contract/test disposition | Entire chain passed |
| Pixel mock E2E | 13/13 original scenarios passed, including corrected quota assertion |
| Original real gateway E2E | 2/2 passed without `GW_FIXTURE_FILE` set |
| WP0 expected-defect reproductions | 4 Node + 9 PWA + 1 real-gateway proofs passed in expected-defect mode |
| `pnpm run lint` | Passed |
| `git diff --check` | Passed |

### Runtime/version caveats

- Local verification used Node 26.7.0. The control-plane package declares Node 24, so Node 24 release verification is still required.
- Browser scenarios used installed Google Chrome with a Pixel profile. This is not an iPhone/WebKit result.
- Expected-defect tests prove current broken behavior, not acceptance. WP1 must convert them to normal regression tests as each fix lands.

### NOT RUN / not accepted here

- iPhone/WebKit E2E and physical iPhone Safari/home-screen PWA.
- Physical Android devices and mainland network measurements.
- Real-tenant, real-model task-quality evaluation and real document/skill outcomes.
- Real staging sign-in through the browser UI, payment, SMS, or Alipay.
- Production health/deployment verification and operator confirmation of exact deployed artifacts.
- Any deployment of this WP0 branch.

## Remaining Work for WP1

- Select and bind the actual Twin by default and prove the outgoing runtime context.
- Replace the independent mobile chat hook with shared per-session semantics.
- Isolate all event handling by session and implement authoritative state transitions.
- Reuse desktop Assistant/professional projections and full `AskUserQuestion` behavior.
- Make start/steer/stop/permission failures explicit and recoverable without blind retry.
- Restore sessions/streams/drafts correctly after reconnect, reload, and multi-device resolution.
- Convert every expected-defect proof into a normal passing regression test before claiming WP1 acceptance.

## Notes

- No WP1 behavior fix is claimed by WP0.
- No production permissions were enabled or changed by the explicit-N work.
- No feature branch was deployed, pushed, or merged to `main`.
