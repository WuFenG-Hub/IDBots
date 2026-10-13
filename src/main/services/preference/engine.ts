import { canonJ, sha256Hex } from '../metatask/canon';
import { FINALITY_GRACE_SEC, PREFERENCE_TALLY_ENGINE } from './constants';
import { checkBallot, parseCommit, parseRevealEnvelope, parseRound } from './schemas';
import { ballotCommitHash } from './sealing';
import type {
  BallotPair,
  JudgeClass,
  PairPick,
  PreferenceChainEvent,
  RoundBody,
  TallyDiagnostics,
  TallyJudgeEntry,
  TallyOutput,
  TallyRankingEntry,
  TallyResult,
  TallyStatus,
} from './types';

type PointMatrix = Record<string, Record<string, number>>;

interface CountedBallot {
  author: string;
  commitPinId: string;
  revealPinId: string;
  judgeClass: JudgeClass;
  kind: TallyJudgeEntry['kind'];
  pairs: BallotPair[];
}

export type RoundResolution =
  | { ok: true; event: PreferenceChainEvent; round: RoundBody }
  | { ok: false; reason: string };

export type TallyRoundResult = { ok: true; result: TallyResult } | { ok: false; reason: string };

const byteCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const compareOrderKey = (a: PreferenceChainEvent, b: PreferenceChainEvent): number =>
  a.height - b.height || a.txIndex - b.txIndex || a.timestampMs - b.timestampMs || byteCompare(a.pinId, b.pinId);

const toSec = (ms: number): number => Math.floor(ms / 1000);

const isConfirmed = (event: PreferenceChainEvent): boolean => event.height >= 0;

export function resolveRound(events: readonly PreferenceChainEvent[], roundPinId: string): RoundResolution {
  const event = events.find((candidate) => candidate.path === 'round' && candidate.pinId === roundPinId);
  if (!event) return { ok: false, reason: 'round:not-found' };
  if (!isConfirmed(event)) return { ok: false, reason: 'round:unconfirmed' };
  const parsed = parseRound(event.body, toSec(event.timestampMs));
  // Literal comparisons: this project compiles without strictNullChecks, where
  // `!parsed.ok` does not narrow a discriminated union.
  return parsed.ok === true ? { ok: true, event, round: parsed.value } : { ok: false, reason: parsed.reason };
}

export function statusAt(round: RoundBody, nowSec: number, decidingBallots: number): TallyStatus {
  if (nowSec <= round.commitCloseAt) return 'collecting';
  if (nowSec <= round.revealCloseAt) return 'revealing';
  if (nowSec <= round.revealCloseAt + FINALITY_GRACE_SEC) return 'settling';
  return decidingBallots >= round.decision.minBallots ? 'decided' : 'no_decision';
}

const zeroMatrix = (ids: readonly string[]): PointMatrix => {
  const matrix: PointMatrix = {};
  for (const i of ids) {
    matrix[i] = {};
    for (const j of ids) if (j !== i) matrix[i][j] = 0;
  }
  return matrix;
};

const addPick = (matrix: PointMatrix, a: string, b: string, pick: PairPick): void => {
  if (pick === 'a') matrix[a][b] += 2;
  else if (pick === 'b') matrix[b][a] += 2;
  else {
    matrix[a][b] += 1;
    matrix[b][a] += 1;
  }
};

const subtract = (total: PointMatrix, part: PointMatrix | undefined): PointMatrix => {
  if (!part) return total;
  const out: PointMatrix = {};
  for (const i of Object.keys(total)) {
    out[i] = {};
    for (const j of Object.keys(total[i])) out[i][j] = total[i][j] - part[i][j];
  }
  return out;
};

const strictWinner = (matrix: PointMatrix, x: string, y: string): string | null =>
  matrix[x][y] > matrix[y][x] ? x : matrix[x][y] < matrix[y][x] ? y : null;

const pickedId = (pair: BallotPair): string | null => (pair.pick === 'a' ? pair.a : pair.pick === 'b' ? pair.b : null);

export function tallyRound(
  events: readonly PreferenceChainEvent[],
  roundPinId: string,
  options: { nowSec: number },
): TallyRoundResult {
  const resolved = resolveRound(events, roundPinId);
  if (resolved.ok === false) return resolved;
  const { event: roundEvent, round } = resolved;
  const ignored: TallyDiagnostics['ignored'] = [];
  const skip = (pinId: string, reason: string): void => {
    ignored.push({ pinId, reason });
  };

  const related = events
    .filter((event) => (event.path === 'commit' || event.path === 'reveal') && event.body.round === roundPinId)
    .sort(compareOrderKey);

  const effectiveCommit = new Map<string, { pinId: string; hash: string }>();
  for (const event of related) {
    if (event.path !== 'commit') continue;
    if (!isConfirmed(event)) { skip(event.pinId, 'commit:unconfirmed'); continue; }
    const parsed = parseCommit(event.body);
    if (parsed.ok === false) { skip(event.pinId, parsed.reason); continue; }
    if (compareOrderKey(event, roundEvent) <= 0) { skip(event.pinId, 'commit:before-round'); continue; }
    if (toSec(event.timestampMs) > round.commitCloseAt) { skip(event.pinId, 'commit:after-close'); continue; }
    if (!event.author) { skip(event.pinId, 'commit:no-author'); continue; }
    const previous = effectiveCommit.get(event.author);
    if (previous) skip(previous.pinId, 'commit:superseded');
    effectiveCommit.set(event.author, { pinId: event.pinId, hash: parsed.value.hash });
  }

  const judgeKinds = new Map(round.judges.map((judge) => [judge.id, judge.kind] as const));
  const authorOf = new Map(round.candidates.map((candidate) => [candidate.id, candidate.author] as const));
  const ballots: CountedBallot[] = [];
  const revealed = new Set<string>();
  for (const event of related) {
    if (event.path !== 'reveal') continue;
    if (!isConfirmed(event)) { skip(event.pinId, 'reveal:unconfirmed'); continue; }
    const parsed = parseRevealEnvelope(event.body);
    if (parsed.ok === false) { skip(event.pinId, parsed.reason); continue; }
    const at = toSec(event.timestampMs);
    if (at <= round.commitCloseAt) { skip(event.pinId, 'reveal:before-commit-close'); continue; }
    if (at > round.revealCloseAt) { skip(event.pinId, 'reveal:after-close'); continue; }
    const commit = effectiveCommit.get(event.author);
    if (!commit || commit.pinId !== parsed.value.commit) { skip(event.pinId, 'reveal:not-effective-commit'); continue; }
    if (revealed.has(event.author)) { skip(event.pinId, 'reveal:duplicate'); continue; }
    const expected = ballotCommitHash({
      round: roundPinId,
      judge: event.author,
      salt: parsed.value.salt,
      ballot: parsed.value.ballot,
    });
    if (expected !== commit.hash) { skip(event.pinId, 'reveal:hash-mismatch'); continue; }
    const checked = checkBallot(parsed.value.ballot, round);
    if (checked.ok === false) { skip(event.pinId, checked.reason); continue; }
    revealed.add(event.author);
    const kind = judgeKinds.get(event.author);
    const judgeClass: JudgeClass = kind === undefined ? 'public' : round.decision.kinds.includes(kind) ? 'deciding' : 'shadow';
    const pairs = checked.value.pairs.filter(
      (pair) => authorOf.get(pair.a) !== event.author && authorOf.get(pair.b) !== event.author,
    );
    ballots.push({
      author: event.author,
      commitPinId: commit.pinId,
      revealPinId: event.pinId,
      judgeClass,
      kind: kind ?? 'public',
      pairs,
    });
  }

  const ids = round.candidates.map((candidate) => candidate.id);
  const deciding = zeroMatrix(ids);
  const ownContribution = new Map<string, PointMatrix>();
  for (const counted of ballots) {
    if (counted.judgeClass !== 'deciding') continue;
    const own = zeroMatrix(ids);
    for (const pair of counted.pairs) {
      addPick(deciding, pair.a, pair.b, pair.pick);
      addPick(own, pair.a, pair.b, pair.pick);
    }
    ownContribution.set(counted.author, own);
  }

  const countClass = (judgeClass: JudgeClass): number =>
    ballots.filter((counted) => counted.judgeClass === judgeClass && counted.pairs.length > 0).length;
  const ballotCounts = { deciding: countClass('deciding'), shadow: countClass('shadow'), public: countClass('public') };

  const ranking: TallyRankingEntry[] = round.candidates
    .map((candidate) => {
      let wins = 0;
      let losses = 0;
      let ties = 0;
      let points = 0;
      for (const other of ids) {
        if (other === candidate.id) continue;
        const mine = deciding[candidate.id][other];
        const theirs = deciding[other][candidate.id];
        points += mine;
        if (mine > theirs) wins += 1;
        else if (mine < theirs) losses += 1;
        else ties += 1;
      }
      return { id: candidate.id, ref: candidate.ref, copeland: 2 * wins + ties, points, wins, losses, ties };
    })
    .sort((x, y) => y.copeland - x.copeland || y.points - x.points || byteCompare(x.ref, y.ref));

  const status = statusAt(round, options.nowSec, ballotCounts.deciding);

  const judges: TallyJudgeEntry[] = ballots
    .map((counted) => {
      const reference = counted.judgeClass === 'deciding' ? subtract(deciding, ownContribution.get(counted.author)) : deciding;
      let agreeN = 0;
      let agreeHits = 0;
      for (const pair of counted.pairs) {
        const winner = strictWinner(reference, pair.a, pair.b);
        if (winner === null) continue;
        agreeN += 1;
        if (pickedId(pair) === winner) agreeHits += 1;
      }
      return {
        id: counted.author,
        kind: counted.kind,
        class: counted.judgeClass,
        commit: counted.commitPinId,
        reveal: counted.revealPinId,
        pairs: counted.pairs.length,
        agreeN,
        agreeHits,
        agreementBP: Math.floor((10000 * (agreeHits + 1)) / (agreeN + 2)),
      };
    })
    .sort((x, y) => byteCompare(x.id, y.id));

  const dimensions: Record<string, Record<string, number>> = {};
  for (const dimension of round.dimensions) {
    const points: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const counted of ballots) {
      if (counted.judgeClass !== 'deciding') continue;
      for (const pair of counted.pairs) {
        const value = pair.dims?.[dimension.id];
        if (value === 'a') points[pair.a] += 2;
        else if (value === 'b') points[pair.b] += 2;
        else if (value === 'tie') {
          points[pair.a] += 1;
          points[pair.b] += 1;
        }
      }
    }
    dimensions[dimension.id] = points;
  }

  const evidence = ballots
    .filter((counted) => counted.judgeClass !== 'public' && counted.pairs.length > 0)
    .map((counted) => counted.revealPinId)
    .sort(byteCompare);

  const output: TallyOutput = {
    engine: PREFERENCE_TALLY_ENGINE,
    round: roundPinId,
    status,
    winner: status === 'decided' ? ranking[0].id : null,
    ranking,
    ballots: ballotCounts,
    judges,
    dimensions,
    evidence,
  };
  const final = status === 'decided' || status === 'no_decision';
  return {
    ok: true,
    result: {
      output,
      tallyHash: final ? sha256Hex(canonJ(output)) : null,
      diagnostics: { ignored, evaluatedAt: options.nowSec },
    },
  };
}
