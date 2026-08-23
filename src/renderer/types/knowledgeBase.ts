/**
 * Knowledge base ("知识库") shared types.
 *
 * Mirrors the main-process records so the preload bridge and the renderer UI
 * share one source of truth:
 * - KnowledgeBaseInfo        <- KnowledgeBaseRecord        (src/main/knowledgeBaseStore.ts)
 * - KnowledgeBaseLearnSummary / KnowledgeBaseLearnStatusEvent
 *                            <- src/main/services/knowledgeBaseService.ts
 */

export interface KnowledgeBaseInfo {
  id: string;
  metabotId: number;
  name: string;
  description: string;
  rawDir: string;
  isDefault: boolean;
  autoLearn: boolean;
  docCount: number;
  chunkCount: number;
  lastLearnedAt: string | null;
  lastAutoLearnDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result of one knowledge-base learn run. */
export interface KnowledgeBaseLearnSummary {
  kbId: string;
  full: boolean;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  failed: Array<{ relpath: string; error: string }>;
  docsTotal: number;
  chunksTotal: number;
}

/** Payload of the `knowledgeBase:learnStatus` renderer event. */
export interface KnowledgeBaseLearnStatusEvent {
  metabotId: number;
  kbId: string;
  state: 'running' | 'done' | 'error';
  summary?: KnowledgeBaseLearnSummary;
  error?: string;
}
