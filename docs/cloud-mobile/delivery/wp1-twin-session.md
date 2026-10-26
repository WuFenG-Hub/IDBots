# Delivery Note — WP1 Twin Session Foundation

- **Date:** 2026-10-26
- **Branch:** `feat/cloud-mobile-wp0-baseline` (WP1 continues on the verified WP0 branch)
- **Base:** WP0 delivery at `e4a82807`; local `main` remains `846316ed`
- **Status:** implementation and deterministic verification complete on branch; real-environment acceptance pending
- **Acceptance:** not accepted, not merged, not deployed

## Scope

WP1 makes the PWA conversation genuinely Twin-bound and replaces the independent mobile streaming demo state with shared desktop/mobile semantics:

- actual Twin selection, first-run greeting, and desktop-equivalent start defaults;
- per-session event isolation, raw-record retention, shared Assistant/professional projection, sequence-gap healing, and stable-ID/revision/epoch recovery;
- authoritative start/steer/stop/permission actions, UUID existing-session submissions, and explicit failed/uncertain outcomes;
- full desktop permission and clarification interactions on mobile;
- running-session/title/live-stream restore, explicit-new and per-session drafts, active-tab restoration, and history pagination through later snapshots.

Frozen files `01-interface-contracts.md` and `02-ipc-allowlist-v1.md` were not changed. `cowork:session:prewarmTurnSlot` remains disabled for mobile. No production or staging system was deployed or modified, no cloud credentials or user secrets were accessed, and no push or merge was performed.

## WP1 Commits and Development Journals

| Commit | Change | On-chain journal pin |
|---|---|---|
| `ab100227` | Share desktop conversation projection | `94473e0fcb12bf95293292aaade12938324b3aa6e93066e8251c37bbb415b802i0` |
| `d4c5f593` | Share per-session state semantics and desktop Redux updates | `605d59f91c13790c9e509320e6f4dc1396168d55e8d41682f1abcda461aaedc3i0` |
| `ee176805` | Rebuild the Twin chat session foundation | `f76cf94af084f269a4bdbcd0902cf3801ad9c587cd3751c1d8aff2fab5e273fai0` |
| `c0678913` | Restore first-run Twin greeting | `192ef0d665a565af7fe65f8ff027ebb844ee5d93fb2be27911ced7e4513ac7fbi0` |
| `5081d41d` | Add full permission and clarification journeys | `1208a48c41bc7b8174c987a8b43798db4ea5a00e10a9d5fd1eac6ca4d2e79fefi0` |
| `dcae1050` | Preserve chat recovery state, drafts, tabs, and history | `3bbc122cba442e65ba45949c23f6647e04cc7059b3f616839e5e894dc8b7bac9i0` |

## Requirement Mapping

The rows separate deterministic implementation evidence from real-environment acceptance. A canned gateway proves transport/rendering/recovery, not model quality.

| Scenario | Deterministic evidence | Real-environment status |
|---|---|---|
| P2-01 login → ready → first chat | WP0 real C3 implementation/tests remain intact. First chat passes the actual Twin ID; sanitized main-process tests prove persona, brain, skills, memory scope, and per-Bot workspace. First-run greeting is covered on mock and real C2. | Real staging sign-in and a real tenant runtime-context capture are **NOT RUN**. |
| P2-02 ordinary chat and follow-up | Streaming Markdown, owner progress, title/history, follow-up submission, and Assistant projection pass on mock and real C2. | Real-model answer quality, model choice, and real skill outcomes are **NOT RUN**. |
| P2-03 two user sessions + background work | Controller and PWA tests prove background text, completion, and permissions cannot contaminate the open session; background state carries unread/activity only. | Concurrent real tenant sessions and scheduled/background isolation are **NOT RUN**. |
| P2-04 mixed Assistant/professional transcript | Shared projection differential fixtures cover thinking, tools/results, owner updates, system errors/diagnostics, subagent control events, empty terminal turns, and unmatched results. Desktop UI regressions pass. | Real-model mixed transcript review is **NOT RUN**. |
| P2-05 clarification and plan review | Five mobile journeys verify single/multi-select, Other, skip, plan detail, per-question timeout and `autoAnswered`, safety approval, malformed denial, and exact `updatedInput.answers` payloads. | Real executor receipt/effect and real plan review are **NOT RUN**. |
| P2-06 two-device permission + reload | Pending requests recover after dismiss/reconnect; remote resolution closes without inventing approval; one-shot mock resolvers preserve first-answer-wins behavior. | Real two-client/two-device resolution and still-pending reload are **NOT RUN**. |
| P2-07 start/steer/stop/failure | UUID submit/retry, uncertain start without blind retry, running steer, authoritative stop, action-vs-refresh failure, and draft preservation are covered. Stop failure cannot fake an idle UI. | Real runner stop latency, real model steering, and lost-start reconciliation are **NOT RUN**. |
| P2-08 reconnect/reload/recovery | Running-session title/status restore, server-driven live-content discovery, stale-snapshot rejection, active-tab/draft restore, and history pagination+snapshot recovery pass on mock and real C2. | Physical airplane mode, control-plane restart with an active turn, and multi-device convergence are **NOT RUN**. |

No known S1/S2 defect remains in the covered deterministic matrix. This is not an acceptance claim for the unexecuted real-environment scenarios.

## WP0 Expected-Defect Conversion

All 14 WP0 expected-defect proofs are now ordinary passing regressions; no `test.fail` or `expectWp0Defect` wrapper remains.

| Area | Converted regression |
|---|---|
| Twin identity | First chat uses the actual Twin, with main-process runtime-context evidence |
| Event isolation | Other-session message, completion, and permission events stay out of the open chat |
| Permission resolution | Unknown remote resolution closes/reconciles without a fake approval |
| Message projection | `tool_use` and raw thinking never become ordinary Assistant bubbles |
| Clarification | Real options and complete question semantics render through the shared desktop panel |
| Send failure | Start failure produces a visible recoverable state |
| Resync correctness | A snapshot requested before newer stream content cannot overwrite it |
| Optimistic sends | Stable IDs/revisions, never text equality, determine identity and order |
| Active-stream recovery | Server `running` state and message metadata drive live-content recovery |
| Full reload | Session title, running state, active tab, and drafts restore correctly |

## Verification

### Automated and browser evidence

| Check | Result |
|---|---|
| Full standard `pnpm test` | Completed with exit code 0; the entire standard chain passed |
| Desktop UI regression suite | 110/110 passed |
| Focused session state/controller tests | 18/18 passed, including explicit-new, greeting drafts, and history+snapshot recovery |
| Mobile unit/SSR/static/real-C3 groups | All executed groups passed; real-C3 group remains 22/22 |
| Full Pixel Chrome mock suite | 29/29 passed |
| Serial real C2 gateway suite | 5/5 passed: greeting, chat/stream, signed file download, running reload, tab/draft recovery |
| Permission journeys | 5/5 passed with exact answer payloads |
| Sanitized Twin runtime context | 2/2 passed; no model call and no secret/prompt contents logged |
| Node 24 control plane | 156/156 tests and build passed |
| Desktop renderer and Electron builds | Passed |
| Mobile app/login production builds and skills | Passed |
| Full repository lint | Passed |
| DSH dependency and kernel-patch checks | `check:dsh-deps` passed; 8 fingerprints verified |
| Frozen contract diff | Empty; expected-defect marker search empty |
| `git diff --check` | Passed |

### Current production bundle budgets

- Login bundle: **56.5 KB gzip** (limit 80 KB).
- App initial JavaScript: **81.3 KB gzip** (limit 500 KB).
- Lazy Chat chunk: **213.48 KB gzip** (measured separately, not an initial-budget claim).
- Production mock-notice check passed.

### Runtime/browser evidence boundary

- Repository/mobile verification used Node **26.7.0**; the control plane was separately verified with declared Node **24.13.1**.
- Browser journeys used installed Google Chrome with a Pixel profile. They are not physical Android evidence and not iPhone/WebKit evidence.
- Real C2 tests use a real gateway server with deterministic tenant handlers. They do not prove real model choices or real skill execution.

## NOT RUN / not accepted here

- Real staging sign-in through the browser UI, SMS, payment, Alipay, and production health/deployment verification.
- Real-tenant, real-model task-quality runs, real tool/skill effects, and multi-trial reliability grading.
- Real two-device permission resolution, real multi-session/background concurrency, and physical airplane-mode/control-plane restart recovery.
- iPhone Safari/home-screen PWA, WebKit, physical Android devices, and mainland network measurements.
- Packaged macOS/Windows smoke for this branch.
- Any deployment of this WP1 branch.

Actual deployed tenant/control-plane images, gateway tier, Metaso release, and staging/production parity remain operator-confirmation items from WP0.

## Remaining Work

WP2 owns attachments and generated-artifact previews, real document/skill journeys, scheduled/long-term work surfaces, and closed-phone result navigation. WP3 owns Bot/model/skill/memory/account breadth and recharge/settings hardening. These were not pulled into WP1.

Before WP1 can be called accepted, merge into `main` with owner approval, build one release candidate from `main`, confirm deployed artifact provenance, and execute the real tenant/model, multi-device, physical-device, and staging scenarios marked NOT RUN above.
