# Known Issues Log (已知问题登记簿)

> 用途：逐条登记 Twin Bot / IDBots 使用过程中发现的可疑或确认问题。
> 每条含：症状、复现、影响、状态、根因（待查/已定位）。
> 维护：AI_Sunny (Twin)。持续累积，不复用旧条目。
>
> **处置策略（2026-08-16 定，两条线）**：
> 1. **常规迭代线（小功能/使用体验类）**：对 IDBots 的小功能、使用体验等层面的正常迭代修改 → 可直接转发给 Builder阿码 修复。
> 2. **DSH 内核线（大模块替换/系统性优化）**：DSH 这个较大模块的替换、系统性优化与迭代开发 → 由相关**外部专门开发 session** 处理，**不转给 Builder阿码**。
>
> **发现即登记的通用原则（2026-08-16 定）**：后续使用中，凡发现「不对劲 / 与以前不一样 / 不符合预期」的现象，先用 DS 视角初步判断是否可能由 DSH 内核引起，无论是否确认，一律先记入本簿。

---

## 问题 1 — 插话（Steer）功能本次失效，无法打断当前一轮

- **登记日期**：2026-08-16
- **登记人**：AI_Sunny（依据 Owner 反馈）
- **严重度**：高（影响协作实时性）
- **分类**：DSH 内核线 · 待专门开发 session 处理（不转阿码）
- **状态**：登记完成，待专门 dev session 解决

### 症状
Owner 在对话过程中插入一条新的指令（插话/steer），但 Twin 侧**在当前这一轮内收不到**，要等**整一轮结束后**才收到这条插话。表现为 steer 无法及时打断正在进行的那一轮处理。

### 复现
- Owner 描述："刚才我就插话了，但你这边收不到，要等你整一轮结束了才收到这个插话功能。"
- 复现条件：上一轮 Twin 尚在处理中时，Owner 发起插话。

### 关键背景：「之前是可以的」
Owner 明确指出该功能**之前正常**，本次修改后失效。这意味着**极可能是本次改动/构建引入了回归**，而非长期存在的已知缺陷。需要与「新建任务快捷入口重构」之外的近期改动做排查对照。

### 影响
- Owner 无法在 Twin 处理过程中实时纠偏或追加意图；
- 打断需要等待，协作节奏被破坏；
- 与 Twin 的核心差异化（实时在场、即时响应）冲突。

### 根因排查（已定位代码路径，runtime 端待一手证实）
**已证实的源码事实（IDBots 仓库内）：**
1. 当前 Twin（AI_Sunny）跑在 **DSH-kernel** 上。coworkRunner 中 steer 分两条路径：
   - **DSH 路径**（executionMode=local 且命中 `dshActiveTurns`）→ `trySubmitSteer` 走 `hub.steer()` → `kernel.steer()` → 调 runtime 的 `session/steer` 端点（coworkRunner.ts:1837-1843, coworkDshTurn.ts:199-204, dshKernel.ts:170-176）。
   - 本地（非 DSH）路径 → 有 `interruptLocalTurnForSteers` 即时打断机制（coworkRunner.ts:1794-1823）。
2. **coworkRunner.ts:1835 注释明确：DSH 路径「no channel and no interrupt-on-steer」**，steer 靠 DSH runtime 的 **step boundary** 交付。即插话在 DSH 路径上不是即时打断，而是等 runtime 下一次 step 边界才注入。
3. 若 DSH 当前 turn 的 step 间隙很长（大量工具调用 + 长生成），插话就会延迟到当前 turn 结束才送达 —— **与观测症状吻合**。

**推断但尚未一手证实的部分**：DSH runtime（deepseek-harness）端 `session/steer` 的具体交付时机（是否仅在下一次 generate-step 完成后注入）。该实现在仓库外，需要 runtime 侧日志或源码证实。

**关键未解问题（与「之前都可以」的口径对照）**：DSH 架构非今日引入，为何此前 steer 看起来正常、这次失效？可能是(a)本次改动改变了 turn/step 结构或 steer 调用时机；(b)runtime 侧行为变化；(c)运行环境/网络延迟。**尚未定位到具体回归 commit**，需对照 cowork.log / runtime 日志。

### 状态
- 登记中（根因方向清晰，回归点未定位）
- 待办：查 cowork.log 中本次会话 steer 的接受时间戳与送达时间戳；确认是不是收到了但排在 step 边界后；对照最近改动是否有影响 turn 结构的 commit。

### 一手验证记录（2026-08-16, AI_Sunny）
- `cowork.log` 与 `cowork.log.old` 中 grep `steer` 均无结果。主机侧 DSH steer 路径默认不打日志（`hub.steer()` 走 `.catch(()=>undefined)`、`notifySteerDelivered` 无日志），因此**无法从现有日志独立证实「送达时机」或「是否进入通道」**。
- **如实标注**：以下为「未独立验证」部分——已确认代码路径（DSH step-boundary steer、无 interrupt），但 runtime 端（deepseek-harness `session/steer`）的确切交付时机与本轮是否延迟，未能从日志一手证实。需要 runtime 日志/源码或再触发一次插话、配合抓取送达时间，才能闭环。
- **处置决定（Owner, 2026-08-16）**：不再深挖，现象记下来即可。此问题属于 DSH 系统性/跨会话问题，后续由专门开发 session 依次解决，不转给 Builder阿码。

---

## 问题 2 — worker 会话被并发启动的 electron:dev 实例重置中断（RECOVERED_AFTER_RESTART）

- **登记日期**：2026-08-17 (跨夜)
- **登记人**：AI_Sunny（依据进程实查 + 会话快照 + twin_task_status 实证）
- **严重度**：中高（中断自动化交付，留下半成品现场）
- **分类**：~~DSH 内核线~~ → **环境/流程线**（根因是并发启动未隔离 dev 实例，非 DSH 内核 bug；DSH 为恢复中断的执行载体）
- **状态**：根因已定位，登记供后续规避；待 Owner 确认是否计入 DSH 排查清单

### 症状
Builder阿码 处理「快捷入口重构」单（task e15778fe）时，会话在执行到**最后一步**——「清理 harness 临时目录 + 验证 working tree clean」——时中断。会话停在一条已发起但未返回结果的 bash（`rm -rf qa-render-tmp && git status...`）调用处，呈 idle 卡住状态。

### 实测取证（2026-08-17, AI_Sunny）
- twin_task_status 显示 attempt `status=failed`，error=`RECOVERED_AFTER_RESTART`（runtime 重启导致恢复中断），step 回到 `ready` 待重试。
- worktree `feat/quick-actions-revamp` 实查：`qa-render-tmp/` **残留未删除**（含 entry-bottom.mjs / entry-panels.mjs），`git status` 显示其为未跟踪文件（非 clean）。

### 根因定位（2026-08-17 补, 一手实证）
**直接触发点不是 DSH runtime 崩溃，而是「并发启动的第二个 Electron dev 实例」挤压导致会话状态被重置为 recovered：**
- 进程实查：`08-17 00:19:47` 拉起 `electron:dev`（`concurrently vite :5175 … start:electron`），用的是**默认 user-data**（`/Users/tusm/Library/Application Support/IDBots`）+ `IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK=1`，即**未隔离数据目录**的开发实例，直接占用了主应用运行环境。
- 该 dev 实例启动时主进程侧触发 SDK 预热（日志 00:19:50 prewarmClaudeSdk / loadClaudeSdk）。
- 同一时刻（00:19:54）正在进行的阿码 attempt 被判定 `RECOVERED_AFTER_RESTART`。
- 阿码工作窗口（14:40Z-16:19Z = 本地 22:40-00:19）内 cowork.log **无任何 DSH runtime exited / ERROR** —— 证明不是 DSH turn 运行时崩溃。

**结论**：这是「用 `electron:dev`（未隔离 user-data）并发启动开发实例，干扰了正在运行的 worker 会话」导致，DSH 是被恢复中断的执行载体，而非 DSH 内核自身 bug。规范做法应是用 `electron:dev:fresh`（带隔离 user-data）预览。

### 关键背景（区分「完成」与「未完成」）
- **阿码在中断前已完成**：AC1-AC5（配置 JSON 解析 / i18n 全覆盖 / skill 引用真实 / 无残留旧引用 / tsc 通过）全部通过；AC6-AC7 用真实组件源码 + 真实图标 + 真实配置跑的 render/behavior harness 输出 `HARNESS_OK`（16 项 skill 解析全符合 SDD §4.2、4 个面板渲染全对、16 项点击行为全对）——这些证据在会话快照中可查。
- **阿码在中断时未完成**：清理临时目录、验证 tree clean、产出 handoff 报告。因此**该单不能按「已完成」闭环**（无 handoff 交付报告，且现场有残留）。

### 影响
- 该单停留在待重试（ready）状态，缺正式交付报告；
- worktree 残留未跟踪临时文件；
- 若多次出现「完成主体工作后、收尾/报告前被 runtime 中断」，属于 DSH 内核层的可靠性问题。

### 处置
- 现象已记入本簿（首次根因：并发 dev 实例导致 RECOVERED_AFTER_RESTART）。
- 已重试派发阿码（attempt f2c36b4b）接续收尾。
- **重试观察（2026-08-17 00:35）**：重试后阿码再次卡在**同一条** `rm -rf qa-render-tmp` 删除命令上（00:29 发起，至 00:35 仍未返回），无 restart，**与首次卡点完全一致**。这表明除「并发 dev 实例重启」外，还存在更根本的「worker 删除权限确认卡死」问题 → 单独立为 **问题 3**。

---

## 问题 3 — worker 会话删除操作卡在权限确认（无人可点删除确认框）

- **登记日期**：2026-08-17
- **登记人**：AI_Sunny（源码实证 + 会话快照观测）
- **严重度**：高（worker 收尾的删除动作必然卡死，影响所有需清临时文件的 worker 任务）
- **分类**：DSH 内核线 / 权限链路

### 症状
后台 worker 会话（Builder阿码）在执行删除（`rm -rf ...`）时，bash 工具的 result **永不返回**，会话永久卡在该删除调用上（观测已超 6 分钟+）。两次独立执行、卡在同一条删除命令上。

### 根因（源码实证）
`evaluateDshToolPolicy`（coworkRunner.ts:6333-6342）：
- 任何删除操作（`isDeleteOperation` 命中）**强制返回 `decision:'ask'`**，reason「删除必须人工确认」，**且不受 bypassPermissions/full-trust 豁免**（与 memory 中「删除确认框不放行」认知一致）。
- 该 `ask` 经 DSH runtime `onPolicyRequest`（coworkDshTurn.ts:368-377）→ `respondPolicy('ask')` → **删除 bash 被阻塞，等待人工确认**。
- 确认需渲染层 `CoworkPermissionModal` 经 `emit('permissionRequest', sessionId, ...)` 弹出、由人类点「允许」才 `respondPolicy('allow')`。

### 为何卡死（推断方向，逻辑高度成立）
- 阿码是**后台 worker 编排会话**，其删除确认框基于 `sessionId` 路由；若确认框没有人类在对应后台会话界面点击（或 owner 未看到该 modal），`respondPolicy` 永不返回 `allow/deny` → 删除 bash 永久 pending → 会话卡死。
- 虽有 `PERMISSION_RESPONSE_TIMEOUT_MS = 60_000` 超时（coworkRunner.ts:10432），但**实测卡超 60s 仍未恢复**，说明删除的 onPolicyRequest 路径可能不走该 pendingPermissions/finalize 超时线，或超时 deny 未正确回传给删除请求。

### 影响
- 任何 worker 会话在收尾/清理阶段触发删除操作即会卡死，无法产出交付报告；
- 直接影响「清理临时目录 → worktree clean」这类标准收尾。

### 待确认（未一手验证的粒度）
- worker 会话的删除确认框是否真的「无人可点」（vs owner 会在主界面看到）；
- 60s 权限超时为何未让删除恢复；
- 是否应豁免「删除**本项目 worktree 内自建临时文件**」这类低风险删除，或给 worker 会话提供自动确认/deny 策略。

### 处置
- 现象已记入本簿，属 DSH 内核/权限链路问题，走专门开发 session 解决（不转阿码）。
- **立即可行的绕过**：下一次如需清理 worker 临时目录，可由 Twin（我，人工确认通道可用）代为执行删除，或 owner 在主界面确认弹窗，而非让 worker 的删除卡死。

---

## 问题 4 — 已取消的 worker 会话在 UI 仍显示 running/卡住，易误判为再次卡死

- **登记日期**：2026-08-17
- **登记人**：AI_Sunny（Owner 反馈 + 会话快照实证）
- **严重度**：低（体验/状态展示问题，不影响执行，但误导排查判断）
- **分类**：DSH 整合线（Owner 确认：之前没有，DSH 整合后出现）

### 症状
被 `twin_task_cancel` 取消的 worker 会话（如 `67f02646-...`）在 UI 中**仍显示 running / 停在卡住的删除步骤**，没有明确标注「已取消」。Owner 因此误以为 worker「又执行删除又卡死」，实际该 attempt 已作废、无活跃进程、卡死动作不再执行。

### 实测取证
- `67f02646` 会话记录：`status: running`、最后消息停在 00:29 的 `rm -rf`，updatedAt 不再变化。
- 但 `ps` 查无该会话的活跃进程；其所属任务 `e15778fe` 已被 `twin_task_cancel` 置为 `cancelled`。
- worktree 实测 clean（qa-render-tmp 已删），`67f02646` 残留的删除并未实际执行。

### 结论
已取消/已作废的 worker 会话在 UI 未正确反映「已取消」终止态，仍呈现 running + 卡住，误导 Owner 判断。属 DSH 编排层的状态展示缺陷。

### 处置
- 已记入本簿，DSH 整合线，随专门开发 session 一并解决（不转阿码）。
- 登记时证据已留档（会话 id + 任务 cancel 状态 + worktree clean 实测）。

---

## 问题 5 — Twin 缺少「停止/管理任意 worker 会话」的能力（产品需求）

- **登记日期**：2026-08-17
- **登记人**：AI_Sunny（Owner 明确提出）
- **严重度**：中（能力缺失，导致卡死会话只能靠 owner 手动停止）
- **分类**：产品设计需求 · DSH/编排层（供外部开发 session 一并实现）

### 需求
从**产品设计角度**，Twin（我）作为编排者**应当具备停止任意 worker 会话的能力**（不只是能 cancel 任务、还应当能终止/停止对应 worker 的会话使其状态落定）。当前我**没有该工具**，卡死的 worker 会话只能由 owner 在 UI 手动点「停止」，Twin 无法自主处置。

### 现状实证
- 本次 `67f02646` 卡死于「删除 approval/asked 未答复」，任务已 cancel 但会话仍显 running（问题 3/4）。
- 我没有暴露的「回答 approval」「关闭/停止指定 worker 会话」接口，只能依靠 owner 在 UI 停止（owner 已于 00:52 手动停止）。
- `respondApproval(id, outcome)` / 会话 `stop` 均为内部 API，无 Twin 可用路由。

### 期望能力（给外部 dev session 的参考）
- Twin 应有「终止/停止指定 worker 会话」并让其 UI 状态落定（不再显示卡死 running）的能力；
- 停止后应自动取消该会话挂起的 approval/tool call，避免永久挂起；
- 或提供「Twin 应答 worker 删除确认」的受控通道（与问题 3 一并考虑：后台 worker 会话的删除确认需有自动/受管策略）。

### 处置
- 已记入本簿，产品/编排线，随专门开发 session 一并实现（不转阿码）。

---

<!-- 后续问题在此追加 -->
## 问题 6 · 保留位
