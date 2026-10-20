#!/usr/bin/env bash
# WS-C — shared helpers for the backup/restore scripts. Source this file:
#   . "$(dirname "$0")/lib.sh"
# Configuration comes from /etc/idbots/backup.env (IDBOTS_BACKUP_ENV overrides
# the path, used by drills).

set -euo pipefail

IDBOTS_BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IDBOTS_BACKUP_ENV="${IDBOTS_BACKUP_ENV:-/etc/idbots/backup.env}"
if [ -f "$IDBOTS_BACKUP_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; . "$IDBOTS_BACKUP_ENV"; set +a
else
  echo "[backup] WARNING: $IDBOTS_BACKUP_ENV not found — relying on exported env" >&2
fi

# --- defaults -------------------------------------------------------------------
BACKUP_BACKEND="${BACKUP_BACKEND:-oss}"
OSS_BUCKET="${OSS_BUCKET:-}"
OSS_ENDPOINT="${OSS_ENDPOINT:-oss-cn-hongkong.aliyuncs.com}"
OSS_ACCESS_KEY_ID="${OSS_ACCESS_KEY_ID:-}"
OSS_ACCESS_KEY_SECRET="${OSS_ACCESS_KEY_SECRET:-}"
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/lib/idbots/backup-drill}"
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
BACKUP_PAUSE_BUDGET_SECONDS="${BACKUP_PAUSE_BUDGET_SECONDS:-60}"
BACKUP_STAGGER_MAX_SECONDS="${BACKUP_STAGGER_MAX_SECONDS:-300}"
BACKUP_ALERT_WEBHOOK="${BACKUP_ALERT_WEBHOOK:-}"
BACKUP_TEXTFILE_DIR="${BACKUP_TEXTFILE_DIR:-/var/lib/idbots/node-exporter-textfile}"
CP_VOLUME_NAME="${CP_VOLUME_NAME:-idbots_cp-data}"
CP_CONTAINER_NAME="${CP_CONTAINER_NAME:-idbots-control-plane-1}"
IDBOTS_VOLUME_ROOT="${IDBOTS_VOLUME_ROOT:-/var/lib/docker/volumes}"
OSSUTIL_BIN="${OSSUTIL_BIN:-}"

export TZ="${TZ:-Asia/Shanghai}"
# macOS bsdtar must not smuggle AppleDouble (._*) entries into archives.
export COPYFILE_DISABLE=1

log()  { echo "[$(date '+%F %T %z')] [$1] $2"; }
info() { log INFO "$*"; }
warn() { log WARN "$*" >&2; }
err()  { log ERROR "$*" >&2; }

die() { err "$*"; exit 1; }

need_bin() {
  command -v "$1" >/dev/null 2>&1 || die "required binary not found: $1"
}

check_common_deps() {
  need_bin tar; need_bin zstd; need_bin age; need_bin rsync; need_bin sqlite3
  case "$BACKUP_BACKEND" in
    oss)
      [ -n "$OSSUTIL_BIN" ] || OSSUTIL_BIN="$(command -v ossutil || command -v ossutil64 || true)"
      [ -n "$OSSUTIL_BIN" ] || die "ossutil not found (install per runbooks/backup-and-restore.md)"
      [ -n "$OSS_BUCKET" ] || die "OSS_BUCKET is empty"
      ;;
    local) : ;;
    *) die "unknown BACKUP_BACKEND: $BACKUP_BACKEND" ;;
  esac
}

# --- alerts (Feishu / DingTalk robot) --------------------------------------------
# Alerting must never break a backup run: failures are logged and swallowed.
alert() {
  local text="[IDBots][$1] $2"
  [ -n "$BACKUP_ALERT_WEBHOOK" ] || { warn "alert webhook unset; alert text was: $text"; return 0; }
  local payload
  case "$BACKUP_ALERT_WEBHOOK" in
    *oapi.dingtalk.com*)
      payload="$(jq -nc --arg t "$text" '{msgtype:"text",text:{content:$t}}')" ;;
    *)
      payload="$(jq -nc --arg t "$text" '{msg_type:"text",content:{text:$t}}')" ;;
  esac
  curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" \
    "$BACKUP_ALERT_WEBHOOK" >/dev/null 2>&1 \
    || warn "failed to deliver alert: $text"
}

# --- metrics (node-exporter textfile collector) -----------------------------------
# write_metric kind tenant result duration_seconds size_bytes
write_metric() {
  local kind="$1" tenant="$2" result="$3" duration="$4" size="$5"
  local dir="$BACKUP_TEXTFILE_DIR"
  [ -d "$dir" ] && [ -w "$dir" ] || { warn "textfile dir $dir not writable; metric skipped"; return 0; }
  local sel="kind=\"$kind\""
  [ "$kind" = tenant ] && sel="$sel,tenant=\"$tenant\""
  local tmp
  tmp="$(mktemp "$dir/.idbots_backup.XXXXXX")"
  {
    echo "# HELP idbots_backup_last_success_timestamp_seconds Unix time of the last successful backup."
    echo "# TYPE idbots_backup_last_success_timestamp_seconds gauge"
    [ "$result" = 1 ] && echo "idbots_backup_last_success_timestamp_seconds{$sel} $(date +%s)"
    echo "# HELP idbots_backup_last_duration_seconds Duration of the last backup run."
    echo "# TYPE idbots_backup_last_duration_seconds gauge"
    echo "idbots_backup_last_duration_seconds{$sel} $duration"
    echo "# HELP idbots_backup_last_size_bytes Size of the last produced archive."
    echo "# TYPE idbots_backup_last_size_bytes gauge"
    echo "idbots_backup_last_size_bytes{$sel} $size"
    echo "# HELP idbots_backup_last_result Result of the last backup run (1 ok, 0 failed)."
    echo "# TYPE idbots_backup_last_result gauge"
    echo "idbots_backup_last_result{$sel} $result"
  } > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$dir/idbots_backup_${kind}${tenant:+_${tenant}}.prom"
}

# --- OSS object layer ------------------------------------------------------------------
oss_upload() { # local_file key
  local file="$1" key="$2"
  case "$BACKUP_BACKEND" in
    oss)
      "$OSSUTIL_BIN" -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "$OSS_ENDPOINT" \
        cp -f "$file" "oss://$OSS_BUCKET/$key" >/dev/null
      ;;
    local)
      mkdir -p "$BACKUP_LOCAL_DIR/$(dirname "$key")"
      cp -f "$file" "$BACKUP_LOCAL_DIR/$key"
      ;;
  esac
}

oss_download() { # key local_file
  local key="$1" file="$2"
  case "$BACKUP_BACKEND" in
    oss)
      "$OSSUTIL_BIN" -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "$OSS_ENDPOINT" \
        cp -f "oss://$OSS_BUCKET/$key" "$file" >/dev/null
      ;;
    local)
      cp -f "$BACKUP_LOCAL_DIR/$key" "$file"
      ;;
  esac
}

oss_object_exists() { # key
  case "$BACKUP_BACKEND" in
    oss)
      "$OSSUTIL_BIN" -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "$OSS_ENDPOINT" \
        stat "oss://$OSS_BUCKET/$1" >/dev/null 2>&1
      ;;
    local)
      [ -s "$BACKUP_LOCAL_DIR/$1" ]
      ;;
  esac
}

oss_latest_key() { # prefix -> prints newest object key (lexicographic = newest date)
  local prefix="$1"
  case "$BACKUP_BACKEND" in
    oss)
      "$OSSUTIL_BIN" -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "$OSS_ENDPOINT" \
        ls "oss://$OSS_BUCKET/$prefix" 2>/dev/null \
        | grep -oE "oss://$OSS_BUCKET/.+" | sed "s|oss://$OSS_BUCKET/||" | sort | tail -1
      ;;
    local)
      find "$BACKUP_LOCAL_DIR/$prefix" -type f -name '*.enc' 2>/dev/null \
        | sed "s|^$BACKUP_LOCAL_DIR/||" | sort | tail -1
      ;;
  esac
}

# --- docker helpers (degrade to no-docker local drills) ---------------------------------
have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

tenant_container_running() { # tenant
  have_docker && [ -n "$(docker ps -q -f "name=^/idb-$1\$")" ]
}

volume_path() { # volume_name -> host path of the volume data
  local vol="$1"
  if have_docker; then
    docker volume inspect -f '{{.Mountpoint}}' "$vol" 2>/dev/null && return 0
  fi
  local p="$IDBOTS_VOLUME_ROOT/$vol/_data"
  [ -d "$p" ] && { echo "$p"; return 0; }
  return 1
}

pause_container() { # container
  if have_docker && docker ps -q -f "name=^/$1\$" | grep -q .; then
    docker pause "$1" >/dev/null
  else
    warn "container $1 not running (or no docker) — pause skipped; backup is crash-consistent only"
  fi
}

unpause_container() { # container
  if have_docker; then
    docker unpause "$1" >/dev/null 2>&1 || true
  fi
}

# --- archive pipeline ---------------------------------------------------------------------
# make_archive snapshot_dir out_file  (tar | zstd | age)
make_archive() {
  local src="$1" out="$2"
  [ -n "$BACKUP_AGE_RECIPIENT" ] || die "BACKUP_AGE_RECIPIENT is empty"
  tar --exclude='._*' -cf - -C "$src" . \
    | zstd -19 -T0 -q \
    | age -r "$BACKUP_AGE_RECIPIENT" -o "$out"
}

# extract_archive enc_file dest_dir  (age -d | zstd -d | tar)
extract_archive() {
  local enc="$1" dest="$2"
  [ -n "${BACKUP_AGE_KEY_FILE:-}" ] || die "BACKUP_AGE_KEY_FILE is unset (bring the offline age key)"
  mkdir -p "$dest"
  age -d -i "$BACKUP_AGE_KEY_FILE" "$enc" \
    | zstd -d -q \
    | tar --exclude='._*' -xf - -C "$dest"
}

integrity_check_sqlite() { # dir-with-sqlite-files label -> 0 if every db says ok
  local dir="$1" label="$2" db rc=0 found=0
  while IFS= read -r db; do
    found=1
    local result
    # Open read-write on purpose: an archived WAL needs recovery on first open,
    # and proving recovery works is part of the check. Only ever runs on
    # restored copies, never on a live volume.
    result="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -1)" || true
    if [ "$result" = ok ]; then
      info "integrity_check ok: $db"
    else
      err "integrity_check FAILED ($label): $db -> $result"
      rc=1
    fi
  done < <(find "$dir" -name '*.sqlite' -type f 2>/dev/null)
  [ "$found" = 1 ] || warn "no .sqlite files under $dir ($label) — integrity check skipped"
  return $rc
}

# snapshot_volume VOLUME DEST_DIR — copy the volume's current contents into
# DEST_DIR. Host path rsync (--delete) when readable; otherwise a helper
# container streams a tar out of the volume (Docker Desktop / remote docker).
snapshot_volume() { # volume dest_dir
  local vol="$1" dest="$2" p=""
  if p="$(volume_path "$vol" 2>/dev/null)" && [ -r "$p" ]; then
    rsync -a --delete "$p/" "$dest/"
  elif have_docker; then
    rm -rf "$dest"; mkdir -p "$dest"
    docker run --rm -i -v "$vol":/data:ro alpine:3.20 tar -cf - -C /data . | tar -xf - -C "$dest"
  else
    return 1
  fi
}

# integrity_check_volume VOLUME LABEL [IMAGE] — PRAGMA integrity_check on every
# .sqlite in the volume. Host sqlite3 when the volume path is readable; a
# helper container running node:sqlite (tools/integrity-check.mjs) otherwise.
integrity_check_volume() { # volume label [image]
  local vol="$1" label="$2" image="${3:-}" p=""
  if p="$(volume_path "$vol" 2>/dev/null)" && [ -r "$p" ]; then
    integrity_check_sqlite "$p" "$label"
  elif have_docker && [ -n "$image" ]; then
    info "volume path not host-readable — integrity check inside helper container ($image)"
    docker run --rm --user 0 --entrypoint node -v "$vol":/data -v "$IDBOTS_BACKUP_DIR":/tools:ro \
      "$image" /tools/integrity-check.mjs /data
  else
    warn "integrity check skipped for $vol (no readable path, no docker/image)"
  fi
}
