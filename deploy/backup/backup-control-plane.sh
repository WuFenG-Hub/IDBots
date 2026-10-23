#!/usr/bin/env bash
# WS-C REQ-C-14 — nightly control-plane database backup.
#
#   backup-control-plane.sh
#
# SQLite online backup (.backup) of cp.sqlite on the cp-data volume, then
# zstd | age -> control-plane/{yyyy-mm-dd}.sqlite.zst.enc. Failure alerts.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

check_common_deps

DATE="$(date +%F)"
KEY="control-plane/$DATE.sqlite.zst.enc"
START_TS="$(date +%s)"
info "backing up control-plane db (volume $CP_VOLUME_NAME) -> $KEY [backend=$BACKUP_BACKEND]"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if have_docker; then
  docker volume inspect "$CP_VOLUME_NAME" >/dev/null 2>&1 || die "volume $CP_VOLUME_NAME does not exist"
fi
VOL_PATH="$(volume_path "$CP_VOLUME_NAME" 2>/dev/null || true)"
if [ -n "$VOL_PATH" ] && [ -r "$VOL_PATH/cp.sqlite" ]; then
  # SQLite online backup: consistent even while the control plane writes.
  sqlite3 "$VOL_PATH/cp.sqlite" ".backup '$WORK/cp.sqlite'"
  CHECK="$(sqlite3 "$WORK/cp.sqlite" 'PRAGMA integrity_check;' | head -1)"
  [ "$CHECK" = ok ] || die "integrity_check on the backup copy failed: $CHECK"
elif have_docker; then
  # Host cannot read the volume path (Docker Desktop / remote docker): run the
  # online backup inside a helper container that mounts the volume.
  HELPER_IMAGE="${IDBOTS_CP_HELPER_IMAGE:-}"
  if [ -z "$HELPER_IMAGE" ]; then
    HELPER_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CP_CONTAINER_NAME" 2>/dev/null || true)"
  fi
  [ -n "$HELPER_IMAGE" ] || die "cannot determine a helper image (set IDBOTS_CP_HELPER_IMAGE)"
  info "host cannot read $CP_VOLUME_NAME — online backup inside helper container ($HELPER_IMAGE)"
  mkdir -p "$WORK/out"
  docker run --rm --entrypoint node -v "$CP_VOLUME_NAME":/data -v "$WORK/out":/out \
    -v "$IDBOTS_BACKUP_DIR":/tools:ro \
    "$HELPER_IMAGE" /tools/cp-online-backup.mjs /data/cp.sqlite /out/cp.sqlite
  mv "$WORK/out/cp.sqlite" "$WORK/cp.sqlite"
else
  die "control-plane database not reachable (no readable path, no docker)"
fi

mkdir -p "$WORK/payload"
mv "$WORK/cp.sqlite" "$WORK/payload/cp.sqlite"
make_archive "$WORK/payload" "$WORK/archive.sqlite.zst.enc"
SIZE="$(stat -f%z "$WORK/archive.sqlite.zst.enc" 2>/dev/null || stat -c%s "$WORK/archive.sqlite.zst.enc")"
oss_upload "$WORK/archive.sqlite.zst.enc" "$KEY"
oss_object_exists "$KEY" || die "upload verification failed for $KEY"

DURATION=$(( $(date +%s) - START_TS ))
write_metric control-plane "" 1 "$DURATION" "$SIZE"
info "done: $KEY (${SIZE} bytes, ${DURATION}s)"
