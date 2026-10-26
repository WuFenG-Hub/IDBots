# 方案 A 实现: 长期任务编排汇报修复

## 实现日期
2026-10-26

## 问题陈述
长期任务(Long-term Task)的自主执行过程中,Worker Bot 完成编排子任务后没有及时向委派方和原始 session 进行交接汇报,导致工作推进不及时。

## 解决方案概述
**方案 A: 在编排任务中记录长期任务上下文**

通过在 `orchestration_tasks` 表增加长期任务关联字段,使得编排完成时能够双重汇报:
1. 向 Twin 的委派 session 汇报(现有逻辑)
2. 向长期任务的定义 session 汇报(新增逻辑)

## 代码更改

### 1. 数据库 Schema 扩展

**文件**: `src/main/orchestrationStore.ts`

#### 1.1 类型定义扩展

```typescript
export interface OrchestrationTask {
  // ... 现有字段 ...
  
  /**
   * Long-term task context (方案 A: explicit linkage for reporting back).
   * When set, this orchestration task is executing a slice of that long-term
   * sub-project; on terminal state (completed/failed) the orchestration service
   * reports back to the long-term task's definition session.
   */
  longtermTaskId: string | null;
  longtermSubtaskId: string | null;
  /**
   * The session to report back to when this orchestration completes. Typically
   * the long-term task's definition session, which may differ from both
   * sourceSessionId (Twin's delegation session) and the sub-task's bound
   * session (the work session).
   */
  longtermReportSessionId: string | null;
  
  // ... 其他字段 ...
}
```

```typescript
export interface CreateOrchestrationTaskInput {
  // ... 现有字段 ...
  
  /**
   * Long-term task context (方案 A): when the Twin delegates a slice of a
   * long-term sub-project, these fields link the orchestration back to it.
   */
  longtermTaskId?: string | null;
  longtermSubtaskId?: string | null;
  longtermReportSessionId?: string | null;
}
```

#### 1.2 数据库迁移

在 `ensureTables()` 方法中添加幂等式列迁移:

```typescript
private ensureTables(): void {
  // ... 现有表创建 ...
  
  // 方案 A: additive migration for long-term task linkage columns (idempotent).
  const taskColumns = this.getAll<{ name: unknown }>('PRAGMA table_info(orchestration_tasks)').map((row) => String(row.name));
  if (!taskColumns.includes('longterm_task_id')) {
    this.db.run('ALTER TABLE orchestration_tasks ADD COLUMN longterm_task_id TEXT');
  }
  if (!taskColumns.includes('longterm_subtask_id')) {
    this.db.run('ALTER TABLE orchestration_tasks ADD COLUMN longterm_subtask_id TEXT');
  }
  if (!taskColumns.includes('longterm_report_session_id')) {
    this.db.run('ALTER TABLE orchestration_tasks ADD COLUMN longterm_report_session_id TEXT');
  }
  this.saveDb();
}
```

#### 1.3 Row 映射更新

```typescript
function taskFromRow(row: Row): OrchestrationTask {
  return {
    // ... 现有字段映射 ...
    longtermTaskId: row.longterm_task_id == null ? null : String(row.longterm_task_id),
    longtermSubtaskId: row.longterm_subtask_id == null ? null : String(row.longterm_subtask_id),
    longtermReportSessionId: row.longterm_report_session_id == null ? null : String(row.longterm_report_session_id),
    // ... 其他字段 ...
  };
}
```

#### 1.4 创建任务更新

```typescript
createTask(input: CreateOrchestrationTaskInput): OrchestrationTask {
  const id = uuidv4();
  const now = new Date().toISOString();
  this.db.run(`INSERT INTO orchestration_tasks
    (..., longterm_task_id, longterm_subtask_id, longterm_report_session_id, ...)
    VALUES (..., ?, ?, ?, ...)`, [
    // ... 现有值 ...
    input.longtermTaskId ?? null,
    input.longtermSubtaskId ?? null,
    input.longtermReportSessionId ?? null,
    // ... 其他值 ...
  ]);
  this.saveDb();
  return this.getTask(id)!;
}
```

### 2. Twin 委派逻辑扩展

**文件**: `src/main/services/twinOrchestrationService.ts`

#### 2.1 委派时填充长期任务上下文

在 `delegateLocalWorker` 方法中:

```typescript
async delegateLocalWorker(sourceSessionId: string, input: DelegateLocalWorkerInput): Promise<DelegateLocalWorkerResult> {
  // ... 现有验证逻辑 ...
  
  // 方案 A: extract long-term task context from the source session if present.
  // When the Twin delegates from a session bound to a long-term sub-project,
  // the orchestration task inherits that linkage so terminal-state notifications
  // can report back to the long-term task's definition session.
  let longtermContext: { taskId: string; subtaskId: string; reportSessionId: string } | null = null;
  const ltStore = this.deps.longTermTaskStore?.();
  if (ltStore) {
    const hit = ltStore.findBySessionId(sourceSessionId);
    if (hit?.subtask) {
      // findBySessionId returns a summary; read the detail to get definitionSessionId.
      const detail = ltStore.getTask(hit.task.id);
      longtermContext = {
        taskId: hit.task.id,
        subtaskId: hit.subtask.id,
        // Report to the long-term task's definition session (where the owner
        // and Twin converse about this task), NOT the sub-task's bound session
        // (the work session, which may differ).
        reportSessionId: detail?.definitionSessionId ?? sourceSessionId,
      };
    }
  }
  
  // ... 幂等性检查 ...
  
  if (!task) {
    task = this.deps.orchestrationStore.createTask({
      // ... 现有字段 ...
      // 方案 A: wire the long-term task linkage into the orchestration ledger.
      longtermTaskId: longtermContext?.taskId ?? null,
      longtermSubtaskId: longtermContext?.subtaskId ?? null,
      longtermReportSessionId: longtermContext?.reportSessionId ?? null,
    });
  }
  
  // ... 创建 step 和 attempt ...
}
```

#### 2.2 完成时双重汇报

在 `notifyTwinTerminalState` 方法中:

```typescript
private notifyTwinTerminalState(
  task: OrchestrationTask,
  attempt: OrchestrationAttempt,
  workerName: string,
  outcome: 'completed' | 'failed',
  detail?: string | null,
): void {
  try {
    // ... 现有 Twin session 通知逻辑 ...
    
    // 方案 A: secondary notification to the long-term task's definition session.
    // When the orchestration task carries long-term linkage AND the report
    // session differs from the delegation session, send a second notification
    // so the owner/Twin conversation about the long-term task sees the progress.
    if (task.longtermReportSessionId && task.longtermReportSessionId !== targetSessionId) {
      const ltResult = this.insertCrossSession({
        sourceSessionId: workerSessionId,
        targetSessionId: task.longtermReportSessionId,
        message: `📋 长期任务子项进展汇报\n\n${text}\n\n（此汇报来自编排任务 ${task.id}，对应长期任务 ${task.longtermTaskId} 的子项 ${task.longtermSubtaskId}）`,
      });
      if ('code' in ltResult) {
        console.warn(
          `[TwinOrchestration] Long-term report notification failed (${task.id} → ${task.longtermReportSessionId}): ` +
          `${ltResult.code} ${ltResult.message}`
        );
      } else {
        console.log(
          `[TwinOrchestration] Long-term task notified (${task.id} → ${task.longtermReportSessionId}): ` +
          `subtask ${task.longtermSubtaskId} ${outcome}`
        );
      }
    }
  } catch (error) {
    console.warn(
      `[TwinOrchestration] Twin notification failed: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

## 数据流图

### 委派阶段

```
长期任务定义 session (A)
  │ 用户与 Twin 讨论任务
  └─> Twin 创建长期任务
  
Twin 工作 session (B)
  │ Twin 决定委派某个子任务给 Worker
  │ 调用 delegateLocalWorker(sessionB, ...)
  │
  ├─> longTermTaskStore.findBySessionId(sessionB)
  │   └─> 发现 sessionB 绑定到长期任务 taskA 的子任务 subtaskX
  │
  ├─> longTermTaskStore.getTask(taskA)
  │   └─> 获取 definitionSessionId = sessionA
  │
  └─> orchestrationStore.createTask({
        sourceSessionId: sessionB,           # Twin 的委派 session
        longtermTaskId: taskA,               # 长期任务 ID
        longtermSubtaskId: subtaskX,         # 子任务 ID
        longtermReportSessionId: sessionA,   # 定义 session (汇报目标)
      })
  
Worker 工作 session (C)
  │ Worker Bot 执行任务
  └─> 完成
```

### 完成汇报阶段

```
编排完成
  │
  └─> notifyTwinTerminalState(task, attempt, ...)
        │
        ├─> 主要通知: Twin session (B)
        │   insertCrossSession(
        │     source: workerSessionC,
        │     target: sessionB,
        │     message: "Worker 完成了任务..."
        │   )
        │
        └─> 次要通知: 长期任务定义 session (A)
            if task.longtermReportSessionId && task.longtermReportSessionId !== sessionB:
              insertCrossSession(
                source: workerSessionC,
                target: sessionA,                      # 定义 session
                message: "📋 长期任务子项进展汇报..."
              )
```

## 关键设计决策

### 1. 为什么不直接使用 sourceSessionId?

- `sourceSessionId` 是 Twin 的当前委派 session (B)
- 长期任务的定义 session (A) 是用户与 Twin 讨论整个任务的地方
- 用户期望在 session A 中看到所有子任务的进展
- Twin 可能在多个 session 中委派不同的子任务

### 2. 为什么不使用 subtask.sessionId?

- `subtask.sessionId` 是子任务绑定的工作 session
- 可能是专门为某个子任务创建的临时 session
- 也可能 Twin 从未显式绑定 session
- 汇报应该回到用户熟悉的主 session

### 3. 幂等性保护

- 现有的 `orch_notify:<taskId>:<attemptId>:<outcome>` guard 已经保护主通知
- 次要通知共享相同的 guard key,避免重复
- Late completion 路径也受保护

## 迁移安全性

### 向后兼容

1. **新增列默认为 NULL**:
   - 所有现有的编排任务记录保持不变
   - 新列为 NULL 时,次要通知逻辑自动跳过

2. **幂等式迁移**:
   - 使用 `PRAGMA table_info` 检查列是否存在
   - 只在列不存在时执行 ALTER TABLE
   - 多次运行 `ensureTables()` 安全

3. **降级兼容**:
   - 如果代码回滚,新列保持在数据库中但被忽略
   - 不影响旧代码的正常运行

### 性能影响

- **读取**: 每次 `taskFromRow` 多读取 3 个字段 (可忽略)
- **写入**: 每次创建编排任务多写入 3 个字段 (可忽略)
- **查询**: 无新索引需求,无查询路径变化

## 测试建议

### 单元测试

1. **OrchestrationStore**:
   - `createTask` 正确保存长期任务上下文
   - `taskFromRow` 正确映射新字段
   - `ensureTables` 幂等式迁移

2. **TwinOrchestrationService**:
   - `delegateLocalWorker` 提取长期任务上下文
   - `notifyTwinTerminalState` 双重汇报逻辑

### 集成测试

1. **端到端流程**:
   - 创建长期任务
   - Twin 从定义 session 委派子任务
   - Worker 完成
   - 验证两个 session 都收到通知

2. **边界情况**:
   - 非长期任务委派(无次要通知)
   - 定义 session 与委派 session 相同(无重复通知)
   - 长期任务存储不可用(降级为现有行为)

## 未来扩展

### 潜在改进

1. **中文/英文通知模板**:
   - 根据用户语言选择通知文本
   - 当前硬编码中文

2. **汇报格式增强**:
   - 包含子任务标题
   - 包含验收标准完成情况
   - 包含 Worker 的工作摘要

3. **多级委派链支持**:
   - 如果 Worker 又委派给其他 Worker
   - 汇报链路传递

## 部署清单

- [x] 数据库 schema 扩展(幂等式迁移)
- [x] 类型定义更新
- [x] 委派逻辑扩展
- [x] 汇报逻辑扩展
- [x] 编译验证通过
- [ ] 单元测试
- [ ] 集成测试
- [ ] 手动测试验证
- [ ] 文档更新

## 参考文档

- 问题分析: `docs/analysis/longterm-task-reporting-gap.md`
- 长期任务设计: `docs/design/long-term-task-redesign-plan.md`
