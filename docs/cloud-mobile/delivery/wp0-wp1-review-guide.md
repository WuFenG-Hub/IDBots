# Cloud-Mobile WP0 and WP1 — Consolidated Review Guide

- **Date:** 2026-10-27
- **Audience:** code reviewers, acceptance reviewers, and review agents
- **Scope:** WP0 baseline/reproduction harness and WP1 Twin session foundation
- **Out of scope:** WP2 attachments/artifacts/background-work surfaces, WP3 account and daily-use breadth, native shells, and production acceptance
- **Primary feature merge:** `9dc7da9e330f2890dccb968455ec8dc0d5ea7ca7`
- **Integrated build checkpoint:** `39d85bc7f3074ff12210a25aa434fa1b008ad396`

## 1. Purpose of This Guide

This is the single entry point for reviewing the WP0 and WP1 delivery. It contains the complete commit list, architecture boundaries, implemented behavior, verification evidence, review commands, and unexecuted acceptance items.

The older [`wp0-baseline.md`](wp0-baseline.md) and [`wp1-twin-session.md`](wp1-twin-session.md) remain optional historical evidence. Their statements such as “not merged” described the branches at the time those notes were written. WP0 and WP1 were subsequently merged into `main` by `9dc7da9e`; this guide records the later integration status.

This guide does not claim product acceptance. Deterministic fixtures and a real C2 gateway with canned tenant handlers prove transport, rendering, state transitions, and recovery behavior. They do not prove real-model quality or real skill outcomes.

## 2. Review Target and Commit Boundary

Use these checkpoints rather than assuming that the latest `main` is identical to the WP0/WP1 delivery:

| Purpose | Commit | Meaning |
|---|---|---|
| Feature-branch base | `846316ed530be5d58eca0c323ccd4694567b375d` | `main` immediately before the WP0 commit stack |
| End of WP0 | `e4a82807261f3fcbdabba96480122301b9bf63ca` | WP0 implementation and delivery note |
| End of WP1 | `8bbf50fdee9eb977b77f4f6b54941b09e34ebfe1` | WP1 implementation and delivery note |
| Combined merge into `main` | `9dc7da9e330f2890dccb968455ec8dc0d5ea7ca7` | `--no-ff` merge of WP0 and WP1 |
| Follow-up build fix | `d21cb5de11fbeea290fd443401e132cf454672b1` | Remove three unused desktop group-task symbols |
| Build-fix merge | `39d85bc7f3074ff12210a25aa434fa1b008ad396` | Integrated checkpoint after the build repair |

The WP0/WP1 feature stack is linear:

```bash
git log --reverse --oneline 846316ed..8bbf50fd
```

Review the integrated WP0/WP1 feature diff with:

```bash
git diff 9dc7da9e^1 9dc7da9e
git show --stat --oneline d21cb5de
```

Do not treat `846316ed..39d85bc7` as a WP0/WP1-only diff: the first-parent `main` history also contains unrelated work. Use the merge diff above for the feature scope and inspect `d21cb5de` separately for the build repair.

## 3. Architecture and Ownership Boundaries

The intended architecture is one isolated cloud tenant per user, running the same IDBots main-process services as the desktop codebase. The PWA is a thin client, not a second Agent implementation and not a remote view of the user's personal desktop.

```text
Mobile PWA presentation
  -> window.electron-compatible bridge
  -> C2 WebSocket / HTTP file routes
  -> Control plane: authentication, tenant routing/lifecycle, proxying
  -> User's cloud tenant: IDBots main process and authoritative stores
       -> CoworkRunner, MetaBotStore, SkillManager, MemoryBackend
       -> sessions, permissions, tasks, files, workspace, configuration
```

Review against these boundaries:

- Reuse desktop/main-process behavior instead of creating a mobile-only session or Agent state machine.
- Keep the control plane thin; it must not become the owner of chat orchestration, skills, memory, or message content.
- Keep the tenant authoritative for durable work and recovery.
- Mobile owns presentation, mobile interaction, non-secret drafts/recovery state, and platform adaptation.
- The PWA having no management page for a capability does not disable that capability in the cloud tenant.
- Do not rebuild skill or memory engines in the PWA. WP0/WP1 concern login, Twin binding, conversation state, permissions, and recovery—not new skill or memory management surfaces.
- Desktop installers and the tenant image come from the same codebase. Desktop behavior is a regression gate for shared-code changes.

## 4. WP0 — Baseline and Reproduction Harness

### 4.1 Complete WP0 Commit List

These six commits are the WP0 delivery range `846316ed..e4a82807`:

| Commit | Subject | Review significance |
|---|---|---|
| `a1e3f3d3a053d67b1e0f7cb2a2cbe3fa456a694c` | `feat(mobile): swap the login API mock for real C3 control-plane endpoints` | Real SMS send/verify, `me`, logout, and deletion-request calls; same-origin cookies and typed errors; production mock elimination |
| `b6ca88926b0cc9cee590353fa3da0f16d3406d28` | `fix(mobile): harden real login and gateway baseline` | Correct Vite production/development detection, avoid `process is not defined`, fix the stale quota assertion, make file-enabled gateway coverage the default |
| `9866b129fa39326f647bacd7bcf8089bc1a0a1d3` | `fix(gateway): tier standing page channels explicitly` | Restore exact contract coverage with four explicit-N `standingPages:*` channels; no permission expansion |
| `b6db529f1fdffe9363dec6fac6d55610782f4a09` | `test(long-term): cover immediate begin fallback` | Align the long-term test with intentional immediate-begin behavior while preserving bound-session quiet behavior |
| `6531b51bbe5f45d9428f40041de0a8d8c807881b` | `test(mobile): reproduce twin session defects` | Deterministic reproductions for Twin identity, session isolation, permissions, projection, submission, resync, and reload defects |
| `e4a82807261f3fcbdabba96480122301b9bf63ca` | `docs: record wp0 baseline delivery` | WP0 scope, evidence, environment caveats, and explicit NOT RUN items |

### 4.2 Delivered Behavior

- Replaced the production mobile login mock with real C3 API calls.
- Restricted demo/mock login behavior to development and test builds; added a production-bundle mock-notice guard.
- Preserved C3 error semantics and avoided logging phone numbers, SMS codes, or invite codes.
- Restored IPC contract classification without enabling new mobile permissions merely to make tests pass.
- Made file delivery part of the default real-gateway E2E matrix rather than an optional forgotten flag.
- Added 14 expected-defect proofs: 4 Node, 9 PWA, and 1 real-gateway reproduction.

**Important evidence distinction:** WP0's expected-defect tests passed when they reproduced known broken behavior. That is not a claim that the defects were fixed in WP0. WP1 converted them into ordinary regression tests.

### 4.3 WP0 Verification Record

| Check | Recorded result |
|---|---|
| Real-C3 tests | 22/22 passed |
| Main mobile TypeScript group | 128/128 passed |
| i18n/static tests | 3/3 passed |
| Control-plane phone loop | 19/19 steps passed |
| IPC contract tests | 7/7 passed; generated contract fresh |
| Long-term baseline tests | 46/46 passed |
| Pixel mock E2E | 13/13 original scenarios passed |
| Original real-gateway E2E | 2/2 passed without a file-enabling override |
| Expected-defect reproductions | 14 proofs reproduced the intended defects |
| Full standard `pnpm test` | Passed after the contract/test disposition |
| `build:mobile`, lint, frozen installs and patch checks | Passed |

WP0 also recorded read-only public staging health and CI artifact observations. Those observations did not establish the exact deployed app commit, tenant/control-plane images, gateway tier, Metaso release, or staging/production parity.

## 5. WP1 — Twin Session Foundation

### 5.1 Complete WP1 Commit List

These seven commits are the WP1 delivery range `e4a82807..8bbf50fd`:

| Commit | Subject | Review significance |
|---|---|---|
| `ab1002272fe52e1e97ef873ae7c6b5b47febbac3` | `refactor: share cowork conversation projection` | Extract shared desktop/mobile Assistant and professional message projection |
| `d4c5f5934bcfbcb852e6c6fb81d3d544ddc7f845` | `refactor: share cowork session state semantics` | Share per-session state, ordering, status, and recovery semantics; consume them from desktop Redux |
| `ee17680573e450aea5921c3f1c8fef5daac59ca8` | `feat(mobile): rebuild Twin chat session foundation` | Bind the actual Twin and replace independent mobile streaming state with the shared session controller |
| `c067891350d597bc6fc60476b07300bd7c60d5d8` | `feat(mobile): restore first-run Twin greeting` | Restore a real first-run greeting only when no prior/running session should be restored |
| `5081d41dd22b38af617161b6357d139b689cfbb8` | `test(mobile): cover permission clarification journeys` | Verify full clarification, plan review, safety approval, timeout, and exact answer payloads |
| `dcae1050cef1a17d3636d4fcb25007393574c57c` | `fix(mobile): preserve chat recovery state` | Preserve running state, explicit-new drafts, per-session drafts, active tabs, and paginated history through recovery |
| `8bbf50fdee9eb977b77f4f6b54941b09e34ebfe1` | `docs: record wp1 twin session delivery` | WP1 scope, deterministic evidence, and real-environment NOT RUN boundaries |

### 5.2 Delivered Behavior

#### Twin identity and first-run behavior

- Select the actual Twin by default rather than starting the first conversation with `metabotId=null`.
- Restore an existing or running session before considering a first-run greeting.
- Preserve the configured Twin persona, brain, skills, memory scope, and per-Bot workspace through the existing main-process runtime.
- Include sanitized runtime-context tests; these tests deliberately make no real model call and log no secret or prompt contents.

#### Shared session and message semantics

- Route events into independent per-session state instead of one global transcript and streaming flag.
- Prevent background/other-session text, completion, and permissions from contaminating the visible session.
- Retain raw records while sharing desktop/mobile view projection and Assistant/professional visibility rules.
- Handle mixed text, thinking, tools/results, owner updates, errors, subagent events, titles, and empty terminal turns.
- Merge by stable message identity and sequence/revision, never by text equality.
- Reject stale snapshots and responses from obsolete targets, generations, or transport epochs.

#### Sending, steering, stopping, and failures

- Use UUID `submissionId` values for existing-session submissions and safe retries.
- Support running-session steering rather than globally locking the composer.
- Make stop session-scoped and reconcile the authoritative result.
- Expose failed and uncertain outcomes; do not blindly retry a lost non-idempotent start.
- Preserve drafts and distinguish action failure from a subsequent refresh failure.

#### Permissions and clarification

- Reuse the desktop permission/clarification semantics in mobile interaction surfaces.
- Cover single-select, multi-select, Other, skip, plan detail, safety approval, malformed denial, per-question timeout, and `autoAnswered` behavior.
- Send exact `updatedInput.answers` payloads.
- Treat first answer as authoritative across clients; never turn an unknown remote resolution into an invented approval.
- Keep still-pending requests recoverable after dismissal, reconnect, or reload.

#### Reload, reconnect, and history

- Restore the session title, active tab, running state, and server-driven live stream after reload.
- Restore explicit-new and per-session drafts without reviving an older session incorrectly.
- Load earlier history pages and reconcile later snapshots without text-based deduplication or ordering regressions.
- Convert all 14 WP0 expected-defect proofs into ordinary passing regressions; no expected-defect wrapper remains.

### 5.3 WP1 Verification Record

| Check | Recorded result |
|---|---|
| Full standard `pnpm test` | Exit code 0 |
| Desktop UI regressions | 110/110 passed |
| Focused session state/controller tests | 18/18 passed |
| Real-C3 tests | 22/22 passed |
| Pixel Chrome mock E2E | 29/29 passed |
| Real C2 gateway E2E | 5/5 passed: greeting, chat/stream, signed file download, running reload, tab/draft recovery |
| Permission journeys | 5/5 passed with exact payloads |
| Sanitized Twin runtime-context tests | 2/2 passed; no model call |
| Node 24 control plane | 156/156 tests and build passed |
| Desktop renderer/Electron and mobile production builds | Passed |
| Lint, DSH dependency check, and kernel-patch fingerprints | Passed; 8 fingerprints verified |
| Frozen `01`/`02` contract diff | Empty |
| WP0 expected-defect conversion | All 14 converted to normal passing regressions |

The WP0/WP1 merge at `9dc7da9e` was also verified with the full standard test chain in an isolated worktree. The follow-up `39d85bc7` checkpoint removed the unused-symbol desktop build failure and passed the full standard chain again.

Production bundle measurements recorded at WP1 were 56.5 KB gzip for login and 81.3 KB gzip for initial app JavaScript. The lazy Chat chunk was measured separately and was not part of the initial-bundle claim.

## 6. Recommended Code-Review Path

Review behavior and invariants, not only component rendering.

### 6.1 Login, build mode, and contract baseline

- `src/mobile/login/loginApi.ts`
- `scripts/check-mobile-no-mock-notice.mjs`
- `tests/mobileLoginApiReal.test.ts`
- `src/main/gateway/allowlist.ts`
- `tests/mobileChannels.test.mjs`
- `scripts/run-mobile-e2e-gateway.mjs`

Confirm real C3 request/error semantics, secret-free logs, production mock elimination, explicit permission tiers, and default file-enabled gateway coverage.

### 6.2 Twin selection and outgoing runtime context

- `src/mobile/app/hooks/useMetabots.ts`
- `src/renderer/services/coworkSessionStart.ts`
- `src/mobile/app/hooks/useChat.ts`
- `src/mobile/app/MobileApp.tsx`
- `tests/mobileTwinRuntimeContext.test.mjs`
- `tests/coworkSessionStart.test.ts`

Confirm actual Twin selection, valid explicit fallback, greeting preconditions, and preservation of main-owned persona/brain/skills/memory/workspace context. Do not mistake a sanitized context test for evidence of real-model behavior.

### 6.3 Shared session core and projection

- `src/renderer/services/coworkSessionController.ts`
- `src/renderer/services/coworkSessionState.ts`
- `src/renderer/services/coworkConversationProjection.ts`
- `src/renderer/services/coworkAssistantText.ts`
- `src/renderer/store/slices/coworkSlice.ts`
- `src/mobile/app/chatProjection.ts`
- `src/mobile/app/hooks/useResync.ts`

Confirm session isolation, stable identity/order, background behavior, sequence-gap recovery, stale-response rejection, raw-record retention, and equivalent desktop/mobile projection.

### 6.4 Interaction and recovery surfaces

- `src/mobile/app/screens/ChatScreen.tsx`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- `src/renderer/components/cowork/ThinkingBlock.tsx`
- `e2e/mobile/permission.spec.ts`
- `e2e/mobile/wp0-repro.spec.ts`
- `e2e/mobile/wp0-gateway-repro.spec.ts`
- `e2e/mobile/gateway.spec.ts`
- `e2e/mobile/gateway-first.spec.ts`

Confirm complete question semantics, first-answer-wins behavior, no invented approval, explicit action failures, stop/steer semantics, draft restoration, active-stream recovery, and history pagination.

### 6.5 Regression evidence

- `tests/mobileWp0Repro.test.ts`
- `tests/coworkSessionController.test.ts`
- `tests/coworkSessionState.test.ts`
- `tests/coworkConversationProjection.test.ts`
- `tests/mobileChatProjection.test.ts`
- `tests/mobileResync.test.ts`

Confirm the WP0 defect reproductions are now normal regressions and that tests would fail if the original defects returned.

## 7. Acceptance Scenarios and Evidence Boundary

| Scenario | Deterministic implementation evidence | Real-environment acceptance |
|---|---|---|
| P2-01 login → ready → first chat | Real C3 implementation/tests; actual Twin ID and sanitized runtime-context tests | Real staging sign-in and real tenant runtime capture: **NOT RUN** |
| P2-02 ordinary chat and follow-up | Streaming, Assistant projection, title/history, follow-up, and structured results on mock/real C2 | Real-model quality, model choice, and real skills: **NOT RUN** |
| P2-03 concurrent sessions/background work | Per-session controller and PWA isolation tests | Real concurrent tenant sessions and scheduled/background isolation: **NOT RUN** |
| P2-04 mixed Assistant/professional transcript | Shared projection differential fixtures and desktop regressions | Real-model mixed transcript review: **NOT RUN** |
| P2-05 clarification and plan review | Five mobile journeys with exact payloads and timeout/denial cases | Real executor receipt/effect and real plan review: **NOT RUN** |
| P2-06 two-device permission and reload | Recovery and first-answer-wins fixtures | Real two-client/two-device resolution: **NOT RUN** |
| P2-07 start/steer/stop/failure | UUID retry, uncertain start, authoritative stop, and draft tests | Real runner latency, real steering, and lost-start reconciliation: **NOT RUN** |
| P2-08 reconnect/reload/recovery | Running restore, live discovery, stale rejection, drafts, tabs, and pagination | Physical airplane mode, control-plane restart during a turn, and real multi-device convergence: **NOT RUN** |

Also **NOT RUN** for WP0/WP1 acceptance:

- Real-tenant, real-model multi-trial task-quality evaluation and real tool/skill outcomes.
- Physical iPhone Safari/home-screen PWA and physical Android devices.
- Real SMS, payment, Alipay, and production deployment verification.
- Packaged macOS/Windows smoke for these branches.
- Mainland network measurements.

WP1 verification used a real C2 gateway with deterministic tenant handlers. That is not a real tenant with a real model. WP0/WP1 were merged locally; no production acceptance follows merely from that merge or from green fixtures.

## 8. Optional Local Reproduction

Run these commands in a disposable worktree at the integrated checkpoint, not in a user's active development checkout:

```bash
git worktree add --detach .worktrees/wp0-wp1-review-target 39d85bc7
cd .worktrees/wp0-wp1-review-target
pnpm install --frozen-lockfile

pnpm test
pnpm run lint
pnpm run build:mobile
pnpm run test:e2e:mobile -- --workers=1
pnpm run test:e2e:mobile:gateway -- --workers=1
```

Use a supported Node version (`>=24 <27`). Browser tests require the applicable local Chromium/WebKit runtime. An unavailable browser, device, credential, or external service is **NOT RUN**, not a pass and not automatically a product defect.

The counts above are the historical WP0/WP1 evidence. Later branches may expand the suites, so reviewers should report the exact commit and actual counts from their own run rather than copying these numbers.

Remove the disposable worktree after verification:

```bash
git worktree remove .worktrees/wp0-wp1-review-target
```

## 9. Required Review Report Format

A review agent should return:

1. **Reviewed commits:** exact hashes and whether the integrated checkpoint was built.
2. **Findings:** severity (S1/S2/S3), file and line, affected invariant, reproduction, and a minimal proposed correction.
3. **Architecture findings:** any duplicated mobile Agent/session semantics, control-plane business logic, cross-tenant/state leakage, unsafe permission expansion, or desktop regression.
4. **Verification actually executed:** commands, counts, environment, and failures; preserve partial evidence.
5. **NOT RUN:** every missing real tenant/model, physical-device, staging, payment, or production scenario.
6. **Separate verdicts:**
   - code/deterministic verification: approve or request changes;
   - real-environment acceptance: accepted or still pending.

Do not convert missing external evidence into a fictional pass. Do not treat a historical delivery note's branch-era status as the current merge status. Do not expand this review into WP2/WP3 features unless a finding directly shows that the WP0/WP1 foundation is incorrect.
