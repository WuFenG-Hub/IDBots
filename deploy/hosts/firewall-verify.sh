#!/usr/bin/env bash
# WS-C review S2-6 / AC-C-1 — prove the tenant isolation rules actually work.
#
#   sudo /opt/idbots/firewall-verify.sh
#
# Prints the live DOCKER-USER/IDBOTS-TENANT ruleset, then spins up probe
# containers on the tenants network and reports expected-vs-actual for every
# REQ-C-6 rule. Exit 0 only if every probe matches its expectation.
set -uo pipefail

CHAIN="IDBOTS-TENANT"
TENANT_NET="${IDBOTS_TENANT_NETWORK:-idbots_tenants}"
CP_IP="${IDBOTS_CP_IP:-172.30.0.2}"
PROBE_IMG="${IDBOTS_PROBE_IMAGE:-alpine:3.20}"
PROBE_A="idbots-fwprobe-a"
PROBE_B="idbots-fwprobe-b"

PASS=0; FAIL=0
note()  { echo "[fw-verify] $*"; }
verdict() { # name expected(ok|blocked) actual(0=connected,other=failed)
  local name="$1" expected="$2" actual="$3"
  local good
  if [ "$expected" = ok ]; then good=$([ "$actual" = 0 ] && echo yes || echo no);
  else good=$([ "$actual" != 0 ] && echo yes || echo no); fi
  if [ "$good" = yes ]; then PASS=$((PASS+1)); echo "PASS  $name (expected $expected)";
  else FAIL=$((FAIL+1)); echo "FAIL  $name (expected $expected, got connect-rc=$actual)"; fi
}

note "cwd:      $(pwd)"
note "script:   $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== live ruleset =="
iptables -L DOCKER-USER -nv --line-numbers | head -6 || true
iptables -L "$CHAIN" -nv --line-numbers || { echo "chain $CHAIN missing — run idbots-firewall.service"; exit 1; }
sysctl net.bridge.bridge-nf-call-iptables

echo "== probes =="
docker rm -f "$PROBE_A" "$PROBE_B" >/dev/null 2>&1 || true
docker run -d --name "$PROBE_B" --network "$TENANT_NET" "$PROBE_IMG" \
  sh -c 'while true; do printf "ok" | nc -l -p 8790; done' >/dev/null
# give the listener a moment, resolve probe B's IP
sleep 1
PROBE_B_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PROBE_B")"
note "probe B (acts as 'another tenant') at $PROBE_B_IP, listening on 8790"

probe() { # run from probe A: args...; returns 0 if the connection succeeded
  docker run --rm --network "$TENANT_NET" --cap-drop ALL "$PROBE_IMG" \
    sh -c "$1" >/dev/null 2>&1
}

probe "nc -w 3 100.100.100.200 80 < /dev/null";        verdict "tenant -> metadata 100.100.100.200" blocked $?
probe "nc -w 3 10.0.0.1 80 < /dev/null";               verdict "tenant -> private 10.0.0.1" blocked $?
probe "nc -w 3 169.254.169.254 80 < /dev/null";        verdict "tenant -> link-local 169.254.169.254" blocked $?
probe "nc -w 3 $CP_IP 8080 < /dev/null";               verdict "tenant -> control plane 8080" blocked $?
probe "nc -w 3 $PROBE_B_IP 8790 < /dev/null";          verdict "tenant -> tenant 8790" blocked $?
probe "nslookup -type=a api.deepseek.com 223.5.5.5";   verdict "tenant -> DNS 223.5.5.5" ok $?
probe "wget -q -T 8 -O /dev/null https://api.deepseek.com"; verdict "tenant -> https://api.deepseek.com" ok $?

echo "== control plane -> tenant 8790 =="
CP_CONTAINER="${IDBOTS_CP_CONTAINER:-idbots-control-plane-1}"
if docker ps -q -f "name=^/$CP_CONTAINER\$" | grep -q .; then
  docker exec "$CP_CONTAINER" node -e \
    "require('net').connect({host:'$PROBE_B_IP',port:8790,timeout:3000},()=>{console.log('connected');process.exit(0)}).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))" \
    >/dev/null 2>&1
  verdict "control plane -> tenant 8790" ok $?
else
  note "control-plane container not running — cp->tenant probe SKIPPED"
fi

docker rm -f "$PROBE_A" "$PROBE_B" >/dev/null 2>&1 || true
echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
