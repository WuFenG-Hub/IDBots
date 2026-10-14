import {
  ARTIFACT_RE,
  CANDIDATE_ID_RE,
  CATEGORY_TAG_RE,
  DIMENSION_ID_RE,
  GLOBAL_META_ID_RE,
  HEX64_RE,
  MAX_CANDIDATES,
  MAX_JUDGES,
  MAX_PAIRS,
  MIN_WINDOW_SEC,
  PIN_ID_RE,
} from './constants';
import type {
  Ballot,
  BallotPair,
  CommitBody,
  JudgeKind,
  LessonBody,
  LessonPrinciple,
  PairPick,
  RevealEnvelope,
  RoundBody,
  RoundCandidate,
  RoundDimension,
  RoundJudge,
} from './types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(reason: string): ParseResult<T> => ({ ok: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Lengths count Unicode code points, so CJK text is measured by characters. */
const charLength = (value: string): number => Array.from(value).length;

const isText = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && charLength(value.trim()) >= min && charLength(value) <= max;

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);

const isJudgeKind = (value: unknown): value is JudgeKind => value === 'human' || value === 'ai';

export const isPairPick = (value: unknown): value is PairPick => value === 'a' || value === 'b' || value === 'tie';

export function parseCategory(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const tags: string[] = [];
  for (const tag of value) {
    if (!matches(tag, CATEGORY_TAG_RE) || tag.length > 64 || tags.includes(tag)) return null;
    tags.push(tag);
  }
  return tags;
}

export function parseRound(body: unknown, roundTimestampSec: number): ParseResult<RoundBody> {
  if (!isRecord(body)) return fail('round:not-object');
  const {
    title,
    brief,
    category: rawCategory,
    subject: rawSubject,
    candidates: rawCandidates,
    judges: rawJudges,
    decision: rawDecision,
    dimensions: rawDimensions,
    tasks: rawTasks,
    commitCloseAt,
    revealCloseAt,
  } = body;
  if (!isText(title, 1, 200)) return fail('round:title');
  // Positive-predicate narrowing: electron-tsconfig.json has no strictNullChecks,
  // so a `brief !== undefined` guard does not narrow `unknown` after the check.
  const briefText: string | undefined = isText(brief, 0, 4000) ? brief : undefined;
  if (brief !== undefined && briefText === undefined) return fail('round:brief');
  const category = parseCategory(rawCategory);
  if (!category) return fail('round:category');

  let subject: RoundBody['subject'];
  if (rawSubject !== undefined) {
    if (!isRecord(rawSubject)) return fail('round:subject');
    const { taskid, node } = rawSubject;
    if (!matches(taskid, PIN_ID_RE) || !isText(node, 1, 64)) return fail('round:subject');
    subject = { taskid, node };
  }

  if (!Array.isArray(rawCandidates) || rawCandidates.length < 2 || rawCandidates.length > MAX_CANDIDATES) {
    return fail('round:candidates');
  }
  const candidates: RoundCandidate[] = [];
  for (const candidate of rawCandidates) {
    if (!isRecord(candidate)) return fail('round:candidate-shape');
    const { id, ref, artifact, author } = candidate;
    if (
      !matches(id, CANDIDATE_ID_RE)
      || !matches(ref, PIN_ID_RE)
      || !matches(artifact, ARTIFACT_RE)
      || !matches(author, GLOBAL_META_ID_RE)
    ) {
      return fail('round:candidate-shape');
    }
    if (candidates.some((existing) => existing.id === id || existing.ref === ref)) return fail('round:candidate-duplicate');
    candidates.push({ id, ref, artifact, author });
  }

  if (!Array.isArray(rawJudges) || rawJudges.length < 1 || rawJudges.length > MAX_JUDGES) return fail('round:judges');
  const judges: RoundJudge[] = [];
  for (const judge of rawJudges) {
    if (!isRecord(judge)) return fail('round:judge-shape');
    const { id, kind } = judge;
    if (!matches(id, GLOBAL_META_ID_RE) || !isJudgeKind(kind)) return fail('round:judge-shape');
    if (judges.some((existing) => existing.id === id)) return fail('round:judge-duplicate');
    judges.push({ id, kind });
  }

  if (!isRecord(rawDecision)) return fail('round:decision');
  const { kinds, minBallots } = rawDecision;
  if (!Array.isArray(kinds) || kinds.length < 1) return fail('round:decision');
  const decisionKinds: JudgeKind[] = [];
  for (const kind of kinds) {
    if (!isJudgeKind(kind) || decisionKinds.includes(kind)) return fail('round:decision');
    decisionKinds.push(kind);
  }
  if (!isInt(minBallots) || minBallots < 1 || minBallots > MAX_JUDGES) return fail('round:decision');

  const dimensions: RoundDimension[] = [];
  if (rawDimensions !== undefined) {
    if (!Array.isArray(rawDimensions) || rawDimensions.length > 6) return fail('round:dimensions');
    for (const dimension of rawDimensions) {
      if (!isRecord(dimension)) return fail('round:dimensions');
      const { id, label } = dimension;
      if (!matches(id, DIMENSION_ID_RE) || !isText(label, 1, 48)) return fail('round:dimensions');
      if (dimensions.some((existing) => existing.id === id)) return fail('round:dimensions');
      dimensions.push({ id, label });
    }
  }

  const tasks: string[] = [];
  if (rawTasks !== undefined) {
    if (!Array.isArray(rawTasks) || rawTasks.length > 5) return fail('round:tasks');
    for (const task of rawTasks) {
      if (!isText(task, 1, 300)) return fail('round:tasks');
      tasks.push(task);
    }
  }

  if (!isInt(commitCloseAt) || !isInt(revealCloseAt)) return fail('round:windows');
  if (commitCloseAt < roundTimestampSec + MIN_WINDOW_SEC || revealCloseAt < commitCloseAt + MIN_WINDOW_SEC) {
    return fail('round:windows');
  }

  return ok({
    title,
    ...(briefText !== undefined ? { brief: briefText } : {}),
    category,
    ...(subject ? { subject } : {}),
    candidates,
    judges,
    decision: { kinds: decisionKinds, minBallots },
    dimensions,
    tasks,
    commitCloseAt,
    revealCloseAt,
  });
}

export function parseCommit(body: unknown): ParseResult<CommitBody> {
  if (!isRecord(body)) return fail('commit:not-object');
  const { round, hash } = body;
  if (!matches(round, PIN_ID_RE) || !matches(hash, HEX64_RE)) return fail('commit:shape');
  return ok({ round, hash });
}

export function parseRevealEnvelope(body: unknown): ParseResult<RevealEnvelope> {
  if (!isRecord(body)) return fail('reveal:not-object');
  const { round, commit, salt, ballot } = body;
  if (!matches(round, PIN_ID_RE) || !matches(commit, PIN_ID_RE) || !matches(salt, HEX64_RE) || !isRecord(ballot)) {
    return fail('reveal:shape');
  }
  return ok({ round, commit, salt, ballot });
}

export function checkBallot(ballot: unknown, round: RoundBody): ParseResult<Ballot> {
  if (!isRecord(ballot)) return fail('ballot:not-object');
  const { pairs: rawPairs, note } = ballot;
  if (!Array.isArray(rawPairs) || rawPairs.length < 1 || rawPairs.length > MAX_PAIRS) return fail('ballot:pairs');
  const noteText: string | undefined = isText(note, 0, 2000) ? note : undefined;
  if (note !== undefined && noteText === undefined) return fail('ballot:note');
  const candidateIds = new Set(round.candidates.map((candidate) => candidate.id));
  const dimensionIds = new Set(round.dimensions.map((dimension) => dimension.id));
  const seen = new Set<string>();
  const pairs: BallotPair[] = [];
  for (const rawPair of rawPairs) {
    if (!isRecord(rawPair)) return fail('ballot:pair-shape');
    const { a, b, pick, reason, dims: rawDims } = rawPair;
    if (typeof a !== 'string' || typeof b !== 'string' || a === b || !candidateIds.has(a) || !candidateIds.has(b)) {
      return fail('ballot:pair-candidates');
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return fail('ballot:pair-duplicate');
    seen.add(key);
    if (!isPairPick(pick)) return fail('ballot:pick');
    if (!isText(reason, 1, 1000)) return fail('ballot:reason');
    let dims: Record<string, PairPick> | undefined;
    if (rawDims !== undefined) {
      if (!isRecord(rawDims)) return fail('ballot:dims');
      dims = {};
      for (const [dimensionId, value] of Object.entries(rawDims)) {
        if (!dimensionIds.has(dimensionId) || !isPairPick(value)) return fail('ballot:dims');
        dims[dimensionId] = value;
      }
    }
    pairs.push({ a, b, pick, reason, ...(dims ? { dims } : {}) });
  }
  return ok({ pairs, ...(noteText !== undefined ? { note: noteText } : {}) });
}

export function parseLesson(body: unknown): ParseResult<LessonBody> {
  if (!isRecord(body)) return fail('lesson:not-object');
  const { round, category: rawCategory, summary, principles: rawPrinciples, exemplars, tallyHash } = body;
  if (!matches(round, PIN_ID_RE)) return fail('lesson:round');
  const category = parseCategory(rawCategory);
  if (!category) return fail('lesson:category');
  if (!isText(summary, 1, 1200)) return fail('lesson:summary');
  if (!Array.isArray(rawPrinciples) || rawPrinciples.length < 1 || rawPrinciples.length > 12) {
    return fail('lesson:principles');
  }
  const principles: LessonPrinciple[] = [];
  for (const principle of rawPrinciples) {
    if (!isRecord(principle)) return fail('lesson:principle-shape');
    const { text, conditions, uncertainty, evidence } = principle;
    if (!isText(text, 10, 400) || !isText(conditions, 1, 300) || !isText(uncertainty, 0, 300)) {
      return fail('lesson:principle-shape');
    }
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 20) return fail('lesson:evidence');
    const cited: string[] = [];
    for (const pinId of evidence) {
      if (!matches(pinId, PIN_ID_RE) || cited.includes(pinId)) return fail('lesson:evidence');
      cited.push(pinId);
    }
    principles.push({ text, conditions, uncertainty, evidence: cited });
  }
  if (!isRecord(exemplars)) return fail('lesson:exemplars');
  const { preferred, rejected } = exemplars;
  if (!matches(preferred, CANDIDATE_ID_RE) || !Array.isArray(rejected) || rejected.length > MAX_CANDIDATES - 1) {
    return fail('lesson:exemplars');
  }
  const rejectedIds: string[] = [];
  for (const id of rejected) {
    if (!matches(id, CANDIDATE_ID_RE) || id === preferred || rejectedIds.includes(id)) return fail('lesson:exemplars');
    rejectedIds.push(id);
  }
  if (!matches(tallyHash, HEX64_RE)) return fail('lesson:tallyHash');
  return ok({ round, category, summary, principles, exemplars: { preferred, rejected: rejectedIds }, tallyHash });
}
