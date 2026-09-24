# xiangqi-adapter fixture 来源与防漂移

本目录是 S1 首局（924-2）裁判 adapter 的**字节级复制件**，供
`tests/agentGameConvergence.test.mjs` 做第三方确定性重放。

- 来源：`/Users/tusm/Documents/MetaID_Projects/llm-play-chinese-chess` main
  （commit 70eb722 validateAction/getResult 契约对齐 + 66e0d95
  serializeState:string，两者即首局 v1.0.2 游戏包的上链构建基线）。
- 布局：`agent-game/adapter.js`（源 `agent-game/xiangqi-adapter.js`，
  import `../js/notation.js`）+ `js/notation.js` + `js/rules.js`。
- 防漂移锚：`agent-game/adapter.js` sha256 必须恒等于
  `eabf1f423c869f91ef9c755e95d61e97ad32189e87a910b4bdfee4678c664a5e`
  （= 首局 v1.0.2 游戏包 adapterHash，测试内 assert）。
- 更新方式：蓝本 adapter 契约再变更时，重新字节复制三件并同步更新
  测试内的 JUDGE_ADAPTER_SHA256 与流 fixture（污染流哈希语义依赖该版本）。
