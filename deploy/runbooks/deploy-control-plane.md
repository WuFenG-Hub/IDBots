# Runbook: deploy / update / roll back the control plane

Updating the control plane never restarts tenant containers (REQ-C-12).
Tenant state lives in the `cp-data` volume and the tenants' own volumes;
a control-plane redeploy is a stateless swap.

## First boot (new host)

After `host-bootstrap.md` § 5, seed the control plane through its admin CLI:

```bash
CP="docker exec idbots-control-plane-1 node dist/cli.js"
$CP invite create --uses 10 --note "seed batch" --as admin:{your-name}
# register this host (one row in hosts; capacity from REQ-C-19):
#   58 on the 31.4 GB production host, 61 on a full 32 GB host, 27 on 16 GB staging
# (WS-B CLI command for host registration — see cloud/control-plane/README.md)
```

Verify `curl -s https://{APP_HOST}/health` returns `{"ok":true,...}`.

## Normal update

1. Pick the new tag from CI (`{version}-{commit7}`, built by
   `.github/workflows/cloud-images.yml`).
2. Edit `/etc/idbots/deploy.env`: `CP_IMAGE_TAG={new-tag}`.
3. Apply:

   ```bash
   cd /opt/idbots/deploy
   docker compose --env-file /etc/idbots/deploy.env -f compose.yml pull control-plane
   docker compose --env-file /etc/idbots/deploy.env -f compose.yml up -d control-plane
   ```

   Only the control-plane container is recreated; caddy, the socket proxy,
   the monitoring stack, and every tenant keep running (AC-B-5: phones
   reconnect within 30 s).
4. Verify:

   ```bash
   docker ps --filter name=control-plane --format '{{.Image}} {{.Status}}'
   curl -s https://{APP_HOST}/health
   docker logs idbots-control-plane-1 --since 2m | tail -20   # migrations ran, no errors
   docker ps --filter 'name=idb-t_' --format '{{.Names}}'     # all tenants still Up
   ```

## Rollback to the previous tag

The previous tag is the old `CP_IMAGE_TAG` value (it is also in the shell
history / the git-ignored env backup you keep in the password manager):

```bash
# 1. set CP_IMAGE_TAG back in /etc/idbots/deploy.env
# 2. same apply as above:
cd /opt/idbots/deploy
docker compose --env-file /etc/idbots/deploy.env -f compose.yml up -d control-plane
# 3. verify /health and that tenants reconcile (control plane logs list every
#    known tenant as running; unknown containers are reported, never deleted).
```

Database migrations are forward-only and idempotent (WS-B REQ-B-5). A
rollback that crosses a migration is safe only if the older binary tolerates
the newer schema — when in doubt, check the release notes before rolling
back, and prefer rolling forward. Worst case, restore `cp.sqlite` from last
night's backup (`backup-and-restore.md`) and redeploy the tag that matches it.

## If the control plane cannot start

Symptoms: `docker ps` shows restarting, caddy returns 502, `ControlPlaneDown`
alert fires.

1. `docker logs idbots-control-plane-1 --tail 100` — the top cause is a bad
   `cp.env` (missing `CP_MASTER_KEY`, SMS fields) or a registry pull failure.
2. Config error → fix `/etc/idbots/cp.env`, `up -d control-plane` again.
3. Image error → roll back (above). Tenants keep serving during the outage;
   only logins, provisioning, and the phone proxy are down.
