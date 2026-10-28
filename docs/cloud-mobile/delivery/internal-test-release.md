# Internal Test Release Handoff — Cloud Mobile WP0–WP3

- **Status:** development release candidate; operator build, staging deployment, and real-environment acceptance pending
- **Environment:** staging only; not production approval
- **Integrated product baseline:** `feda8cc68bf2e3c99c9e0b36dde7ee1bcf7f0453`
- **WP2 review remediation merge:** `ad81fbb9f3b13f5b32441363325f5f74694ee2b8`
- **WP3 merge:** `feda8cc68bf2e3c99c9e0b36dde7ee1bcf7f0453`
- **Release-gate hardening:** `94b3db60d8a76304c42e54525f9e23f27413d8d0`
- **Application version:** `1.0.8`
- **C1/C2 contract version:** `1.0.0`
- **Mobile gateway tier:** P1 for this internal core-flow test; P2 features are not part of this candidate

## 1. Release Rule

Deploy the final reviewed `main` commit after this release-hardening handoff is merged, not a feature or remediation branch. Record that full SHA in the operator report:

```bash
git checkout main
git status --short
git rev-parse HEAD
```

The working tree must be clean except for explicitly understood unrelated files. The release manager must make the exact `main` SHA available to the CI system before starting the image workflow. Local-only commits cannot be built by GitHub Actions. No push, tag, deployment, or production change is performed by this handoff.

Expected image coordinates for final commit `<commit7>`:

```text
{REGISTRY}/idbots/tenant:1.0.8-<commit7>
{REGISTRY}/idbots/control-plane:0.1.0-<commit7>
```

Both images must come from the same source SHA. The tenant image carries the PWA and the IDBots main-process services; the control-plane image carries the mobile login bundle. The control plane does not acquire Agent, skill, memory, session, or task business logic.

## 2. Candidate Scope

WP0–WP3 plus the WP2 review remediation provide:

- real C3 login wiring and production mock elimination;
- Twin-bound sessions, desktop-equivalent Assistant projections, full clarification/permission handling, send/steer/stop, and reconnect/reload recovery;
- attachments, generated-artifact preview/download, scheduled and long-term work, and result navigation;
- the running-session refresh-race fix and deterministic completion/timing lanes;
- on-chain Bot lifecycle/configuration, per-Bot model and skills, and safe settings/relay handling;
- quota/recharge recovery, duplicate-creation guards, and expired-order reconciliation;
- mandatory PWA image builds, mandatory control-plane and conformance CI legs, and exact runtime commit provenance.

The frozen `01-interface-contracts.md` and `02-ipc-allowlist-v1.md` remain unchanged. `CR-WP3-001-bundle-order-recovery.md` is only a proposed follow-up; it is not an approved or implemented server contract change.

## 3. Development Verification

| Check | Evidence |
|---|---|
| WP3 recharge recovery unit tests | 7/7 passed |
| WP3 bundle service tests | 10/10 passed |
| WP3 recharge recovery/expiry browser journeys | 18/18 across iPhone WebKit and Pixel Chromium |
| Combined mobile tests after the WP2/WP3 merges | 164 TypeScript + 6 static + 48 session/login tests passed |
| Control plane on Node 24.13.1 | 156/156 tests, build, and lint passed |
| Tenant/release static gates | 15/15 passed; workflow YAML parsed; shell syntax and `git diff --check` passed |
| Full integrated `main` verification at `feda8cc6` | Standard `pnpm test`, lint, mobile production build, skills build, DSH dependency and patch checks passed |
| Integrated `main` Mock and real-C2 E2E | Mock 102/102; real-C2 32/32 across both profiles; 100 ms timing lane 4/4 |
| Release-hardening branch verification | Full standard chain, lint, mobile/skills builds, and DSH checks passed; Mock 102/102; real-C2 32/32; 100 ms timing lane 4/4 |

Real C2 means the actual gateway, C2 WebSocket, allowlist/restrictions, and mobile shim with deterministic tenant handlers. It is not evidence from a real tenant, model, chain, payment processor, or physical phone.

## 4. Operator Build and Deployment

1. Confirm the exact final `main` SHA is available to CI and that the ACR variables/credentials named in `.github/workflows/cloud-images.yml` are configured. Do not place credentials in the repository or this report.
2. Run the **Cloud Images** workflow for that SHA. The workflow must build both Linux/amd64 images, run Trivy, start the tenant, verify that `/readyz.commit` equals the full source SHA, run `cloud/conformance/run.mjs`, and push both images. Any missing or skipped required leg is a failed release, not a pass.
3. Record the workflow URL, both image tags and digests, the source SHA, contract version, and gateway tier. Do not deploy if `/readyz` reports `commit=dev` or a different SHA.
4. Confirm staging configuration explicitly. Keep production fake SMS, test hooks, and mock payment settings off. Staging-only test switches must be documented; use synthetic identities and test phone numbers except for the designated real-SMS check.
5. Update the control plane using `deploy/runbooks/deploy-control-plane.md`. Confirm existing tenants stay running and phones reconnect.
6. Upgrade **one synthetic canary tenant** using `deploy/runbooks/tenant-image-rollout.md`. Preserve its volume and gateway secret. Do not start with a fleet rollout.
7. Run the health, readiness, public Caddy/control-plane, and isolation checks in `deploy/runbooks/host-bootstrap.md`. Keep the previous known-good image tags available for rollback.
8. Execute the internal acceptance matrix below. Expand to more internal users only after the canary has no open S1/S2 defect.

## 5. Internal Acceptance Matrix

Run the applicable scenarios from `60-acceptance-and-go-live.md` on the deployed candidate. Record sanitized tenant IDs and times, device/browser versions, screenshots or recordings outside git, and relevant log locations without message contents, phone numbers, tokens, mnemonics, API keys, QR payloads, or redeem codes.

| Scenario | Required result |
|---|---|
| A-01/A-02 sign-up and returning login | Invite/SMS/provisioning work; repeat login needs no invite; two devices see the same Bots/sessions |
| A-03 Twin chat | Correct Twin binding; smooth streaming; stop within 2 s; complete history and older-session restore |
| A-04 document and search skills | Real docx/xlsx/pptx/pdf files open on the phone; real web-search answer has citations; forced browser search path works |
| A-05 attachments | Real camera/photo and PDF content is understood; upload errors remain visible |
| A-06 two-device permission | Both devices see the request; first answer wins; neither invents an approval |
| A-07 phone-closed scheduled work | Task runs on time; result and artifact are visible after reopening |
| A-08 network/control-plane recovery | Airplane-mode recovery and control-plane restart preserve the session and stream without duplicates; tenant does not restart |
| A-09/A-11 payment | Controlled staging purchase credits both meters exactly once; perform the real ¥0.01 Alipay check only with owner-approved test configuration |
| A-10 quota recovery | Exhausted quota produces the recharge card; after confirmed credit the next real-model message works without rekeying/resetting the tenant |
| A-12 worker Bot | Real chain creation/configuration/fees are visible; persona/model/skills persist; long-term work uses the intended Bot |
| Physical PWA checks | iPhone Safari and home-screen PWA plus Android Chrome: keyboard, safe areas, backgrounding, file/photo picker, share/download, and expired links |
| Recovery stress | Reload during streaming, foreground after expiry, stale response rejection, and unknown order-create outcomes never create duplicate sessions/orders |

Critical real-model tasks should run at least three times before drawing a reliability conclusion. Classify product defects separately from model/provider and harness failures.

## 6. Stop and Rollback Conditions

Stop the canary and do not expand rollout for any of the following:

- cross-tenant/session data exposure or wrong Bot identity;
- user-data loss, reset, or failed upgrade rollback;
- duplicate order, duplicate credit, reused QR, or uncertain payment shown as successful;
- lost/duplicated accepted chat messages, unrecoverable permissions, or background results routed into the wrong session;
- missing image provenance, a skipped required CI leg, or a fixed CRITICAL vulnerability;
- any other open S1/S2 defect.

Use the previous known-good control-plane and tenant tags through the existing runbooks. Do not delete or reset a tenant volume to work around a failure.

## 7. Explicit Limits / NOT RUN Here

- No Linux/amd64 image build or container smoke was run on the development Mac because Docker is unavailable. The operator CI must supply this evidence.
- No staging or production deployment was performed.
- No real tenant/model task-quality, physical-device, real chain/payment, or external exactly-once payment acceptance is claimed by deterministic tests.
- Server-authoritative order idempotency and lost-order lookup still require the CR review and WS-A/WS-D coordination. Local fail-closed guards are not proof of server reconciliation.
- P2 social/group/knowledge/dream/surf features, mnemonic export, and native shells are outside this core internal candidate.

## 8. Operator Handback

Return the exact deployed SHA, workflow URL, image tags/digests, gateway tier, Metaso environment/release, canary tenant ID, acceptance results, failed scenarios, and rollback status. Mark missing credentials, devices, or scenarios **NOT RUN**. Do not mark the release accepted from a health endpoint or from this development handoff alone.
