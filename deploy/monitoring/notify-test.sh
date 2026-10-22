#!/usr/bin/env bash
# WS-C review S2-2 — prove the alert webhook path actually delivers.
#
#   notify-test.sh [message]
#
# Reads /etc/idbots/monitoring.env (override: MONITORING_ENV), sends one test
# message through the SAME formatting/signing logic the alert-relay uses, and
# prints the HTTP status code and response body. Run it after configuring the
# robot, after every webhook rotation, and during the AC-C-6 fire drill.
set -euo pipefail

MONITORING_ENV="${MONITORING_ENV:-/etc/idbots/monitoring.env}"
if [ -f "$MONITORING_ENV" ]; then
  set -a; . "$MONITORING_ENV"; set +a
fi

WEBHOOK="${ALERT_WEBHOOK_URL:-}"
SECRET="${ALERT_SECRET:-}"
MSG="${1:-[IDBots] notify-test $(date '+%F %T %Z') from $(hostname)}"

[ -n "$WEBHOOK" ] || { echo "ALERT_WEBHOOK_URL is unset (in $MONITORING_ENV)" >&2; exit 2; }
case "$WEBHOOK" in
  *REPLACE_ME*) echo "webhook is still the placeholder — fill $MONITORING_ENV first" >&2; exit 2 ;;
esac

echo "cwd:      $(pwd)"
echo "script:   $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "webhook:  ${WEBHOOK%%\?*}"   # never print query strings (token lives there)

if [[ "$WEBHOOK" == *oapi.dingtalk.com* ]]; then
  URL="$WEBHOOK"
  if [ -n "$SECRET" ]; then
    TS="$(date +%s%3N)"
    SIGN="$(printf '%s\n%s' "$TS" "$SECRET" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)"
    # URL-encode the base64 signature.
    SIGN_ENC="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$SIGN")"
    URL="$WEBHOOK&timestamp=$TS&sign=$SIGN_ENC"
  fi
  BODY="{\"msgtype\":\"text\",\"text\":{\"content\":\"$MSG\"}}"
else
  URL="$WEBHOOK"
  if [ -n "$SECRET" ]; then
    TS="$(date +%s)"
    SIGN="$(printf '' | openssl dgst -sha256 -hmac "$(printf '%s\n%s' "$TS" "$SECRET")" -binary | base64)"
    BODY="{\"timestamp\":\"$TS\",\"sign\":\"$SIGN\",\"msg_type\":\"text\",\"content\":{\"text\":\"$MSG\"}}"
  else
    BODY="{\"msg_type\":\"text\",\"content\":{\"text\":\"$MSG\"}}"
  fi
fi

echo "sending:  $MSG"
RESP="$(mktemp)"
CODE="$(curl -sS -m 10 -o "$RESP" -w '%{http_code}' -H 'Content-Type: application/json' -d "$BODY" "$URL")" || CODE="curl-failed"
echo "HTTP:     $CODE"
echo "response: $(cat "$RESP")"
rm -f "$RESP"
[ "$CODE" = 200 ] || exit 1
echo "OK — check the robot group for the message."
