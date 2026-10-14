import { CANDIDATE_ID_RE, COMMIT_CUTOFF_SEC, PIN_ID_RE, REVEAL_DELAY_SEC } from './constants';
import type { PreferenceRoundView, PreferenceService } from './service';
import type { PreferenceBallotStatus } from './store';
import type { Ballot, JudgeClass, JudgeKind, RoundDimension, TallyStatus } from './types';

export interface PreferenceUserRoundSummary {
  pinId: string;
  title: string;
  status: TallyStatus | 'pending';
  winner: string | null;
  confirmed: boolean;
  category: string[];
  subject: { taskid: string; node: string } | null;
  candidateCount: number;
  commitCloseAt: number;
  commitCutoffAt: number;
  revealCloseAt: number;
  myKind: JudgeKind | null;
  myBallotStatus: PreferenceBallotStatus | null;
}

export interface PreferenceHumanBallot {
  id: string;
  status: PreferenceBallotStatus;
  commitPinId: string | null;
  revealPinId: string | null;
  lastError: string | null;
  ballot: Ballot;
  updatedAtMs: number;
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
  dimensions: RoundDimension[];
  tasks: string[];
  candidates: { id: string; artifact: string; own: boolean }[];
  me: { globalMetaId: string | null; listed: boolean; kind: JudgeKind | null; class: JudgeClass };
  myBallots: PreferenceHumanBallot[];
  status: TallyStatus | 'pending';
  tallyError: string | null;
  winner: string | null;
  winnerArtifact: string | null;
  tallyHash: string | null;
  ranking: { id: string; copeland: number; points: number; wins: number; losses: number; ties: number }[];
  ballots: { deciding: number; shadow: number; public: number } | null;
}

export interface PreferenceIpcDeps {
  service: () => PreferenceService;
  userGlobalMetaId: () => string | null;
}

type Fail = { success: false; error: string };

const fail = (error: unknown): Fail => ({ success: false, error: error instanceof Error ? error.message : String(error) });

const asRecord = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

const isPinId = (value: unknown): value is string => typeof value === 'string' && PIN_ID_RE.test(value);

const isPairKey = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parts = value.split('|');
  return parts.length === 2 && parts.every((part) => CANDIDATE_ID_RE.test(part));
};

const userBallotsOf = (view: PreferenceRoundView, me: string | null): PreferenceHumanBallot[] =>
  me === null
    ? []
    : view.localBallots
        .filter((row) => row.signerType === 'user' && row.judgeGlobalMetaId === me)
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
        .map((row) => ({
          id: row.id,
          status: row.status,
          commitPinId: row.commitPinId,
          revealPinId: row.revealPinId,
          lastError: row.lastError,
          ballot: row.ballot,
          updatedAtMs: row.updatedAtMs,
        }));

export function toHumanRoundView(view: PreferenceRoundView, me: string | null): PreferenceHumanRoundView {
  const output = view.tally?.output ?? null;
  const winner = output?.winner ?? null;
  const listed = me === null ? undefined : view.round.judges.find((judge) => judge.id === me);
  const judgeClass: JudgeClass = !listed
    ? 'public'
    : view.round.decision.kinds.includes(listed.kind)
      ? 'deciding'
      : 'shadow';
  return {
    pinId: view.pinId,
    confirmed: view.confirmed,
    title: view.round.title,
    brief: view.round.brief ?? '',
    category: view.round.category,
    subject: view.round.subject ?? null,
    commitCloseAt: view.round.commitCloseAt,
    commitCutoffAt: view.round.commitCloseAt - COMMIT_CUTOFF_SEC,
    revealsFrom: view.round.commitCloseAt + REVEAL_DELAY_SEC,
    revealCloseAt: view.round.revealCloseAt,
    dimensions: view.round.dimensions,
    tasks: view.round.tasks,
    candidates: view.round.candidates.map((candidate) => ({
      id: candidate.id,
      artifact: candidate.artifact,
      own: me !== null && candidate.author === me,
    })),
    me: { globalMetaId: me, listed: Boolean(listed), kind: listed?.kind ?? null, class: judgeClass },
    myBallots: userBallotsOf(view, me),
    status: output?.status ?? 'pending',
    tallyError: view.tallyError,
    winner,
    winnerArtifact: winner ? view.round.candidates.find((candidate) => candidate.id === winner)?.artifact ?? null : null,
    tallyHash: view.tally?.tallyHash ?? null,
    ranking: (output?.ranking ?? []).map(({ id, copeland, points, wins, losses, ties }) => ({
      id,
      copeland,
      points,
      wins,
      losses,
      ties,
    })),
    ballots: output?.ballots ?? null,
  };
}

export function createPreferenceIpcHandlers(deps: PreferenceIpcDeps) {
  const locate = async (roundPinId: string): Promise<PreferenceRoundView | { error: string }> => {
    const service = deps.service();
    const first = service.roundStatus(roundPinId);
    if (!('error' in first) || first.error !== 'round:not-found') return first;
    await service.refresh('ipc:round');
    return service.roundStatus(roundPinId);
  };

  return {
    async listRounds(
      input: unknown,
    ): Promise<{ success: true; rounds: PreferenceUserRoundSummary[]; userGlobalMetaId: string | null } | Fail> {
      try {
        const args = asRecord(input);
        const me = deps.userGlobalMetaId();
        if (args.mine === true && !me) return { success: true, rounds: [], userGlobalMetaId: null };
        if (args.taskid !== undefined && !isPinId(args.taskid)) return { success: true, rounds: [], userGlobalMetaId: me };
        const service = deps.service();
        const summaries = service.listRounds({
          judge: args.mine === true && me ? me : undefined,
          taskid: isPinId(args.taskid) ? args.taskid : undefined,
        });
        const rounds = summaries.map((summary): PreferenceUserRoundSummary => {
          const view = service.roundStatus(summary.pinId);
          const mine = 'error' in view ? [] : userBallotsOf(view, me);
          return {
            pinId: summary.pinId,
            title: summary.title,
            status: summary.status,
            winner: summary.winner,
            confirmed: summary.confirmed,
            category: summary.category,
            subject: summary.subject,
            candidateCount: summary.candidateCount,
            commitCloseAt: summary.commitCloseAt,
            commitCutoffAt: summary.commitCloseAt - COMMIT_CUTOFF_SEC,
            revealCloseAt: summary.revealCloseAt,
            myKind: me ? summary.judges.find((judge) => judge.id === me)?.kind ?? null : null,
            myBallotStatus: mine[0]?.status ?? null,
          };
        });
        return { success: true, rounds, userGlobalMetaId: me };
      } catch (error) {
        return fail(error);
      }
    },

    async roundStatus(input: unknown): Promise<{ success: true; view: PreferenceHumanRoundView } | Fail> {
      try {
        const roundPinId = asRecord(input).roundPinId;
        if (!isPinId(roundPinId)) return { success: false, error: 'preference:invalid-round' };
        const view = await locate(roundPinId);
        if ('error' in view) return { success: false, error: view.error };
        return { success: true, view: toHumanRoundView(view, deps.userGlobalMetaId()) };
      } catch (error) {
        return fail(error);
      }
    },

    async commit(input: unknown): Promise<{ success: true; pinId: string; ballotId: string } | Fail> {
      try {
        const args = asRecord(input);
        if (!isPinId(args.roundPinId)) return { success: false, error: 'preference:invalid-round' };
        const roundPinId = args.roundPinId;
        const me = deps.userGlobalMetaId();
        if (!me) return { success: false, error: 'USER_IDENTITY_MISSING' };
        const view = await locate(roundPinId);
        if ('error' in view) return { success: false, error: view.error };
        if (!view.round.judges.some((judge) => judge.id === me)) {
          return { success: false, error: 'preference:not-a-listed-judge' };
        }
        const result = await deps.service().commitBallot({ type: 'user' }, roundPinId, args.ballot);
        if ('error' in result) return { success: false, error: result.error };
        return { success: true, pinId: result.pinId, ballotId: result.ballotId };
      } catch (error) {
        return fail(error);
      }
    },

    telemetry(input: unknown): { success: true } | Fail {
      try {
        const args = asRecord(input);
        if (!isPinId(args.roundPinId) || !isPairKey(args.pairKey) || typeof args.seconds !== 'number') {
          return { success: false, error: 'preference:invalid-telemetry' };
        }
        deps.service().recordTelemetry(args.roundPinId, args.pairKey, args.seconds);
        return { success: true };
      } catch (error) {
        return fail(error);
      }
    },

    async refresh(): Promise<{ success: true; eventCount: number } | Fail> {
      try {
        const result = await deps.service().refresh('ipc:manual');
        return result.ok ? { success: true, eventCount: result.eventCount } : { success: false, error: result.error ?? 'preference:refresh-failed' };
      } catch (error) {
        return fail(error);
      }
    },
  };
}
