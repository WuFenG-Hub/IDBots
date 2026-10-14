import { sha256Hex } from '../services/metatask/canon';
import type { MetaTaskTaskProjection } from '../services/metatask/types';
import { ARTIFACT_RE, PILOT_CANDIDATE_CAP } from '../services/preference/constants';
import type { RoundBody, RoundCandidate } from '../services/preference/types';

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
