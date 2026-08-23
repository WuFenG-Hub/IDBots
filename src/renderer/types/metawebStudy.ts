/**
 * MetaWeb study job ("自主学习任务", M4) shared types.
 *
 * Mirrors the main-process record so the preload bridge and the renderer UI
 * share one source of truth:
 * - MetawebStudyJobInfo <- MetawebStudyJobRecord (src/main/metawebStudyJobStore.ts)
 */

export type MetawebStudyJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface MetawebStudyJobInfo {
  id: string;
  metabotId: number;
  topic: string;
  status: MetawebStudyJobStatus;
  budgetPins: number;
  /** Cumulative pinIds saved into knowledge bases across all runs. */
  processedPinIds: string[];
  runCount: number;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
