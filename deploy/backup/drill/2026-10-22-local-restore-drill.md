# Restore Drill Record — 2026-10-22 (local, review-hardened re-run)

**Executor:** WS-C delivery agent · **Host:** macOS laptop, Docker Desktop
**Scope added since the 10-20 drill** (review item S2-3): the restore drill now
proves DATA FIDELITY, not only database integrity — every archive carries a
`_backup-manifest.json` (file count, total bytes, per-table sqlite row
counts), and `restore-tenant.sh` recomputes and compares it against the
restored tree, failing on any DIFF.

## 恢复目标耗时与校验通过判据（审查要求写清）

- **恢复目标耗时**：单租户 ≤ 30 分钟（A-21 / `60` 非功能目标）。本次演练全程
  ~11 s（备份 3 s + 恢复 8 s）。
- **校验通过判据**（全部满足才算 PASS）：
  1. 每个 `.sqlite` 的 `PRAGMA integrity_check` 返回 `ok`；
  2. 保真对比全 PASS：文件数一致、总字节一致、每张表行数一致；
  3. 恢复卷属主归一为 uid 1000（C1）；
  4. 试用容器在恢复数据上 `/healthz` 90 s 内转为健康；
  5. 失败路径可观测：任一 DIFF/失败即非零退出并向机器人告警。

## Commands and output (verbatim)

```bash
export IDBOTS_BACKUP_ENV=/tmp/idbots-drill/backup.env   # BACKUP_BACKEND=local
export BACKUP_AGE_KEY_FILE=/tmp/idbots-drill/age.key

deploy/backup/backup-tenant.sh t_drill00000000000000
# pass 1 snapshot done (16K)
# pass 2 snapshot done; container paused for 2s (budget 60s)
# manifest: 3 files, 8227 bytes, 1 sqlite db(s)
# done: tenants/t_drill00000000000000/2026-10-22.tar.zst.enc (1117 bytes, 3s)

deploy/backup/restore-tenant.sh t_drill00000000000000 --mode drill --keep
# decrypted + extracted 52K
# materialized volume idb-t_drill00000000000000-restore-20261022144346
# integrity check inside helper container: ok /data/userdata/idbots.sqlite
# comparing restored data against the archived manifest
#   PASS  files: 3
#   PASS  bytes: 8227
#   PASS  userdata/idbots.sqlite.bots rows=2
# data fidelity: MATCH
# drill container healthy on restored data
# RESTORE DRILL PASSED for t_drill00000000000000 (…2026-10-22.tar.zst.enc) in 8s
```

The fidelity gate immediately proved its worth during development: its first
run DIFFed because WAL sidecars (`*.sqlite-wal/-shm`) were created between the
manifest and the archive step — fixed by excluding sidecars from byte
accounting (row counts still cover their logical content) while keeping them
inside the archive for crash consistency.

Unchanged from the 10-20 record: same fixture, same local backend rationale,
same staging follow-ups (real OSS leg, `--mode replace`, 27-tenant window,
full-host snapshot restore before M5).
