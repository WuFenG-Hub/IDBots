# Backend Request — Phase 3b: Free-Grant Campaign & Recharge Codes

Status: handed to the assist-base-service team on 2026-08-14.
Full spec: `docs/gasfee-flow/backend-spec-v2.md` (sections A and B).

## The request (as handed over)

在现有 traffic 分支基础上继续开发两个新功能（Phase 3b），需求文档在本机：
`/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/gasfee-flow/backend-spec-v2.md`
（Feature A 免费领取 + Feature B 充值码，含数据模型、API、管理后台、
验收标准 A1–A8 / B1–B10）。

要点速览（细节以 Spec 为准）：

A. 免费领取活动
- 每个流量账户限领一次（新表 tb_traffic_free_grant，account_id 唯一约束），
  默认 10MB，额度与开关在 tb_traffic_config（free_grant_enabled /
  free_grant_bytes / free_grant_client_allowlist / free_grant_client_token）。
- 接口：GET /v1/traffic/campaign/free-grant/status、POST
  /v1/traffic/campaign/free-grant/claim（沿用现有流量签名认证；claim 带
  clientApp/clientVersion，白名单默认只认 idbots；可选 X-Client-Token，
  默认关闭）。
- 入账走统一账本：direction=1，sourceType="free_grant"，幂等键
  (accountId, credit, free_grant, grantId)。
- 管理后台加一页：开关、额度、领取记录（分页+汇总）。
- 防薅分层已写进 Spec §A.4，注意 token 不是安全边界（文档里写明了）。

B. 充值码
- 码格式 IDB-XXXX-XXXX-XXXX（base32 去掉 I/L/O/0/1），单码单次，
  兑换接口 POST /v1/traffic/redeem-code（行锁原子兑换；同账号重复提交
  同一码幂等返回原结果；CODE_NOT_FOUND/CODE_USED/CODE_DISABLED/CODE_EXPIRED）。
- 入账账本 sourceType="recharge_code"。
- 管理后台新页：批量生成（数量+单码流量+可选有效期+备注）、导出未用码、
  单码禁用/整批作废、列表筛选、统计。
- 表：tb_traffic_recharge_code + tb_traffic_recharge_batch（字段见 Spec §B.2）。

通用：Swagger 与 docs/traffic-deployment.md 同步更新；go build ./... &&
go test ./... 全绿；验收按 Spec 的 A1–A8、B1–B10 逐条自测并在报告里
标注实现位置；沿用老规矩（分支开发、commit + 链上日志、完成后通知我们
验收、先不合 main、测试实例发布后给验收路径）。

## Client-side follow-up once delivered

- IDBots client lands in parallel: claim button, redeem input, ledger labels
  for free_grant / recharge_code, i18n. Joint E2E (M3b.4) after both sides
  land: claim once → redeem one code → admin generate/revoke → verify ledger.
