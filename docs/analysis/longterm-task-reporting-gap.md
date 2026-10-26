# 长期任务编排汇报缺失分析

## 问题陈述

在长期任务(Long-term Task)的自主执行过程中,发现编排子任务完成后,Worker Bot 没有及时向委派方(Twin Bot 或原始 session)进行交接和汇报,导致相关工作推进不及时。

## 案例

1. **IDBots://f5ebbc58-8637-485b-b500-4343c77027db**
   - 在发起方 session 中没有看到任何交接内容
   - Worker Bot 完成了工作,但没有在合适的对话中进行汇报跟交接

2. **IDBots://d3832582-e2bc-49a3-9745-7d60211461c6**
   - Worker Bot 输出了交接信息
   - 但没有对来源进行汇报

## 代码分析

### 1. 编排任务(Orchestration)的汇报机制

**文件**: `src/main/services/twinOrchestrationService.ts`

编排任务有完整的汇报机制:

```typescript
// 行452-458: 正常完成时通知 Twin
this.notifyTwinTerminalState(
  task,
  this.deps.orchestrationStore.getAttempt(attempt.id) ?? attempt,
  worker.name,
  'completed',
);

// 行471-478: 失败时通知 Twin
this.notifyTwinTerminalState(
  task,
  this.deps.orchestrationStore.getAttempt(attempt.id) ?? currentAttempt,
  worker.name,
  'failed',
  message,
);
```

`notifyTwinTerminalState` 方法(行208-261)的关键特性:
- 使用 `insertCrossSessionUserMessage` 向 Twin session 插入 ORCH-NOTIFY 消息
- 使用 kv 存储提供幂等性保护(`orch_notify:<taskId>:<attemptId>:<status>`)
- 消息来源是委派 session (`task.sourceSessionId`)
- 目标是 Twin session

### 2. 长期任务(Long-term Task)的委派机制

**文件**: `src/main/longTermTaskStore.ts`

长期任务的子任务生命周期:

```typescript
// 行956-988: beginSubtask - 只更新状态,不创建 session
beginSubtask(subtaskId: string, actor: LongTermActor, channel?: LongTermPreferredChannel | null) {
  // ... 依赖检查 ...
  this.db.run(
    "UPDATE long_term_subtasks SET status = 'in_progress', preferred_channel = ?, ...",
    [channelClause, nowIso(), subtaskId],
  );
  // 将焦点固定到当前子任务
  this.db.run('UPDATE long_term_tasks SET current_subtask_id = ?, updated_at = ? WHERE id = ?', 
    [subtaskId, nowIso(), current.taskId]);
  this.addEvent(current.taskId, subtaskId, 'began', actor, ...);
  // ... 返回更新后的子任务 ...
}

// 行1216-1234: bindSession - 手动绑定 session
bindSession(subtaskId: string, sessionId: string, actor: LongTermActor) {
  // ... 验证 ...
  this.db.run('UPDATE long_term_subtasks SET session_id = ?, session_history_json = ?, updated_at = ? WHERE id = ?', 
    [trimmed, JSON.stringify(history), nowIso(), subtaskId]);
  this.addEvent(current.taskId, subtaskId, 'note', actor, `session bound: ${trimmed}`);
  // ... 返回更新后的子任务 ...
}
```

**文件**: `src/main/libs/longTermTaskAgentTools.ts`

Twin Bot 的工具集中只有 `longterm_delegation_anchor` 用于生成委派上下文:

```typescript
// 行571-589: 生成委派锚点
const delegationAnchor = tool(
  'longterm_delegation_anchor',
  'Build the context anchor block for a delegation brief...',
  { taskId: z.string(), subtaskId: z.string() },
  async (args) => {
    // 返回包含任务上下文的锚点文本块
    return textResult(buildDelegationAnchorBlock(detail, subtask, ...));
  },
);
```

### 3. 关键缺失环节

**问题 1: 委派流程不自动**

长期任务的子任务开始后:
1. `beginSubtask` 只更新状态为 `in_progress`
2. Twin Bot 需要手动:
   - 调用 `idbots_delegate_worker` 创建编排任务
   - 调用 `longterm_delegation_anchor` 获取上下文
   - 将锚点文本加入委派目标
   - 调用 `longterm_subtask_bind_session` 绑定 session

**问题 2: 汇报流程断裂**

当 Worker Bot 完成编排任务后:
1. 编排系统向 Twin session 发送 ORCH-NOTIFY 消息(通过 `notifyTwinTerminalState`)
2. Twin session 收到通知(在哪个 session? 是委派时的 session 还是当前的 session?)
3. **缺失**: Twin Bot 没有机制自动回到长期任务的原始 session 进行汇报
4. **缺失**: 没有触发器让 Twin Bot 知道应该更新长期任务的子任务状态

**问题 3: Session 绑定与通知目标不一致**

- 长期任务绑定的 session ID (`subtask.sessionId`) 是工作 session
- 编排任务的委派来源 session (`task.sourceSessionId`) 是 Twin 的当前 session
- ORCH-NOTIFY 消息发送到的是委派来源 session
- 但这个 session 可能不是长期任务的定义 session (`task.definitionSessionId`)

## 根本原因

1. **责任链断裂**: 编排完成通知到达 Twin session,但 Twin Bot 不知道这个通知对应哪个长期任务的哪个子任务

2. **Session 映射缺失**: 缺少从编排任务到长期任务子任务的反向映射
   - 已有: `longTermTaskStore.findBySessionId(sessionId)` 查找 session 对应的任务
   - 缺少: 从编排任务 ID 查找对应的长期任务子任务

3. **自动化触发缺失**: Twin Bot 收到 ORCH-NOTIFY 后,没有自动化流程:
   - 识别这是长期任务的子任务委派
   - 切换到长期任务的原始 session
   - 更新子任务状态(propose / accept / report)
   - 向长期任务的相关方汇报进展

## 影响范围

### 受影响的流程

1. **delegate_bot channel**: Twin 委派给 Worker Bot
2. **group_task channel**: Twin 创建群组任务
3. **所有通过编排系统执行的长期子任务**

### 表现

- Twin Bot 完成委派但不知道结果
- Worker Bot 的输出留在工作 session,不回流到长期任务
- 长期任务的子任务状态一直是 `in_progress`,从不自动变为 `waiting_owner` 或 `accepted`
- 定义 session 和用户看不到工作进展,除非主动查询编排任务状态

## 解决方案设计(待实现)

### 方案 A: 在编排任务中记录长期任务上下文

1. 在 `orchestration_tasks` 表增加字段:
   ```sql
   ALTER TABLE orchestration_tasks ADD COLUMN longterm_task_id TEXT;
   ALTER TABLE orchestration_tasks ADD COLUMN longterm_subtask_id TEXT;
   ```

2. Twin 委派时自动填充这些字段(在 `twinOrchestrationService.delegateLocalWorker`)

3. `notifyTwinTerminalState` 检查这些字段:
   - 如果有长期任务上下文,额外发送通知到长期任务的定义 session
   - 或者调用长期任务的回调来更新子任务状态

### 方案 B: 通过 session 关联建立映射

1. Worker session 创建时,在元数据中记录长期任务上下文
2. 编排完成时,通过 Worker session 元数据找到长期任务
3. 向长期任务的相关 sessions 发送汇报消息

### 方案 C: 增强 Twin Bot 的 ORCH-NOTIFY 处理

1. Twin Bot 收到 ORCH-NOTIFY 后:
   - 检查当前 session 是否绑定到长期任务子任务
   - 如果是,自动调用 `longterm_subtask_propose` 或更新状态
   - 向长期任务的定义 session 发送进展摘要

2. 在 CoworkRunner 中增加 ORCH-NOTIFY 后处理钩子

## 建议

1. **短期**: 方案 C - 最小侵入,利用现有机制
2. **中期**: 方案 A - 显式关联,清晰可靠
3. **长期**: 完整的委派-汇报追踪系统,支持多级委派链

## 下一步

1. 确认具体案例的 session 关系和编排任务状态
2. 选择解决方案并实现
3. 添加测试覆盖长期任务委派-完成-汇报全流程
