# SleepGuard 工作源覆盖矩阵（Boss 需求：本地 / 线上 / 群任务工作期间设备不睡）

> 本文是 `fix/sleep-guard-macos` 分支上「工作源覆盖核实与补强」这一步的交付物。
> 关注点不是「断言机制能不能生效」（上一轮已修，见 `src/main/sleepGuard.ts` 头部注释），
> 而是「哪些入口会被判定为有工作」。判定标准：**这条路径会不会产生分钟级以上的持续工作**，
> 而不是「它算不算一个会话」。

## 0. 覆盖模型：有界工作 vs 常驻 daemon

`SleepGuard` 只在「设置 ON **且** 至少一个有界工作单元在跑」时持有 OS 断言。

- **有界工作（计入）**：用户/任务在等结果的工作单元，有明确的开始与结束。
- **常驻 daemon（不计入）**：只要 App 活着就在跑的进程/循环——p2p indexer、MCP skill server、
  本地 MetaApp server、各类 listener/socket、backfill 巡检。把它们计入会让断言**永久持有**，
  等于把「阻止休眠」变成一个常开的开关，这不是 Boss 要的语义。

工作源收集做成可注入的纯函数：`src/main/sleepGuardWorkSources.ts`（`collectSleepGuardWorkFrom`），
每个源独立 try/catch：**任何一个源抛错只会让该源为空，不会崩掉 guard，也不会让其它源的实时工作失守**。

## 1. 逐入口矩阵

| # | 入口 | 是否进入工作源 | 结论依据（代码位置） |
|---|---|---|---|
| 1 | 本地对话（Cowork UI） | ✅ 内（`cowork`） | 渲染层 `coworkService.startSession` → IPC `cowork:session:start`（`src/main/main.ts:8609`）→ `runner.startSession`（`src/main/main.ts:8741`）→ `CoworkRunner.startSession` 写入 `activeSessions`（`src/main/libs/coworkRunner.ts:6117`，turn 内重注册 `:7463`）→ `getActiveSessionIds()`（`:12070`） |
| 2 | 线上对话 A2A（入站私聊） | ✅ 内（`a2aChat` + `cowork`） | 入站处理任务登记在 `privateChatDaemon` 的 in-flight 集合（`src/main/services/privateChatDaemon.ts:3187`/`4895`，新导出 getter `:250`）；长路径（技能回合）走 `runPrivateChatSkillTurn` → `runSkillTurnInExistingSession` → `orchestratorCoworkBridge.ts:604` → `startSession` |
| 3 | 私聊订单执行（Gig Square / A2A 订单） | ✅ 内（`cowork`） | `src/main/services/privateChatOrderCowork.ts:206`（首次执行）与 `:658`（缺件续跑）都调用 `coworkRunner.startSession`；订单视频长任务在同一会话内（`startVideoLongTaskStatusUpdates`） |
| 4 | 群任务编排（Group Task daemon） | ✅ 内（`groupTask`，**本次新增**） | 会话部分：`groupTaskDaemon` 的 `runSkillTurn`（`src/main/main.ts:3721`）→ `runSkillTurnInExistingSession` → `orchestratorCoworkBridge.ts:604`；**会话外的多分钟部分**（chair 规划/验收、链上发送、交付物上传、验收摘要）由 turn 级在飞状态兜住：`turnInFlight.set(key…)`（`src/main/services/groupTaskDaemon.ts:6510`）→ 导出 `getGroupTaskTurnActivity()`（`:10270`）→ 新工作源 |
| 5 | 群聊自动回复 daemon（`group_chat_tasks`） | ✅ 内（`groupChat`，**本次新增**） | 回复管线在飞状态：`thinkingTasks`（`src/main/services/cognitiveOrchestrator.ts:972`/`985`，新导出 getter `:181`）；技能分支仍走 cowork（`runSkillTurnViaCowork` → `orchestratorCoworkBridge.ts:425`），纯对话分支是**没有会话**的 reasoning completion（`cognitiveOrchestrator.ts:797`），故整个管线必须自己作为工作源 |
| 6 | 定时任务 | ✅ 内（`scheduledTask` + `cowork`） | `Scheduler.getActiveTaskIds()`（`src/main/libs/scheduler.ts:82`，`activeTasks` 覆盖整个 run，`:219` 登记/`:235` 释放）；会话本体 `scheduler.ts:342` → `startSession` |
| 7 | IM 触发（Telegram/Discord/飞书/钉钉/NIM…） | ✅ 内（`cowork`） | `src/main/im/imCoworkHandler.ts:185` → `startSession`（活跃则 `continueSession`，`coworkRunner.ts:6172`，非活跃时委托 `startSession`） |
| 8 | 夜间梦境 | ✅ 内（`dream`） | `DreamService.getDreamingBotIds()`（`src/main/services/dreamService.ts:181`），`dreamingBots` 在梦境运行期间登记/释放（`:605`/`:656`）；梦境本身在 main 进程内做 LLM 固化，没有 cowork 会话 |
| 8b | 夜间学习 / 链上问答冲浪（study / qa-surf job） | ✅ 内（`cowork`） | `runStudyJob` 用 `runOrchestratorSkillTurn`（`src/main/main.ts:6836` 起）跑一个有界后台会话 → `orchestratorCoworkBridge.ts:425` → `startSession` |
| 9 | Bot Browser 长任务 | ✅ 内（`cowork`） | 浏览器会话就是 `sessionType === 'browser'` 的 cowork 会话：渲染层 `src/renderer/services/browserCowork.ts:68-72` → 同一个 `cowork:session:start`（`main.ts:8634` 归一化类型，`:8741` 启动）；自动化工具（截图/导航/发布）都在该会话回合内执行 |
| 10 | 直接 spawn / dsh-runtime 长跑 | ✅ 内（`cowork`，随会话生灭） | `coworkVmRunner`（真正 spawn DSH runtime：`src/main/libs/coworkVmRunner.ts:326`/`:331`）只被 `coworkRunner` 使用（唯一 import 方），即 runtime 子进程绑定在活跃会话上 |
| 11 | OpenTeam 访客 daemon / Twin 编排 Worker | ✅ 内（`cowork`） | 都经由 `runSkillTurnInExistingSession` / `runOrchestratorSkillTurn` 起会话（`openTeamGuestDaemon.ts:648` + `main.ts:3726` 注入） |
| 12 | 常驻 daemon / 连接器（p2p indexer、MCP skill server、MetaApp local server、listener、backfill 巡检） | ⛔ 有意不计入 | 只要 App 运行就存在，计入=断言永久持有；它们的单次网络/DB 工作不是「任务推进」的等待对象。见 `src/main/sleepGuardWorkSources.ts` 头部说明 |
| 13 | 应用更新下载 | ⛔ 有意不计入 | OS 层可续传的用户发起的下载，不是会话/任务推进；不在 Boss 本次口径（本地/线上/群任务）内 |

**本次补强的缺口**：`#4 / #5 / #2-纯对话分支`。修前它们**部分或全部不在覆盖内**——群任务回合的
绝大多数时间（规划/验收/上链/上传）没有任何 cowork 会话，群聊与 A2A 的纯对话回复分支同样没有会话。
修后新增 3 个工作源：`groupTask` / `groupChat` / `a2aChat`。

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `src/main/sleepGuard.ts` | `SleepGuardSource` 增 `groupTask`/`groupChat`/`a2aChat`；`SleepGuardWorkInput` 增 3 个字段；`evaluateSleepGuardWork` 稳定顺序追加；头部注释补「什么算工作」 |
| `src/main/sleepGuardWorkSources.ts`（新） | 可注入的工作源收集器（每源独立容错 + 非数组返回显式报错），`groupTaskTurnIdsOf()` 生成 `taskId:metabotId` 键 |
| `src/main/main.ts` | 用收集器接 6 个 getter；`emitTaskEvent` 在 `groupTask:turnActivityChanged` 时立即重算（群任务回合即刻生效，不等 20s 轮询） |
| `src/main/services/cognitiveOrchestrator.ts` | 导出 `getActiveGroupChatReplyTaskIds()` |
| `src/main/services/privateChatDaemon.ts` | 导出 `getActiveA2AReplyTaskIds()` |
| `src/renderer/components/SleepGuardBadge.tsx` + `services/i18n.ts` | 3 个新源的 tooltip 标签（中/英）：群任务回合 / 群聊回复 / 线上私聊回复 |
| `tests/sleepGuard.test.mjs` | 新源判定、多源并列、群任务回合独占即持有断言、收集器逐源容错/非数组、真实 getter 存在性 |
| `scripts/sleep-guard-real-host-check.cjs` | 三个新源各自「独占 → 真机断言出现 → 回合结束 → 断言消失」+ 收集器真机校验 |
| `scripts/sleep-guard-e2e-real-app.cjs`（新） | 真机 App 端到端驱动：真会话跑 `sleep 150`，采样 guard 状态 + `pmset` |

## 3. 验证证据

### 3.1 单测（28/28 绿）

```
npm run compile:electron && node --test tests/sleepGuard.test.mjs
ℹ tests 28   ℹ pass 28   ℹ fail 0   ℹ duration_ms 627
```

### 3.2 真机断言闭环（43/43 PASS，负向对照必 FAIL）

```
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/sleep-guard-real-host-check.cjs
RESULT: PASS (43/43)

PASS  groupTask: a session-less turn alone engages the guard: {"active":true,"sources":["groupTask"],"engaged":true,"engagedBy":"caffeinate",...}
  pmset (groupTask engaged): pid 57354(caffeinate): ... PreventUserIdleSystemSleep named: "caffeinate command-line tool" | Details: caffeinate asserting on behalf of Process ID 57333 | Created for PID: 57333. | Localized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.
PASS  OS: groupTask holds a real PreventUserIdleSystemSleep assertion
PASS  OS: groupTask assertion gone once the turn settles: (none)
（groupChat / a2aChat 同上，各 2 条 OS 断言检查）

# 负向对照（关掉断言机制，必须 FAIL 才算验证有效）
SLEEP_GUARD_CHECK_DISABLE_ASSERTIONS=1 ... → RESULT: FAIL (34/43)，NEGATIVE CONTROL OK
```

### 3.3 真机端到端：真实工作运行期间断言确实存在（本次主证据）

隔离实例：`cdp 127.0.0.1:9444`，`userData=.dev-userdata-sleepguard-e2e`（配置就绪 + 只有
`sleep_guard_prevent_device_sleep=true`，listener 显式关闭），真实 Electron main pid **57771**。

真实工作：通过该实例自己的 IPC 起一个真会话（不是 mock），Agent 真的调用了 bash：

```
startSession -> {"success":true,"id":"0cca8024-622c-4279-b3f8-910c3f00fdb9","status":"running"}
cowork_messages: tool_use metadata = {"toolName":"bash","toolInput":{"command":"sleep 150",...},"timeoutMs":180000}
会话结束：cowork_sessions.status=completed
```

工作期间的 `pmset`（原始行，含进程 pid 与 Created for PID 明细）：

```
[e2e] 2026-09-10T15:25:34.231Z guard={"active":true,"sources":["cowork"],"engaged":true,"engagedBy":"caffeinate","preventDeviceSleepEnabled":true}
      assertion=58943(caffeinate) PreventUserIdleSystemSleep |
      Details: caffeinate asserting on behalf of Process ID 57771 | Created for PID: 57771. |
      Localized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.
（此后每 5s 采样，断言持续持有到 15:28:10，全程约 2 分 36 秒）

[e2e] pmset assertion for main pid AFTER work: (none)
[e2e] final guard status: {"active":false,"sources":[],"engaged":false,"engagedBy":null,...}
[e2e] RESULT: PASS — engaged while real work ran: true; released after work: true; assertion gone afterwards: true
```

工作开始前该 pid 无任何断言；工作期间 mock/关键词均不参与判定（判定依据是 `pmset` 中归属本 pid
的 `caffeinate` 断言 + `Created for PID` 明确指向 Electron main pid）；工作结束后断言消失。

## 4. 已知边界（诚实标注，未修）

1. **采样粒度 20s**：guard 的兜底轮询是 20s（`main.ts` `startSleepGuardRefresh`），会话类入口有
   事件驱动即时重算，群任务回合已补 `groupTask:turnActivityChanged` 事件；群聊/A2A 纯对话回复目前
   只靠 20s 轮询——对秒级回复可能整个窗口都没被采样到。覆盖目标是分钟级工作（Boss 口径），
   秒级回复落在窗口外的概率与影响都很小；若要更严，应给这两个 daemon 也加事件钩子。
2. **断言类型边界不变**：`PreventUserIdleSystemSleep` 只挡「用户空闲导致的系统睡眠」；
   合盖、Apple 菜单里手动睡眠、低电量强制睡眠不受此保护（`sleepGuard.ts` 头部已写明）。
3. **无链上写操作**：本次所有验证都没有触发任何链上写；真机 E2E 的实例把 listener 显式关掉，
   且只在会话里跑本地 `sleep`。
