import type { CollectPreferenceEventsResult } from './collector';
import type { PreferenceSegment } from './constants';
import { compareOrderKey, tallyRound } from './engine';
import { canonicalRoundForSubject, checkLesson, verifyLessonPin, type CanonicalRoundResolution } from './lesson';
import { parseRound } from './schemas';
import { toBallotView, type PreferenceBallotView, type PreferenceStore } from './store';
import type {
  LessonPrinciple,
  PreferenceChainEvent,
  RoundBody,
  RoundCandidate,
  RoundJudge,
  TallyResult,
  TallyStatus,
} from './types';

export type PreferenceSigner = { type: 'user' } | { type: 'metabot'; metabotId: number };

export interface PreferencePinWriteResult {
  pinId: string;
  txids: string[];
}

export interface PreferenceWriter {
  globalMetaId: string;
  write(segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult>;
}

export type PreferenceWriterResolution = PreferenceWriter | { error: string };

export interface PreferenceServiceDeps {
  store: PreferenceStore;
  collect: () => Promise<CollectPreferenceEventsResult>;
  resolveWriter: (signer: PreferenceSigner) => PreferenceWriterResolution;
  nowMs?: () => number;
  onUpdate?: (reason: string) => void;
}

export interface PreferenceRoundSummary {
  pinId: string;
  author: string;
  confirmed: boolean;
  title: string;
  category: string[];
  subject: { taskid: string; node: string } | null;
  candidateCount: number;
  judges: RoundJudge[];
  commitCloseAt: number;
  revealCloseAt: number;
  status: TallyStatus | 'pending';
  winner: string | null;
}

export interface PreferenceRoundView {
  pinId: string;
  author: string;
  confirmed: boolean;
  round: RoundBody;
  tally: TallyResult | null;
  tallyError: string | null;
  localBallots: PreferenceBallotView[];
  lesson: { pinId: string; valid: boolean; reason: string | null } | null;
}

export interface PreferenceLessonView {
  pinId: string;
  author: string;
  timestampMs: number;
  roundPinId: string;
  roundTitle: string;
  category: string[];
  summary: string;
  principles: LessonPrinciple[];
  preferred: RoundCandidate;
  rejected: RoundCandidate[];
  decidingBallots: number;
}

export interface PreferenceRefreshResult {
  ok: boolean;
  eventCount: number;
  error: string | null;
}

type ErrorResult = { error: string };

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const tagMatches = (query: string, tag: string): boolean => tag === query || tag.startsWith(`${query}:`);

export class PreferenceService {
  private readonly deps: PreferenceServiceDeps;
  private refreshing: Promise<PreferenceRefreshResult> | null = null;

  constructor(deps: PreferenceServiceDeps) {
    this.deps = deps;
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  refresh(reason: string): Promise<PreferenceRefreshResult> {
    if (!this.refreshing) {
      this.refreshing = this.runRefresh(reason).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async runRefresh(reason: string): Promise<PreferenceRefreshResult> {
    try {
      const result = await this.deps.collect();
      this.deps.store.upsertEvents(result.events, this.nowMs());
      const errors = result.perPath.filter((entry) => entry.error).map((entry) => `${entry.segment}: ${entry.error}`);
      this.deps.onUpdate?.(reason);
      return { ok: errors.length === 0, eventCount: result.events.length, error: errors.length > 0 ? errors.join('; ') : null };
    } catch (error) {
      return { ok: false, eventCount: 0, error: errorOf(error) };
    }
  }

  events(): PreferenceChainEvent[] {
    return this.deps.store.loadEvents();
  }

  /** Finds a round in the cache, confirmed or not, and validates it against its own timestamp. */
  private locateRound(
    events: readonly PreferenceChainEvent[],
    roundPinId: string,
  ): { event: PreferenceChainEvent; round: RoundBody } | ErrorResult {
    const event = events.find((candidate) => candidate.path === 'round' && candidate.pinId === roundPinId);
    if (!event) return { error: 'round:not-found' };
    const parsed = parseRound(event.body, Math.floor(event.timestampMs / 1000));
    return parsed.ok === true ? { event, round: parsed.value } : { error: parsed.reason };
  }

  listRounds(filter: { judge?: string; taskid?: string } = {}): PreferenceRoundSummary[] {
    const events = this.events();
    const nowSec = this.nowSec();
    const rounds = events.filter((event) => event.path === 'round').sort((a, b) => b.timestampMs - a.timestampMs);
    const out: PreferenceRoundSummary[] = [];
    for (const event of rounds) {
      const located = this.locateRound(events, event.pinId);
      if ('error' in located) continue;
      const { round } = located;
      if (filter.judge && !round.judges.some((judge) => judge.id === filter.judge)) continue;
      if (filter.taskid && round.subject?.taskid !== filter.taskid) continue;
      const confirmed = event.height >= 0;
      const tally = confirmed ? tallyRound(events, event.pinId, { nowSec }) : null;
      out.push({
        pinId: event.pinId,
        author: event.author,
        confirmed,
        title: round.title,
        category: round.category,
        subject: round.subject ?? null,
        candidateCount: round.candidates.length,
        judges: round.judges,
        commitCloseAt: round.commitCloseAt,
        revealCloseAt: round.revealCloseAt,
        status: tally && tally.ok === true ? tally.result.output.status : 'pending',
        winner: tally && tally.ok === true ? tally.result.output.winner : null,
      });
    }
    return out;
  }

  roundStatus(roundPinId: string, options: { lessonPinId?: string } = {}): PreferenceRoundView | ErrorResult {
    const events = this.events();
    const located = this.locateRound(events, roundPinId);
    if ('error' in located) return located;
    const nowSec = this.nowSec();
    const tally = tallyRound(events, roundPinId, { nowSec });
    let lesson: PreferenceRoundView['lesson'] = null;
    if (options.lessonPinId) {
      const lessonEvent = events.find((event) => event.path === 'lesson' && event.pinId === options.lessonPinId);
      const verdict = verifyLessonPin(events, options.lessonPinId, nowSec);
      const sameRound = lessonEvent?.body.round === roundPinId;
      lesson = {
        pinId: options.lessonPinId,
        valid: verdict.ok && sameRound,
        reason: verdict.ok === true ? (sameRound ? null : 'lesson:round-mismatch') : verdict.reason,
      };
    }
    return {
      pinId: roundPinId,
      author: located.event.author,
      confirmed: located.event.height >= 0,
      round: located.round,
      tally: tally.ok === true ? tally.result : null,
      tallyError: tally.ok === true ? null : tally.reason,
      localBallots: this.deps.store.listBallots({ roundPinId }).map(toBallotView),
      lesson,
    };
  }

  canonicalRound(subject: { taskid: string; node: string; rootAuthor: string }): CanonicalRoundResolution {
    return canonicalRoundForSubject(this.events(), subject, this.nowSec());
  }

  searchLessons(query: { category?: string[]; limit?: number } = {}): PreferenceLessonView[] {
    const events = this.events();
    const nowSec = this.nowSec();
    const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
    const tallies = new Map<string, TallyResult | null>();
    const out: PreferenceLessonView[] = [];
    const lessons = events
      .filter((event) => event.path === 'lesson' && event.height >= 0)
      .sort((a, b) => compareOrderKey(b, a));
    for (const event of lessons) {
      const roundPinId = typeof event.body.round === 'string' ? event.body.round : '';
      if (!tallies.has(roundPinId)) {
        const tally = tallyRound(events, roundPinId, { nowSec });
        tallies.set(roundPinId, tally.ok === true ? tally.result : null);
      }
      const tally = tallies.get(roundPinId);
      if (!tally) continue;
      const verdict = checkLesson(event.body, tally);
      if (verdict.ok === false) continue;
      const { lesson } = verdict;
      const wanted = query.category ?? [];
      if (wanted.length > 0 && !wanted.some((tag) => lesson.category.some((own) => tagMatches(tag, own)))) continue;
      const located = this.locateRound(events, roundPinId);
      if ('error' in located) continue;
      const byId = new Map(located.round.candidates.map((candidate) => [candidate.id, candidate] as const));
      const preferred = byId.get(lesson.exemplars.preferred);
      if (!preferred) continue;
      out.push({
        pinId: event.pinId,
        author: event.author,
        timestampMs: event.timestampMs,
        roundPinId,
        roundTitle: located.round.title,
        category: lesson.category,
        summary: lesson.summary,
        principles: lesson.principles,
        preferred,
        rejected: lesson.exemplars.rejected.flatMap((id) => {
          const candidate = byId.get(id);
          return candidate ? [candidate] : [];
        }),
        decidingBallots: tally.output.ballots.deciding,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
