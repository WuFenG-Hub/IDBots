# 60 — Acceptance and Go-Live

**Party:** owner and the acceptance reviewer (this planning workspace), with
every workstream supplying evidence.
**Used at:** M2, M3, M4, and M5 in `00-program-plan.md`.

## How Acceptance Works

1. A workstream delivers a branch, an image or build, and a delivery note
   that lists each of its requirements with evidence.
2. The reviewer checks the delivery note against the workstream document
   (its AC items) and reviews the code changes.
3. The reviewer runs the end-to-end scenarios below on staging (production
   for M5) and records the result in the sign-off table.
4. Defects are logged with severity S1 to S3 as defined in `00`. A milestone
   passes with no open S1 or S2 defects in its scope.

Evidence for every scenario: a screen recording from the phone, the
`tenantId` and times, and for backend steps the relevant log lines (no
secrets, no phone numbers, no message contents). Store evidence outside git;
link it from the sign-off table.

Test accounts: staging fake SMS numbers (`CP_FAKE_SMS_NUMBERS`) for most
runs, at least one real phone number per milestone; identities and balances
are test data only.

## End-to-End Scenarios

Unless stated, a scenario runs on an iPhone (web app) and on an Android phone
(browser for M2 and M3, APK for M4). "Phone closed" means the app is closed and
the screen is off.

### Phase 1 (A-01 to A-12)

| ID | Scenario | Pass when | Milestone |
|----|----------|-----------|-----------|
| A-01 | Sign up with an invite: phone, SMS code, invite code, display name, consents | The Bot is ready within 5 minutes (P95 over 5 runs); the display name appears on-chain; the traffic balance shows the redeem-code grant | M2 |
| A-02 | Log in again on the same phone and on a second phone at the same time | No invite asked; both devices show the same sessions and Bots; logout on one does not affect the other | M2 |
| A-03 | Chat: send a message, watch it stream, stop a reply, switch MetaBot, open an older session | Streaming is smooth; stop works within 2 s; history is complete | M2 |
| A-04 | Ask for a document (docx, pdf, xlsx, pptx, one each) through a skill; ask one question that needs a web search | Each file is created and opens on the phone through its link; the answer cites web results and the chat stays open (no page reload) | M2 |
| A-05 | Attach a camera photo and a PDF, ask about them | The answer refers to their content | M2 |
| A-06 | A tool permission request with two phones connected | Both see the sheet; the first answer wins; the other closes it | M2 |
| A-07 | Create a scheduled task due in 5 minutes, close the phone | It runs on time; on reopening, the run and its result are visible | M2 |
| A-08 | Airplane mode for 30 s in the middle of a reply; then restart the control plane | The reply completes without duplicates; the app reconnects within 30 s each time; no tenant restarts | M2 |
| A-09 | Buy the ¥0.01 acceptance plan with Alipay from the phone | Alipay opens; after payment the order is credited within 10 s and both meters rise | M3 |
| A-10 | Drain the test identity's LLM quota (WS-D admin), chat, recharge from the quota card, chat again | The chat shows the quota card instead of a raw error; after paying, the next message works | M3 |
| A-11 | Buy a bundle with the mock gateway on staging | Order credited; LLM and traffic meters rise by the plan amounts; one ledger entry each | M2 |
| A-12 | Create a worker MetaBot, edit its persona, skills, and model; start a long-term task for it | The Bot is created on-chain (traffic balance drops by the write cost); edits persist after an app restart; the long-term task shows progress | M3 |

### Phase 2 (A-13 to A-23)

| ID | Scenario | Pass when | Milestone |
|----|----------|-----------|-----------|
| A-13 | Hire a remote service in Gig Square and pay for it | The order is placed, paid, and the delivery arrives in the chat | M4 |
| A-14 | Another user hires one of this user's MetaBots while the phone is closed | The Bot accepts and delivers; on reopening the order shows as delivered | M4 |
| A-15 | Post a Buzz with a photo | The post is on-chain and visible in the feed and on another client within 5 minutes (Phase 0: about 3 minutes through the indexer) | M4 |
| A-16 | Private chat between this user's MetaBot and another user's MetaBot | Messages arrive both ways, also while the phone is closed | M4 |
| A-17 | Create a group task with two MetaBots | Status and checkpoints update live; the owner report is delivered | M4 |
| A-18 | Export the user mnemonic and a MetaBot mnemonic | Works only after SMS re-verification; reusing the verification fails; nothing appears in logs or the database; Android blocks screenshots | M4 |
| A-19 | Install the APK on Xiaomi, Huawei (HarmonyOS 4 or earlier), and OPPO or vivo phones; run A-03, A-04, A-07, A-09 | All pass | M4 |
| A-20 | Install the TestFlight build; run A-03 and A-07; check the iPhone web app still runs A-09 | All pass; the TestFlight build has no recharge entry | M4 |
| A-21 | Restore one tenant from last night's backup into a new container | The user logs in and sees Bots, sessions, files, and tasks; purchased LLM quota is intact after re-bootstrap; done within 30 minutes | M4 |
| A-22 | Upgrade the tenant image while two phones are connected; then upgrade to an image that never becomes ready | Phones show "updating" and reconnect; no data loss; the bad image is rolled back automatically and alerts | M4 |
| A-23 | Request account deletion from the app; operator exports and completes it with the runbook | Export produced; container and volume removed; the phone can no longer log in without a new invite; audit log has every step | M4 |

## Non-Functional Targets

| Area | Target | Measured by |
|------|--------|-------------|
| Sign-up to ready | P95 at most 5 minutes | A-01, WS-B metrics |
| App open to usable chat | P95 at most 5 s on 4G in the mainland | Device pass |
| Added latency to first token compared with desktop | At most 500 ms | Same prompt, desktop and phone |
| Reconnect after network returns | At most 30 s; immediate on foreground | A-08 |
| Availability (production) | 99% per month during the demo period | External uptime check |
| Capacity | 29 tenants on a 32 GB host (provisional, WS-C REQ-C-19) with host memory and CPU under 85%; the formula value of 58 only after REQ-A-31 passes | WS-C metrics, soak test |
| Memory after skills | A tenant is back within 150 MB of its idle memory 10 minutes after its last skill run (Phase 0 idle: 463 MB) | WS-A AC-A-5 |
| Backups | RPO 24 h; one tenant restored within 30 minutes; whole host within 4 h | A-21, WS-C drill |
| Upgrades | No data loss; failed upgrades roll back | A-22 |

## Security Checklist

Items marked P1 must pass for M3; P2 for M4.

| # | Check | Phase | Source |
|---|-------|-------|--------|
| SEC-01 | Tenant isolation: no tenant reaches another tenant, the metadata service, private ranges, or the host | P1 | AC-C-1 |
| SEC-02 | Gateway: unlisted channels refused; every R rule has passing positive and negative tests; `app_config` never returns a real API key | P1 | `02` tests |
| SEC-03 | File tokens: path traversal, other-tenant tokens, and expired tokens all fail | P1 | WS-A tests |
| SEC-04 | Login: cookie flags, Origin checks, SMS and verify rate limits, hashed codes and tokens | P1 | AC-B-2 to B-4 |
| SEC-05 | No secrets in git, images, CI logs, or application logs; Trivy shows no CRITICAL with a fix | P1 | WS-C CI, log review |
| SEC-06 | Production has fake SMS off and Metaso mock payments off | P1 | Configuration review |
| SEC-07 | Payment tampering tests pass | P1 | AC-D-5 |
| SEC-08 | Hosts: SSH limited to listed IPs and keys; Docker reachable only through the socket proxy; admin CLI actions audited | P1 | WS-C, AC-B |
| SEC-09 | Independent code review (security-focused) of the gateway, the control-plane auth and proxy, and the bundle endpoints, with findings closed | P1 | Review report |
| SEC-10 | Mnemonic export only through re-verification, never over the WebSocket, never logged | P2 | A-18 |
| SEC-11 | Backups encrypted, bucket private, restore tested | P2 | A-21 |
| SEC-12 | Phone numbers masked in all logs; display names user-chosen | P1 | Log review |

## Go-Live Checklist (M5)

**Legal and policy (owner, with counsel)**

- [ ] Terms of service and privacy policy published; the login page links them.
- [ ] Legal review of storing mainland users' data in Hong Kong (separate
      consent in the sign-up flow, scope of personal information collected)
      and of offering an AI service to invited users; conditions for a later
      public launch recorded.
- [ ] Refund and support policy written.

**Accounts and vendors**

- [ ] SMS signature and templates approved; production SMS sending tested.
- [ ] Alipay merchant live; the ¥0.01 plan tested on production, then
      switched off.
- [ ] Bundle plans, free LLM grant, and redeem-code value set (WS-D owner
      decisions).
- [ ] Apple and Android signing keys stored as listed in the secrets register.

**Platform**

- [ ] Production host sized for the first invite batch (29 tenants per
      32 GB host unless REQ-A-31 has raised it); monitoring, alerts,
      and the external uptime check live; every alert tested once.
- [ ] Nightly backups ran at least three nights; a restore drill passed.
- [ ] Runbooks in `deploy/runbooks/` complete and tried once by someone other
      than their author.
- [ ] Partner IP policy active for the production egress IP.

**Release**

- [ ] Versions recorded: tenant image tag, control-plane tag, contract
      version, Metaso release, APK version, TestFlight build.
- [ ] Redeem-code pool holds at least the number of invite uses issued.
- [ ] Invite batch created; support channel and on-call owner announced.
- [ ] All Phase 1 and Phase 2 scenarios passed on staging; A-01, A-03, A-07,
      and A-09 passed once on production.

## Rollback and Emergency Controls

| Problem | Action | Owner |
|---------|--------|-------|
| Bad tenant image | `tenant upgrade --all --image {previous}` within the `rollback-safe-to` rule | WS-C |
| Bad control-plane release | Redeploy the previous control-plane tag (tenants keep running) | WS-C |
| Payment problem | Set all bundle plans off sale in the Metaso console; the app shows recharge as unavailable | WS-D |
| Sign-up problem or abuse | Disable invites (`invite disable`) | Owner |
| Suspected compromise of a tenant or the host | Stop affected tenants, rotate secrets (`secret-rotation.md`), follow `incident-response.md` | WS-C |
| Mobile bundle bug | Ship a tenant image with the previous `dist-mobile/` (the bundle is baked into the image) | WS-A, WS-E |

## Business Metrics to Report

The demo exists to show the model works. Report weekly from data the
systems already hold (no new tracking SDK):

| Metric | Source |
|--------|--------|
| Invites sent, sign-ups, sign-up to first chat | Control-plane database |
| Weekly active users, day-1 and day-7 return | Control plane `last_login_at` and session data |
| Paying users, orders, revenue, average spend | Metaso admin console |
| LLM tokens and traffic bytes per user | Metaso ledgers |
| Cost per user per month (host share, LLM, traffic) | WS-C host costs and Metaso usage |

## Investor Demo Script (10 Minutes)

Prepare the demo account the day before: grant it LLM quota from the Metaso
admin console (the free allowance lasts only about 17 turns with heavy
skills) and run the script once end to end.

1. Open the app on a fresh phone, sign up with an invite (A-01); while the Bot
   is prepared, explain that each user gets a private cloud computer.
2. Ask the Bot for a short report as a Word or PDF file and open it (A-04).
3. Create a scheduled task, lock the phone (A-07); show the result later in
   the demo.
4. Show the meters and buy a bundle with Alipay (A-09).
5. Hire a service in Gig Square, or show a MetaBot that earned from another
   user (A-13, A-14).
6. Return to the scheduled task's result; close with the cost-per-user and
   usage numbers.

## Sign-Off

| Milestone | Scope | Evidence | Result | Signed by | Date |
|-----------|-------|----------|--------|-----------|------|
| M0 | Phase 0 report and verdict | `PHASE0_REPORT.md`, `results.json` (commit `e8653bac`), S05b addendum | Pending S05b re-run | Owner | |
| M1 | `01` and `02` at 1.0.0 | | | Owner and every party | |
| M2 | A-01 to A-08, A-11 on staging | | | Acceptance | |
| M3 | A-01 to A-12 on staging, security P1 | | | Owner | |
| M4 | A-13 to A-23, security P2 | | | Acceptance | |
| M5 | Go-live checklist | | | Owner | |
