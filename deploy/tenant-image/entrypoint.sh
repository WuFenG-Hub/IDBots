#!/bin/sh
# Stand-in tenant entrypoint. WS-A's real entrypoint:
#   1. removes stale Xvfb locks (/tmp/.X99-lock, /tmp/.X11-unix/X99)
#   2. starts Xvfb :99 and D-Bus
#   3. execs Electron with --no-sandbox (no remote debugging port)
# The stand-in has no display stack; keep the shape so the swap is drop-in.
set -e

# --- WS-A: Xvfb lock cleanup + Xvfb :99 + D-Bus would go here ---

exec node /app/server.mjs
