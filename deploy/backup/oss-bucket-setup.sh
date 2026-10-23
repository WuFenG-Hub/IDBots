#!/usr/bin/env bash
# WS-C REQ-C-14 / 15-ops-procurement — ONE-TIME OSS bucket provisioning.
# Run by the operations team with an admin-side RAM user (never on the host,
# never with the root account). This script only WRITES configuration to the
# bucket; it stores nothing in this repository.
#
#   OSS_BUCKET=idbots-backup-hk OSS_REGION=cn-hongkong ./oss-bucket-setup.sh
#
# Requirements: ossutil (v1.7+) configured with the provisioning RAM
# credentials (`ossutil config`), or exported OSS_ACCESS_KEY_ID /
# OSS_ACCESS_KEY_SECRET for that user.
set -euo pipefail

OSS_BUCKET="${OSS_BUCKET:?set OSS_BUCKET}"
OSS_REGION="${OSS_REGION:-cn-hongkong}"
OSS_ENDPOINT="${OSS_ENDPOINT:-oss-${OSS_REGION}.aliyuncs.com}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OSSUTIL=(ossutil -e "$OSS_ENDPOINT")
[ -n "${OSS_ACCESS_KEY_ID:-}" ] && OSSUTIL+=(-i "$OSS_ACCESS_KEY_ID")
[ -n "${OSS_ACCESS_KEY_SECRET:-}" ] && OSSUTIL+=(-k "$OSS_ACCESS_KEY_SECRET")

echo "1/5 create bucket oss://$OSS_BUCKET ($OSS_REGION)"
"${OSSUTIL[@]}" mb "oss://$OSS_BUCKET" || echo "   (already exists — continuing)"

echo "2/5 block public access: bucket ACL private"
"${OSSUTIL[@]}" set-acl "oss://$OSS_BUCKET" private
echo "   NOTE: also verify 'Block Public Access' in the OSS console for this bucket."

echo "3/5 server-side encryption (SSE-OSS / AES256)"
"${OSSUTIL[@]}" bucket-encryption --method put "oss://$OSS_BUCKET" --sse-algorithm AES256

echo "4/5 versioning on"
"${OSSUTIL[@]}" bucket-versioning --method put "oss://$OSS_BUCKET" enabled

echo "5/5 lifecycle: expire current AND noncurrent versions after 30 days"
"${OSSUTIL[@]}" lifecycle --method put "oss://$OSS_BUCKET" "$HERE/oss-lifecycle.json"

cat <<EOF

Bucket oss://$OSS_BUCKET is ready. Expected layout:
  tenants/{tenantId}/{yyyy-mm-dd}.tar.zst.enc
  control-plane/{yyyy-mm-dd}.sqlite.zst.enc

Next: create the least-privilege RAM user for the nightly job with OSS write
scoped to oss://$OSS_BUCKET/* (and read for restore drills), then put its
credentials into /etc/idbots/backup.env on the host. NEVER the root AccessKey.
EOF
