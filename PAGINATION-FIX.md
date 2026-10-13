# fix: metaTask 事件抓取分页至空页（深层事件丢失）

## 现象与根因

metaTask 投影引擎（idbots-metatask-engine/1.2.1，`collector.ts` → `protocolPinFetch.ts`）
的池抓取有 `maxPages` 硬上限（collector 传 100），且退出时不区分「走完」与「被截断」：
索引器 pins_by_path 每页按响应字节截断（~19KB），共享提交池混入巨型 base64 载荷后
`size=100` 实测每页只返回 2–3 行——281 行的池子需要 90+ 页，一旦页预算耗尽循环带着
**非空 cursor 静默退出**，深层事件（晚到的 submission / verify 票）从此不进事件集，
投影永久停在旧边界（RSI 任务 eventCount 停 26、N3/N4/N5 三件在链却被投影无视）。

## 修复

1. `protocolPinFetch.ts`：`fetchProtocolPinPages` 返回 `{ pins, hasMore }`；
   `hasMore = 达到 maxPages 且 cursor 仍非空`。`fetchProtocolPinsFromIndexer` 新增
   `onTruncated` 回调 + console.warn——**截断可观测**，不再静默丢事件。
2. `collector.ts`：默认 `maxPages` 100 → **1000**（1000 页是 runaway 守卫不是预算），
   并挂 onTruncated 告警。抓取语义改为 **cursor 翻页至空页**。
3. 不改 API 形状：`fetchProtocolPinsFromIndexer` 仍返回数组，main.ts 等 5 处既有
   调用方零改动。

## 验证

- 新增 `tests/metataskCollectorPagination.test.mjs`（3 例，mock 索引器 3 行/页复现字节预算形态）：
  400 行池走到底恰好 ceil(400/3)=134 页终页回空 cursor；守卫触发时 onTruncated 上报；
  281 行池默认口径深层行（旧实现必丢的 pin280）入集。
- `pnpm run test:metatask`：122/122 既有用例全绿；三引擎锚
  `726959e9…`（v1.3.0 registration）逐字不变。
- 真链验证 `scripts/metatask-pagination-validation.mjs`（exit 0）：
  - ② RSI 根 `82aa4332…`：三枚深部 submission（0cb6fb3e/19f6fc3e/91fcd0df）全入事件集，
    三张在途 pass 票（fc9d2c21/96c29e11/1b9e7024）全数计票，
    **progress 9/9 verified、taskComplete=true、winningChain 9 件含全部三件、
    competitive settlement 产出**；
  - ③ TLMC `08cac496…` / JSP `a7548162…`：新旧口径 eventSetHash 与投影**逐字节一致**
    （61ee2987… / 49f72ffe…），无回归（双侧重放钉同一 evaluatedAtMs 排除时钟噪声）。

## 如实标注

真链抓取当日 legacy（100 页）与 fixed 口径收集行数相同——当前线上池恰好落在旧预算内，
字节预算截断形态未在当日真链复现；该形态由 mock 索引器测试确定性复现（正是测试的存在意义）。
投影折叠验证（②）在真链完成，且与 chair 提供的三方投影互证口径一致。
