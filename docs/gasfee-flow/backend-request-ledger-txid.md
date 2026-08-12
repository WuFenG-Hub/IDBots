# Backend Change Request — Ledger API Returns `txId`

Status: request sent to the assist-base-service team (2026-08-11).
When delivered: verify against the acceptance below, then optionally simplify
the IDBots client (the local `traffic_spend_journal` join in
`trafficAccountService.ts` becomes a fallback for cross-device entries).

## The request (as handed over)

在 `feat/traffic-account` 分支继续开发一个小改动：**流量账本接口返回链上交易 TXID**。

背景：IDBots 客户端的流量账本 UI 现在会为每条 sponsor 扣费记录展示对应
链上交易的 TXID，供用户在区块链浏览器核查。目前 TXID 是客户端用自己的
本地日志（orderId → txId）join 出来的，只能覆盖**本机**产生的记录；在
其他设备上产生的扣费、以及过期释放的记录都显示不出 TXID。需要后端在账
本接口直接返回。

需求明细（`GET /v1/traffic/ledger` 的每条 entry 增加可选字段 `txId`）：

1. `sourceType = sponsor_order` 且方向为消耗（commit spend）的记录：
   `txId` = 该 sponsor 订单 commit 阶段广播上链的交易 txid。sponsor 订单
   表里已经存了 commit 的 tx hash，按 `sourceId = orderId` join 出来即可。
2. 同一订单的预留（pre reserve）记录：可以带上同一 `txId`（与客户端现在
   的展示行为一致），也可以不带——两种都接受，选实现简单的。
3. 释放（release / 过期）记录：没有链上交易，`txId` 为 null 或省略。
4. `sourceType = recharge_order` 的记录：不涉及链上交易，`txId` 为 null
   或省略。
5. 纯增量字段，保持向后兼容；同步更新 Swagger 和 `docs/traffic-deployment.md`。

验收标准：

- 调 `/v1/traffic/ledger`，任一 commit spend 记录带出的 `txId` 能在 MVC
  区块链浏览器上查到对应交易。
- 不带 `txId` 的记录类型符合上面 3/4 的规则。
- 现有测试保持绿色，`go build ./... && go test ./...` 通过。

参考文档（本机路径）：

- 需求规格：`/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/gasfee-flow/backend-spec.md`
- 你们的部署文档：`/Users/tusm/Documents/MetaID_Projects/assist-base-service/docs/traffic-deployment.md`

老规矩：分支上开发，commit + 链上日志，完成后通知我们验收，先不合 main。

## Client-side follow-up once delivered

- `src/main/services/trafficAccountService.ts` — prefer server-provided
  `txId`; keep the journal join only as a fallback for entries missing it.
- Update `tests/trafficAccountService.test.mjs` ledger-enrichment cases.
