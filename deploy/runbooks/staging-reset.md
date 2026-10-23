# Runbook: staging reset

Wipes ALL staging test data. Requires the owner's written approval (chat
record or email, attached to the ops log). Staging may be wiped by the
owner's decision (`00-program-plan.md`); production never.

## 1. Approval and notice

- Written owner approval recorded (who, when).
- Robot notice in the team group: staging goes down for a wipe at {time},
  test users must re-register.

## 2. Stop everything

```bash
cd /opt/idbots/deploy
docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml down
docker ps -aq --filter 'name=idb-t_' | xargs -r docker rm -f
```

## 3. Destroy the data

```bash
docker volume ls -q --filter 'name=idb-t_' | xargs -r docker volume rm
docker volume rm idbots_cp-data idbots_caddy-data idbots_caddy-config \
  idbots_prometheus-data idbots_alertmanager-data
# OSS staging backups (if the staging bucket exists): remove tenants/* and
# control-plane/* prefixes in the console or with ossutil rm -r.
```

## 4. Bring it back

```bash
docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml up -d
# then re-seed per deploy-control-plane.md § first boot: invites, redeem
# codes (staging batch), host row (capacity 27), CP_FAKE_SMS_NUMBERS set.
```

## 5. Verify the reset

```bash
curl -s https://staging.{APP_DOMAIN}/health
docker ps --filter 'name=idb-t_' --format '{{.Names}}'   # empty
# sign up one fake-number user end to end (fixed code 246810) to prove the loop
```

Record the reset (date, approver, what was wiped) in the ops log.
