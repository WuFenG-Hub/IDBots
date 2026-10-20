# Runbook: secret rotation

Rotation cadence and owners come from the secrets register
(`00-program-plan.md`). Nothing below ever touches git. After any rotation,
update the password-manager entry and note the date in the ops log.

## 1. Per-tenant gateway secret — on demand

```bash
CP="docker exec idbots-control-plane-1 node dist/cli.js"
$CP tenant rotate-secret t_xxx --as admin:{you}
```

The control plane mints a new 32-byte secret, re-encrypts it with the master
key, and recreates the container (brief user reconnect). Old file-download
tokens die with the secret — expected.

## 2. Control-plane master key — yearly, with re-encryption

The master key encrypts tenant gateway secrets at rest. Rotating it means
re-encrypting every stored secret — do it as a planned maintenance:

1. Generate: `openssl rand -base64 32`; store the new value in the password
   manager next to the old one.
2. Put the new key in `/etc/idbots/cp.env` (`CP_MASTER_KEY`), keep the file
   0600.
3. Re-encrypt: use the control-plane CLI's re-encryption command if WS-B
   ships one (check `cloud/control-plane/README.md`); otherwise run the
   rotation during a tenant-wide `rotate-secret` wave — each tenant's secret
   is rewritten with the new key as it rotates.
4. Redeploy the control plane (`deploy-control-plane.md`), verify
   `/health` and one tenant proxy connection.
5. Destroy the old key copy only after every tenant has rotated.

## 3. SMS AccessKey — yearly (or on suspicion)

1. Console: create a second AccessKey on the SMS RAM user (never the root
   account).
2. Update `CP_SMS_ACCESS_KEY_ID` / `CP_SMS_ACCESS_KEY_SECRET` in
   `/etc/idbots/cp.env`; redeploy the control plane.
3. Send a login code to a staging number; then disable the old AccessKey in
   the console.

## 4. OSS backup AccessKey — yearly

1. Console: new AccessKey on the OSS-write RAM user.
2. Update `/etc/idbots/backup.env`; run
   `sudo /opt/idbots/backup/backup-tenant.sh t_xxx` once to prove write works.
3. Disable the old key. Restore drills keep working (they read with the same
   RAM user; no change needed if the user itself is unchanged).

## 5. Backup age key pair — on suspicion only

The age private key lives offline; backups encrypt to the public key.
Rotating means NEW backups go to a new recipient while OLD backups stay
decryptable only by the old key — keep both private keys offline, labeled by
date. Update `BACKUP_AGE_RECIPIENT` in `backup.env`.

## 6. Registry credentials — yearly

- Push (CI only): console → new AccessKey on the ACR push RAM user → update
  the GitHub secrets `ACR_USERNAME` / `ACR_PASSWORD` → run a manual
  `cloud-images` dispatch to prove the push.
- Pull (hosts): update the docker login on each host
  (`docker login {REGISTRY}`), then `docker compose ... pull` once.

## 7. Alert webhook — on leak

Recreate the robot in the Feishu/DingTalk group, update
`/etc/idbots/monitoring.env` (relay), `/etc/idbots/backup.env`, and
`CP_ALERT_WEBHOOK` in `cp.env`; `up -d` the relay + control plane; send a
test through the relay (`deploy/monitoring/README.md`).
