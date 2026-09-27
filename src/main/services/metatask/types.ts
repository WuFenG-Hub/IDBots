import type { MetaTaskEventPath } from './constants';

/** A chain event normalized for replay (pin list item → engine input). */
export interface MetaTaskChainEvent {
  pinId: string;
  path: MetaTaskEventPath;
  /** Pin author globalMetaId. */
  author: string;
  /** Genesis block height; -1 (or missing) = unconfirmed/mempool. */
  height: number;
  txIndex: number;
  timestampMs: number;
  /** Parsed payload body (contentBody base64 → JSON, fallback contentSummary). */
  body: Record<string, unknown>;
}

// ── payload bodies (fields the engine actually reads) ────────────────────────

export interface TaskPolicyPayload {
  claim_ttl_hours?: number;
  verify_quorum?: number;
  verify_window_hours?: number;
  reward_sat?: number;
  challenge_ttl_days?: number;
  split?: {
    submitterShareBP?: number;
    reviewerFloorBP?: number;
    rosterid?: string | null;
  };
}

export interface TaskBody {
  title?: string;
  brief?: string;
  treeid?: string;
  specid?: string;
  policy?: TaskPolicyPayload;
  tags?: string[];
}

export interface TreeNodeBody {
  id: string;
  parent: string | null;
  title: string;
  kind: string;
  specid: string | null;
  params: Record<string, unknown>;
  deps: string[];
  weight?: number;
}

export interface TreeBody {
  root: string;
  nodes: TreeNodeBody[];
}

export interface AmendOp {
  op: 'add_node' | 'remove_node' | 'reweight' | 'retitle' | 'respec';
  node?: string;
  weight?: number;
  title?: string;
  specid?: string;
  /** add_node only: full node record. */
  newNode?: TreeNodeBody;
}

export interface AmendBody {
  taskid: string;
  bases: string;
  ops: AmendOp[];
}

export interface ChallengeBody {
  targetid: string;
  category: 'correctness' | 'attribution' | 'priority' | 'identity' | string;
  reason: string;
  evidence: string;
  priorref?: string | null;
  withdraw?: boolean;
}

// ── replay output ────────────────────────────────────────────────────────────

export type MetaTaskNodeStatus = 'open' | 'claimed' | 'verified';

export interface MetaTaskVoteSummary {
  voter: string;
  verdict: 'pass' | 'fail' | 'invalid' | string;
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
  /** Effective claim, if any. */
  holder: { pinId: string; claimant: string; sinceMs: number } | null;
  /** Effective submission of the current cycle, if any. */
  submission: {
    pinId: string;
    submitter: string;
    atMs: number;
    superseded: boolean;
  } | null;
  passVotes: number;
  failVotes: number;
  votes: MetaTaskVoteSummary[];
  /** Submission cycles that ended without verification (unpaid history input). */
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
  /** Tree in effect at boundary (after amend fold), with weights (null = legacy task). */
  nodes: TreeNodeBody[];
  /** Current tree head pinId: the original treeid, or the last effective amend (v1.2). */
  amendHead: string;
  nodeStates: Record<string, MetaTaskNodeProjection>;
  progress: { total: number; verified: number; claimed: number; open: number; disputed: number };
  taskComplete: boolean;
  participants: MetaTaskParticipantStats[];
  settlement: MetaTaskSettlementManifest | null;
  /** Blocks the settlement would pay but for open challenges (node ids). */
  freshness: {
    boundaryBlock: number;
    evaluatedAtMs: number;
    eventCount: number;
    eventSetHash: string;
    expiryApplied: boolean;
  };
  /** Latest event timestamp (ms) across the task-scoped set. */
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
  myStats: { claimed: number; submitted: number; verified: number; reviewVotes: number; shareBP: number } | null;
  settlementFinalized: boolean;
}

export interface MetaTaskAlert {
  kind: 'claim_ttl_soon' | 'submission_change' | 'closing_drive';
  rootPinId: string;
  node: string | null;
  /** Optional transition detail for submission_change: `${from}->${to}`. */
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
