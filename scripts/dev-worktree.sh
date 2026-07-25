#!/usr/bin/env bash
# Dev server for this worktree on a dedicated port (5175/5176 are taken by other
# checkouts' dev instances). Usage: bash scripts/dev-worktree.sh [port]
set -e
cd "$(dirname "$0")/.."
PORT="${1:-5177}"
export IDBOTS_VITE_DEV_PORT="$PORT"

npx rimraf dist-electron
npm run compile:electron
npm run build:skills
npx concurrently \
  "vite --host 127.0.0.1 --port ${PORT} --strictPort" \
  "wait-on http://127.0.0.1:${PORT} && node scripts/wait-electron-dev-build.mjs dist-electron && cross-env NODE_ENV=development IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK=1 ELECTRON_START_URL=http://127.0.0.1:${PORT} electron ."
