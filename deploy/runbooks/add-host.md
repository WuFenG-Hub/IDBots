# Runbook: add a host

Needed before user 59 on the 31.4 GB production host (REQ-C-1/C-19), or when
`TenantsNearCapacity` fires and stays. The control plane's `hosts` table is
multi-host ready (WS-B); v1 runs one row.

## 1. Buy and baseline (owner's team)

Same shape as the existing production host (`ecs.g8i.2xlarge`-class,
8 vCPU / 32 GB, encrypted ESSD, EIP ≥ 100 Mbps peak, Ubuntu 24.04,
`cn-hongkong`). Publish the new egress IP to WS-D (partner policy covers
one or two egress IPs, C4).

## 2. Bootstrap

Follow `host-bootstrap.md` § 1–5 identically: bootstrap script, env files
(same `APP_HOST`, same secrets except nothing host-specific), registry login,
stack up. The edge (caddy) on the second host stays idle for now — v1 keeps a
single public entry on host 1; the second host's caddy is its failover seed.

## 3. Register in `hosts`

```bash
CP="docker exec idbots-control-plane-1 node dist/cli.js"
# the control plane reaches the NEW host's Docker through ITS socket proxy —
# for v1 the control plane talks to one docker_url per host row:
#   docker_url = http://{new-host-internal-ip}:2375  (socket proxy, see note)
#   capacity   = 58 (31.4 GB) or 61 (full 32 GB) per REQ-C-19
# (exact CLI: cloud/control-plane/README.md — hosts add)
```

Note: the socket proxy port is NOT published by the stock compose file —
expose it only on the VPC internal address of the new host (add a
`ports: ["{internal-ip}:2375:2375"]` override on ITS host), never publicly;
the `cp-docker` network isolation still applies to host 1. Confirm from host
1: `curl http://{new-host-internal-ip}:2375/version`.

## 4. Firewall alignment

The new host runs the same `idbots-firewall.service`. Additionally, allow
host 1's control plane to reach the new host's tenants on 8790: the shipped
rule accepts from `172.30.0.2` — on the new host, add host 1's INTERNAL IP
to the accept rule:

```bash
sudo IDBOTS_CP_IP="172.30.0.2 {host1-internal-ip}" /opt/idbots/firewall.sh
# (extend firewall.sh env to loop over multiple CP IPs if it does not already)
```

Persist the same in the unit's environment (`/etc/systemd/system/idbots-firewall.service.d/cp-ips.conf`).

## 5. Move tenants (only if rebalancing)

New provisioning lands on the host with free capacity automatically.
Rebalancing an existing tenant = backup → restore on the new host via the
control plane (WS-B's provisioning path), then delete on the old host after
the user verifies. Treat it as a restore operation
(`backup-and-restore.md`) with the control plane pointed at the new host.

## 6. Verify

- `hosts` row shows the new capacity; provisioning beyond the old host is
  refused correctly (fill test on staging first).
- A new sign-up lands on the new host; isolation checks
  (`host-bootstrap.md` § 7) pass there.
- `TenantsNearCapacity` stops firing.
