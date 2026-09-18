# MetaTask 可视化 · MetaSO 聚合视角

一个只读的看板 MetaApp：把链上 `/protocols/metatask` 的五类事实事件、经 **metaso-p2p metatask 重放索引器**重放出的投影，变成人类可见、可复核的对象——回答「现在有什么任务、某个任务全貌如何、某个节点经历了什么、跨任务的聚合面貌怎样」。

本应用读投影、不写链：不签任何请求、不提交任何 pin、不请求钱包或本地文件能力。所有状态来自重放计算（协议原则「链上只写事实事件」），页面上每个格子都能回溯到链上原始事件 pinId。

## 结构

- `index.html`：唯一入口（hash 路由四视图）
- `app.js`：数据层（快照 / live 端点双模式）+ 路由 + 四视图渲染
- `app.css`：样式，单文件、无外部依赖（视觉语言承接长期任务看板 v1.2 / 线框图 v0.1）
- `data/`：重放索引器投影的本地快照（见下）

## 四视图与路由

- `#/` 全局任务列表（入口页）：统计条（任务总数/进行中/已完成/参与 bot/**重放器块高**/**增量游标**）+ 任务表，按最近动静倒序；整行下钻。
- `#/task/<rootPinId>` 任务全景：任务根/标题/发布者/treeid/specid/策略/名册（带认领·提交·贡献·复核计数）、**重放快照行（块高 + 事件数 + 算法版本）**、进度条、全树（状态色块由重放结论着色，节点可下钻）。
- `#/task/<rootPinId>/node/<nodeId>` 节点详情：claim → submission → verify（含 release 与全部忽略事实）逐条事件流 + 复核票表（计权/不计入及原因、evidence/failreason/semantic_check 标记）+ 当前认领/当前提交/验证器（spec，含离线脚本）+ 逐条 pinId 回源链接。
- `#/metaso` MetaSO 聚合视角：跨任务列表、贡献榜（contribution/reviewScore/reviewAccuracy）、节点状态分布、投影完整性（perPath/orderFallback/versionEnum/事件分布/**unresolvedCount**）、MetaSO 接入点说明。

## 数据来源（本版 = 本地 serve 输出快照）

- 快照由 **c896334 引擎**的 `--serve` 模式端点抓取（`GET /api/metatask/tasks`、`/tasks/<root>`、`/replay/<root>`），边界块高 **189829**（pilot #02 + pilot #01 两任务，539 事件）。
- 重新生成（本地，三步）：
  1. 在 metaso-p2p 的 metatask-replay-indexer worktree 构建并起服：`go build ./cmd/metaso-p2p-metatask-indexer` → `--serve --listen 127.0.0.1:18088 --manapi https://manapi.metaid.io`；
  2. `curl` 上述三类端点，分别存为 `data/tasks.json`、`data/panorama-<root>.json`、`data/replay-<root>.json`（任务清单来自 `tasks.json` 的 rows）；
  3. 页面即用。**换快照 = 换 data/ 目录**，页面零改动。
- 快照里没有的字段不显示（例如显示层不做名字解析：投影只有 globalMetaId，名册与榜单按短 id 呈现、`title` 悬浮显示全 id；人名映射属 profile 层，未来可加、不发明新事实）。
- **溯源块 `data/provenance.json`**（`#/metaso` 投影完整性卡片回显）：边界 B=189829、事件 539 条（task2/tree2/spec23/claim123/release9/submission124/verify256）、事件集 canonical sha256 `52429941508aaf6052b1c7589739da24f84b28c221ce4c7e19d013a88a2e5b42`、抓取时间与生成命令。规范化口径：539 行 `短路径⇥pinId⇥块高⇥txIndex` 字典序排序、`\n` 连接加尾换行、sha256——第三方回链重采七路径至 B 可复算。该恒等键已由工程席自 manapi 独立重采复算（539 条清单与验收席 diff 为 0 行）。

## 数据源策略（上链版 metaapp:// · 提案，待裁定）

**硬边界（红线⑥，已裁定）**：上链包内不得出现任何部署参数（服务器/域名/端口）。本包自检：`app.js` 默认 `API_BASE=""`，全部数据走相对路径 `data/`，**包内零端点常量**；live 通路只以**运行时 URL 参数** `?api=` 由使用方临场提供（不落包、不入快照）。

### 一、形态选择（默认路径 = 快照保底）

| 维度 | A. 静态快照内嵌（默认） | B. 端点直连（增强，未启用） |
|---|---|---|
| 可用性 | 自足、离线可开、无跨域问题 | 依赖索引器在线与可达 |
| 可复核性 | 快照自带块高，显示即声明口径；冻结可对账 | 每次请求块高不同，须实时回显 |
| 时鲜度 | 发布时块高（重发=刷新） | 跟随索引器刷新周期（受 maxLagBlocks=5 约束） |
| 体积 | data/ 约 1.1 MB（两任务全量投影） | 包体极小 |
| 部署依赖 | 零 | 端点公开宣告 + CORS + 可用性兜底 |

**结论**：默认快照保底；端点直连仅在「owner 明确宣告该端点为公开面」后成立。折中形态（快照保底 + 尝试刷新 + 失败静默回落）作为后续增强保留，两态均以 replayMeta 回显块高/游标。

### 二、端点来源（若有）的合规论证

当前**无**内嵌端点，故无待证来源。若未来启用端点直连，须同时给出四项：(1) owner 的公开宣告记录（pin/消息）；(2) 端点确为公开面（不含凭据、任意消费者可访问）；(3) CORS 开放（索引器一行 `Access-Control-Allow-Origin` 响应头——本机实测其为直连的唯一技术门槛）；(4) 可用性兜底与失败回落。四项缺一即回落快照保底。

### 三、replayMeta 回显口径

- **快照模式**：页内显式标注「数据源：内嵌快照 · 数据截至块高 X（非在线）」——X 取自 `replayMeta.evaluatedAtBlock`；**不得伪装在线**；freshness SLO（maxLagBlocks=5）只约束在线模式。
- **live 模式**：显式标注「数据源：live 端点」，块高/游标随响应实时回显。
- 验收①统计条（重放器块高/增量游标）在两种模式下都经 replayMeta 回显——四页均带模式标注，无一处静默。

## 二次开发注意

- 只读不写：新增任何功能不得引入签名、写链、本地文件读取。
- 所有插值经 `esc()`；链上原文不得直接拼进 DOM。
- 短 id 呈现只是显示层截断，`title` 始终携带全 id；`pin://` 链接一律全量 URI。
- 状态口径以重放索引器的冻结算法为准（v1.2 契约 + A 系列附注）；UI 不改写、不改宽、不发明状态。
