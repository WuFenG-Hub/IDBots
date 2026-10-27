# Delivery Note — WP2 Work, Artifacts, and Background Tasks

- **Date:** 2026-10-27
- **Original merge:** `f19de10d678eeef66649ac29abce40d681c696b2`
- **Review-remediation branch:** `fix/cloud-mobile-wp2-review-findings`
- **Remediation base:** `d60eb69baef794ca01d8995d1e334663b17602c6`
- **Status:** implementation and deterministic verification complete on branch; not merged, not deployed, and real-environment acceptance is pending.

## 1. Scope

WP2 completes the mobile work journey from input and attachments to generated artifacts and background-work results:

- multi-file selection, real upload progress/errors, per-session attachment drafts, and desktop-equivalent prompt composition and recovery;
- in-app image, PDF, and Markdown preview with real signed bytes, download/share fallbacks, and expiring-link rotation without unloading chat;
- scheduled-task create/edit/delete/toggle/run/stop/history with explicit Twin and tenant-workspace binding;
- long-term task board/progress, participant and evidence projection, owner actions, and real bound-session result navigation;
- review follow-up for streamed-tail assertions, running-session restore races, sanitizer boundaries, and explicit fixture timing lanes.

The PWA remains a thin client over C2. The control plane owns accounts, routing, lifecycle, and proxying; it does not acquire Agent, skills, memory, session, or task business logic. The tenant continues to own the IDBots main-process services and durable work.

The frozen documents `01-interface-contracts.md` and `02-ipc-allowlist-v1.md` were not edited. No `cloud/` files were changed.

## 2. Original WP2 Commits

| Commit | Change |
|---|---|
| `f35aedb48a4e57576060728a5c09437ec1352a1e` | Complete the attachment chat workflow: multi-file uploads, ordered progress, attachment drafts, desktop prompt composition, refusal rollback, and send recovery |
| `d54913e429312eab5524a17725acf3901d3885b7` | Add in-app artifact previews, real signed-byte downloads/sharing, and expiring-link refresh |
| `c50bd560d06dc82b99df785eb722d26a90445818` | Complete scheduled/long-term work surfaces and authoritative result-session navigation |
| `5eaef1e39d87ecba6ccc33d51513720a89df033d` | Wait for turn completion before opening artifacts in the affected WebKit test helper |

The original integration was merged as `f19de10d`. The original merge validation passed the full standard chain, lint, mobile production builds, skills build, DSH checks, 78/78 Mock E2E scenarios, and 24/24 real-C2 scenarios. Those results apply to the original integration, not automatically to this remediation branch.

## 3. Review Remediation Commits

| Commit | Finding | Resolution |
|---|---|---|
| `ff7433c5` | F-1 streamed-tail acceptance | Require a settled turn and the complete directory label before asserting that no raw container path remains |
| `1914821a` | F-2 running-session restore | Distinguish loaded/superseded/failed refresh outcomes so a superseded open cannot incorrectly create a replacement greeting |
| `787a759b` | S3 sanitizer/timing coverage | Add exact depth-six/depth-eight sanitizer coverage and a named 100 ms recovery lane |

### 3.1 F-1 — streamed tail and raw container paths

The reviewer reported intermittent loss of the final streamed directory-link character. The remediation independently ran the original F-11 scenario on the unmodified integration at 40 ms with retries disabled. It passed 5/5 on iPhone WebKit and 5/5 on Pixel Chromium, so a persistent product defect was not reproduced locally.

The existing `cowork:stream:complete` handler already calls `refreshSession`; no duplicate production refresh was added. The F-11 test previously treated the last artifact link as proof of a complete reply even though the directory label arrives later. It now requires both turn-phase settlement and the complete `工作目录` label before checking for raw paths. The strengthened combined F-11 and running-reload matrix passed 10/10 per engine (five repetitions of each scenario).

**Disposition:** deterministic completion criteria added; no product-code change was justified by the locally reproduced evidence. This is not a claim that the reviewer's missing probe artifacts were inspected or that every possible stream-ordering defect is excluded.

### 3.2 F-2 — running-session restore after full reload

A real controller defect was reproduced independently. Cold WebKit reloads failed two of five runs by showing a new Welcome session even though C2 `cowork:session:get` responses successfully returned the intended running session.

The trace showed the cause: an older `openSession` refresh returned `false` after being superseded by a newer refresh, causing restore to fall through `newChat` into `createGreeting` despite valid target data. Code history places the race at `ee176805` in WP1, not at the WP2 artifact-preview commit.

The controller now has explicit loaded/superseded/failed outcomes. Public `refreshSession` semantics used by stop and permission flows remain unchanged. `openSession` accepts supersession only while it still targets the same current session; genuine failures remain failures.

A deterministic controller regression proves that a superseded restore cannot create an unintended greeting. The browser regression now requires restored running state, subsequent stream completion, and complete tail content, with a 5-second interactive-readiness budget rather than an arbitrary fixed wait.

**Evidence:** controller tests 15/15; independent cold reloads now pass 5/5 on iPhone WebKit and 5/5 on Pixel Chromium with the final 5-second readiness cap. The 100 ms recovery lane also passed 5/5 per engine with that cap.

### 3.3 S3 follow-ups

- `tests/mobileChannels.test.mjs` now proves that a primitive at depth six survives while an object at depth eight is truncated. Existing participant/evidence checks remain intact; mobileChannels tests passed 9/9.
- `test:e2e:mobile:gateway:timing` provides a named 100 ms recovery lane using the existing `GW_FIXTURE_STREAM_INTERVAL_MS` control, separate from the default 40 ms product-regression lane. F-11 and full running-session reload passed 2/2 per engine.
- This document supplies the missing WP2 delivery note.
- The reviewer worktree named in the report was no longer present during remediation. No reviewer or unrelated worktree was removed by this work.

## 4. Original WP2 Requirement Mapping

| Area | Delivered behavior |
|---|---|
| Attachments | Multi-file selection, ordered real uploads, progress/errors, size/type handling, per-session durable attachment drafts, attachment-only start/steer, and desktop-equivalent prompt composition |
| Artifacts | Real image/PDF/Markdown preview, other-file download, share/copy fallbacks, signed-byte checks, and link rotation without losing chat or composer state |
| Scheduled work | Twin-bound create/edit/delete/toggle/run/stop/history, tenant workspace selection, partial-update preservation, and useful failure states |
| Long-term work | Board/progress, participants/evidence, waiting reasons, owner actions, sequence deduplication, and fallback refresh |
| Result navigation | Resolve current-subtask session → latest historical session → definition session; preflight availability and never create a replacement session on failure |
| Gateway safety | Opaque scheduled-task ID handling, confined update payload paths, bounded IPC sanitization, and no expansion of frozen permissions |

## 5. Verification

### 5.1 Original integration evidence

| Check | Recorded result |
|---|---|
| Full standard `pnpm test` | Passed |
| Mobile unit/static/session groups | 150/150, 3/3, 47/47 |
| Desktop UI regressions | 110/110 |
| Mock E2E | 78/78: 39 iPhone + 39 Pixel |
| Real-C2 E2E | 24/24: 12 iPhone + 12 Pixel |
| Mobile production budgets | Login 58.7 KB gzip; app initial 86.7 KB gzip |
| Lint, skills build, DSH dependency and patch checks | Passed; 8 fingerprints verified |

### 5.2 Remediation-focused evidence

| Check | Result |
|---|---|
| Original F-11 baseline at 40 ms | 5/5 iPhone + 5/5 Pixel; no local reproduction |
| Strengthened F-11 and running-reload scenarios | 10/10 per engine |
| F-2 cold reload before controller fix | 2/5 iPhone runs failed with an unintended Welcome session |
| F-2 cold reload after controller fix | 5/5 iPhone + 5/5 Pixel with final readiness and completion assertions |
| Controller tests | 15/15 passed |
| Sanitizer and mobile channel tests | 9/9 passed |
| Named 100 ms recovery lane | F-11 and reload passed 2/2 per engine |

### 5.3 Final regression

| Check | Status |
|---|---|
| Full standard `pnpm test` on the remediation branch | Passed |
| `test:mobile`, lint, mobile build, skills build, DSH checks | Passed |
| Full Mock E2E matrix | Passed: 78/78 (39 iPhone + 39 Pixel) |
| Full real-C2 E2E matrix | Passed: 24/24 (12 iPhone + 12 Pixel) |
| Frozen-contract and unrelated-diff checks | Empty; no contract edits |

## 6. NOT RUN / Not Accepted Here

The evidence above uses the real C2 gateway with deterministic tenant handlers. It does not prove real model choices, skill quality, or production reliability.

- Real tenant/model document, spreadsheet, presentation, PDF, web-search, weather, and citation-quality journeys.
- Real photo/PDF understanding and multi-trial task-quality evaluation.
- Physical iPhone Safari/home-screen PWA and physical Android Chrome.
- Native OS share/clipboard, real expired-token behavior, and OS eviction recovery.
- Physical phone-closed scheduled and long-term task execution.
- Staging or production deployment and exact running-artifact provenance.

Missing external evidence remains **NOT RUN**, never a pass. This delivery note alone does not accept WP2 for production.

## 7. Review Commands

```bash
pnpm test
pnpm run test:mobile
pnpm run lint
pnpm run build:mobile
pnpm run build:skills
pnpm run check:dsh-deps
node scripts/apply-dsh-kernel-patches.cjs --check

pnpm run test:e2e:mobile -- --workers=1
pnpm run test:e2e:mobile:gateway -- --workers=1
pnpm run test:e2e:mobile:gateway:timing --workers=1
```

Use a supported Node version (`>=24 <27`). Browser tests require the appropriate Chromium/WebKit runtime. Report the exact commit and actual counts from each run; do not copy historical numbers as fresh evidence.
