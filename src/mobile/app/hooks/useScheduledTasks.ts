import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRun } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';

/**
 * Tasks tab state (REQ-E-13, scheduled tasks only): list with live status
 * events, create (interval or daily-time schedule), enable/disable toggle,
 * run-now and per-task run history hydrated from listRuns + runUpdate.
 */

export function useScheduledTasks(resyncCounter = 0): {
  tasks: ScheduledTask[];
  creating: boolean;
  createError: string | null;
  createTask: (input: { name: string; prompt: string; schedule: ScheduledTaskInput['schedule'] }) => Promise<boolean>;
  toggleTask: (id: string, enabled: boolean) => Promise<void>;
  runTask: (id: string) => Promise<void>;
  runsFor: (taskId: string) => ScheduledTaskRun[];
  loadRuns: (taskId: string) => Promise<void>;
} {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [runsByTask, setRunsByTask] = useState<Record<string, ScheduledTaskRun[]>>({});
  const loadedRunsRef = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    const result = await getMobileElectron().scheduledTasks.list();
    if (result?.success && Array.isArray(result.tasks)) {
      setTasks(result.tasks);
    }
  }, []);

  useEffect(() => {
    void reload();
    const api = getMobileElectron().scheduledTasks;    const offStatus = api.onStatusUpdate(({ taskId, state }) => {
      setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, state: { ...state } } : task)));
    });
    const offRun = api.onRunUpdate(({ run }) => {
      setRunsByTask((prev) => {
        if (!loadedRunsRef.current.has(run.taskId)) return prev;
        const runs = prev[run.taskId] ?? [];
        const index = runs.findIndex((entry) => entry.id === run.id);
        const nextRuns =
          index >= 0 ? runs.map((entry) => (entry.id === run.id ? { ...run } : entry)) : [{ ...run }, ...runs];
        return { ...prev, [run.taskId]: nextRuns };
      });
      // Reflect run-driven state changes on the task row as well.
      setTasks((prev) =>
        prev.map((task) =>
          task.id === run.taskId
            ? {
                ...task,
                state: {
                  ...task.state,
                  lastStatus: run.status === 'running' ? 'running' : run.status,
                  lastRunAtMs: run.finishedAt ? Date.parse(run.finishedAt) : task.state.lastRunAtMs,
                },
              }
            : task,
        ),
      );
    });
    return () => {
      offStatus();
      offRun();
    };
    // resyncCounter: REQ-E-5 reconnect resync re-lists after every reconnect.
  }, [reload, resyncCounter]);

  const loadRuns = useCallback(async (taskId: string) => {
    const result = await getMobileElectron().scheduledTasks.listRuns(taskId, 20);
    loadedRunsRef.current.add(taskId);
    if (result?.success && Array.isArray(result.runs)) {
      setRunsByTask((prev) => ({ ...prev, [taskId]: result.runs }));
    }
  }, []);

  const createTask = useCallback(
    async (input: { name: string; prompt: string; schedule: ScheduledTaskInput['schedule'] }) => {
      setCreating(true);
      setCreateError(null);
      try {
        const result = await getMobileElectron().scheduledTasks.create({
          name: input.name,
          description: '',
          prompt: input.prompt,
          schedule: input.schedule,
          workingDirectory: '/data/workspace',
          systemPrompt: '',
          executionMode: 'auto',
          expiresAt: null,
          notifyPlatforms: [],
          enabled: true,
        });
        if (!result?.success || !result.task) {
          setCreateError(result?.error ?? 'create failed');
          return false;
        }
        await reload();
        return true;
      } finally {
        setCreating(false);
      }
    },
    [reload],
  );

  const toggleTask = useCallback(async (id: string, enabled: boolean) => {
    const result = await getMobileElectron().scheduledTasks.toggle(id, enabled);
    // The statusUpdate event only carries the schedule state; apply the
    // enabled flag locally so the row's switch flips without a full reload.
    if (result?.success && result.task) {
      setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, enabled: result.task.enabled } : task)));
    }
  }, []);

  const runTask = useCallback(async (id: string) => {
    await getMobileElectron().scheduledTasks.runManually(id);
  }, []);

  const runsFor = useCallback((taskId: string) => runsByTask[taskId] ?? [], [runsByTask]);

  return { tasks, creating, createError, createTask, toggleTask, runTask, runsFor, loadRuns };
}
