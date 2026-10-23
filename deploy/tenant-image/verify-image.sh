#!/bin/bash
# ============================================================================
# verify-image.sh <image:tag> [build-log]
#
# Post-build checks for the tenant image (REQ-A-26/REQ-A-27), run from any
# host with a Docker daemon — no container startup needed beyond short
# one-shot runs. Usage:
#
#   deploy/tenant-image/verify-image.sh idbots/tenant:1.0.2-a2bff22 build.log
#
# Exit 0 only when every check passes. The optional build log (captured via
# `docker buildx build ... 2>&1 | tee build.log`) is checked for the two
# build-time gate invocations.
# ============================================================================
set -uo pipefail

IMAGE="${1:-}"
BUILD_LOG="${2:-}"

if [ -z "${IMAGE}" ]; then
  echo "usage: $0 <image:tag> [build-log]" >&2
  exit 2
fi

PASS=0
FAIL=0
failures=()

ok() {
  PASS=$((PASS + 1))
  printf 'ok   %s\n' "$1"
}

bad() {
  FAIL=$((FAIL + 1))
  failures+=("$1")
  printf 'FAIL %s\n' "$1"
}

# Run a read-only one-shot command inside the image.
drun() {
  docker run --rm --entrypoint /bin/bash "${IMAGE}" -lc "$*"
}

echo "== verifying ${IMAGE}"

# --- C1 labels ---------------------------------------------------------------
# C1 allows org.idbots.rollback-safe-to to be empty ("empty if none"), so the
# key must exist while version/commit must carry values and contract is 1.0.0.
label_lines="$(docker inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "${IMAGE}" 2>/dev/null)"
for label in org.idbots.version org.idbots.commit org.idbots.contract org.idbots.rollback-safe-to; do
  if printf '%s\n' "${label_lines}" | grep -q "^${label}="; then
    ok "label ${label} present ($(printf '%s\n' "${label_lines}" | grep "^${label}=" | cut -d= -f2-))"
  else
    bad "label ${label} missing"
  fi
done
for label in org.idbots.version org.idbots.commit; do
  value="$(printf '%s\n' "${label_lines}" | grep "^${label}=" | cut -d= -f2-)"
  [ -n "${value}" ] || bad "label ${label} is empty"
done
contract="$(printf '%s\n' "${label_lines}" | grep '^org.idbots.contract=' | cut -d= -f2-)"
[ "${contract}" = "1.0.0" ] && ok "label org.idbots.contract is 1.0.0" || bad "label org.idbots.contract != 1.0.0 ('${contract}')"

# --- Non-root uid (C1: uid 1000) ---------------------------------------------
uid_out="$(drun 'id -u' 2>/dev/null)"
[ "${uid_out}" = "1000" ] && ok "runs as uid 1000" || bad "expected uid 1000, got '${uid_out}'"

# --- HEALTHCHECK present -------------------------------------------------------
hc="$(docker inspect -f '{{if .Config.Healthcheck}}yes{{else}}no{{end}}' "${IMAGE}" 2>/dev/null)"
[ "${hc}" = "yes" ] && ok "HEALTHCHECK configured" || bad "HEALTHCHECK missing"

# --- Skills Python venv --------------------------------------------------------
if drun '/opt/skills-venv/bin/python -c "import pptx"' >/dev/null 2>&1; then
  ok "python-pptx imports in /opt/skills-venv"
else
  bad "python-pptx does not import in /opt/skills-venv"
fi

# --- Apt stack -----------------------------------------------------------------
if drun 'command -v chromium' >/dev/null 2>&1 && drun 'chromium --version' >/dev/null 2>&1; then
  ok "chromium $(drun 'chromium --version' 2>/dev/null | head -1)"
else
  bad "chromium missing or not runnable"
fi

soffice_version="$(drun 'soffice --version' 2>/dev/null | head -1)"
[ -n "${soffice_version}" ] && ok "soffice: ${soffice_version}" || bad "soffice --version produced no output"

pandoc_version="$(drun 'pandoc --version' 2>/dev/null | head -1)"
[ -n "${pandoc_version}" ] && ok "pandoc: ${pandoc_version}" || bad "pandoc --version produced no output"

if drun 'tesseract --list-langs' 2>/dev/null | grep -q '^chi_sim$'; then
  ok "tesseract languages include chi_sim"
else
  bad "tesseract chi_sim language missing"
fi

ffmpeg_version="$(drun 'ffmpeg -version' 2>/dev/null | head -1)"
[ -n "${ffmpeg_version}" ] && ok "ffmpeg: ${ffmpeg_version}" || bad "ffmpeg -version produced no output"

# --- Entrypoint guard: refuses without IDBOTS_SERVER_MODE ----------------------
refusal="$(docker run --rm -e IDBOTS_TENANT_ID=t_verify -e IDBOTS_GATEWAY_SECRET=x "${IMAGE}" 2>&1)"
refusal_code=$?
if [ "${refusal_code}" -ne 0 ] && printf '%s' "${refusal}" | grep -q 'IDBOTS_SERVER_MODE'; then
  ok "entrypoint refuses to start without IDBOTS_SERVER_MODE (exit ${refusal_code})"
else
  bad "entrypoint did not refuse without IDBOTS_SERVER_MODE (exit ${refusal_code})"
fi

# --- Entrypoint guard: requires the C1 secrets ---------------------------------
refusal2="$(docker run --rm -e IDBOTS_SERVER_MODE=1 -e IDBOTS_GATEWAY_SECRET=x "${IMAGE}" 2>&1)"
refusal_code2=$?
if [ "${refusal_code2}" -ne 0 ] && printf '%s' "${refusal2}" | grep -q 'IDBOTS_TENANT_ID'; then
  ok "entrypoint requires IDBOTS_TENANT_ID (exit ${refusal_code2})"
else
  bad "entrypoint did not require IDBOTS_TENANT_ID (exit ${refusal_code2})"
fi

# --- Static contract: no debugging port in the entrypoint ----------------------
# (the pattern is assembled so this script itself stays free of the literal flag)
needle='remote-deb'
needle="${needle}ugging-port"
if docker run --rm --entrypoint /bin/bash "${IMAGE}" -lc "grep -r '${needle}' /usr/local/bin/tenant-entrypoint.sh" >/dev/null 2>&1; then
  bad "entrypoint mentions a debugging-port flag"
else
  ok "entrypoint has no debugging port"
fi

# --- Build-time gates from the build log (optional) ----------------------------
if [ -n "${BUILD_LOG}" ]; then
  if [ ! -f "${BUILD_LOG}" ]; then
    bad "build log not found: ${BUILD_LOG}"
  else
    if grep -q 'apply-dsh-kernel-patches.cjs --check' "${BUILD_LOG}" && ! grep -q 'ELIFECYCLE\|process exited' "${BUILD_LOG}"; then
      ok "build log shows the kernel-patch --check gate"
    else
      bad "build log missing the kernel-patch --check gate or shows a failure"
    fi
    if grep -qE 'check:dsh-deps|check-dsh-runtime-deps.cjs' "${BUILD_LOG}"; then
      ok "build log shows the check:dsh-deps gate"
    else
      bad "build log missing the check:dsh-deps gate"
    fi
  fi
else
  echo "note no build log given — skipping the build-gate log checks"
fi

echo
echo "== ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -gt 0 ]; then
  printf 'failures:\n' >&2
  printf '  - %s\n' "${failures[@]}" >&2
  exit 1
fi
