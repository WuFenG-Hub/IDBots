# Runbook: user data export and deletion

Triggered by a `POST /api/v1/account/deletion-request` (lands in
`deletion_requests` and alerts the operator) or a direct written user
request. Every step lands in the control-plane `audit_log` (A-23). REQ-C-20:
never read `idbots.sqlite` contents without a written user request — the
export is a byte-level archive, not an inspection.

## 1. Export

```bash
CP="docker exec idbots-control-plane-1 node dist/cli.js"
$CP deletion list                                   # find the open request
$CP tenant export t_xxx --to /var/lib/idbots/exports/t_xxx.tar.zst --as admin:{you}
```

The CLI stops the container briefly, archives the volume, restarts it, and
writes the audit row. Deliver the archive to the user through an OSS
signed URL (private bucket, hours-long expiry) — never by email:

```bash
ossutil -i ... -k ... -e {ENDPOINT} cp /var/lib/idbots/exports/t_xxx.tar.zst \
  oss://{OSS_BUCKET}/exports/t_xxx-{date}.tar.zst
ossutil -i ... -k ... -e {ENDPOINT} sign oss://{OSS_BUCKET}/exports/t_xxx-{date}.tar.zst --timeout 21600
```

## 2. Complete the deletion

Only after the export exists. `--confirm` must match the user's phone —
it is the operator's "are you sure" against the wrong account:

```bash
$CP deletion complete {requestId} --confirm +861xxxxxxxxxx --as admin:{you}
```

The control plane removes the container AND the volume and closes the
request (both audited). Then:

1. Purge the operator-side export copy after the user confirms receipt
   (or after 30 days): remove the OSS object and the local file.
2. Nightly backups of this tenant age out with the 30-day bucket lifecycle;
   to delete sooner, remove the `tenants/t_xxx/` prefix objects from the
   console (with the owner's approval).
3. The phone can no longer log in without a new invite (A-23).

## 3. Verify

```bash
docker ps -a --filter name=idb-t_xxx        # nothing
docker volume ls --filter name=idb-t_xxx    # nothing
$CP deletion list                           # request closed
```
