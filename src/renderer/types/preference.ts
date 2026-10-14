export type PreferenceTallyStatus = 'collecting' | 'revealing' | 'settling' | 'decided' | 'no_decision' | 'pending';
export type PreferenceBallotStatus =
  | 'committing'
  | 'committed'
  | 'commit_failed'
  | 'superseded'
  | 'revealed'
  | 'reveal_failed'
  | 'expired';
export type PreferenceJudgeKind = 'human' | 'ai';
export type PreferenceJudgeClass = 'deciding' | 'shadow' | 'public';
export type PreferencePick = 'a' | 'b' | 'tie';
export type PreferenceChoice = 'left' | 'right' | 'tie';

export interface PreferenceBallotPair {
  a: string;
  b: string;
  pick: PreferencePick;
  reason: string;
  dims?: Record<string, PreferencePick>;
}

export interface PreferenceBallot {
  pairs: PreferenceBallotPair[];
  note?: string;
}

export interface PreferenceUserRoundSummary {
  pinId: string;
  title: string;
  status: PreferenceTallyStatus;
  winner: string | null;
  confirmed: boolean;
  category: string[];
  subject: { taskid: string; node: string } | null;
  candidateCount: number;
  commitCloseAt: number;
  commitCutoffAt: number;
  revealCloseAt: number;
  myKind: PreferenceJudgeKind | null;
  myBallotStatus: PreferenceBallotStatus | null;
}

export interface PreferenceHumanBallot {
  id: string;
  status: PreferenceBallotStatus;
  commitPinId: string | null;
  revealPinId: string | null;
  lastError: string | null;
  ballot: PreferenceBallot;
  updatedAtMs: number;
}

export interface PreferenceCandidateView {
  id: string;
  artifact: string;
  own: boolean;
}

export interface PreferenceHumanRoundView {
  pinId: string;
  confirmed: boolean;
  title: string;
  brief: string;
  category: string[];
  subject: { taskid: string; node: string } | null;
  commitCloseAt: number;
  commitCutoffAt: number;
  revealsFrom: number;
  revealCloseAt: number;
  dimensions: { id: string; label: string }[];
  tasks: string[];
  candidates: PreferenceCandidateView[];
  me: { globalMetaId: string | null; listed: boolean; kind: PreferenceJudgeKind | null; class: PreferenceJudgeClass };
  myBallots: PreferenceHumanBallot[];
  status: PreferenceTallyStatus;
  tallyError: string | null;
  winner: string | null;
  winnerArtifact: string | null;
  tallyHash: string | null;
  ranking: { id: string; copeland: number; points: number; wins: number; losses: number; ties: number }[];
  ballots: { deciding: number; shadow: number; public: number } | null;
}

export interface PreferencePairSlot {
  key: string;
  left: string;
  right: string;
}

export interface PreferencePairAnswer {
  choice: PreferenceChoice | null;
  reason: string;
  dims: Record<string, PreferenceChoice>;
}

export type PreferenceAnswers = Record<string, PreferencePairAnswer>;
