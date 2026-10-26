# 方案 A 实现总结

## 问题

长期任务的自主执行中，Worker Bot 完成编排子任务后没有及时向委派方和原始 session 汇报，导致：
- 用户在长期任务的定义 session 中看不到进展
- Twin Bot 需要主动轮询或等待心跳才能知道子任务完成
- 工作循环不闭合，影响自主任务的推进效率

## 解决方案

**方案 A: 在编排任务中记录长期任务上下文，实现双重汇报**

### 核心变更

1. **数据库 Schema 扩展** (`orchestrationStore.ts`):
   - 新增 3 个可选列: `longterm_task_id`, `longterm_subtask_id`, `longterm_report_session_id`
   - 幂等式迁移，向后兼容

2. **委派时自动填充上下文** (`twinOrchestrationService.ts`):
   - Twin 委派时检查 sourceSessionId 是否绑定到长期任务
   - 如果是，提取长期任务信息并保存到编排任务记录

3. **完成时双重汇报** (`twinOrchestrationService.ts`):
   - 保持现有的向 Twin 委派 session 汇报
   - 新增向长期任务定义 session 汇报（仅当定义 session ≠ 委派 session）

## 文件修改清单

### 主要代码修改

1. `src/main/orchestrationStore.ts`:
   - 类型定义: `OrchestrationTask`, `CreateOrchestrationTaskInput`
   - 数据库迁移: `ensureTables()` 中的列添加逻辑
   - Row 映射: `taskFromRow()` 新字段映射
   - 创建逻辑: `createTask()` 新字段保存

2. `src/main/services/twinOrchestrationService.ts`:
   - 委派逻辑: `delegateLocalWorker()` 提取长期任务上下文
   - 汇报逻辑: `notifyTwinTerminalState()` 双重汇报实现

### 文档

3. `docs/analysis/longterm-task-reporting-gap.md`: 问题分析
4. `docs/implementation/longterm-task-reporting-solution-a.md`: 详细实现文档

### 测试

5. `tests/longterm-orchestration-reporting.test.mjs`: 单元测试（6 个测试用例全部通过）

## 验证结果

### 编译验证

```bash
npm run compile:electron
# ✓ 通过，0 错误
```

### 测试验证

```bash
node --test tests/longterm-orchestration-reporting.test.mjs
# ✓ 6 个测试全部通过
```

### Lint 验证

```bash
npm run lint
# ✓ 通过，0 警告
```

## 数据流演示

### 委派阶段

```
长期任务定义 session (A) "我要做这个项目"
  │
  └─> Twin 创建长期任务，规划子任务
  
Twin 工作 session (B) "执行子任务 1"
  │ sourceSessionId = B
  │
  ├─> longTermTaskStore.findBySessionId(B)
  │   └─> 发现绑定: taskId=ltt_main, subtaskId=lts_sub1
  │
  ├─> longTermTaskStore.getTask(ltt_main)
  │   └─> 获取 definitionSessionId = A
  │
  └─> orchestrationStore.createTask({
        sourceSessionId: B,                # Twin 委派 session
        longtermTaskId: ltt_main,          # 长期任务 ID
        longtermSubtaskId: lts_sub1,       # 子任务 ID  
        longtermReportSessionId: A,        # 定义 session
      })
  
Worker 工作 session (C)
  └─> 执行任务...
```

### 汇报阶段

```
Worker 完成
  │
  └─> notifyTwinTerminalState(task, attempt, ...)
        │
        ├─> 主要通知: session B (Twin 委派 session)
        │   insertCrossSession(
        │     source: C,
        │     target: B,
        │     message: "[ORCH-NOTIFY] Worker 完成了..."
        │   )
        │
        └─> 次要通知: session A (长期任务定义 session)
            if longtermReportSessionId && longtermReportSessionId !== B:
              insertCrossSession(
                source: C,
                target: A,
                message: "📋 长期任务子项进展汇报..."
              )
```

## 关键设计决策

### 1. 为什么不复用 sourceSessionId？

- `sourceSessionId` 是 Twin 的当前委派 session (B)
- 用户期望在定义 session (A) 看到进展
- Twin 可能在不同 session 中委派不同子任务

### 2. 为什么不使用 subtask.sessionId？

- `subtask.sessionId` 是子任务的工作 session
- 可能是临时 session，用户不熟悉
- 汇报应该回到用户的主对话

### 3. 向后兼容性

- 新列默认 NULL，现有记录不受影响
- 无长期任务上下文时，次要通知自动跳过
- 代码回滚时，新列被忽略但不影响功能

### 4. 幂等性保护

- 现有的 `orch_notify:<taskId>:<attemptId>:<outcome>` guard 保护两次通知
- 重试和延迟完成不会重复汇报

## 后续工作

### 必需

- [ ] 手动测试完整流程
- [ ] 观察生产环境日志
- [ ] 确认汇报消息格式符合用户预期

### 可选改进

- [ ] 支持中英文通知模板
- [ ] 汇报消息包含更多上下文（子任务标题、验收标准等）
- [ ] 支持多级委派链的汇报传递

## 部署注意事项

1. **数据库迁移**: 自动幂等式迁移，无需手动干预
2. **回滚安全**: 代码回滚时新列被忽略，不影响现有功能
3. **性能影响**: 可忽略（每次委派多读 1 次 longTermTaskStore，多写 3 个字段）

## 验收标准

- [x] 编译通过，0 错误
- [x] 测试通过，6/6 个测试用例
- [x] Lint 通过，0 警告
- [ ] 手动测试: 创建长期任务 → Twin 委派子任务 → Worker 完成 → 定义 session 收到汇报
- [ ] 观察日志: 次要通知成功发送，目标 session 正确

## 提交信息

```
feat: 长期任务编排双重汇报机制（方案 A）

问题:
- Worker Bot 完成编排子任务后，长期任务的定义 session 看不到进展
- Twin Bot 需要主动轮询才能知道子任务完成
- 工作循环不闭合，影响自主任务推进效率

解决方案:
- 在编排任务中记录长期任务上下文（taskId, subtaskId, reportSessionId）
- Twin 委派时自动提取并保存长期任务关联
- 完成时双重汇报: Twin 委派 session + 长期任务定义 session

变更:
- orchestrationStore: 新增 3 个可选列，幂等式迁移
- twinOrchestrationService: 委派时填充上下文，完成时双重汇报
- tests: 新增 6 个单元测试，全部通过

向后兼容:
- 新列默认 NULL，现有记录不受影响
- 无长期任务上下文时，次要通知自动跳过
- 代码回滚时，新列被忽略但不影响功能

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```
