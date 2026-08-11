# Session Handoff — How to Resume This Project

> Read this after a restart / in a fresh session. It is the short version;
> the durable long version is the whole `docs/gasfee-flow/` directory.

## Where everything lives

- **Branch / worktree**: `feat/gasfee-flow` at `.worktrees/gasfee-flow`
  (persists on disk across reboots; nothing is only in memory)
- **Docs (read in this order)**:
  1. `README.md` — background, vision, confirmed decisions, progress log
  2. `roadmap.md` — phases & milestone status (M1.x, M2.x, M3.x all done)
  3. `architecture.md` — system design
  4. `backend-spec.md` — backend contract (+ §12 errata)
  5. `idbots-implementation-plan.md` — client plan
  6. `manual-qa-checklist.md` — the pending on-device walkthrough
- **Backend repo (do NOT modify)**: `/Users/tusm/Documents/MetaID_Projects/assist-base-service`,
  their branch `feat/traffic-account` (worktree `.worktrees/traffic-account`)

## Current state (2026-08-10)

- Client Phases A–E **complete**; backend Phase 1 **complete**; joint
  integration (M1.7) **PASSED** — all 13 acceptance criteria verified live
  against the test instance. Latest commit: `d57f0f98`.
- Test instance: `http://47.76.58.120:7882` (mainnet chain, isolated test keys).
  Admin token: **not stored in the repo** — copy it from the backend team's
  handoff message in chat history / ask ops.
- E2E evidence & scripts: `scripts/traffic-e2e/` (`run-traffic-e2e.mjs`,
  `run-acceptance-extended.mjs`, `run-acceptance-feerate.mjs`), runnable with
  `ASSIST_ADMIN_TOKEN=... node scripts/traffic-e2e/run-traffic-e2e.mjs`.

## What remains (in order)

1. **On-device QA of the Traffic panel** — follow `manual-qa-checklist.md`:
   `cd .worktrees/gasfee-flow && npm run dev`, then Settings → Traffic →
   Advanced → `http://47.76.58.120:7882` (no path suffix) → the checklist steps.
2. **Merge decision** — deferred by product owner ("version has big changes,
   accept on the branch first"). Our branch is merge-ready (default self-pay =
   zero behavior change); backend's `feat/traffic-account` is also accepted.
   Merge only on explicit instruction, with `git merge --no-ff`.
3. **Phase 4 real payment** — Stripe + Alipay together, after company
   qualifications; replace the clearly-marked mock-pay points
   (`TrafficSettings.tsx` handleMockConfirm + backend MockGateway).
4. Known follow-ups: 3 pre-existing test failures on main (unrelated, logged in
   README progress); backend nits already forwarded (order response lacks
   `networkFeeRate`; rate-limit retry guidance for their docs).

## Working agreements (must keep)

- Every change: small commit (`<type>: <desc>`) + on-chain dev journal via the
  `metabot-post-buzz` skill (user scope, not the repo's SKILLs copy).
- Never modify the assist-base-service repo; feedback goes to their team.
- All code changes stay inside the worktree; never commit on main directly.
- tests/* is gitignored → new test files need `git add -f`.
