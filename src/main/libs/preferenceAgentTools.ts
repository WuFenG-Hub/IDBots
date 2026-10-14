import { z } from 'zod';
import { sha256Hex } from '../services/metatask/canon';
import type { MetaTaskTaskProjection } from '../services/metatask/types';
import { ARTIFACT_RE, PILOT_CANDIDATE_CAP, REVEAL_DELAY_SEC } from '../services/preference/constants';
import { checkBallot } from '../services/preference/schemas';
import type { PreferenceRoundView, PreferenceService } from '../services/preference/service';
import type {
  BallotPair,
  JudgeClass,
  JudgeKind,
  PreferenceChainEvent,
  RoundBody,
  RoundCandidate,
} from '../services/preference/types';

export type CandidateDerivation = { ok: true; candidates: RoundCandidate[] } | { ok: false; reason: string };

const byteCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function candidatesFromMetaTaskNode(
  detail: MetaTaskTaskProjection,
  node: string,
  cap: number = PILOT_CANDIDATE_CAP,
): CandidateDerivation {
  const nodeState = detail.nodeStates[node];
  if (!nodeState) return { ok: false, reason: `preference:node-not-found:${node}` };
  const eligible = (nodeState.submissions ?? [])
    .filter(
      (submission) =>
        submission.chainValid &&
        submission.verified &&
        !submission.failed &&
        !submission.superseded &&
        typeof submission.attachment === 'string' &&
        ARTIFACT_RE.test(submission.attachment),
    )
    .sort(
      (a, b) =>
        (a.verifiedHeight ?? 0) - (b.verifiedHeight ?? 0) ||
        (a.verifiedTxIndex ?? 0) - (b.verifiedTxIndex ?? 0) ||
        byteCompare(a.pinId, b.pinId),
    );
  if (eligible.length < 2) return { ok: false, reason: `preference:too-few-candidates:${eligible.length}` };
  const chosen = eligible.slice(0, cap).sort((a, b) => byteCompare(a.pinId, b.pinId));
  return {
    ok: true,
    candidates: chosen.map((submission, index) => ({
      id: `c${index + 1}`,
      ref: submission.pinId,
      artifact: String(submission.attachment),
      author: submission.submitter,
    })),
  };
}

export function judgePairOrder(judge: string, roundPinId: string, round: RoundBody): { a: string; b: string }[] {
  const ids = round.candidates
    .filter((candidate) => candidate.author !== judge)
    .map((candidate) => candidate.id)
    .sort(byteCompare);
  const pairs: { a: string; b: string; key: string }[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = sha256Hex(`${roundPinId}|${judge}|${ids[i]}|${ids[j]}`);
      const swap = Number.parseInt(key.slice(0, 1), 16) % 2 === 1;
      pairs.push({ a: swap ? ids[j] : ids[i], b: swap ? ids[i] : ids[j], key });
    }
  }
  return pairs.sort((x, y) => byteCompare(x.key, y.key)).map(({ a, b }) => ({ a, b }));
}

/**
 * Preference agent tools: the session bot's surface for /protocols/preference
 * (docs/metaid_protocols/09-preference.md). Writes go through
 * PreferenceService, which owns salts, windows, and writer-side refusals.
 *
 * Judge independence: views never show candidate authors, never show another
 * local judge's sealed ballot, and show ballot reasons only after the commit
 * window has closed.
 */

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: never) => Promise<unknown>,
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

const refuse = (reason: string) => textResult(`Refused: ${reason}`, true);

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface PreferenceAgentControl {
  service: () => PreferenceService;
  resolveGlobalMetaId: (metabotId: number) => string | null;
  metataskDetail: (rootPinId: string) => MetaTaskTaskProjection | null;
  refreshMetaTask: (reason: string) => Promise<{ ok: boolean; error: string | null }>;
}

interface JudgeRole {
  listed: boolean;
  kind: JudgeKind | null;
  class: JudgeClass;
}

interface RevealReason {
  reveal: string;
  judgeKind: JudgeKind | 'public';
  judgeClass: JudgeClass;
  pairs: BallotPair[];
  note: string | null;
}

const judgeRole = (round: RoundBody, me: string | null): JudgeRole => {
  const entry = me ? round.judges.find((judge) => judge.id === me) : undefined;
  if (!entry) return { listed: false, kind: null, class: 'public' };
  return { listed: true, kind: entry.kind, class: round.decision.kinds.includes(entry.kind) ? 'deciding' : 'shadow' };
};

const revealReasons = (events: readonly PreferenceChainEvent[], view: PreferenceRoundView): RevealReason[] => {
  if (!view.tally) return [];
  const byReveal = new Map(view.tally.output.judges.map((judge) => [judge.reveal, judge] as const));
  return view.tally.output.evidence.flatMap((revealPinId) => {
    const event = events.find((candidate) => candidate.path === 'reveal' && candidate.pinId === revealPinId);
    const judge = byReveal.get(revealPinId);
    if (!event || !judge) return [];
    const parsed = checkBallot(event.body.ballot, view.round);
    if (parsed.ok === false) return [];
    return [
      {
        reveal: revealPinId,
        judgeKind: judge.kind,
        judgeClass: judge.class,
        pairs: parsed.value.pairs,
        note: parsed.value.note ?? null,
      },
    ];
  });
};

const roundStatusView = (view: PreferenceRoundView, events: readonly PreferenceChainEvent[], me: string | null) => {
  const output = view.tally?.output ?? null;
  const collecting = output ? output.status === 'collecting' : !view.confirmed;
  const winner = output?.winner ?? null;
  const winnerCandidate = winner ? view.round.candidates.find((candidate) => candidate.id === winner) : undefined;
  return {
    roundPinId: view.pinId,
    confirmed: view.confirmed,
    title: view.round.title,
    brief: view.round.brief ?? '',
    category: view.round.category,
    subject: view.round.subject ?? null,
    windows: {
      commitCloseAt: view.round.commitCloseAt,
      revealsFrom: view.round.commitCloseAt + REVEAL_DELAY_SEC,
      revealCloseAt: view.round.revealCloseAt,
    },
    decision: view.round.decision,
    dimensions: view.round.dimensions,
    tasks: view.round.tasks,
    candidates: view.round.candidates.map((candidate) => ({
      id: candidate.id,
      artifact: candidate.artifact,
      own: me !== null && candidate.author === me,
    })),
    myRole: judgeRole(view.round, me),
    pairsToJudge: me && collecting ? judgePairOrder(me, view.pinId, view.round) : [],
    myBallots: view.localBallots
      .filter((row) => me !== null && row.judgeGlobalMetaId === me)
      .map((row) => ({
        id: row.id,
        status: row.status,
        commitPinId: row.commitPinId,
        revealPinId: row.revealPinId,
        lastError: row.lastError,
      })),
    status: output?.status ?? 'pending',
    tallyError: view.tallyError,
    winner,
    winnerRef: winnerCandidate?.ref ?? null,
    winnerArtifact: winnerCandidate?.artifact ?? null,
    tallyHash: view.tally?.tallyHash ?? null,
    ranking: output?.ranking ?? [],
    ballots: output?.ballots ?? null,
    judges: (output?.judges ?? []).map((judge) => ({
      kind: judge.kind,
      class: judge.class,
      pairs: judge.pairs,
      agreementBP: judge.agreementBP,
      reveal: judge.reveal,
      isMe: judge.id === me,
    })),
    dimensionPoints: output?.dimensions ?? {},
    evidence: output?.evidence ?? [],
    reasons: collecting ? [] : revealReasons(events, view),
    lesson: view.lesson,
  };
};

interface RoundsListArgs {
  mine?: boolean;
  taskRootPinId?: string;
  refresh?: boolean;
}

interface SubjectArg {
  rootPinId: string;
  node: string;
}

interface RoundStatusArgs {
  roundPinId?: string;
  subject?: SubjectArg;
  lessonPinId?: string;
  refresh?: boolean;
}

interface LessonsSearchArgs {
  category?: string[];
  limit?: number;
  refresh?: boolean;
}

export function buildPreferenceAgentTools(deps: {
  tool: SdkToolFactory;
  control: PreferenceAgentControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  nowMs?: () => number;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const sessionBot = (): { metabotId: number; globalMetaId: string } | { error: string } => {
    const metabotId = resolveMetabotId(sessionId);
    if (metabotId === undefined) return { error: 'preference:no-session-bot' };
    const globalMetaId = control.resolveGlobalMetaId(metabotId);
    if (!globalMetaId) return { error: 'METABOT_IDENTITY_MISSING' };
    return { metabotId, globalMetaId };
  };

  const sessionGlobalMetaId = (): string | null => {
    const bot = sessionBot();
    return 'error' in bot ? null : bot.globalMetaId;
  };

  const roundsList = tool(
    'preference_rounds_list',
    'List preference rounds (/protocols/preference) from the local chain cache, newest first: round pinId, title, status (collecting / revealing / settling / decided / no_decision, or pending while the round pin is unconfirmed), winner, category, MetaTask subject, and windows. mine=true keeps rounds that list YOU as a judge and reports your judge kind. Read-only.',
    {
      mine: z.boolean().optional().describe('Only rounds where the session bot is a listed judge.'),
      taskRootPinId: z.string().optional().describe('Only rounds whose subject is this MetaTask root pinId.'),
      refresh: z.boolean().optional().describe('Sweep the chain pools first (slower, fresher).'),
    },
    async (args: RoundsListArgs) => {
      try {
        const service = control.service();
        if (args.refresh) await service.refresh('preference_rounds_list');
        let judge: string | undefined;
        if (args.mine) {
          const bot = sessionBot();
          if ('error' in bot) return refuse(bot.error);
          judge = bot.globalMetaId;
        }
        const rounds = service.listRounds({ judge, taskid: args.taskRootPinId });
        return jsonResult({
          rounds: rounds.map((entry) => ({
            roundPinId: entry.pinId,
            title: entry.title,
            status: entry.status,
            winner: entry.winner,
            confirmed: entry.confirmed,
            category: entry.category,
            subject: entry.subject,
            candidateCount: entry.candidateCount,
            commitCloseAt: entry.commitCloseAt,
            revealCloseAt: entry.revealCloseAt,
            myRole: judge ? entry.judges.find((listed) => listed.id === judge)?.kind ?? null : null,
          })),
        });
      } catch (error) {
        return textResult(`Failed to list preference rounds: ${errorOf(error)}`, true);
      }
    },
  );

  const roundStatus = tool(
    'preference_round_status',
    'Read one preference round and its deterministic tally. Pass roundPinId, or subject {rootPinId, node} to resolve the canonical round of a MetaTask node (protocol §7: the earliest valid round by the task root author that did not end no_decision). Returns windows, candidates (id + artifact URI + whether it is yours; builder identities are hidden), your judge role, pairsToJudge (your stable pair order while commits are open; own candidates excluded), your own ballot statuses, status, ranking, winner + winnerRef + winnerArtifact, tallyHash (final only), per-judge agreement, evidence reveal pinIds, and — only after the commit window closed — the evidence ballots\' pairs and reasons for lesson distillation. With lessonPinId it also reports whether that lesson is valid for the round. Read-only.',
    {
      roundPinId: z.string().optional(),
      subject: z.object({ rootPinId: z.string().min(1), node: z.string().min(1) }).optional(),
      lessonPinId: z.string().optional().describe('Also validate this lesson pin against the round.'),
      refresh: z.boolean().optional(),
    },
    async (args: RoundStatusArgs) => {
      try {
        const service = control.service();
        if (args.refresh) await service.refresh('preference_round_status');
        let roundPinId = args.roundPinId;
        let canonical: 'decided' | 'pending' | null = null;
        if (!roundPinId && args.subject) {
          const detail = control.metataskDetail(args.subject.rootPinId);
          if (!detail) return refuse(`preference:task-not-found:${args.subject.rootPinId}`);
          const resolution = service.canonicalRound({
            taskid: args.subject.rootPinId,
            node: args.subject.node,
            rootAuthor: detail.publisher,
          });
          if (resolution.state === 'none') {
            return jsonResult({
              canonical: 'none',
              note: 'No canonical round yet: the task author has not opened one for this node, or every round ended no_decision.',
            });
          }
          roundPinId = resolution.roundPinId;
          canonical = resolution.state;
        }
        if (!roundPinId) return refuse('preference:round-required (pass roundPinId or subject)');
        let view = service.roundStatus(roundPinId, { lessonPinId: args.lessonPinId });
        if ('error' in view && !args.refresh) {
          await service.refresh('preference_round_status');
          view = service.roundStatus(roundPinId, { lessonPinId: args.lessonPinId });
        }
        if ('error' in view) return refuse(view.error);
        return jsonResult({ ...roundStatusView(view, service.events(), sessionGlobalMetaId()), canonical });
      } catch (error) {
        return textResult(`Failed to read the preference round: ${errorOf(error)}`, true);
      }
    },
  );

  const lessonsSearch = tool(
    'preference_lessons_search',
    'Search valid on-chain preference lessons (/protocols/preference/lesson), newest first. category matches by tag prefix: "ui" matches "ui:qa-community". Each lesson lists principles (text, conditions, uncertainty, evidence count), the preferred exemplar artifact (open it with bot_browser_open_uri), rejected artifacts, round size, and shadow AI agreement. Lessons are evidence-backed options, not orders: apply a principle only when its conditions match your app. Read-only.',
    {
      category: z.array(z.string()).max(8).optional().describe('Tag filters, e.g. ["ui:qa-community"] or ["ui"].'),
      limit: z.number().int().min(1).max(50).optional(),
      refresh: z.boolean().optional(),
    },
    async (args: LessonsSearchArgs) => {
      try {
        const service = control.service();
        if (args.refresh) await service.refresh('preference_lessons_search');
        const lessons = service.searchLessons({ category: args.category, limit: args.limit });
        return jsonResult({
          usage:
            'Treat principles as options with conditions; prefer lessons with more deciding ballots; open preferredArtifact before designing; respect an explicit explorer assignment that tells you not to use lessons.',
          lessons: lessons.map((lesson) => {
            const view = service.roundStatus(lesson.roundPinId);
            const judges = 'error' in view || !view.tally ? [] : view.tally.output.judges;
            return {
              lessonPinId: lesson.pinId,
              roundPinId: lesson.roundPinId,
              roundTitle: lesson.roundTitle,
              author: lesson.author,
              publishedAt: new Date(lesson.timestampMs).toISOString(),
              category: lesson.category,
              summary: lesson.summary,
              principles: lesson.principles.map((principle) => ({
                text: principle.text,
                conditions: principle.conditions,
                uncertainty: principle.uncertainty,
                evidenceCount: principle.evidence.length,
              })),
              preferredArtifact: lesson.preferred.artifact,
              rejectedArtifacts: lesson.rejected.map((candidate) => candidate.artifact),
              roundSize: {
                candidates: 'error' in view ? null : view.round.candidates.length,
                decidingBallots: lesson.decidingBallots,
              },
              shadowAgreementBP: judges.filter((judge) => judge.class === 'shadow').map((judge) => judge.agreementBP),
            };
          }),
        });
      } catch (error) {
        return textResult(`Failed to search preference lessons: ${errorOf(error)}`, true);
      }
    },
  );

  return [roundsList, roundStatus, lessonsSearch];
}
