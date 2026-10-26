# Handoff — Cloud and Mobile

Start here. The package index is [`README.md`](README.md). Requirements and
acceptance live in the numbered files.

## Current status (2026-10-26)

The program now has real server-mode, gateway, control-plane, tenant-image,
and PWA code plus delivery records. It is a working main-flow prototype, not
an accepted product. The current productization plan is
[`70-phase-2-optimization-and-iteration-plan.md`](70-phase-2-optimization-and-iteration-plan.md):
it prioritizes a correctly bound Twin Bot conversation, shared desktop/mobile
session behavior, complete work and artifact journeys, and PWA/cloud recovery
before native shells or fine polish. Read it after `00-program-plan.md` and
before starting new implementation work.

The sections below are the historical continuity record for the planning
session that ended on 2026-10-16. At that point no product code existed; the
session had written documents only, merged as `20240bc5`
(`merge: docs/mobile-cloud-design`). The branch `docs/mobile-cloud-design` and
its worktree were removed after that merge. Do not recreate them. New work
branches from current `main`.

## Read in this order

1. This file.
2. [`README.md`](README.md) and [`00-program-plan.md`](00-program-plan.md).
3. The implementation plan for the part you are building (`11`, `21`, `31`,
   `41`, `51`, or [`15-ops-procurement.md`](15-ops-procurement.md)).
4. [`01-interface-contracts.md`](01-interface-contracts.md) and, for the
   phone, [`02-ipc-allowlist-v1.md`](02-ipc-allowlist-v1.md).
5. The matching requirements file (`10`, `20`, `30`, `40`, or `50`) and
   [`60-acceptance-and-go-live.md`](60-acceptance-and-go-live.md).

An agent that is building the whole program follows the order in "Build
order" below and still uses one branch per task, from `main`, per
`AGENTS.md`. Do not push or merge to `main` unless the owner says so.

## Decisions already signed

- **M0 GO** and **M1 contracts 1.0.0**, signed by the owner on 2026-10-15.
  `01` and `02` are frozen. A sentence that cannot be implemented becomes a
  change request. Do not edit those two files to match the code.
- **One codebase, one version.** Desktop installers and the tenant image are
  cut from the same commit. `IDBOTS_SERVER_MODE` unset means today's desktop
  behavior. Packaged desktop builds do not start the gateway. Desktop
  acceptance is AC-A-1 in `10`. The phone does not remote-control a user's
  desktop; the only link is a mnemonic export that can be imported into
  desktop IDBots.
- **Where the code goes.**
  - WS-A server mode, gateway, and tenant image: this repository.
  - WS-B control plane: this repository, `cloud/control-plane/`, its own
    pnpm package. It is not shipped in the desktop installer. It does not
    import IDBots app code.
  - WS-C deploy assets, Caddy, firewall, backups, CI, runbooks: this
    repository, `deploy/`.
  - WS-D bundle billing only: the Metaso repository
    `assist-base-service` (Go, Gin, MySQL). Do not put the control plane or
    the host deploy files there. That service already runs traffic accounts,
    Alipay, the LLM relay, and gas sponsorship for desktop users.
  - WS-E mobile client: this repository, `src/mobile/` and `mobile-shell/`.
- Do not open a new repository for the control plane or the infrastructure
  in this release. The tenant image and the control plane must ship
  together because they share the C2 gateway protocol.

## What Phase 0 proved

The stock app runs headless in one container per user on a Hong Kong Linux
host, with no app patch. Signed numbers: tenant memory limit **2304 MB**,
**58** tenants on the 31.4 GB host, **27** on 16 GB. Idle about 463 MB.
Web-search passed by its HTTP script; its browser-launch path is still
unproven (AC-A-5). Memory returns by about 30 minutes; server mode must
shorten that to 10 minutes (REQ-A-31). The free LLM allowance is per
identity and runs out after a handful of heavy skills.

The plan is
[`docs/superpowers/plans/2026-10-14-phase0-linux-headless-spike.md`](../superpowers/plans/2026-10-14-phase0-linux-headless-spike.md).
The results branch is not in the repository. The owner archived it on
2026-10-16:

- Git bundle: `/Users/tusm/Downloads/spike-linux-headless.bundle`
  (branch `spike/linux-headless` at `956f2b05`).
- Patch-series tarball:
  `/Users/tusm/Downloads/phase0-linux-headless-results.tgz`, sha256
  `ec684f1ce37e77e2ab38a3e9950347f8606f7950649ef5faffa48fef60c1088b`.

Restore the bundle only to read `spikes/linux-headless/PHASE0_REPORT.md`
and `results.json`. Do not merge that branch into `main`.

## Build order for the whole program

These can start together, from current `main`:

| Track | First branch | Plan | Waits on |
|-------|----------------|------|----------|
| IDBots server mode | `feat/ipc-registry` and `feat/ipc-contract` | `11` | Nothing |
| Control plane | `feat/control-plane` against its own fake tenant | `21` | Nothing for the fake tenant |
| Mobile UI | `feat/mobile-bridge` on the mock bridge | `51` | Nothing for the mock |
| Metaso bundle | staging API in `assist-base-service` | `41` | Nothing. Send the staging base URL by 2026-10-23 |
| Deploy assets | `feat/cloud-deploy` | `31` | Nothing for the files. Applying them waits on `15` |
| Accounts | no code | `15` | Owner. SMS signature and the Apple account have the longest lead time |

Then: WS-A gateway (`feat/gateway`) so WS-E can leave the mock and WS-B can
proxy a real gateway. Then server mode and the tenant image. Then WS-C
staging, using the host and domain from `15`. Phase 1 is accepted at M3
(scenarios A-01 to A-12). Shells, Gig Square, and backups are M4.

## How to hand work back

One delivery note per branch: each requirement id, status, and evidence.
Open S1 or S2 defects are not accepted. The planning desk accepts against
the workstream criteria and `60`. It does not implement the program.
