import type { PreferenceSegment } from './constants';

export interface PreferenceChainEvent {
  pinId: string;
  path: PreferenceSegment;
  /** globalMetaId of the signer. */
  author: string;
  /** -1 while unconfirmed. */
  height: number;
  txIndex: number;
  timestampMs: number;
  body: Record<string, unknown>;
}

export type JudgeKind = 'human' | 'ai';
export type JudgeClass = 'deciding' | 'shadow' | 'public';
export type PairPick = 'a' | 'b' | 'tie';

export interface RoundCandidate {
  id: string;
  ref: string;
  artifact: string;
  author: string;
}

export interface RoundJudge {
  id: string;
  kind: JudgeKind;
}

export interface RoundDimension {
  id: string;
  label: string;
}

export interface RoundBody {
  title: string;
  brief?: string;
  category: string[];
  subject?: { taskid: string; node: string };
  candidates: RoundCandidate[];
  judges: RoundJudge[];
  decision: { kinds: JudgeKind[]; minBallots: number };
  dimensions: RoundDimension[];
  tasks: string[];
  commitCloseAt: number;
  revealCloseAt: number;
}

export interface BallotPair {
  a: string;
  b: string;
  pick: PairPick;
  reason: string;
  dims?: Record<string, PairPick>;
}

export interface Ballot {
  pairs: BallotPair[];
  note?: string;
}

export interface CommitBody {
  round: string;
  hash: string;
}

export interface RevealEnvelope {
  round: string;
  commit: string;
  salt: string;
  ballot: Record<string, unknown>;
}

export interface LessonPrinciple {
  text: string;
  conditions: string;
  uncertainty: string;
  evidence: string[];
}

export interface LessonBody {
  round: string;
  category: string[];
  summary: string;
  principles: LessonPrinciple[];
  exemplars: { preferred: string; rejected: string[] };
  tallyHash: string;
}

export type TallyStatus = 'collecting' | 'revealing' | 'settling' | 'decided' | 'no_decision';

export interface TallyRankingEntry {
  id: string;
  ref: string;
  copeland: number;
  points: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface TallyJudgeEntry {
  id: string;
  kind: JudgeKind | 'public';
  class: JudgeClass;
  commit: string;
  reveal: string;
  pairs: number;
  agreeN: number;
  agreeHits: number;
  agreementBP: number;
}

export interface TallyOutput {
  engine: string;
  round: string;
  status: TallyStatus;
  winner: string | null;
  ranking: TallyRankingEntry[];
  ballots: { deciding: number; shadow: number; public: number };
  judges: TallyJudgeEntry[];
  dimensions: Record<string, Record<string, number>>;
  evidence: string[];
}

export interface TallyDiagnostics {
  ignored: { pinId: string; reason: string }[];
  /** Unix seconds the tally was evaluated at. Never hashed. */
  evaluatedAt: number;
}

export interface TallyResult {
  output: TallyOutput;
  /** Present only for final tallies (decided / no_decision). */
  tallyHash: string | null;
  diagnostics: TallyDiagnostics;
}
