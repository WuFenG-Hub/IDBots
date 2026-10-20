#!/usr/bin/env bash
# WS-C REQ-C-14 — crash-consistent per-tenant backup to OSS.
#
#   backup-tenant.sh TENANT_ID
#
# Flow: rsync the live volume -> docker pause -> rsync the delta -> unpause
# (pause bounded by BACKUP_PAUSE_BUDGET_SECONDS, REQ-C-14: at most 60 s) ->
# tar | zstd | age -> upload to tenants/{tenantId}/{yyyy-mm-dd}.tar.zst.enc.
# A failure alerts BACKUP_ALERT_WEBHOOK and exits non-zero.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TENANT="${1:?usage: backup-tenant.sh TENANT_ID}"
[[ "$TENANT" =~ ^t_[a-z0-9]+$ ]] || die "bad tenant id: $TENANT"

check_common_deps   # docker itself is optional: local directory drills run without it

CONTAINER="idb-$TENANT"
VOLUME="idb-$TENANT-data"
DATE="$(date +%F)"
KEY="tenants/$TENANT/$DATE.tar.zst.enc"
START_TS="$(date +%s)"

# The volume must exist up front: `docker run -v` would otherwise auto-create
# an empty volume and we would "successfully" back up nothing.
if have_docker; then
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "volume $VOLUME does not exist"
else
  [ -d "$IDBOTS_VOLUME_ROOT/$VOLUME/_data" ] || die "volume $VOLUME not found under $IDBOTS_VOLUME_ROOT"
fi

VOL_PATH="$(volume_path "$VOLUME" 2>/dev/null || echo '(via helper container)')"
info "backing up $TENANT: volume $VOLUME ($VOL_PATH) -> $KEY [backend=$BACKUP_BACKEND]"

WORK="$(mktemp -d)"
cleanup() {
  unpause_container "$CONTAINER"
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/snapshot"

# Pass 1: copy while the tenant runs (the long part, no downtime).
snapshot_volume "$VOLUME" "$WORK/snapshot" || die "snapshot pass 1 failed for $VOLUME"
info "pass 1 snapshot done ($(du -sh "$WORK/snapshot" | cut -f1))"

# Pass 2: pause, copy the delta, unpause — bounded pause.
PAUSE_START="$(date +%s)"
pause_container "$CONTAINER"
snapshot_volume "$VOLUME" "$WORK/snapshot" || die "snapshot pass 2 failed for $VOLUME"
unpause_container "$CONTAINER"
PAUSED_FOR=$(( $(date +%s) - PAUSE_START ))
info "pass 2 snapshot done; container paused for ${PAUSED_FOR}s (budget ${BACKUP_PAUSE_BUDGET_SECONDS}s)"
if [ "$PAUSED_FOR" -gt "$BACKUP_PAUSE_BUDGET_SECONDS" ]; then
  alert backup "tenant $TENANT pause exceeded budget: ${PAUSED_FOR}s > ${BACKUP_PAUSE_BUDGET_SECONDS}s"
fi

# Archive + encrypt + upload.
make_archive "$WORK/snapshot" "$WORK/archive.tar.zst.enc"
SIZE="$(stat -f%z "$WORK/archive.tar.zst.enc" 2>/dev/null || stat -c%s "$WORK/archive.tar.zst.enc")"
oss_upload "$WORK/archive.tar.zst.enc" "$KEY"
oss_object_exists "$KEY" || die "upload verification failed for $KEY"

DURATION=$(( $(date +%s) - START_TS ))
write_metric tenant "$TENANT" 1 "$DURATION" "$SIZE"
info "done: $KEY (${SIZE} bytes, ${DURATION}s)"
