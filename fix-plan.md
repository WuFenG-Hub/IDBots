# IDBots issue #40 修复方案与落地记录

- 仓库工作树：`/Users/wufeng/idbots/project/bots/2/2026-09-22/idbots-bugfix/IDBots/.worktrees/group-broadcast-durability`
- 分支：`fix/group-broadcast-durability`（基线 `37ee6e6`，与本地 main 逐字对齐）
- 日期：2026-09-23
- 状态：**实现完成 + 本机验证通过；第二轮复核返工（N1 / N4）已完成并实测**；改动未 commit、未 push、未开 PR、未发任何公开内容。
- 一句话：三条根因全部按最小可行范围处理，同一套用例「改前 5 fail / 改后 5 pass」；第二轮复核发现的 N1（同群双 bot 同触发消息吞答复）与 N4（新测试文件被 gitignore 忽略）已修复，改前/改后实测见 §7。

---

## 0. 结论摘要（先看这里）

### 已验证（本机可复现）

| 项 | 结果 |
|---|---|
| 改前复现（基线 37ee6e6，首轮 5 用例） | `tests/groupChatOutboxDurability.test.mjs`：tests 5 / pass 0 / **fail 5** |
| 改后验证（本工作树，含返工） | 同一条命令：tests **7 / pass 7 / fail 0**（首轮 5 + 返工新增 2 条跨 bot 用例） |
| 回归 | `npm run test:group-tasks`：tests **544 / pass 544 / fail 0**（含新增 7 条用例） |
| 相邻测试 | `cognitiveGroupChatPrompt / sleepGuard / llmSafeText / sqliteRecoveryLifecycle`：50 pass / 0 fail |
| 既有编排器用例 | `tests/groupChatAllowChatSkillsRuntime.test.mjs`：4 pass / 0 fail（已适配 outbox 查询） |
| 返工 N1（同群双 bot 同触发消息） | 改前 2 fail → 改后 2 pass；probe-crossbot 两场景实测见 §7.2 |
| 返工 N4（测试文件可被 git 跟踪） | `git check-ignore -v` 不再命中，白名单 + `git add` 实测见 §7.3 |
| 静态检查 | `tsc`（`npm run compile:electron`）通过；`eslint` 三个改动 TS 文件 exit 0 |
| 仓库状态 | 无残留 stash；`main` 分支未动；无远端写入 |

### 三条根因 → 处理状态

| issue #40 失败事实 | 状态 | 落地方式 |
|---|---|---|
| ① 失败即丢、无重试 | ✅ 本轮修复 | 广播前先持久化「投递义务」行；失败保留 `pending` + 退避，drain 用**同一文本**重发（不重跑 LLM） |
| ② 失败也推进游标 | ✅ 本轮修复 | 游标改为「义务到达终态才可越过触发消息」；`pending` 期间钉在 `trigger_msg_id - 1` |
| ③ 传输层 pinId 被丢弃、无法 ACK | ✅ 本轮修复（到「本地写入 ACK」为止） | `BroadcastGroupChatFn` 契约改为返回 `{pinId}`；`main.ts` 接住；写入义务行 `pin_id` |

### 待验证（本机无法验证，见 §6）

- 真实 Electron + 真链路的端到端行为（钱包签名、broadcast、回读）；
- 生产环境里 `SUBMITTED` 行实际重试节奏与 `saveDb()` 落盘时序；
- 「上游是否接受该方向」（issue 正文在等答复；本任务禁发公开内容，故未互动）。

### 明确未做（建议后续单独处理，见 §5.2）

- `SUBMITTED → CONFIRMED` 外部回读确认（pin 回读 / `verifyPinSources`）；
- 占位消息（`copyRespondingPlaceholder`）半状态问题（issue 正文事实②）；
- 重复投递的读回去重（`createPin` 已上链但调用抛异常的窗口）；
- UI 可观测、`ABANDONED` 行清理策略、其他出站路径的同类加固。

---

## 1. 根因确认（对照三条失败事实逐条核对 37ee6e6 代码）

> 核对方式：在基线 37ee6e6 上逐行读源码 + 用「改前复现」用例实跑（§3），两条证据一致。

**① 失败即丢、无重试 —— 确认**
`src/main/services/cognitiveOrchestrator.ts` 原 `:818-824`：

```ts
try {
  await broadcastGroupChat(task.metabot_id, task.group_id, metabot.name, trimmed);
} catch (err) {
  rethrowSqliteWasmBoundsError(err);
  console.error('[Orchestrator] Broadcast failed:', ...);
  return;   // 只打日志：回复文本、失败原因、"欠哪条消息一条回复"都不落表
}
```

原文件内只有 4 处 `UPDATE group_chat_tasks`、零 `INSERT`——没有任何可重试的持久记录。

**② 失败也推进游标 —— 确认**
同文件原 `:990-995`：`tick()` 末尾无条件执行

```ts
db.run('UPDATE group_chat_tasks SET last_processed_msg_id = ? WHERE id = ?', [maxProcessedId, task.id]);
```

广播失败的早退分支不回滚游标，下个 tick 的 `id > last_processed_msg_id` 再也选不中触发消息——失败与成功在游标层面不可区分。

**③ 传输层 pinId 被丢弃、无法 ACK —— 确认**
- 原类型契约 `:124-129`：`BroadcastGroupChatFn = (...) => Promise<void>`；
- 实际传输层 `src/main/services/groupChatTransport.ts:275-300` `sendGroupChatMessage()` 已 `return { pinId: result.pinId }`；
- 接线处 `src/main/main.ts:3516-3518`：`await sendGroupChatMessage(...)` 未接收返回值。

**与 issue 正文的差异（已核对）**：issue 正文把「占位消息半状态」列为事实②、基线为 `5026b235`；本任务给定的三条根因中②为「失败也推进游标」，基线 `37ee6e6`。逐行核对后，本任务三条在 37ee6e6 上全部成立（行号 ±1 偏移）。占位问题不在本轮范围（§5.2）。

---

## 2. 修复方案（文件 + 行号 + 改动点 + 理由）

### 2.1 新增 `src/main/services/groupChatOutbox.ts`（新文件，261 行，返工后）

**投递义务表**（模块自持 schema；`ensureGroupChatOutboxSchema()` 幂等建表，orchestrator 每次 tick 首次访问前调用。参照树内 `dreamStore.ts` / `teamCultureStore.ts` 的「store 自持表」先例，不动 `sqliteStore.ts`）：

```sql
CREATE TABLE IF NOT EXISTS group_chat_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metabot_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  trigger_msg_id INTEGER NOT NULL,      -- 触发本次回复的 group_chat_messages.id
  nick_name TEXT,
  content TEXT NOT NULL,                -- 已生成的回复文本（重试原样重发）
  content_hash TEXT,                    -- sha256(groupId + '\n' + content)，留给后续回读确认
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  pin_id TEXT,                          -- 传输层 ACK
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (group_id, metabot_id, trigger_msg_id)   -- 返工 N1：按 (群, bot, 消息) 隔离
);
```

**状态机与常量**（`:35-64`）：

```
PENDING --内联发送成功(拿到 pinId)--> SUBMITTED        （终态；本轮不再回读）
PENDING --内联发送失败-------------> PENDING           （退避，drain 重发）
PENDING --达到重试上限-------------> ABANDONED         （终态；行保留可审计）
```

- `GROUP_CHAT_OUTBOX_BACKOFF_MS = [30s, 60s, 120s, 300s]`（显式常量，不做魔法数字）；
- `GROUP_CHAT_OUTBOX_MAX_ATTEMPTS = 5`（= 1 次内联 + 4 次重试）。

**函数清单**：`ensureGroupChatOutboxSchema(:69)`、`groupChatContentHash(:94)`、`enqueueGroupChatSend(:123)`、`findGroupChatSendByTrigger(:155)`、`listPendingGroupChatSends(:173)`、`lowestPendingTriggerMsgId(:193)`、`markGroupChatSendSubmitted(:207)`、`markGroupChatSendFailed(:222)`。

**关键设计理由**：
1. **先落义务、再发送（persist-then-send）**：即使进程在 INSERT 与广播之间崩溃，重启后 drain 仍能把这条回复发出去——「失败即丢」的第一层保险。
2. **`UNIQUE (group_id, metabot_id, trigger_msg_id)`**（返工 N1 修正；初版为 `(group_id, trigger_msg_id)`）：一条触发消息对**每个 bot** 至多一条义务；同一消息命中同群多个 bot 时各自成行、互不覆盖，`enqueue` / `markSubmitted` 也不会串写他 bot 的义务行。消息被重新选中时，闸门（§2.2）靠它挡住重复 LLM 与重复发送。
3. **重试重发存储文本，而不是重跑 LLM**：失败点在「LLM 之后、发送之中」，重发 `content` 比再次生成更便宜、内容一致、也避免新回复引用的上下文漂移。
4. **`INSERT OR IGNORE` + 回读 id**：防御性幂等，任何重复入队都不会产生第二行。
5. 树内先例对照：`groupTaskDaemon` 的 durable defer queue 在 **turn 层**重试（`tests/groupTaskDaemon.test.mjs` task #64）；本模块在**投递层**重试——因为失败点在生成之后，重发文本是更小的动作单元。

### 2.2 `src/main/services/cognitiveOrchestrator.ts`（+148/-6，返工后实测；首轮实为 +141/-6）

| 位置（改后行号） | 改动 | 对应根因 |
|---|---|---|
| `:141-163` | `BroadcastGroupChatFn` 契约：`Promise<void>` → `Promise<GroupChatBroadcastAck \| void>`（`{ pinId?: string }`）；`ackPinId()` 容错读取（兼容既有返回 void 的 JS 测试替身） | ③ |
| `:616` | `runReplyPipeline()` 新增 `triggerMsgId` 参数（义务表的键） | ①② |
| `:853-885` | 广播前 `enqueueGroupChatSend()` + `saveDb()`；成功 → `markGroupChatSendSubmitted(pin_id=ACK)`；失败 → `markGroupChatSendFailed()` 保留 `pending`/`abandoned` 后返回（替换原 `:818-824` 的「只打日志」） | ①②③ |
| `:892-933` | 新增 `drainPendingGroupChatSends()`：tick 每任务开始时，把 `next_attempt_at` 已到期的 `pending` 行**按存储文本**重新广播；成功 → `submitted`，失败 → 退避/`abandoned` | ① |
| `:997` | tick 读取新消息**之前**先 drain（同群全量扫描，行自包含），返回值 = 本 bot 剩余 `pending` 的最小 `trigger_msg_id`（游标地板） | ①② |
| `:1080-1109` | 触发闸门：若该消息已有**本 bot 的**义务（任意状态）→ 不重跑 LLM（`break`；返工 N1 已按 (群, bot) 隔离，他 bot 的义务不阻塞本 bot）；若存在更老的 `pending` 义务（`msgId > pendingFloor`）→ 延后本条，保持回复顺序 | ①② |
| `:1113-1128` | 游标封顶（替换原无条件 `UPDATE`）：`nextCursor = min(maxProcessedId, max(floor-1, effectiveLastProcessed))` | ② |

**游标语义（根因②的核心）**：

- 广播失败 → 义务 `pending` → 游标钉在 `trigger_msg_id - 1`：该消息下个 tick 仍会被选中，但闸门发现已有义务，**不会重复调用 LLM**；drain 重试用的是存储文本。
- 重试成功（`submitted`）或到达上限（`abandoned`）→ 不再是 `pending` → 游标越过触发消息，后续消息继续处理。
- 地板按 **(group_id, metabot_id)** 过滤：同一群里另一个 bot 任务的 pending 义务不会冻结本任务（专门用例覆盖；返工 N1 后同一触发消息命中双 bot 的场景同样成立，见 §7）。
- `max(floor-1, effectiveLastProcessed)` 保证封顶永不把游标**回退**到已处理位置之前。

### 2.3 `src/main/main.ts:3514-3520`

```ts
async (metabotId, groupId, nickName, content) => {
  // Issue #40: hand the transport ACK (pinId) back to the orchestrator so
  // the outbox can record it instead of discarding the return value.
  return await sendGroupChatMessage(metabotId, groupId, { content, nickName });
},
```

原实现 `await` 后丢弃。传输层内部已有的 `recordOutgoingGroupSend`（进程内发送台账，R4 单发去重）不受影响。

### 2.4 测试与接线

- **新增** `tests/groupChatOutboxDurability.test.mjs`（442 行 / 7 用例，返工后）：用真实 `sql.js` 内存库 + 编译产物 `dist-electron/.../cognitiveOrchestrator.js` 的 `runTickOnce` 注入 mock，覆盖：失败持久化+游标不前进、退避重试（不重跑 LLM）、ACK 落库、重试上限→ABANDONED→游标解封、多 bot 同群互不干扰、**同一触发消息命中同群双 bot 两条回复都要发出（N1 返工新增）、首 bot 失败不得吞掉次 bot 回复也不串写义务行（N1 返工新增）**。
- **适配** `tests/groupChatAllowChatSkillsRuntime.test.mjs:61-65`：该文件的严格 fake DB 遇到未知 SQL 会直接抛错，为 outbox 读取增加「无义务」分支（不改任何断言）。
- **接线** `package.json:36`：`test:group-tasks` 列表追加新测试文件（随 `test:release-regressions` 进入既有回归门）。

---

## 3. 复现 / 验证（可执行命令 + 实测输出）

### 前置（本机一次性）

```bash
cd /Users/wufeng/idbots/project/bots/2/2026-09-22/idbots-bugfix/IDBots/.worktrees/group-broadcast-durability
ln -sfn ../../node_modules node_modules    # worktree 无依赖，软链仓储根
export PATH="/Users/wufeng/idbots/project/bots/2/2026-09-22/idbots-bugfix/tools/node-v24.21.0-darwin-arm64/bin:$PATH"
npm run compile:electron
```

### 「改前能复现、改后不能复现」（同一条命令，真实验证过）

```bash
# ---- 改前（基线行为）：只回退 src/main，测试文件保留 ----
git stash push -u -m "issue40-baseline-repro" -- src/main
npm run compile:electron
node --test tests/groupChatOutboxDurability.test.mjs      # 实测：tests 5 / pass 0 / fail 5

# ---- 恢复修复版 ----
git stash pop && npm run compile:electron
node --test tests/groupChatOutboxDurability.test.mjs      # 实测：tests 5 / pass 5 / fail 0
```

**改前实测输出**（每条失败对应一条根因）：

```
✖ failed broadcast persists a pending obligation and keeps the cursor before the trigger message
  AssertionError: cursor must NOT advance past the trigger message (id 1) while its reply is undelivered
    actual: 1, expected: 0                       ← 根因②：失败仍推进游标
✖ pending obligation is retried with the stored text (no LLM re-run) and releases the cursor after success
    actual: undefined, expected: 'pending'       ← 根因①：失败后没有任何持久记录
✖ successful broadcast records the transport ACK pinId on the obligation
  AssertionError: obligation row must exist      ← 根因③：ACK/义务行不存在
✖ after MAX attempts the obligation is abandoned (terminal) and the cursor unblocks
    actual: 1, expected: 5                       ← 根因①：永不重试（只广播过 1 次）
✖ one bot's pending obligation never pins another bot task's cursor in the same group
    actual: 0, expected: 2                       ← 根因①：无义务表
ℹ tests 5 / pass 0 / fail 5
```

**改后实测输出**：

```
✔ failed broadcast persists a pending obligation and keeps the cursor before the trigger message
✔ pending obligation is retried with the stored text (no LLM re-run) and releases the cursor after success
✔ successful broadcast records the transport ACK pinId on the obligation
✔ after MAX attempts the obligation is abandoned (terminal) and the cursor unblocks
✔ one bot's pending obligation never pins another bot task's cursor in the same group
ℹ tests 5 / pass 5 / fail 0
```

> 返工后同一命令为 **7 条用例**（新增 2 条跨 bot 同触发消息用例）：`ℹ tests 7 / pass 7 / fail 0`，见 §7.2。

### 回归命令

```bash
npm run test:group-tasks                         # 实测 tests 542 / pass 542 / fail 0（含新用例）
npx eslint src/main/services/groupChatOutbox.ts \
           src/main/services/cognitiveOrchestrator.ts src/main/main.ts   # exit 0
node --test tests/cognitiveGroupChatPrompt.test.mjs tests/sleepGuard.test.mjs \
            tests/llmSafeText.test.mjs tests/sqliteRecoveryLifecycle.test.mjs   # 50 pass / 0 fail
```

### 明确「改前改后一致」的既有脚本（避免误伤，本修复无关）

以下两个脚本在基线 37ee6e6 上**本来就失败**；修复前后各跑一次，输出一致（非本修复引入）：

- `node scripts/test_cognitive_phase2.mjs`：脚本内存 schema 缺 `sender_global_metaid` 列（`no such column`），与本修复无关；
- `node scripts/test_cognitive_hook.mjs`：基线即 2 条 `FAIL:`（Cowork skill turn 路径断言）。

---

## 4. 变更文件清单

| 文件 | 类型 | 规模 |
|---|---|---|
| `src/main/services/groupChatOutbox.ts` | 新增 | 261 行（返工后） |
| `src/main/services/cognitiveOrchestrator.ts` | 修改 | **+148 / -6**（返工后实测；复核 N6 更正：首轮提交时实为 +141 / -6，原稿「+147 / -8」有误） |
| `src/main/main.ts` | 修改 | +3 / -1 |
| `tests/groupChatOutboxDurability.test.mjs` | 新增 | 442 行 / **7 用例**（返工新增 2 条） |
| `tests/groupChatAllowChatSkillsRuntime.test.mjs` | 修改 | +5 |
| `.gitignore` | 修改 | +1（N4 白名单 `!tests/groupChatOutboxDurability.test.mjs`） |
| `package.json` | 修改 | 1 行（测试接线） |

> `dist-electron/`（编译产物）与 `node_modules`（软链）均被 `.gitignore` 覆盖，不进入改动集。

---

## 5. 本轮范围与未覆盖项（防范围蔓延）

### 5.1 本轮就做（最小可行修复，均已在 §3 验证）

1. 失败持久化 + 退避重试通道（义务表 + drain，重发存储文本，不重跑 LLM）；
2. 游标只在义务终态后推进（per-bot 地板 + 闸门 + 封顶）；
3. pinId 接住形成 ACK（类型契约 + main.ts 接线 + `pin_id` 落库）；
4. 对应回归用例与 CI 接线；既有编排器用例适配。

### 5.2 建议后续单独处理（不在本轮，需单独评估/单独 PR）

1. **`CONFIRMED` 外部回读**（issue 设计的完整版）：`SUBMITTED` 只证明本机写入；用 pin 回读 / `verifyPinSources`（单源 404 不算不存在）把终态升级为链上确认。**本轮已在表中预留 `pin_id` / `content_hash`**。
2. **重复投递窗口**：`createPin` 已上链但调用抛异常（超时/响应解析失败）时，重试会重复发送。彻底解决依赖第 1 项的读回判据（issue 强调的「冷却期长于实测索引延迟」属于这一层）。
3. **占位消息半状态**（issue 正文事实②）：特权 skill 路径在正文前广播 `copyRespondingPlaceholder()`（改后 `cognitiveOrchestrator.ts:732`，基线为 `:697`），正文失败时链上留半状态；本轮未动。
4. **LLM 失败 / 空回复路径**：无回复内容可投递，消息照旧被消费（基线语义保留）。
5. **可观测性**：`pending/abandoned` 行如何呈现给用户（日志面板 / 群任务视图），以及 ABANDONED 行的保留与清理策略。
6. **其他出站路径加固**：私聊 daemon、`group_chat` 工具内联发送等是否有同类「失败即丢」语义，需各自核对（不在 issue #40 范围）。

---

## 6. 核不了 / 不确定的地方（如实列出）

1. **未做真实链路端到端**：所有验证都在进程内以注入 mock 的 `runTickOnce` 上进行（发送成功 = mock 返回 `{pinId}`）；真实钱包签名、`createPin` 网络行为、索引延迟未验证。
2. **`saveDb()` 落盘时序未单独验证**：按既有 tick 用法接入（每次义务写后调用），store 层的节流/落盘语义未深入核查。
3. **退避常量未经线上实测**：30s/60s/120s/300s 是保守的显式常量；issue 建议对「SUBMITTED 后的确认冷却」用实测值，本轮不涉及该阶段。
4. **进程重启后的 drain 只做了等价推理**：表中行是持久化写入 + 重启后 tick 会按 `pending` 扫描（代码路径已验），但「真实进程崩溃→重启」未实测。
5. **上游方向未确认**：issue 正文提问「方向是否被接受」；本任务禁发公开内容，未回复、未互动。
6. **生产库迁移**：新表由 orchestrator 首次 tick 幂等创建（`CREATE TABLE IF NOT EXISTS`，无 `ALTER`），未在真实用户库上演练（风险低：全新表 + IF NOT EXISTS）。

---

## 附录 A：验收对照

| 验收项 | 证据 |
|---|---|
| 方案文档：文件 + 改动点 + 每处理由 | 本文 §2（每条改动标注对应根因） |
| 改前能复现 / 改后不能复现的可执行命令 | §3 stash 序列；实测 5 fail → 5 pass |
| 处理根因①失败即丢无重试 | §2.1 + §2.2（drain/闸门）；用例 1/2/4 |
| 处理根因②失败也推进游标 | §2.2 游标封顶；用例 1/2/4 |
| 处理根因③pinId 被丢弃 | §2.2 契约 + §2.3；用例 3 |
| 标注本轮 vs 后续 | §5.1 / §5.2 |
| 不碰 main、不 push、改动只在工作树 | 全程 `git status` 仅工作树内文件；`main` worktree 未动；无远端操作 |
| 「已验证 / 待验证」不混说 | §0 两个列表 + §6 |

## 附录 B：运维速查（供评审参考，非本轮交付）

```sql
-- 当前未投递成功的回复（应被 drain 重试）
SELECT id, metabot_id, group_id, trigger_msg_id, state, attempts, last_error, next_attempt_at
  FROM group_chat_outbox WHERE state = 'pending' ORDER BY id;
-- 已本地写入（有 pinId）的回复
SELECT id, trigger_msg_id, attempts, pin_id FROM group_chat_outbox WHERE state = 'submitted';
-- 放弃重试的回复（需人工关注）
SELECT id, trigger_msg_id, attempts, last_error FROM group_chat_outbox WHERE state = 'abandoned';
```

---

## 7. 第二轮复核返工记录（N1 / N4，2026-09-23）

> 复核结论：首轮修复引入一个行为回退 N1（同群双 bot 命中同一触发消息时，第二个 bot 的回复被静默吞掉），
> 且新测试文件被 `.gitignore` 忽略（N4，干净克隆/CI 拉不到）。两项必修项已在本次返工修复并实测。
> N2 / N3 / N5 / N6 本轮不修，状态如实记录于 §7.4（未假装解决）。

### 7.1 N1 根因（已独立复核 + 实测复现）

首轮把「投递义务」的键与回复闸门做成了**群级**，缺 `metabot_id` 维度：

- `groupChatOutbox.ts:87` 唯一约束 `UNIQUE (group_id, trigger_msg_id)`；
- `enqueueGroupChatSend()` 回读 SELECT 同样缺 `metabot_id`；
- `findGroupChatSendByTrigger()` 群级查找 → 编排器闸门（`cognitiveOrchestrator.ts:1085`）在第二个 bot 的 tick 里命中**第一个 bot 的义务行** → `break`：第二条回复既不生成也不发送；
- 游标封顶本就按 (群, bot) 过滤 → 第二个 bot 的游标照常前进 → **静默吞掉**。

**改前实测（probe-crossbot 场景，PRE-FIX build）**：

```text
trigger message : msg id 1 mentions TestBot + OtherBot (same group)
LLM replies generated : 1
broadcast attempts    : [{"metabotId":7,"content":"status ok from bot 1"}]
outbox rows           : [[7,1,"submitted","pin-bot-7"]]
task cursors          : [[7,1],[8,1]]
VERDICT: SECOND BOT REPLY SWALLOWED (N1 reproduces)
```

（bot 8 游标 = 1，但既无 LLM 回复、无广播、也无自己的义务行 —— 与复核实测逐字一致。）

### 7.2 N1 修复与验证

| 位置 | 改动 |
|---|---|
| `groupChatOutbox.ts` schema | `UNIQUE (group_id, metabot_id, trigger_msg_id)`（表随未发布分支引入，无历史数据迁移） |
| `groupChatOutbox.ts` `enqueueGroupChatSend()` | 回读 SELECT 加 `metabot_id`，返回**本 bot** 的义务行 id（不再串写他 bot 行） |
| `groupChatOutbox.ts` `findGroupChatSendByTrigger()` | 签名加 `metabotId`，按三元组查询（闸门按 (群, bot, 消息) 隔离） |
| `cognitiveOrchestrator.ts` 闸门 `:1085` | 传 `task.metabot_id`；注释明确「他 bot 的义务不得阻塞本 bot 的回复」 |
| `drainPendingGroupChatSends()` | 保持群级扫描（每行自包含、各带 `metabot_id`），注释补充「永不串写本 bot 行」 |

**新增 2 条覆盖用例（改前 fail 2 / 改后 pass 2，同一编译基线）**：

```text
改前（首轮构建，即返工前）：
✖ same trigger message reaching two bots in one group delivers BOTH replies (N1 regression)
  AssertionError: each bot runs its own reply pipeline        1 !== 2
✖ a failing first bot never suppresses the second bot's reply nor cross-writes its obligation
  AssertionError: both bots must attempt their own send       1 !== 2
ℹ tests 2 / pass 0 / fail 2

改后（本工作树）：
✔ same trigger message reaching two bots in one group delivers BOTH replies (N1 regression)
✔ a failing first bot never suppresses the second bot's reply nor cross-writes its obligation
ℹ tests 7 / pass 7 / fail 0
```

**改后 probe-crossbot 实测（两场景）**：

```text
=== scenario 1: both bots succeed on the SAME trigger message ===
LLM replies generated : 2
broadcast attempts    : [{"metabotId":7,"content":"reply 1"},{"metabotId":8,"content":"reply 2"}]
outbox rows (bot,msg,state,attempts,pin) : [[7,1,"submitted",1,"pin-bot-7"],[8,1,"submitted",1,"pin-bot-8"]]
task cursors (bot,cursor)                : [[7,1],[8,1]]
=== scenario 2: bot 7 fails, bot 8 must still reply (no cross-write) ===
LLM replies generated : 2
broadcast attempts    : [{"metabotId":7,"content":"reply 1"},{"metabotId":8,"content":"reply 2"}]
outbox rows (bot,msg,state,attempts,pin) : [[7,1,"pending",1,null],[8,1,"submitted",1,"pin-bot-8"]]
task cursors (bot,cursor)                : [[7,0],[8,1]]
```

场景 2 证明：bot 7 失败不影响 bot 8 的回复与记录；bot 7 的 `pin_id` 保持 `null`（未被 bot 8 的 ACK 串写），其游标钉在 0。

### 7.3 N4 修复（测试文件被 gitignore 忽略）

- **改前**：`git check-ignore -v tests/groupChatOutboxDurability.test.mjs` → `.gitignore:57:tests/*`（exit 0）；`git status` 看不到该文件；但 `package.json:36` 的 `test:group-tasks` 已引用它 → 干净克隆/CI 缺文件、`node --test` exit 1。
- **修复（选 a，与仓库 100+ 条同类白名单一致）**：`.gitignore` 新增 `!tests/groupChatOutboxDurability.test.mjs`（放在 `groupChatAllowChatSkillsRuntime` 条目之后，第 116 行）。
- **改后实测**：

```text
$ git check-ignore -v tests/groupChatOutboxDurability.test.mjs
（无输出）exit=1                                # 不再命中忽略规则
$ git check-ignore --no-index -v tests/groupChatOutboxDurability.test.mjs
.gitignore:116:!tests/groupChatOutboxDurability.test.mjs   # 最终生效的是「反忽略」白名单
$ git add tests/groupChatOutboxDurability.test.mjs          # 不加 -f，exit 0（被忽略时该命令会拒绝）
$ git ls-files --error-unmatch tests/groupChatOutboxDurability.test.mjs
tests/groupChatOutboxDurability.test.mjs                    # 已进入 git index
$ git status --short
 M .gitignore
 M package.json
 M src/main/main.ts
 M src/main/services/cognitiveOrchestrator.ts
 M tests/groupChatAllowChatSkillsRuntime.test.mjs
A  tests/groupChatOutboxDurability.test.mjs
?? fix-plan.md
?? src/main/services/groupChatOutbox.ts
```

对照证明 `tests/*` 规则本身未被破坏（同规则下未白名单路径仍被忽略）：
`git check-ignore --no-index -v tests/zzz-not-whitelisted-probe.mjs` → `.gitignore:57:tests/*`。

> 本步禁 push、不创建 commit：测试文件已 `git add`（index 状态 `A`），`.gitignore` 白名单在工作树；
> 后续 commit 步骤一并提交后，干净克隆/CI 即可拉到该文件。**「干净克隆实测」标注为待提交后成立**。

### 7.4 复核 N2 / N3 / N5 / N6 状态（本轮不修，如实记录）

| 项 | 状态 | 说明 |
|---|---|---|
| N2：ABANDONED 后消息永久丢失（退避 30s+60s+120s+300s ≈ 8.5 分钟，无重放路径） | **未修，语义待上游裁决** | ABANDONED 按当前设计是终态；是否引入无限重试 / 人工重放 / 死信告警需 issue 语境下拍板，本轮未改行为。 |
| N3：有界队首阻塞（上界 ≈ 8.5 分钟，无永久死锁）；群任务全停用后 pending 行遗留 | **未修，已知边界（代码确认）** | `tick()` 在 `taskCount === 0` 时提前 `return` → 全部任务停用后 drain 不再运行，pending 行留在表中等待任务重启用；无行为改动。 |
| N5：`main.ts` 的 ACK 接线无测试覆盖（退回基线后套件仍全绿） | **未修，已确认** | 根因③的**生产接线**没有测试护栏；要在 Electron 入口层引入可测接缝，超出本轮最小返工范围。 |
| N6：文档数字与「隔离」表述 | **已更正（文档层）** | 首轮「+147/-8」实为 `cognitiveOrchestrator.ts` **+141/-6**（复核指正正确）；返工后 **+148/-6**（§4 已更正）。「隔离」原对同触发消息不成立（群级键）——本返工后按 (群, bot, 消息) 成立（§7.2 实测）。 |

### 7.5 返工后总体验证（本机实测）

```text
npm run compile:electron                      # exit 0
node --test tests/groupChatOutboxDurability.test.mjs          # 7 / pass 7 / fail 0
npm run test:group-tasks                      # tests 544 / pass 544 / fail 0
node --test tests/cognitiveGroupChatPrompt.test.mjs tests/sleepGuard.test.mjs \
            tests/llmSafeText.test.mjs tests/sqliteRecoveryLifecycle.test.mjs   # 50 / pass 50 / fail 0
node --test tests/groupChatAllowChatSkillsRuntime.test.mjs    # 4 / pass 4 / fail 0
npx eslint src/main/services/groupChatOutbox.ts src/main/services/cognitiveOrchestrator.ts src/main/main.ts  # exit 0
```

**待验证（本机无法验证）**：真实 Electron + 真链路端到端、真实进程崩溃恢复、提交后的干净克隆实测 —— 与 §6 一致，未变化。
