/**
 * MetaWeb surf ("AI 冲浪") shared types.
 *
 * Mirrors the main-process records so the preload bridge and the renderer UI
 * share one source of truth:
 * - MetawebSurfRunInfo <- MetawebSurfRunRecord (src/main/metawebSurfStore.ts)
 */

export type MetawebSurfTrigger = 'manual-chat' | 'manual-ui' | 'pre-dream';
export type MetawebSurfRunStatus = 'running' | 'done' | 'failed';

export interface MetawebSurfRunStats {
  fetched: number;
  deepRead: number;
  savedToKb: number;
  knowledgePoints: number;
  liked: number;
  commented: number;
  answered: number;
  posted: number;
  challenged: number;
  inboxHandled: number;
  discoveredProtocols: number;
}

export interface MetawebSurfRunInfo {
  id: string;
  metabotId: number;
  trigger: MetawebSurfTrigger;
  status: MetawebSurfRunStatus;
  stats: MetawebSurfRunStats;
  reportMarkdown: string | null;
  reportJson: string | null;
  /** The briefing digest the session was shown that night (report stored separately). */
  briefingMarkdown: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
