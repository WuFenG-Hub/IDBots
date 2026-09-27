/**
 * MetaTask renderer-facing types (P1 read path). Mirrors the main-process
 * projection shapes in src/main/services/metatask/types.ts — the renderer
 * never re-derives node states; it only renders what replay produced.
 */

export type MetaTaskNodeStatus = 'open' | 'claimed' | 'verified';

export interface MetaTaskVoteSummary {
  voter: string;
  verdict: string;
  pinId: string;
  counted: boolean;
  ignoreReason: string | null;
  semanticCheck: boolean;
  failreason: boolean;
}

export interface MetaTaskNodeProjection {
  id: string;
  parent: string | null;
  title: string;
  kind: string;
  weight: number | null;
  status: MetaTaskNodeStatus;
  disputed: boolean;
  holder: { pinId: string; claimant: string; sinceMs: number } | null;
  submission: { pinId: string; submitter: string; atMs: number; superseded: boolean } | null;
  passVotes: number;
  failVotes: number;
  votes: MetaTaskVoteSummary[];
  cycleCount: number;
}

export interface MetaTaskParticipantStats {
  metaId: string;
  effectiveClaims: number;
  submissions: number;
  verifiedContrib: number;
  reviewVotes: number;
  reviewCorrect: number;
  reviewTerminal: number;
}

export interface MetaTaskSettlementShare {
  metaId: string;
  shareBP: number;
  from: { submittedBP: number; reviewedBP: number };
}

export interface MetaTaskSettlementManifest {
  taskid: string;
  boundaryBlock: number;
  eventSetHash: string;
  engineAlgoVersion: string;
  shares: MetaTaskSettlementShare[];
  unpaidHistory: { node: string; author: string; pinId: string; reason: string }[];
  disputed: string[];
  weightsTableHash: string;
}

export interface MetaTaskTaskProjection {
  rootPinId: string;
  title: string;
  brief: string;
  publisher: string;
  tags: string[];
  policy: {
    claimTtlHours: number;
    verifyQuorum: number;
    verifyWindowHours: number;
    rewardSat: number;
    challengeTtlDays: number;
    hasSplit: boolean;
    rosterid: string | null;
  };
  nodes: { id: string; parent: string | null; title: string; kind: string; weight?: number }[];
  nodeStates: Record<string, MetaTaskNodeProjection>;
  progress: { total: number; verified: number; claimed: number; open: number; disputed: number };
  taskComplete: boolean;
  participants: MetaTaskParticipantStats[];
  settlement: MetaTaskSettlementManifest | null;
  freshness: {
    boundaryBlock: number;
    evaluatedAtMs: number;
    eventCount: number;
    eventSetHash: string;
    expiryApplied: boolean;
  };
  lastActivityMs: number;
  ignoredEvents: { pinId: string; reason: string }[];
}

export interface MetaTaskBoardTask {
  rootPinId: string;
  title: string;
  publisher: string;
  tags: string[];
  taskComplete: boolean;
  progress: { total: number; verified: number; claimed: number; open: number; disputed: number };
  participantCount: number;
  lastActivityMs: number;
  freshness: { boundaryBlock: number; evaluatedAtMs: number; eventCount: number };
  myRoles: ('publisher' | 'participant')[];
  myStats: {
    claimed: number;
    submitted: number;
    verified: number;
    reviewVotes: number;
    shareBP: number;
  } | null;
  settlementFinalized: boolean;
}

export interface MetaTaskAlert {
  kind: 'claim_ttl_soon' | 'submission_change' | 'closing_drive';
  rootPinId: string;
  node: string | null;
  detail: string | null;
  createdAtMs: number;
}

export interface MetaTaskBoard {
  localRosterMetaIds: string[];
  tasks: MetaTaskBoardTask[];
  alerts: MetaTaskAlert[];
  refresh: {
    lastRefreshAtMs: number | null;
    lastOkAtMs: number | null;
    lastError: string | null;
    boundaryBlock: number | null;
    refreshing: boolean;
  };
}
