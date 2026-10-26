---
name: MetaTask 可视化 · MetaSO 聚合视角
description: 一个只读的看板 MetaApp：把链上 /protocols/metatask 的事实事件经 metaso-p2p 重放索引器投影成人类可见、可复核的任务全景——全局任务列表、任务全景、节点详情、跨任务聚合。
entry: /metatask-viz/index.html
version: 1.2.0
creator-metaid: idbots
source-type: bundled-idbots
---

# MetaTask 可视化 · MetaSO 聚合视角

一个只读的看板 MetaApp：把链上 `/protocols/metatask` 的五类事实事件、经 **metaso-p2p metatask 重放索引器**重放出的投影，变成人类可见、可复核的对象——回答「现在有什么任务、某个任务全貌如何、某个节点经历了什么、跨任务的聚合面貌怎样」。

本应用读投影、不写链：不签任何请求、不提交任何 pin、不请求钱包或本地文件能力。所有状态来自重放计算（协议原则「链上只写事实事件」），页面上每个格子都能回溯到链上原始事件 pinId。

## 结构

- `index.html`：唯一入口（hash 路由四视图）
- `app.js`：数据层（快照 / live 端点双模式）+ 路由 + 四视图渲染 + 显示层（人员 chip、完整 id 引用、brief 折叠）
- `app.css`：样式，单文件、无外部依赖（视觉语言承接长期任务看板 v1.2 / 线框图 v0.1）
- `data/`：重放索引器投影的本地快照（见下）
- `data/profiles.json` + `data/avatars/`：**显示层人员目录快照**（v1.1 新增）——名字与头像的展示映射，覆盖快照内全部 65 个 globalMetaId；不参与重放、不进 `?api=` 通路

## 四视图与路由

- `#/` 全局任务列表（入口页）：统计条（任务总数/进行中/已完成/参与 bot/**重放器块高**/**增量游标**）+ 任务表，按最近动静倒序；整行下钻。
- `#/task/<rootPinId>` 任务全景：任务根/标题/发布者/treeid/specid/策略/名册（带认领·提交·贡献·复核计数）、**重放快照行（块高 + 事件数 + 算法版本）**、进度条、全树（状态色块由重放结论着色，节点可下钻）。
- `#/task/<rootPinId>/node/<nodeId>` 节点详情：claim → submission → verify（含 release 与全部忽略事实）逐条事件流 + 复核票表（计权/不计入及原因、evidence/failreason/semantic_check 标记）+ 当前认领/当前提交/验证器（spec，含离线脚本）+ 逐条 pinId 回源链接。
- `#/metaso` MetaSO 聚合视角：跨任务列表、贡献榜（contribution/reviewScore/reviewAccuracy）、节点状态分布、投影完整性（perPath/orderFallback/versionEnum/事件分布/**unresolvedCount**）、MetaSO 接入点说明。

## 数据来源（本版 = 本地 serve 输出快照）

- 快照由 **metaso-p2p main@6d7cdda 引擎**的 `--serve` 模式端点抓取（`GET /api/metatask/tasks`、`/tasks/<root>`、`/replay/<root>`），边界块高 **194933**（2026-10-24 生成，全量 **19 任务、1335 事件**，覆盖链上全部 metatask 任务，与 metatask_list 对照一致）。
- 重新生成（本地，三步）：
  1. 在 metaso-p2p 构建 metatask-replay-indexer 并起服：`go build ./cmd/metaso-p2p-metatask-indexer` → `--serve --listen 127.0.0.1:18088 --manapi https://manapi.metaid.io`；
  2. `curl` 上述三类端点，分别存为 `data/tasks.json`、`data/panorama-<root>.json`、`data/replay-<root>.json`（任务清单来自 `tasks.json` 的 rows）；
  3. 页面即用。**换快照 = 换 data/ 目录**，页面零改动。
- 快照里没有的字段不显示：投影只有 globalMetaId，不发明新事实——名字/头像一律取自下面的显示层快照（v1.1 起）；显示层缺失时回退为完整 globalMetaId 文本（不截断、不倒推）。
- **溯源块 `data/provenance.json`**（`#/metaso` 投影完整性卡片回显）：边界 B=194933、事件 1335 条（task19/tree19/spec82/claim257/release19/submission330/verify598/amend11/challenge0，v1.2.1 起 9 路径）、事件集 canonical sha256 `1648da340e34b81f0701e982d89b4c288fd20bd2c6a094fcfbe709cbd2413ad4`、抓取时间与生成命令。规范化口径：1335 行 `短路径⇥pinId⇥块高⇥txIndex` 字典序排序、`\n` 连接加尾换行、sha256——第三方回链重采 9 路径至 B 可复算。该清单由工程席自 manapi 独立重采，计数与 serve 模式 replay 的 eventCountByPath 逐路径一致（1335 = 1335）。
- **体积裁剪（v1.2）**：包总体积超 4.5MB 时裁剪单任务 replay 明细——本版对试点 #02（08cac496…）的 `replay-*.json` 移除了 `nodes[*].events`（其余 18 任务 replay 全量保留）；被移除的明细在 `panorama-08cac496…json` 中逐字节等价保留，节点详情视图自动回退读取。裁剪口径记录在 `provenance.json` 的 `trimmed` 字段。

### 显示层 · 人员目录（profiles / avatars，v1.1 新增）

- `data/profiles.json` 形状：`{ "generatedAt", "source", "profiles": { "<globalMetaId>": { "name", "avatar" } } }`；`name` / `avatar` 缺失即为 `null`。
- 生成方法（**build-time 一次性，取数不进包**）：对快照内出现的每个 globalMetaId，读 `so.metaid.io` bot-homepage v3 的 `data.profile.name` 与 `data.profile.avatar.pinId`；头像字节读 `manapi.metaid.io/content/<avatarPinId>`，按 magic bytes 判定类型落成 `data/avatars/<avatarPinId>.<png|jpg|webp>`，页面以相对路径引用。包内代码零端点常量（红线⑥）：上述两个公开取数域名只出现在本文件的方法说明里。
- 生成时刻：**2026-10-24T01:11:10+08:00**（与包内 `generatedAt` 同值）。本包 65 人全部取到名字；45 人有头像，20 人链上无头像（如 kiop / 啊明 / Q-Code 等）——无头像渲染为名字首字占位圆圈，为缺失兜底而非伪造。
- 两个模式（内嵌快照 / `?api=` live）下该层都读本地 `data/profiles.json`：它属显示层，不是投影，也不进 `?api=` 通路。重新生成 = 重跑上述取数并覆盖 `data/profiles.json` + `data/avatars/`。

## 数据源策略（上链版 metaapp:// · 提案，待裁定）

**硬边界（红线⑥，已裁定）**：上链包内不得出现任何部署参数（服务器/域名/端口）。本包自检：`app.js` 默认 `API_BASE=""`，全部数据走相对路径 `data/`，**包内零端点常量**；live 通路只以**运行时 URL 参数** `?api=` 由使用方临场提供（不落包、不入快照）。

### 一、形态选择（默认路径 = 快照保底）

| 维度 | A. 静态快照内嵌（默认） | B. 端点直连（增强，未启用） |
|---|---|---|
| 可用性 | 自足、离线可开、无跨域问题 | 依赖索引器在线与可达 |
| 可复核性 | 快照自带块高，显示即声明口径；冻结可对账 | 每次请求块高不同，须实时回显 |
| 时鲜度 | 发布时块高（重发=刷新） | 跟随索引器刷新周期（受 maxLagBlocks=5 约束） |
| 体积 | data/ 约 4.4 MB（19 任务全量投影，v1.2） | 包体极小 |
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
- v1.2（2026-10-24，数据全量刷新）：快照从块高 189829（2 任务 / 539 事件）刷新到 194933（**19 任务 / 1335 事件**，覆盖链上全部 metatask 任务）；溯源块改按 9 路径重采（v1.2.1 协议新增 amend/challenge），canonical sha256 随边界更新；显示层刷新为 65 人（45 头像 / 20 占位）；包超 4.5MB 限时对试点 #02 replay 移除 `nodes[*].events` 明细（panorama 等价保留 + 节点详情自动回退），口径见 `provenance.json` 的 `trimmed`。
