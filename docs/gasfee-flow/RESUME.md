# Session Handoff — How to Resume This Project

> Read this after a restart / in a fresh session. It is the short version;
> the durable long version is the whole `docs/gasfee-flow/` directory.
> Last refreshed: 2026-08-11 (post R1/R2 merge).

## Where everything lives

- **All traffic work is merged into `main`** (latest merge: `65e9eff5`,
  R1 ledger detail). There is no long-lived feature branch anymore.
- **Docs (read in this order)**:
  1. `README.md` — background, vision, confirmed decisions, progress log
  2. `roadmap.md` — phases & milestone status (M1.x, M2.x except M2.4, M3.x done)
  3. `architecture.md` — system design
  4. `backend-spec.md` — backend contract (+ §12 errata)
  5. `idbots-implementation-plan.md` — client plan
  6. `m2-4-fee-rate-threading.md` — **next client task**, ready to start
  7. `phase4-payment-plan.md` — real payment plan (blocked on company credentials)
  8. `backend-request-ledger-txid.md` — pending backend change request
  9. `manual-qa-checklist.md` — on-device walkthrough
- **Backend repo (do NOT modify)**: `/Users/tusm/Documents/MetaID_Projects/assist-base-service`,
  their branch `feat/traffic-account` (worktree `.worktrees/traffic-account`)

## Current state (2026-08-11)

- Phase 1 (backend traffic account) **done**, 13/13 acceptance criteria verified
  live. Phase 2 (sponsor for all writes) done **except M2.4**. Phase 3 (recharge
  UI + traffic center) **done**.
- Two rounds of real-device QA feedback were addressed and merged:
  i18n coverage + friendly network errors, missing EN keys, adaptive B/KB/MB
  units (R2), ledger detail with full timestamp + TXID + business kind (R1).
- Product-owner decisions on record:
  - Source labels stay at business-kind level (chat / buzz / file).
    **Group/task-level source labels were explicitly rejected** (2026-08-11).
  - Mock payment is acceptable until company qualifications are ready.
  - Multi-chain recharge (Phase 6) comes after single-ISP (MVC) is proven.
- Test instance: `http://47.76.58.120:7882` (mainnet chain, isolated test keys;
  use the bare URL, **no** `/assist-open-api` suffix). Admin token: **not stored
  in the repo** — ask ops / copy from the backend team's handoff message.
- E2E scripts: `scripts/traffic-e2e/`, run with
  `ASSIST_ADMIN_TOKEN=... node scripts/traffic-e2e/run-traffic-e2e.mjs`.

## What remains (in order)

1. **Phase 3b — free-grant campaign + recharge codes** — SHIPPED to production
   (2026-08-14: prod smoke 26/26 PASS, campaign left OFF behind the admin
   switch; opening it requires no release). Acceptance runner committed:
   `scripts/traffic-e2e/run-phase3b-acceptance.mjs`. Ops guide:
   `operator-manual.md`.
2. **Client follow-up: prefer server-provided ledger `txId`** — backend
   delivered and live-verified 2026-08-13. Update `trafficAccountService.ts`
   to use the server field and demote the local journal join to a fallback.
3. **P2-03 — switch default apiBase to production** before release.
4. **Phase 4 real payment** (see `phase4-payment-plan.md`) — blocked on
   company qualifications.
5. Known non-blockers: 3 pre-existing test failures on main (mvcSpend pickUtxo
   ordering, two metaidCoreMvcRecovery) proven unrelated — do not chase them.

## Gotchas (cost us real time — read before testing)

- **Main-process tests import the compiled bundle** (`dist-electron/main/...`),
  not `src/`. After any merge or main-process edit, run
  `npm run compile:electron` first, or tests silently exercise stale code.
- Run traffic tests with `npx tsx --test tests/trafficAccountService.test.mjs`
  (plain `node --test` fails); renderer tests: `npx tsx --test tests/<file>.tsx`.
- `tests/*` is gitignored → new test files need `git add -f`.
- If the user reports "fetch failed" in the Traffic panel, first check the test
  instance is up: `curl -m 10 http://47.76.58.120:7882/v1/traffic/pricing`.

## Working agreements (must keep)

- Rhythm: new branch + same-named worktree (`.worktrees/<name>`, symlink
  `node_modules`), small commits, report, **wait for explicit confirmation**,
  then `git merge --no-ff` into main, delete branch + worktree.
- Every commit gets an on-chain dev journal via the `metabot-post-buzz` skill
  (user scope, not the repo's SKILLs copy). Docs/commits/comments in English.
- Never modify the assist-base-service repo; feedback goes to their team.
