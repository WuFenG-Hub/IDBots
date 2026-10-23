# Backend Request — Free-Grant Repeat Claims (Low-Balance Top-Up Campaign)

Status: handed to the assist-base-service team on 2026-10-23.
Builds on: Phase 3b free-grant campaign (`docs/gasfee-flow/backend-request-phase-3b.md`,
backend spec `docs/gasfee-flow/backend-spec-v2.md` §A).

## The request (as handed over)

在现有 traffic 免费流量活动基础上，把「每账户限领一次」升级为「低余额可重复领取」，
需求背景：推广初期让用户免费持续使用，活动参数随时可调、随时可停。

用户可见行为：

- 新用户照旧可领取一次免费流量（当前线上配置 50MB，`free_grant_bytes` 控制）。
- 当账户可用余额低于阈值（默认 1MB）且距上次领取超过冷却期（默认 7 天）时，
  领取入口再次出现，可再次领取；不满足条件时入口不出现。
- 活动总开关、单次额度、低余额阈值、冷却期全部为后台热配置，可随时停掉或调整。

客户端（IDBots）侧已配套修改：status 响应新增字段全部可选、向后兼容，
前端展示完全以后端 `claimable` 为准（见文末「客户端契约」）。

## 改动要点（细节以下文为准）

A. 数据模型
- `tb_traffic_free_grant` 去掉 `UNIQUE(accountId)`（
  `sql/update.sql` 中的 `tb_traffic_free_grant_accountId_uindex`），
  改为普通索引；每次领取插入一行，保留完整领取历史。
- 迁移 SQL 追加进 `sql/update.sql`（MySQL：`DROP INDEX ... ADD INDEX`，
  注意已存在的库需要幂等的 IF NOT EXISTS 守卫，参考现有
  `idx_traffic_free_grant_created` 的写法）；SQLite 测试路径同步适配。
- DAO：`GetByAccountId` 改为「取最新一条」（ORDER BY id DESC LIMIT 1），
  用于 status/claim 的最近领取判定。

B. 新配置项（tb_traffic_config，全部热更新，管理后台可改）
- `free_grant_repeat_enabled`：重复领取开关，默认 `false`（关闭时行为与现状完全一致）。
- `free_grant_low_balance_bytes`：低余额阈值（含边界：balance < 阈值才可领），默认 `1000000`（1MB）。
- `free_grant_repeat_interval_seconds`：两次领取最小间隔，默认 `604800`（7 天）。
- 现有 `free_grant_enabled`（总开关）/ `free_grant_bytes`（单次额度）/
  `free_grant_client_allowlist` / `free_grant_client_token` / `free_grant_ip_limit` 语义不变。

C. 领取资格（`service/traffic_service/campaign_service.go` 的 `ClaimFreeGrant`）
- 在事务内（沿用 `GetOneForUpdate` 锁账户行）判定：
  - 从未领取 → 允许（同现状）。
  - 已领取且 `repeat_enabled=false` → `ErrAlreadyClaimed`（同现状）。
  - 已领取且 repeat 开启：
    - `now - lastClaimAt < interval` → 新错误码 `CLAIM_COOLDOWN`；
    - `account.BalanceBytes >= threshold` → 新错误码 `BALANCE_NOT_LOW`；
    - 两者都满足 → 允许，插入新 grant 行，账本入账不变
      （direction=1，sourceType=`free_grant`，幂等键用新 grantId，天然不冲突）。
- 新错误码注册进 `service/traffic_service/errors.go`
  （`NewCodedError` 模式，`data.errorCode` 下发，与 ALREADY_CLAIMED 同款）。
- 防薅分层不变：client 白名单、可选 token、`free_grant_ip_limit`、
  合作伙伴出口 IP 豁免全部保留。

D. status 接口扩展（`GET /v1/traffic/campaign/free-grant/status`）
`TrafficFreeGrantStatusRespond`（`controller/respond/traffic_respond.go`）追加字段，
全部向后兼容（老客户端忽略新字段）：

```json
{
  "enabled": true,
  "grantBytes": 50000000,
  "claimed": true,
  "claimable": true,
  "repeatEnabled": true,
  "thresholdBytes": 1000000,
  "lastClaimAt": 1761000000000,
  "nextClaimAt": 0
}
```

- `claimable` 由后端用当前余额实时计算：
  `enabled && (!claimed || (repeatEnabled && balanceBytes < thresholdBytes && now >= nextClaimAt))`。
- `lastClaimAt` / `nextClaimAt`：毫秒时间戳（与 `tool.MakeTimestamp()`、
  `tb_traffic_free_grant.createTime` 口径一致）；从未领取时 `lastClaimAt=0`，
  当前可领时 `nextClaimAt=0`。
- 注意：status 里判定 claimable 需要账户余额，`loadActiveAccountByIdentity`
  拿到的账户行已含 `BalanceBytes`，直接用即可。

E. 管理后台
- 免费流量设置页追加三个配置项的读写（`AdminGetFreeGrantSettings` /
  `AdminUpdateFreeGrantSettings` + `controller/admin_ui` 页面）。
- 领取记录列表无需改动（分页+汇总已支持多行同账户）。

F. 文档与验收
- Swagger（`swag init`）与 `docs/traffic-deployment.md` 同步更新。
- `go build ./... && go test ./...` 全绿；`campaign_service_test.go` 覆盖：
  首次领取、repeat 关闭时重复领取被拒（ALREADY_CLAIMED）、
  冷却期内被拒（CLAIM_COOLDOWN）、余额高于阈值被拒（BALANCE_NOT_LOW）、
  低余额+过冷却期领取成功且账本幂等、status 新字段口径。
- 沿用老规矩：分支开发、commit + 链上日志、完成后通知我们验收、先不合 main。

签名 canonical 约定不变：status/claim 仍分别为
`traffic-free-grant-status:<accountId>:<ts>` 与 `traffic-free-grant-claim:<accountId>:<ts>`，
客户端无需改动签名逻辑。

## 客户端契约（IDBots 侧已落地，供对齐）

- status 新字段（`repeatEnabled` / `thresholdBytes` / `lastClaimAt` / `nextClaimAt`）
  客户端按可选字段解析，缺省时按旧的一次性活动语义渲染。
- 领取入口显隐完全以后端 `claimable` 为准（`claimed=true` 不再隐藏入口）。
- 新错误码映射：`CLAIM_COOLDOWN` / `BALANCE_NOT_LOW` / `CLAIM_RATE_LIMITED`
  已加客户端友好文案；旧码不变。
- 桌面端 bootstrap 的首领自动领取仍只在 `!claimed` 时触发，不自动重复领取；
  重复领取走用户手动点击。
- 兼容窗口：新客户端 + 老后端（无新字段）行为与现状一致；老客户端 + 新后端
  忽略新字段、行为不变（老客户端因 `claimed=true` 不显示重复领取入口，仅损失新能力）。

## 验收 checklist

1. repeat 开关关闭：老用户（已领过）status `claimable=false`，claim 返回 ALREADY_CLAIMED。
2. repeat 开启、余额 ≥ 阈值：status `claimable=false`，claim 返回 BALANCE_NOT_LOW。
3. repeat 开启、余额 < 阈值、冷却未满：claim 返回 CLAIM_COOLDOWN，`nextClaimAt` 正确。
4. repeat 开启、余额 < 阈值、冷却已满：claim 成功，账本新增一条 free_grant 入账，
   同一响应重放不产生第二笔（幂等键为新 grantId）。
5. 新用户：与现状一致，可领首次。
6. 管理后台改阈值/冷却/开关后立即生效（热配置），停掉 `free_grant_enabled` 后
   status `enabled=false`、claim 返回 CAMPAIGN_DISABLED。
7. `tb_traffic_free_grant` 历史库迁移幂等：重复执行 update.sql 不报错、不丢历史行。
