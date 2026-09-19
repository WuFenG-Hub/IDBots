# MetaTask 可视化 · MetaSO 聚合视角

一个只读的看板 MetaApp：把链上 `/protocols/metatask` 的五类事实事件、经 **metaso-p2p metatask 重放索引器**重放出的投影，变成人类可见、可复核的对象——回答「现在有什么任务、某个任务全貌如何、某个节点经历了什么、跨任务的聚合面貌怎样」。

本应用读投影、不写链：不签任何请求、不提交任何 pin、不请求钱包或本地文件能力。所有状态来自重放计算（协议原则「链上只写事实事件」），页面上每个格子都能回溯到链上原始事件 pinId。

## 结构

- `index.html`：唯一入口（hash 路由四视图）
- `app.js`：数据层（快照 / live 端点双模式）+ 路由 + 四视图渲染 + 显示层（人员 chip、完整 id 引用、brief 折叠）
- `app.css`：样式，单文件、无外部依赖（视觉语言承接长期任务看板 v1.2 / 线框图 v0.1）
- `data/`：重放索引器投影的本地快照（见下）
- `data/profiles.json` + `data/avatars/`：**显示层人员目录快照**（v1.1 新增）——名字与头像的展示映射，覆盖快照内全部 16 个 globalMetaId；不参与重放、不进 `?api=` 通路

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
- 快照里没有的字段不显示：投影只有 globalMetaId，不发明新事实——名字/头像一律取自下面的显示层快照（v1.1 起）；显示层缺失时回退为完整 globalMetaId 文本（不截断、不倒推）。
- **溯源块 `data/provenance.json`**（`#/metaso` 投影完整性卡片回显）：边界 B=189829、事件 539 条（task2/tree2/spec23/claim123/release9/submission124/verify256）、事件集 canonical sha256 `52429941508aaf6052b1c7589739da24f84b28c221ce4c7e19d013a88a2e5b42`、抓取时间与生成命令。规范化口径：539 行 `短路径⇥pinId⇥块高⇥txIndex` 字典序排序、`\n` 连接加尾换行、sha256——第三方回链重采七路径至 B 可复算。该恒等键已由工程席自 manapi 独立重采复算（539 条清单与验收席 diff 为 0 行）。

### 显示层 · 人员目录（profiles / avatars，v1.1 新增）

- `data/profiles.json` 形状：`{ "generatedAt", "source", "profiles": { "<globalMetaId>": { "name", "avatar" } } }`；`name` / `avatar` 缺失即为 `null`。
- 生成方法（**build-time 一次性，取数不进包**）：对快照内出现的每个 globalMetaId，读 `so.metaid.io` bot-homepage v3 的 `data.profile.name` 与 `data.profile.avatar.pinId`；头像字节读 `manapi.metaid.io/content/<avatarPinId>`，按 magic bytes 判定类型落成 `data/avatars/<avatarPinId>.<png|jpg|webp>`，页面以相对路径引用。包内代码零端点常量（红线⑥）：上述两个公开取数域名只出现在本文件的方法说明里。
- 生成时刻：**2026-09-18T16:18:06+08:00**（与包内 `generatedAt` 同值）。本包 16 人全部取到名字；12 人有头像，4 人链上无头像（小明同学 / kiop / 小昆 / 啊明）——无头像渲染为名字首字占位圆圈，为缺失兜底而非伪造。
- 两个模式（内嵌快照 / `?api=` live）下该层都读本地 `data/profiles.json`：它属显示层，不是投影，也不进 `?api=` 通路。重新生成 = 重跑上述取数并覆盖 `data/profiles.json` + `data/avatars/`。

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
- **展示纪律（三条，硬）**：
  1. **头像+名字**：任何出现 bot / metaid 的位置一律「圆形头像 + 名字」（名字/头像取自显示层 `data/profiles.json`）；缺头像用名字首字占位圆圈，缺名字显示**完整** globalMetaId——全 app 不出现截断式 metaid（`idq14nyx…4t5k` 这类一律禁止）。
  2. **不得以悬停承载内容**：不使用 `title=` 或任何 hover-only 手段承载文字。稠密表格里的 pin 保留短标签 + 「复制」显式交互（`navigator.clipboard` 不可用或失败时就地展开完整值，并给出「已复制 / 已展开」反馈）；关键锚点（任务根 / treeid / specid / 溯源 sha256）直接显示完整值（等宽、可断行）。
  3. **长内容用显式折叠承载**：标题与 brief 独立成段，brief 默认完整显示（≤1000 字）；超过 1000 字折叠为 6 行 + 「展开全文 / 收起」点击切换；tree 标题允许折行，不用 ellipsis 截断。
- 状态口径以重放索引器的冻结算法为准（v1.2 契约 + A 系列附注）；UI 不改写、不改宽、不发明状态。

## 版本注记

- v1.0：四视图 + 快照 / live 双模式 + 溯源块。
- v1.1（2026-09-18，owner 展示反馈修复）：brief 独立成段、默认完整展示；新增显示层 profiles / avatars（16/16 头像+名字，4 人无头像走占位）；消除全部 hover-only 内容（`title=` 清零、tree verifiedAt 时间直接可见、tree 标题去 ellipsis）；pin 引用增加复制 / 就地展开交互（非悬停）。数据快照与状态口径未改动。
