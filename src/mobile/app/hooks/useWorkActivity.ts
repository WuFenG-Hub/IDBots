import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LongTermBoard } from '@/types/longTermTask';
import type { MockMetabot, ScheduledTask, ScheduledTaskRun } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';
import { buildWorkActivity, resolveLongTermResultSession, type WorkActivity } from '../activity';
import { t } from '../../i18n';

export type OpenWorkSession = (sessionId: string) => Promise<boolean>;

export interface ActivitySnapshot {
  tasks: ScheduledTask[];
  runs: Array<ScheduledTaskRun & { taskName?: string }>;
  bots: MockMetabot[];
  board: LongTermBoard | null;
}

const EMPTY_SNAPSHOT: ActivitySnapshot = { tasks: [], runs: [], bots: [], board: null };

export function mergeActivitySnapshot(
  previous: ActivitySnapshot,
  patch: Partial<ActivitySnapshot>,
): ActivitySnapshot {
  return {
    tasks: patch.tasks ?? previous.tasks,
    runs: patch.runs ?? previous.runs,
    bots: patch.bots ?? previous.bots,
    board: patch.board === undefined ? previous.board : patch.board,
  };
}

export function reduceLongTermUpdate(
  lastSeenSeq: number,
  update: { seq?: number; reason?: string },
): { seq: number; reload: boolean } {
  if (typeof update?.seq !== 'number' || !Number.isSafeInteger(update.seq) || update.seq <= lastSeenSeq) {
    return { seq: lastSeenSeq, reload: false };
  }
  return { seq: update.seq, reload: update.reason !== 'heartbeat' };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useWorkActivity(resyncCounter = 0) {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [longTermError, setLongTermError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const sequenceRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    const api = getMobileElectron();
    try {
      const [taskResult, runResult, botResult, boardResult] = await Promise.all([
        api.scheduledTasks.list().catch(() => null),
        api.scheduledTasks.listAllRuns(50, 0).catch(() => null),
        api.metabot.list().catch(() => null),
        api.longtermTask.board().catch((cause: unknown) => ({
          success: false as const,
          error: errorText(cause, t('mobile.activity.longTermUnavailable')),
        })),
      ]);
      if (request !== requestRef.current) return;
      const tasksValid = taskResult?.success && Array.isArray(taskResult.tasks);
      const runsValid = runResult?.success && Array.isArray(runResult.runs);
      const botsValid = botResult?.success && Array.isArray(botResult.list);
      const boardValid = boardResult?.success && Boolean(boardResult.board);
      setSnapshot((previous) => mergeActivitySnapshot(previous, {
        tasks: tasksValid ? taskResult.tasks : undefined,
        runs: runsValid ? runResult.runs : undefined,
        bots: botsValid ? botResult.list : undefined,
        board: boardValid ? boardResult.board : undefined,
      }));
      setError(tasksValid && runsValid && botsValid ? null : t('mobile.activity.loadFailed'));
      setLongTermError(boardValid ? null : boardResult?.error ?? t('mobile.activity.longTermUnavailable'));
    } catch (cause) {
      if (request === requestRef.current) setError(errorText(cause, t('mobile.activity.loadFailed')));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const api = getMobileElectron();
    const offLongTerm = api.longtermTask.onUpdate((data: { seq?: number; reason?: string }) => {
      const update = reduceLongTermUpdate(sequenceRef.current, data);
      sequenceRef.current = update.seq;
      if (update.reload) void reload();
    });
    const offScheduledRun = api.scheduledTasks.onRunUpdate(() => void reload());
    const timer = setInterval(() => void reload(), 30_000);
    return () => {
      requestRef.current += 1;
      offLongTerm();
      offScheduledRun();
      clearInterval(timer);
    };
  }, [reload, resyncCounter]);

  const openActivity = useCallback(async (
    activity: WorkActivity,
    openSession: OpenWorkSession,
  ): Promise<boolean> => {
    try {
      let sessionId = activity.kind === 'scheduled' ? activity.sessionId : null;
      if (activity.kind === 'longterm') {
        const result = await getMobileElectron().longtermTask.get({ taskId: activity.taskId });
        if (!result?.success || !result.detail) {
          setError(result?.error ?? t('mobile.activity.sessionUnavailable'));
          return false;
        }
        sessionId = resolveLongTermResultSession(result.detail);
      }
      if (!sessionId || !(await openSession(sessionId))) {
        setError(t('mobile.activity.sessionUnavailable'));
        return false;
      }
      setError(null);
      return true;
    } catch (cause) {
      setError(errorText(cause, t('mobile.activity.sessionUnavailable')));
      return false;
    }
  }, []);

  const setStage = useCallback(async (
    taskId: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<boolean> => {
    try {
      const result = await getMobileElectron().longtermTask.setStage({ taskId, action });
      if (!result?.ok) {
        setError(result?.error ?? t('mobile.activity.actionFailed'));
        return false;
      }
      setError(null);
      await reload();
      return true;
    } catch (cause) {
      setError(errorText(cause, t('mobile.activity.actionFailed')));
      return false;
    }
  }, [reload]);

  const activities = useMemo(() => buildWorkActivity(snapshot), [snapshot]);
  return { activities, loading, error, longTermError, reload, openActivity, setStage };
}
