# Runbook: backup and restore

Covers REQ-C-13..C-15 and the drill requirement in `60` (RPO 24 h; one tenant
back within 30 minutes; the whole host within 4 hours). Latest drill record:
`deploy/backup/drill/2026-10-20-local-restore-drill.md`.

## The nightly job (REQ-C-14)

`idbots-backup.timer` fires `idbots-backup.service` at 03:05 Asia/Shanghai;
`backup-nightly.sh` backs up the control-plane database first, then every
running `idb-t_*` container, staggered across the 03:00–05:00 window. Objects:

```
oss://{OSS_BUCKET}/tenants/{tenantId}/{yyyy-mm-dd}.tar.zst.enc
oss://{OSS_BUCKET}/control-plane/{yyyy-mm-dd}.sqlite.zst.enc
```

- Each archive is `tar | zstd | age` — client-side encrypted; the bucket adds
  SSE, versioning, and a 30-day lifecycle (`oss-bucket-setup.sh`).
- A tenant container is paused at most 60 s (alert if exceeded).
- Any failure alerts the robot and the `BackupFailed`/`BackupStale` Prometheus
  rules fire (textfile metrics in `/var/lib/idbots/node-exporter-textfile/`).

Operate it:

```bash
systemctl list-timers idbots-backup.timer
journalctl -u idbots-backup.service -n 100 --since today
sudo /opt/idbots/backup/backup-nightly.sh --now                 # manual full run
sudo /opt/idbots/backup/backup-tenant.sh t_xxx                  # single tenant
```

## Disk snapshots (REQ-C-13)

Daily automatic snapshots of the data disk are an Alibaba Cloud console
setting (not a repo asset): ECS → 自动快照策略 — daily, keep 7 daily + 4
weekly snapshots, applied to the encrypted ESSD. Verify once after bootstrap
and record the policy id in the host inventory.

## Single-tenant restore — drill (verification path)

Use the drill whenever you want to PROVE a backup is good without touching
the user (AC-C-5, A-21 rehearsal):

```bash
# bring the offline age private key onto the host (0600), then:
sudo BACKUP_AGE_KEY_FILE=/root/idbots-backup.key \
  /opt/idbots/backup/restore-tenant.sh t_xxx --mode drill
# or pick a night: --date 2026-10-20 ; keep the drill running: --keep
```

The script: downloads the object → decrypts → materializes a NEW volume
`idb-t_xxx-restore-{ts}` → normalizes ownership to uid 1000 →
`PRAGMA integrity_check` on every sqlite file → boots a throwaway container
on it (same image and env as the live tenant) → waits for `/healthz` → tears
down (unless `--keep`). Finish with `shred -u /root/idbots-backup.key`.

## Single-tenant restore — replace (disaster path)

Use when the user's data is actually lost or corrupted. Downtime: one tenant,
minutes.

```bash
sudo BACKUP_AGE_KEY_FILE=/root/idbots-backup.key \
  /opt/idbots/backup/restore-tenant.sh t_xxx --mode replace --confirm-replace [--date ...]
```

What happens: control-plane CLI stops the tenant → safety copy of the current
volume to `idb-t_xxx-data-pre-restore-{ts}` → backup materialized into a new
volume → integrity check → contents swapped into the tenant's volume → CLI
starts the tenant → the script waits for `ready|degraded` via the CLI.
The pre-restore volume stays until YOU remove it (after the user confirms
their data is back):

```bash
docker volume rm idb-t_xxx-data-pre-restore-{ts}     # only after confirmation
```

Rollback mid-restore: if the tenant does not become ready, the script stops
with the safety volume intact — swap it back the same way (see the script's
final error message) or rerun with an older `--date`.

After any restore: the tenant re-bootstraps its chain/LLM bindings from
Metaso (C4 identity-bound quota — purchased LLM quota survives, A-21).

## Full-host restore (from disk snapshot)

Test on staging once before M5 (REQ-C-15); production RTO target 4 h.

1. Console: create a new disk from the latest automatic snapshot, attach it
   to a fresh 8 vCPU / 32 GB host built per `host-bootstrap.md` § 1–2
   (same region/AZ), mount at `/var/lib/docker`.
2. Install Docker + the deploy assets (`bootstrap.sh`), fill `/etc/idbots/*`
   from the password-manager copies.
3. `docker compose ... up -d` — named volumes (cp-data, caddy-data) and all
   tenant volumes come back with the disk; the control plane reconciles its
   `tenants` table with the containers it finds (WS-B REQ-B-11) and resumes
   polling. Tenants start on their `unless-stopped` policy.
4. Verify: `/health`, a sample of tenants `/healthz` via the control plane,
   then switch the EIP/DNS to the new host.
5. Anything the snapshot missed (≤ 24 h) is replayed per tenant from OSS
   (`--mode replace`).

## Restore drill records

Keep one record per drill in `deploy/backup/drill/` (command, output,
duration, who ran it). Template: the 2026-10-20 record. Drills due:

- staging, after the first backup week (AC-C-5)
- staging, before M5, including the full-host path (`60` go-live checklist)
- production, quarterly (record goes into the ops log, not git, if it names
  real tenant ids)
