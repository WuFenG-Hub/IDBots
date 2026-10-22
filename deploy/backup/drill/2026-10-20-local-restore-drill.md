# Restore Drill Record — 2026-10-20 (local, pre-staging)

**Executor:** WS-C delivery agent · **Host:** macOS laptop, Docker Desktop
(linux/arm64 VM) · **Scripts under test:** `deploy/backup/` @ `feat/cloud-deploy`
**Backend:** `BACKUP_BACKEND=local` (a directory stands in for OSS; the OSS leg
uses the same code path through `oss_upload`/`oss_download`).

> Why local: the work order forbids buying cloud resources or touching the
> owner's accounts, and no staging host exists yet (procurement checklist
> `15`). This drill proves the backup → encrypt → store → fetch → decrypt →
> materialize → integrity-check → boot chain end to end. It must be repeated
> on staging against real OSS before M4 (AC-C-5) and again before M5
> (`60` go-live checklist). The staging procedure is identical except
> `BACKUP_BACKEND=oss` and the bucket variables.

## Fixture

- Stand-in tenant image `registry.cn-hongkong.aliyuncs.com/idbots/tenant:1.0.2-a87e87b`
  built from `deploy/tenant-image/` (`build.sh`, first build exercised the
  script end to end).
- Volume `idb-t_drill00000000000000-data` with `userdata/idbots.sqlite` (WAL;
  `bots` table: DrillBot, WorkerBot), `appdata/settings.json`,
  `workspace/uploads/hello.txt`. Volume `idbots_cp-data` with `cp.sqlite`.
- Tenant container `idb-t_drill00000000000000` running during the backup
  (so the pause/unpause leg is real).
- age key pair generated for the drill; private key kept in
  `/tmp/idbots-drill/age.key` (0600), never in the repo.

## Commands and output

```bash
export IDBOTS_BACKUP_ENV=/tmp/idbots-drill/backup.env   # BACKUP_BACKEND=local
export BACKUP_AGE_KEY_FILE=/tmp/idbots-drill/age.key

deploy/backup/backup-control-plane.sh
# done: control-plane/2026-10-20.sqlite.zst.enc (800 bytes, 2s)

deploy/backup/backup-tenant.sh t_drill00000000000000
# pass 1 snapshot done (16K)
# pass 2 snapshot done; container paused for 1s (budget 60s)
# done: tenants/t_drill00000000000000/2026-10-20.tar.zst.enc (924 bytes, 2s)

deploy/backup/backup-nightly.sh --now
# control-plane + 1 tenant(s), 0 failures — 4.8s total

deploy/backup/restore-tenant.sh t_drill00000000000000 --mode drill --keep
# decrypted + extracted 16K
# materialized volume idb-t_drill00000000000000-restore-20261020154718
# integrity check inside helper container: ok /data/userdata/idbots.sqlite
# drill container healthy on restored data
# RESTORE DRILL PASSED in 7s
```

## Verification of the restored data

| Check | Result |
|---|---|
| `PRAGMA integrity_check` on restored `idbots.sqlite` | `ok` |
| `bots` rows after restore | `[{id:1,DrillBot},{id:2,WorkerBot}]` — intact |
| `workspace/uploads/hello.txt` | content intact |
| `appdata/settings.json` | content intact |
| Ownership inside restored volume | normalized to uid 1000 (C1) |
| Drill container `/healthz` | healthy in <10 s on restored data |
| Backup pause time | 1–2 s (budget 60 s, REQ-C-14) |
| Wall time backup → verified restore | **~10 s** (target for A-21: 30 min) |
| Failure path: nonexistent tenant | standalone run dies; nightly run alerts the webhook (Feishu payload observed at a mock receiver) |

## Defects found by the drill and fixed before delivery

1. **AppleDouble pollution (macOS drills):** bsdtar smuggled `._*` sidecars
   into archives; the integrity checker then choked on `._idbots.sqlite`.
   Fix: `COPYFILE_DISABLE=1` + `--exclude='._*'` in both archive directions,
   and the checker skips `._*` names.
2. **Ownership after extraction:** archives extracted on a drill laptop (or
   by root on the host) left files the uid-1000 tenant could not write
   (`attempt to write a readonly database`). Fix: `restore-tenant.sh`
   normalizes the restored volume to `1000:1000` before any check or boot.
3. **Helper entrypoint:** the stand-in image's entrypoint swallowed helper
   commands. Fix: helpers run with `--entrypoint node` (documented for WS-A:
   helper images need `node:sqlite`, i.e. any node ≥ 24 image).
4. **Silent success on missing volume:** `docker run -v` auto-created an empty
   volume, producing a "successful" empty backup. Fix: both backup scripts
   verify the volume exists first.
5. **`flock` is Linux-only:** nightly single-flight now falls back to an
   `mkdir` lock where `flock` is absent.

## Not covered by this drill (scheduled)

| Leg | When | Where |
|---|---|---|
| Real OSS upload/download with the RAM credential | staging (T3) | runbooks/backup-and-restore.md § first-night checks |
| `--mode replace` against the control-plane CLI | staging (T3) | same runbook |
| 27-tenant nightly window timing (stagger) | staging AC-C-4/C-5 | same runbook |
| Full-host restore from disk snapshot | staging, before M5 (REQ-C-15) | same runbook § full-host restore |
