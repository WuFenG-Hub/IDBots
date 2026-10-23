import { getMobileElectron } from '../appBridge';
import { useCallback, useEffect, useState } from 'react';

/**
 * Scheduled-task demo state (REQ-E-8): lists the fixture tasks, listens for
 * the mock run event, and keeps the run history of the demo task fresh.
 */

export interface DemoTask {
  id: string;
  name: string;
  enabled: boolean;
  state: {
    nextRunAtMs: number | null;
    lastRunAtMs: number | null;
    lastStatus: 'success' | 'error' | 'running' | null;
  };
}

export interface DemoTaskRun {
  id: string;
  taskId: string;
  status: 'running' | 'success' | 'error' | 'skipped';
  startedAt: string;
  durationMs: number | null;
  trigger: 'scheduled' | 'manual';
}

const DEMO_TASK_ID = 'mock-task-1';

export function useScheduledTasks(): { tasks: DemoTask[]; runs: DemoTaskRun[]; reload: () => Promise<void> } {
  const [tasks, setTasks] = useState<DemoTask[]>([]);
  const [runs, setRuns] = useState<DemoTaskRun[]>([]);

  const reload = useCallback(async () => {
    const api = getMobileElectron().scheduledTasks;
    const [taskResult, runResult] = await Promise.all([api.list(), api.listRuns(DEMO_TASK_ID, 20)]);
    if (taskResult?.success && Array.isArray(taskResult.tasks)) {
      setTasks(taskResult.tasks);
    }
    if (runResult?.success && Array.isArray(runResult.runs)) {
      setRuns(runResult.runs);
    }
  }, []);

  useEffect(() => {
    void reload();
    const api = getMobileElectron().scheduledTasks;
    const offRun = api.onRunUpdate(() => {
      void reload();
    });
    const offStatus = api.onStatusUpdate(() => {
      void reload();
    });
    return () => {
      offRun();
      offStatus();
    };
  }, [reload]);

  return { tasks, runs, reload };
}
