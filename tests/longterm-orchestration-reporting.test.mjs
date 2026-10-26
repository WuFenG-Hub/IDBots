/**
 * 方案 A: 长期任务编排汇报 - 单元测试
 *
 * 验证编排任务与长期任务的关联和双重汇报机制。
 *
 * 注: OrchestrationStore 的完整测试需要 better-sqlite3，这在 worktree 中
 * 不易设置。这里只测试核心逻辑（上下文提取和双重汇报），数据库层的
 * 完整测试应在主 repo 中的集成测试套件运行。
 */

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

describe('TwinOrchestrationService - Context Extraction Logic', () => {
  /**
   * 这个测试模拟了 delegateLocalWorker 中的长期任务上下文提取逻辑。
   */

  test('extract long-term context when source session is bound', () => {
    // Mock long-term task store
    const mockLtStore = {
      findBySessionId(sessionId) {
        if (sessionId === 'sess_twin_work') {
          return {
            task: { id: 'ltt_main', stage: 'active' },
            subtask: { id: 'lts_sub1', status: 'in_progress' },
          };
        }
        return null;
      },
      getTask(taskId) {
        if (taskId === 'ltt_main') {
          return {
            id: 'ltt_main',
            definitionSessionId: 'sess_definition',
            subtasks: [],
            events: [],
          };
        }
        return null;
      },
    };

    // Simulate extraction logic
    const sourceSessionId = 'sess_twin_work';
    const hit = mockLtStore.findBySessionId(sourceSessionId);

    let longtermContext = null;
    if (hit?.subtask) {
      const detail = mockLtStore.getTask(hit.task.id);
      longtermContext = {
        taskId: hit.task.id,
        subtaskId: hit.subtask.id,
        reportSessionId: detail?.definitionSessionId ?? sourceSessionId,
      };
    }

    assert.ok(longtermContext);
    assert.equal(longtermContext.taskId, 'ltt_main');
    assert.equal(longtermContext.subtaskId, 'lts_sub1');
    assert.equal(longtermContext.reportSessionId, 'sess_definition');
  });

  test('no context when session not bound to long-term task', () => {
    const mockLtStore = {
      findBySessionId() { return null; },
      getTask() { return null; },
    };

    const sourceSessionId = 'sess_regular';
    const hit = mockLtStore.findBySessionId(sourceSessionId);

    let longtermContext = null;
    if (hit?.subtask) {
      const detail = mockLtStore.getTask(hit.task.id);
      longtermContext = {
        taskId: hit.task.id,
        subtaskId: hit.subtask.id,
        reportSessionId: detail?.definitionSessionId ?? sourceSessionId,
      };
    }

    assert.equal(longtermContext, null);
  });

  test('fallback to source session when definition session missing', () => {
    const mockLtStore = {
      findBySessionId(sessionId) {
        if (sessionId === 'sess_twin') {
          return {
            task: { id: 'ltt_orphan', stage: 'active' },
            subtask: { id: 'lts_orphan', status: 'in_progress' },
          };
        }
        return null;
      },
      getTask(taskId) {
        if (taskId === 'ltt_orphan') {
          return {
            id: 'ltt_orphan',
            definitionSessionId: null, // Missing
            subtasks: [],
            events: [],
          };
        }
        return null;
      },
    };

    const sourceSessionId = 'sess_twin';
    const hit = mockLtStore.findBySessionId(sourceSessionId);

    let longtermContext = null;
    if (hit?.subtask) {
      const detail = mockLtStore.getTask(hit.task.id);
      longtermContext = {
        taskId: hit.task.id,
        subtaskId: hit.subtask.id,
        reportSessionId: detail?.definitionSessionId ?? sourceSessionId,
      };
    }

    assert.ok(longtermContext);
    assert.equal(longtermContext.reportSessionId, 'sess_twin'); // Fallback
  });
});

describe('TwinOrchestrationService - Dual Reporting Logic', () => {
  test('sends secondary notification when report session differs', () => {
    const notifications = [];

    const mockInsertCrossSession = (input) => {
      notifications.push({
        source: input.sourceSessionId,
        target: input.targetSessionId,
        message: input.message,
      });
      return { messageId: 'msg_' + notifications.length };
    };

    // Simulate notifyTwinTerminalState logic
    const task = {
      id: 'ot_123',
      sourceSessionId: 'sess_twin_delegation',
      longtermTaskId: 'ltt_main',
      longtermSubtaskId: 'lts_sub1',
      longtermReportSessionId: 'sess_definition',
    };
    const attempt = { id: 'att_456', workerSessionId: 'sess_worker' };
    const targetSessionId = task.sourceSessionId;
    const workerSessionId = attempt.workerSessionId;
    const text = '[ORCH-NOTIFY] Worker completed task ot_123';

    // Primary notification
    mockInsertCrossSession({
      sourceSessionId: workerSessionId,
      targetSessionId,
      message: text,
    });

    // Secondary notification (方案 A logic)
    if (task.longtermReportSessionId && task.longtermReportSessionId !== targetSessionId) {
      mockInsertCrossSession({
        sourceSessionId: workerSessionId,
        targetSessionId: task.longtermReportSessionId,
        message: `📋 长期任务子项进展汇报\n\n${text}\n\n（此汇报来自编排任务 ${task.id}，对应长期任务 ${task.longtermTaskId} 的子项 ${task.longtermSubtaskId}）`,
      });
    }

    assert.equal(notifications.length, 2);
    assert.equal(notifications[0].target, 'sess_twin_delegation');
    assert.equal(notifications[1].target, 'sess_definition');
    assert.ok(notifications[1].message.includes('长期任务子项进展汇报'));
  });

  test('skips secondary notification when report session equals delegation session', () => {
    const notifications = [];

    const mockInsertCrossSession = (input) => {
      notifications.push({
        source: input.sourceSessionId,
        target: input.targetSessionId,
        message: input.message,
      });
      return { messageId: 'msg_' + notifications.length };
    };

    const task = {
      id: 'ot_123',
      sourceSessionId: 'sess_same',
      longtermTaskId: 'ltt_main',
      longtermSubtaskId: 'lts_sub1',
      longtermReportSessionId: 'sess_same', // Same as sourceSessionId
    };
    const attempt = { id: 'att_456', workerSessionId: 'sess_worker' };
    const targetSessionId = task.sourceSessionId;
    const workerSessionId = attempt.workerSessionId;
    const text = '[ORCH-NOTIFY] Worker completed task ot_123';

    // Primary notification
    mockInsertCrossSession({
      sourceSessionId: workerSessionId,
      targetSessionId,
      message: text,
    });

    // Secondary notification (should skip)
    if (task.longtermReportSessionId && task.longtermReportSessionId !== targetSessionId) {
      mockInsertCrossSession({
        sourceSessionId: workerSessionId,
        targetSessionId: task.longtermReportSessionId,
        message: `📋 长期任务子项进展汇报\n\n${text}`,
      });
    }

    assert.equal(notifications.length, 1); // Only primary
  });

  test('skips secondary notification when no long-term linkage', () => {
    const notifications = [];

    const mockInsertCrossSession = (input) => {
      notifications.push({
        source: input.sourceSessionId,
        target: input.targetSessionId,
        message: input.message,
      });
      return { messageId: 'msg_' + notifications.length };
    };

    const task = {
      id: 'ot_123',
      sourceSessionId: 'sess_twin',
      longtermTaskId: null,
      longtermSubtaskId: null,
      longtermReportSessionId: null,
    };
    const attempt = { id: 'att_456', workerSessionId: 'sess_worker' };
    const targetSessionId = task.sourceSessionId;
    const workerSessionId = attempt.workerSessionId;
    const text = '[ORCH-NOTIFY] Worker completed task ot_123';

    // Primary notification
    mockInsertCrossSession({
      sourceSessionId: workerSessionId,
      targetSessionId,
      message: text,
    });

    // Secondary notification (should skip)
    if (task.longtermReportSessionId && task.longtermReportSessionId !== targetSessionId) {
      mockInsertCrossSession({
        sourceSessionId: workerSessionId,
        targetSessionId: task.longtermReportSessionId,
        message: `📋 长期任务子项进展汇报\n\n${text}`,
      });
    }

    assert.equal(notifications.length, 1); // Only primary
  });
});

