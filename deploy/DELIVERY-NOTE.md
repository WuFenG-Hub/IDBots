# Delivery Note — WS-C

## 基线

- 基线提交: `3cab9f0b79688f7afdfae18b43d14b94f4ac6788`
- 分支: `feat/cloud-deploy`（worktree `.worktrees/cloud-deploy`，未推远端、未合 main）
- 推送位置: 无 / HEAD

交付物全部在 `deploy/` 与 `.github/workflows/cloud-images.yml`，共 8 笔提交。
仓库内已验证 grep 不到真实密钥（模式扫描：LTAI*、AGE-SECRET-KEY、PRIVATE KEY、长 secret 赋值，结果为 CLEAN）。

## 资产清单

| 文件 | 作用 | 依赖的环境变量 |
|---|---|---|
| `deploy/hosts/bootstrap.sh` | 一键引导：装 Docker/依赖、daemon.json、sysctl、防火墙 unit、sshd 加固、fail2ban/auditd/自动升级、资产落位 `/opt/idbots`、渲染 prometheus.yml、装备份 timer | `--role staging\|production` |
| `deploy/hosts/compose.yml` | 编排 caddy + control-plane + docker-socket-proxy + node-exporter + cAdvisor；网络 edge/cp-docker(internal)/tenants(172.30.0.0/16, cp 固定 .2)/monitoring；cp-data、caddy-data 具名卷（REQ-C-10/11） | `APP_HOST` `REGISTRY` `CP_IMAGE_TAG`（来自 `/etc/idbots/deploy.env`）；`/etc/idbots/cp.env` |
| `deploy/hosts/compose.monitoring.yml` | prometheus / alertmanager / alert-relay / blackbox-exporter（均不发布端口） | `/etc/idbots/monitoring.env` |
| `deploy/hosts/Caddyfile` | REQ-C-5 冻结参考配置：自动签发 TLS、HSTS、26MB 请求体上限、WS 无空闲超时、/files/ 日志脱敏 | `APP_HOST` |
| `deploy/hosts/daemon.json` | Docker DNS 223.5.5.5/223.6.6.6（REQ-C-2）；json-file 20m×5 日志（C1） | — |
| `deploy/hosts/firewall.sh` + `idbots-firewall.service` | REQ-C-6 六组 DOCKER-USER 规则（established→cp→tenant:8790→禁租户互访→放行 DNS→禁 metadata/私网/主机→放行出站），systemd 在 docker 启动后重放 | `IDBOTS_TENANT_SUBNET` `IDBOTS_CP_IP` `IDBOTS_DNS_SERVERS`（有默认值） |
| `deploy/hosts/{cp,deploy}.env.example` | 全部 WS-B 变量与主机变量，仅占位符（REQ-C-10/21） | — |
| `deploy/tenant-image/` | 占位租户镜像（C1/C2 契约面：healthz/readyz/WS welcome+echo/401/4009/4012/1MiB 帧上限/uid1000//data 卷/JSON 日志）+ `build.sh`（出 `{registry}/idbots/tenant:{version}-{commit7}`，带 C1 标签）+ `smoke-test.mjs`（13 项契约冒烟） | `REGISTRY` `IDBOTS_BUILDER`（构建时）；运行期按 C1 环境契约 |
| `deploy/backup/backup-nightly.sh` | 夜间驱动：先控制面后租户，03:00–05:00 错峰，失败汇总告警 | `/etc/idbots/backup.env` |
| `deploy/backup/backup-tenant.sh` | 崩溃一致备份：活跃快照→pause(≤60s)→增量→unpause→tar\|zstd\|age→上传 `tenants/{id}/{date}.tar.zst.enc` | `BACKUP_*` `OSS_*` |
| `deploy/backup/backup-control-plane.sh` | cp.sqlite 在线备份（.backup / VACUUM INTO）→ `control-plane/{date}.sqlite.zst.enc` | 同上 + `CP_VOLUME_NAME` |
| `deploy/backup/restore-tenant.sh` | REQ-C-15：drill（新卷+integrity_check+试启动+自清理）/ replace（CLI 停→安全卷→换内容→CLI 起） | `BACKUP_AGE_KEY_FILE`（演练时带入） |
| `deploy/backup/lib.sh` | 日志/告警(飞书钉钉)/OSS 与 local 双后端/age/textfile metrics/docker 助手 | 同上 |
| `deploy/backup/oss-bucket-setup.sh` + `oss-lifecycle.json` | 一次性建桶：SSE、版本化、30 天生命周期、ACL 私有 | `OSS_BUCKET` `OSS_REGION`（运维侧执行） |
| `deploy/backup/idbots-backup.{service,timer}` | 03:05 Asia/Shanghai 触发 | — |
| `deploy/backup/drill/2026-10-20-local-restore-drill.md` | 恢复演练记录（见下） | — |
| `.github/workflows/cloud-images.yml` | REQ-C-9：tag `cloud-v*`/手动触发 → 构建两镜像(linux/amd64) → Trivy（有修复的 CRITICAL 即失败）→ 起租户跑一致性套件 → 推 `{version}-{commit7}` | `vars.ACR_REGISTRY` `secrets.ACR_USERNAME` `secrets.ACR_PASSWORD`（CI 注入，不入库） |
| `deploy/monitoring/alert-rules.yml` | REQ-C-16 每条款一条规则（宿主机 mem/cpu/disk、租户 cpu/重启/failed/OOM、cp health/5xx、TLS<14d、备份失败/过期、容量 80%） | — |
| `deploy/monitoring/alertmanager.yml` `prometheus.yml.template` `blackbox.yml` | 告警路由→relay；采集 node-exporter/cAdvisor/cp:9100/blackbox；公网路径探活+证书期 | 渲染自 `deploy.env` |
| `deploy/monitoring/alert-relay/` | 无依赖 Node 服务：Alertmanager webhook→飞书/钉钉机器人（自动识别、支持加签、重试、healthz），含 Dockerfile | `ALERT_WEBHOOK_URL` `ALERT_TARGET` `ALERT_SECRET` |
| `deploy/runbooks/`（9 本） | host-bootstrap / deploy-control-plane / tenant-image-rollout / backup-and-restore / incident-response / secret-rotation / user-data-export-and-deletion / add-host / staging-reset | — |

## 部署步骤

从一台空机器（Ubuntu 24.04，已完成采购清单：ECS/EIP/DNS/ACR/SMS/OSS/机器人/RAM 用户）到服务可访问：

```bash
# 0. 数据盘挂到 /var/lib/docker（先挂盘后装 Docker）；安全组仅 80/443 + 指定 IP 的 22
# 1. 仓库（或仅 deploy/ 目录）拷到机器上
sudo deploy/hosts/bootstrap.sh --role production        # 或 staging
# 2. 填四个 env（见“密钥放置说明”）；再跑一遍 bootstrap（渲染 prometheus.yml、启用备份 timer）
$EDITOR /etc/idbots/{deploy.env,cp.env,backup.env,monitoring.env}
sudo deploy/hosts/bootstrap.sh --role production
# 3. ACR pull 凭据登录
docker login registry.cn-hongkong.aliyuncs.com --username {ACR_PULL_RAM_USER}
# 4. 拉起
cd /opt/idbots/deploy
docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml pull
docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml up -d
# 5. 验证（runbooks/host-bootstrap.md §6–10）
curl -sI http://{APP_HOST}/health          # 301→https；DNS 已指向 EIP 时 Caddy 自动签发证书
curl -s https://{APP_HOST}/health          # {"ok":true,...}
sudo iptables -L IDBOTS-TENANT -nv         # 六组隔离规则
systemctl list-timers idbots-backup.timer  # 下次 03:05
```

详细版（含隔离验证、告警点火演练、站点监控、首夜备份检查）在
`deploy/runbooks/host-bootstrap.md`。

## 恢复演练

记录全文：`deploy/backup/drill/2026-10-20-local-restore-drill.md`。摘要：

- 环境：本机 Docker Desktop（无云账号可触达，`BACKUP_BACKEND=local`，目录代替 OSS 桶；同一套代码路径）
- 命令与耗时：
  - `backup-control-plane.sh` → 800 B，**2s**（含 helper 容器 VACUUM INTO + 副本 integrity_check）
  - `backup-tenant.sh t_drill…` → 924 B，**2s**，容器 pause **1–2s**（预算 60s）
  - `backup-nightly.sh --now`（驱动端到端）→ **4.8s**，0 失败
  - `restore-tenant.sh t_drill… --mode drill --keep` → **7s**：下载→解密→新卷→uid 归一→integrity_check ok→恢复数据上试启动容器 /healthz 通过
- 数据校验：bots 表两行、uploads 文件、settings.json 全部完好；恢复卷属主 1000:1000
- 失败路径：不存在租户 → 单脚本直接报错；nightly 汇总失败并把飞书格式告警送达 mock webhook（载荷已核对）
- 演练发现并修复 5 个缺陷（AppleDouble 污染、恢复属主不可写、helper entrypoint 吞命令、不存在卷被静默备份空包、flock 跨平台）——均已修复并复测通过
- 未覆盖（需 staging）：真实 OSS 上传腿、replace 模式、27 户窗口、整主机快照恢复（M5 前在 staging 各做一次，见 runbook）

## 密钥放置说明

| 密钥 | 位置（不是值） |
|---|---|
| CP 主密钥 `CP_MASTER_KEY` | `/etc/idbots/cp.env`（0600 root）；离线副本在 owner 密码管理器 |
| SMS AccessKey（最小权限 RAM） | `/etc/idbots/cp.env` |
| 租户网关密钥 | 控制面数据库内主密钥加密存储（WS-B 供应时生成），不进任何 env 文件 |
| OSS 备份 AccessKey（仅写该桶 RAM） | `/etc/idbots/backup.env`（0600 root） |
| 备份 age 私钥 | **离线**（owner 密码管理器）；演练时以 `BACKUP_AGE_KEY_FILE` 带入主机（0600），用完 `shred -u` |
| ACR pull 凭据 | 主机 docker 凭据库（`docker login`） |
| ACR push 凭据 | 仅 CI secret store（`ACR_USERNAME`/`ACR_PASSWORD`），主机不出现 |
| 告警 webhook（及加签 secret） | `/etc/idbots/monitoring.env`、`backup.env`、`cp.env`（机器人重建后三处同步轮换） |
| CI 变量 | `vars.ACR_REGISTRY`（非密）在仓库 CI 设置里 |
| SSH 私钥 | 运维各自机器；主机只放公钥 |

## 未完成 / 存疑

1. **租户镜像是占位实现**：`deploy/tenant-image/` 的镜像内容属 WS-A（`00` 分工表）。我交付了构建脚本/Dockerfile/CI 接线/冒烟套件，WS-A 到手直接换镜像内容即可，标签与门禁不变。
2. **CI 两处 mock-first 守卫**：`cloud/control-plane/Dockerfile`（WS-B）与 `cloud/conformance/run.mjs`（WS-A）在基线上不存在，workflow 对这两腿做了「存在即强制、缺席则 ::warning 跳过」处理；两者落地后应删除守卫转为硬门禁（届时 AC-C-3 才算完整可验）。
3. **真实云腿未验证**（工单禁止买资源/碰账号）：OSS 上传、ACR 推送、机器人真实到群、TLS 真实签发、CloudMonitor 站点监控均需 staging（T2/T3）按 runbook 验收；备份 OSS 腿与 local 腿共用同一函数，仅传输层不同。
4. **docker-socket-proxy 固定 0.3.0、caddy 2.8.4 等镜像版本**：首次部署前可按 runbook 升级到当时稳定版并复测。
5. **控制面 Prometheus 指标名**（`cp_tenants_by_status`、`cp_http_requests_total`、`cp_host_capacity`）是约定名：REQ-B-20 未定名，WS-B 落地若不同，改 `alert-rules.yml` 一处即可。
6. **prometheus/alertmanager 无 Web UI 认证**（不发布端口，SSH 隧道访问）；如需多人查看，建议后续加 OAuth 代理，本期按 REQ 未做。
7. 按 AGENTS.md 每笔提交应配链上开发日志（metabot-post-buzz）；本工单第 4 条禁止碰任何远端/账号，故未发链上日志。若需要可补发。
