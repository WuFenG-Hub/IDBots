# 31 — WS-C Implementation Plan

**Party:** infrastructure engineering. **Spec:** `30-ws-c-infra-ops.md`.
**Contracts consumed:** C1 (how a tenant is run). **Accepted against:**
AC-C-1 to AC-C-7.

Buying the domain, the hosts, the registry, SMS, and the other accounts is
not this plan. That list is `15-ops-procurement.md`. This party writes the
deploy assets and applies them once those accounts exist.

The planning desk does not write this code. One branch plus one worktree
from `main`, per `AGENTS.md`. Do not push or merge until the owner says so.

## Start now, no cloud account required

### T1 — `feat/cloud-deploy` (REQ-C-5, REQ-C-6, REQ-C-7, REQ-C-9, REQ-C-10, REQ-C-11, the runbook set)

In the repository:

- `deploy/hosts/compose.yml`, env example, Caddyfile using `{$APP_HOST}`,
  firewall unit, backup and restore scripts.
- `.github/workflows/cloud-images.yml`, ready to push once ACR credentials
  exist as CI secrets.
- The nine runbooks under `deploy/runbooks/`. Write them so an operator who
  did not write them can follow them. Fill host-specific values as
  placeholders until T2.

`{APP_DOMAIN}` may still be unset. Keep it a variable. Do not invent a
domain.

Done when a reviewer can read the compose file and the runbooks and see
where the ops checklist's outputs plug in.

## After the ops checklist marks staging host, domain, and ACR done

### T2 — apply staging (REQ-C-1 staging, REQ-C-2, REQ-C-3, REQ-C-4, REQ-C-8, REQ-C-12)

Bootstrap the staging host from `host-bootstrap.md`. Capacity 27. Elastic IP
billed by traffic with at least 100 Mbps peak. Publish the egress IP to WS-D
(they need it for REQ-D-6).

Done when AC-C-1 and AC-C-2 pass on staging.

### T3 — backups, monitoring, reboot (REQ-C-13 to REQ-C-22)

Nightly backups, alerts (including CPU), external uptime check, and AC-C-4
with the staging host filled to its capacity of 27 tenants. That fill uses
fake tenants if the real image is not ready, and real tenants once WS-A T5
is accepted.

## After the ops checklist marks the production host done (M3)

### T4 — production

Same assets, capacity 58, empty of users until M5. A second host is not
bought until user 59.

## Handback

A delivery note per stage: which AC passed, the staging URL, the egress IP,
and the image tags. No AccessKey, private key, or password in the note or
in git.
