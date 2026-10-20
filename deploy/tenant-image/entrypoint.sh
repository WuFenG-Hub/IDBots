#!/bin/bash
# ============================================================================
# IDBots tenant entrypoint — REQ-A-6 (exact), C1 "Image" + "Lifecycle".
#
#   1. Require server mode and the C1-required secrets.
#   2. Remove stale Xvfb locks (Phase 0: docker stop/start leaves them and the
#      app dies with "Missing X server or $DISPLAY").
#   3. Create the C1 volume directories on a fresh named volume.
#   4. Start D-Bus and Xvfb on :99, export DISPLAY.
#   5. exec Electron with --no-sandbox ON THE COMMAND LINE (Phase 0: the
#      app's internal switch applies too late under no-new-privileges) and no
#      debugging port of any kind.
#
# exec keeps Electron as the container's main process so SIGTERM (graceful
# shutdown, REQ-A-3/T4) reaches it; the container must run with --init (C1).
# ============================================================================
set -euo pipefail

log() {
  printf '{"ts":"%s","level":"info","component":"entrypoint","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

fail() {
  printf '{"ts":"%s","level":"error","component":"entrypoint","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2
  exit 1
}

# --- C1 required environment -----------------------------------------------
[ "${IDBOTS_SERVER_MODE:-}" = "1" ] \
  || fail "IDBOTS_SERVER_MODE=1 is required: this image runs the IDBots tenant backend in server mode and refuses to start without it."
[ -n "${IDBOTS_TENANT_ID:-}" ] \
  || fail "IDBOTS_TENANT_ID is required (opaque tenant id from the control plane)."
[ -n "${IDBOTS_GATEWAY_SECRET:-}" ] \
  || fail "IDBOTS_GATEWAY_SECRET is required (32 random bytes, base64url)."

export IDBOTS_SERVER_MODE IDBOTS_TENANT_ID
: "${IDBOTS_GATEWAY_PORT:=8790}"
export IDBOTS_GATEWAY_PORT

# --- Stale Xvfb locks (Phase 0 restart finding) ------------------------------
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# --- C1 volume directories (fresh named volume) ----------------------------
mkdir -p /data/userdata /data/appdata /data/workspace

# --- D-Bus session -----------------------------------------------------------
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS
fi

# --- Xvfb on :99 (REQ-A-6) ---------------------------------------------------
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 &
XVFB_PID=$!
for _ in $(seq 1 50); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done
[ -S /tmp/.X11-unix/X99 ] || fail "Xvfb did not create /tmp/.X11-unix/X99"
log "Xvfb ready on :99 (pid ${XVFB_PID}); DISPLAY=${DISPLAY}"

# --- Electron ----------------------------------------------------------------
# --no-sandbox MUST be on the command line: under no-new-privileges the setuid
# sandbox cannot work, and the app's internal switch is applied too late.
# No debugging port is opened (REQ-A-32); nothing may listen on 9222 except
# web-search's own Chromium.
# The same no-new-privileges profile breaks Chromium's sandbox too, so the
# web-search skill opts into --no-sandbox via this env (see
# SKILLs/web-search/server/playwright/browser.ts).
export WEB_SEARCH_CHROME_NO_SANDBOX=1
log "starting IDBots tenant backend (uid $(id -u), gateway port ${IDBOTS_GATEWAY_PORT})"
exec electron --no-sandbox /app
