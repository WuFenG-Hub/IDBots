#!/usr/bin/env bash
# WS-C REQ-C-15 — restore one tenant from a chosen backup.
#
#   restore-tenant.sh TENANT_ID [--date YYYY-MM-DD] [--mode drill|replace] [--keep] [--confirm-replace]
#
# drill (default): materializes the backup into a NEW volume
#   idb-{tenant}-restore-{ts}, checks PRAGMA integrity_check, starts a
#   throwaway container on it (same image + env as the live tenant), waits for
#   /healthz, then tears everything down (unless --keep). The live tenant is
#   never touched. This is the restore drill for AC-C-5 / A-21.
#
# replace: the disaster path. Stops the tenant through the control-plane CLI,
#   keeps a safety copy of the current volume, replaces its contents with the
#   backup, and starts the tenant again through the CLI. Requires
#   --confirm-replace. See runbooks/backup-and-restore.md.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TENANT=""
DATE=""
MODE="drill"
KEEP=0
CONFIRM_REPLACE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --date) DATE="${2:?}"; shift 2 ;;
    --mode) MODE="${2:?}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --confirm-replace) CONFIRM_REPLACE=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    t_*|[a-z]*_[a-z0-9]*) [ -z "$TENANT" ] && { TENANT="$1"; shift; } || die "unexpected argument: $1" ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$TENANT" ] || die "usage: restore-tenant.sh TENANT_ID [--date ...] [--mode drill|replace] [--keep] [--confirm-replace]"
[[ "$TENANT" =~ ^t_[a-z0-9]+$ ]] || die "bad tenant id: $TENANT"
[ "$MODE" = drill ] || [ "$MODE" = replace ] || die "--mode must be drill or replace"
if [ "$MODE" = replace ] && [ "$CONFIRM_REPLACE" != 1 ]; then
  die "replace mode overwrites the live volume — pass --confirm-replace (see runbooks/backup-and-restore.md)"
fi

check_common_deps
[ -n "${BACKUP_AGE_KEY_FILE:-}" ] || die "BACKUP_AGE_KEY_FILE is unset — bring the offline age private key (0600), then remove it after the drill"
[ -r "$BACKUP_AGE_KEY_FILE" ] || die "BACKUP_AGE_KEY_FILE not readable: $BACKUP_AGE_KEY_FILE"

START_TS="$(date +%s)"
TS="$(date +%Y%m%d%H%M%S)"
CONTAINER="idb-$TENANT"
VOLUME="idb-$TENANT-data"
WORK="$(mktemp -d)"

DRILL_VOLUME=""
DRILL_CONTAINER=""
cleanup_drill() {
  if [ "$MODE" = drill ] && [ "$KEEP" != 1 ]; then
    [ -n "$DRILL_CONTAINER" ] && have_docker && docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
    [ -n "$DRILL_VOLUME" ] && have_docker && docker volume rm -f "$DRILL_VOLUME" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup_drill EXIT

# --- 1. locate + download + decrypt ----------------------------------------------------
KEY=""
if [ -n "$DATE" ]; then
  KEY="tenants/$TENANT/$DATE.tar.zst.enc"
else
  KEY="$(oss_latest_key "tenants/$TENANT/")"
  [ -n "$KEY" ] || die "no backups found under tenants/$TENANT/ (backend=$BACKUP_BACKEND)"
fi
info "restoring $TENANT from $KEY (mode=$MODE, backend=$BACKUP_BACKEND)"
oss_download "$KEY" "$WORK/backup.tar.zst.enc"
[ -s "$WORK/backup.tar.zst.enc" ] || die "download produced an empty file for $KEY"

mkdir -p "$WORK/extracted"
extract_archive "$WORK/backup.tar.zst.enc" "$WORK/extracted"
info "decrypted + extracted $(du -sh "$WORK/extracted" | cut -f1)"

# --- 2. materialize into a NEW volume ----------------------------------------------------
if [ "$MODE" = drill ]; then
  DRILL_VOLUME="idb-$TENANT-restore-$TS"
  DRILL_CONTAINER="idb-$TENANT-restore-$TS"
else
  DRILL_VOLUME="idb-$TENANT-data-restored-$TS"
fi

if have_docker; then
  docker volume create "$DRILL_VOLUME" >/dev/null
  # Populate via a helper container so ownership/permissions are preserved
  # exactly as archived, without host root quirks.
  tar -cf - -C "$WORK/extracted" . | docker run --rm -i -v "$DRILL_VOLUME":/data alpine:3.20 tar -xf - -C /data
else
  DEST="$IDBOTS_VOLUME_ROOT/$DRILL_VOLUME/_data"
  mkdir -p "$DEST"
  (cd "$WORK/extracted" && tar -cf - .) | tar -xf - -C "$DEST"
  warn "no docker — materialized $DRILL_VOLUME as a plain directory ($DEST)"
fi

# C1: the tenant runs as uid 1000. Extraction as a non-root operator (drill
# laptop) or root (host) can leave wrong ownership behind — normalize it so
# the restored tenant can always write its own data.
if have_docker; then
  docker run --rm -v "$DRILL_VOLUME":/data alpine:3.20 chown -R 1000:1000 /data
else
  chown -R 1000:1000 "$IDBOTS_VOLUME_ROOT/$DRILL_VOLUME/_data" 2>/dev/null \
    || warn "chown to uid 1000 failed (not root?) — tenant may not be able to write"
fi
info "materialized volume $DRILL_VOLUME"

# Resolve the image up front: the integrity check may need it for a helper
# container, and the drill boots it.
LIVE_IMAGE=""
if have_docker; then
  LIVE_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
fi
IMAGE="${IDBOTS_DRILL_IMAGE:-${LIVE_IMAGE:-}}"

# --- 3. integrity check (before anything boots on the data) ------------------------------
integrity_check_volume "$DRILL_VOLUME" "$KEY" "$IMAGE" || die "integrity check failed — NOT proceeding"

# --- 3b. fidelity compare against the archive's manifest (WS-C review S2-3) ---------------
info "comparing restored data against the archived manifest"
if compare_manifests "$WORK/extracted/_backup-manifest.json" "$WORK/extracted"; then
  info "data fidelity: MATCH"
else
  die "data fidelity MISMATCH — restored data differs from the archived manifest"
fi

if [ "$MODE" = drill ]; then
  # --- 4a. boot a throwaway container on the restored volume -------------------------------
  if have_docker; then
    [ -n "$IMAGE" ] || die "cannot determine the tenant image (set IDBOTS_DRILL_IMAGE)"
    ENVFILE="$WORK/drill.env"
    if [ -n "$LIVE_IMAGE" ]; then
      docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" > "$ENVFILE"
    else
      printf 'IDBOTS_SERVER_MODE=1\nIDBOTS_TENANT_ID=%s\nIDBOTS_GATEWAY_SECRET=%s\n' \
        "$TENANT" "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" > "$ENVFILE"
    fi
    NETWORK="$(docker inspect -f '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
    NETWORK="${NETWORK:-bridge}"
    info "starting drill container $DRILL_CONTAINER (image $IMAGE, network $NETWORK)"
    docker run -d --init --name "$DRILL_CONTAINER" \
      --network "$NETWORK" \
      --env-file "$ENVFILE" \
      -v "$DRILL_VOLUME":/data \
      --memory 2304m --cpus 2 --pids-limit 2048 --shm-size 1g \
      --cap-drop ALL --security-opt no-new-privileges \
      "$IMAGE" >/dev/null

    # Wait for /healthz from inside the container (curl, wget, or node).
    HEALTHY=0
    for _ in $(seq 1 18); do
      sleep 5
      for probe in \
        "curl -fsS -m 3 http://127.0.0.1:8790/healthz" \
        "wget -q -O /dev/null -T 3 http://127.0.0.1:8790/healthz" \
        "node -e \"fetch('http://127.0.0.1:8790/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""; do
        if docker exec "$DRILL_CONTAINER" sh -c "$probe" >/dev/null 2>&1; then
          HEALTHY=1; break
        fi
      done
      [ "$HEALTHY" = 1 ] && break
      docker ps -q -f "name=^/$DRILL_CONTAINER\$" | grep -q . || break
    done
    if [ "$HEALTHY" = 1 ]; then
      info "drill container healthy on restored data"
    else
      err "drill container did not become healthy in 90 s"
      have_docker && docker logs --tail 50 "$DRILL_CONTAINER" >&2 2>/dev/null || true
      die "restore drill FAILED at container boot"
    fi
  else
    warn "no docker — container-boot leg of the drill skipped (integrity check already passed)"
  fi

  DURATION=$(( $(date +%s) - START_TS ))
  info "RESTORE DRILL PASSED for $TENANT from $KEY in ${DURATION}s"
  [ "$KEEP" = 1 ] && info "--keep: left $DRILL_CONTAINER / $DRILL_VOLUME in place"
  exit 0
fi

# --- 4b. replace mode: swap the live volume's contents, restart through the CLI ------------
info "replace mode: stopping tenant through the control-plane CLI"
CP_CLI=(docker exec "$CP_CONTAINER_NAME" node dist/cli.js)
"${CP_CLI[@]}" tenant stop "$TENANT" --as admin:restore
sleep 2

SAFETY_VOLUME="idb-$TENANT-data-pre-restore-$TS"
info "safety copy: $VOLUME -> $SAFETY_VOLUME"
docker volume create "$SAFETY_VOLUME" >/dev/null
docker run --rm -v "$VOLUME":/from -v "$SAFETY_VOLUME":/to alpine:3.20 \
  sh -c 'cp -a /from/. /to/'

info "replacing contents of $VOLUME with the restored backup"
docker run --rm -v "$VOLUME":/dst -v "$DRILL_VOLUME":/src alpine:3.20 \
  sh -c 'rm -rf /dst/* /dst/.[!.]* 2>/dev/null; cp -a /src/. /dst/'

info "starting tenant through the control-plane CLI"
"${CP_CLI[@]}" tenant start "$TENANT" --as admin:restore

# The control plane polls /readyz and flips status to ready/degraded.
READY=0
for _ in $(seq 1 36); do
  sleep 5
  STATUS="$("${CP_CLI[@]}" tenant show "$TENANT" 2>/dev/null | grep -oE '"status"[[:space:]]*:[[:space:]]*"[a-z]+"' | head -1 | grep -oE '[a-z]+"$' | tr -d '"' || true)"
  case "$STATUS" in ready|degraded) READY=1; break ;; failed) break ;;
  esac
done
if [ "$READY" = 1 ]; then
  DURATION=$(( $(date +%s) - START_TS ))
  info "REPLACE RESTORE PASSED for $TENANT (status=$STATUS) in ${DURATION}s"
  info "safety volume kept: $SAFETY_VOLUME — remove it after the user confirms (runbooks/backup-and-restore.md)"
  docker volume rm -f "$DRILL_VOLUME" >/dev/null 2>&1 || true
else
  err "tenant did not become ready (last status: ${STATUS:-unknown})"
  err "the pre-restore data is safe in volume $SAFETY_VOLUME — see runbooks/backup-and-restore.md § rollback"
  alert restore "tenant $TENANT replace-restore FAILED; safety volume $SAFETY_VOLUME retained"
  exit 1
fi
