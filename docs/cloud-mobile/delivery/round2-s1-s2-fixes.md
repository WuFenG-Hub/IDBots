# WS-A 第 2 轮修复单回执（S1 + S2）

> 修复分支：`feat/server-mode`（`5cd5dc0e`、`61548810`），已合并至 `feat/tenant-image`（`32bde0c8`）。
> 全部修复含守卫测试；容器实测基于 `idbots/tenant:1.0.2-round2`（因 Docker Hub 不可达，采用「上一版完整构建镜像 + 本地产物」增量补丁镜像，应用代码与分支 HEAD 一致）。

## 1. 改动文件与 diff 摘要

### S1 — 服务端调度器从未启动

| 文件 | 改动 |
|---|---|
| `src/main/libs/startupTiers.ts`（新增） | 从 main.ts 抽出启动 tier 队列（`scheduleStartupTier` / `clearPendingStartupTiers` / `cancelDeferredStartupWork`），新增 `noteSqliteDaemonsStarted()`：**首次 daemon 启动不清空；重入（sqlite recovery）仍清空上一代待启动项**，保留原重入语义（方案 A 的等价最小实现：首代不清、重入清前代）。 |
| `src/main/main.ts` | 删除内联 tier 实现改为 import 该模块；`startSqliteDaemons()` 首行由 `clearPendingStartupTiers()` 改为 `noteSqliteDaemonsStarted()`；`setStartupTierLogger(startupLog)` 保持 tier 日志逐字一致；`runIdleStartupSteps` 的取消标记改经 `areStartupTiersCancelled()` 读取。 |
| `tests/startupTiers.test.mjs`（新增） | 三条守卫测试（见第 2 节）。 |
| `tests/serverMode.test.mjs` | REQ-A-33 静态断言的 `resolveServerBootDelayMs` 行改指向新模块（行为断言不变）。 |
| `package.json` / `.gitignore` | 新测试接入 `pnpm test` 首组；`!tests/startupTiers.test.mjs`、`!tests/webSearchRuntimeDir.test.mjs`。 |

### S2 — web-search 启动路径断裂

| 文件 | 改动 |
|---|---|
| `SKILLs/web-search/scripts/start-server.sh` | 新增 `WEB_SEARCH_RUNTIME_DIR`（默认 `${XDG_RUNTIME_DIR:-/tmp}/idbots-web-search`，`mkdir -p` 自建）；`.server.pid` / `.server.log` 移出只读技能目录。 |
| `SKILLs/web-search/scripts/stop-server.sh` | 同一运行时目录的 `.server.pid`。 |
| `SKILLs/web-search/scripts/search.sh` | `.connection` 缓存与 `.server.log` 读取移到同一运行时目录。 |
| `tests/webSearchRuntimeDir.test.mjs`（新增） | 三个脚本各一条静态断言：可写默认目录 + 自建 + 不再读写技能目录下运行时文件。 |

桌面默认目录同样可写（macOS/Linux `/tmp`）；已有运行中的桥由健康检查接管，不重复拉起。

## 2. 守卫测试：先红后绿

**修复前**（`/tmp/s1-red.log`，`node --test tests/startupTiers.test.mjs`，exit 1）：

```
✖ boot tier survives the FIRST sqlite daemon start (S1 guard) (1.717209ms)
✖ re-entry clears previous-generation pending tiers without double-starting (25.296834ms)
✔ desktop delayMs is passed through (no server-mode behavior change)
ℹ pass 1 / ℹ fail 2
```

失败内容：`hasPendingStartupTiers()` 为 false（tier 被 daemon 启动清掉）、调度器 spy 计数 0。

**修复后**（`/tmp/s1-green.log`，exit 0）：

```
✔ boot tier survives the FIRST sqlite daemon start (S1 guard)
✔ re-entry clears previous-generation pending tiers without double-starting
✔ desktop delayMs is passed through (no server-mode behavior change)
ℹ pass 3 / ℹ fail 0
```

全量 `pnpm test`（含全部既有套件）：**exit 0，全绿**；`pnpm run lint`、`pnpm run compile:electron`、`pnpm run build:skills` 均通过。

## 3. 修复前后启动日志对照

**修复前**（staging 复核现象 + 本机分析）：`[Scheduler] Started` 一条都没有；`startSqliteDaemons()` 在 `scheduleStartupTier('server: task scheduler start', 0, …)` 之后同步执行 `clearPendingStartupTiers()`，该 tier 被确定性清除。

**修复后**（容器 `t5-round2` 实测）：

```
deferred startup "server: task scheduler start" begin
[Scheduler] Started
[Startup +102602ms] server mode: task scheduler + heavy maintenance started
deferred startup "server: task scheduler start" done
```

（调度器在 +102s 的错峰窗口内启动，REQ-A-33 的延迟语义保留；其余 tier 日志不变。）

**定时任务真跑（无窗口、无手动触发）**：经网关 `scheduledTask:create` 创建 75 秒后的一次性任务，到点自动执行，`listRuns` 返回：

```json
{"status":"success","trigger":"scheduled","startedAt":"2026-10-22T09:00:22.607Z","finishedAt":"2026-10-22T09:00:31.055Z","durationMs":8448,"skipReason":null}
```

**web-search**：boot 后桥自行就绪（`GET /api/health` 正常）；`scripts/search.sh` 真实联网搜索返回结果；`.connection` 写入 `/tmp/idbots-web-search/`（可写运行时目录，不再写只读技能目录）。

## 4. 重入路径验证

- 单元级（`tests/startupTiers.test.mjs` 第二条）：调度器 tier 运行一次后，模拟 sqlite recovery 重入 `noteSqliteDaemonsStarted()`——上一代待启动 tier 被清除（防重复启动语义保留），调度器 spy 计数保持 1；重入后新排的 tier 正常执行。
- 守护测试先红后绿（第 2 节）证明这条路径在修复前也是断的。

## 5. 桌面模式影响确认

桌面行为不变，验证方式：
- 代码层：tier 队列、日志格式、`startServerAwareBootJob` 的桌面 inline 分支均未改；仅首次 daemon 启动不再清空队列，而桌面上 message/idle tier 本就在 `startSqliteDaemons()` 内部排队（清空之后），时序语义不变。
- 实测：桌面开发实例启动日志 `window ready-to-show` → `[Scheduler] Started`，`message daemons`（+2s）与 `idle background work`（+7s）照常触发。
- 全量测试 `pnpm test` exit 0（含桌面既有回归套件）。

## 附：S2 附带环境说明

- 镜像为增量补丁镜像（Docker Hub/镜像源当时不可达）；完整 Dockerfile 未改，中转环境全量构建即可得到同等产物。
- 测试容器/卷已清理；交付说明与链上开发日志已同步。
