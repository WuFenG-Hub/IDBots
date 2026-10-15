/**
 * Pure helpers for the preference compare panel. Plain JS (like
 * groupTaskUtils.js) so node --test can import it directly.
 */

export const MAX_REASON_CHARS = 1000;

const fnv1a = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

export function buildPairSchedule(judgeId, roundPinId, candidates) {
  const ids = candidates
    .filter((candidate) => !candidate.own)
    .map((candidate) => candidate.id)
    .sort();
  const slots = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = pairKey(ids[i], ids[j]);
      const seed = fnv1a(`${roundPinId}|${judgeId}|${key}`);
      const swap = (seed & 1) === 1;
      slots.push({ key, left: swap ? ids[j] : ids[i], right: swap ? ids[i] : ids[j], seed });
    }
  }
  return slots
    .sort((x, y) => x.seed - y.seed || (x.key < y.key ? -1 : 1))
    .map(({ key, left, right }) => ({ key, left, right }));
}

const CHOICE_TO_PICK = { left: 'a', right: 'b', tie: 'tie' };
const PICK_TO_CHOICE = { a: 'left', b: 'right', tie: 'tie' };

export function answersToBallot(schedule, answers, note) {
  const pairs = schedule.flatMap((slot) => {
    const answer = answers[slot.key];
    if (!answer || !CHOICE_TO_PICK[answer.choice]) return [];
    const dims = Object.fromEntries(
      Object.entries(answer.dims ?? {})
        .filter(([, choice]) => CHOICE_TO_PICK[choice])
        .map(([dimension, choice]) => [dimension, CHOICE_TO_PICK[choice]]),
    );
    return [
      {
        a: slot.left,
        b: slot.right,
        pick: CHOICE_TO_PICK[answer.choice],
        reason: String(answer.reason ?? '').trim(),
        ...(Object.keys(dims).length > 0 ? { dims } : {}),
      },
    ];
  });
  const trimmedNote = String(note ?? '').trim();
  return trimmedNote ? { pairs, note: trimmedNote } : { pairs };
}

export function ballotToAnswers(schedule, ballot) {
  const out = {};
  for (const pair of ballot?.pairs ?? []) {
    const slot = schedule.find((entry) => entry.key === pairKey(pair.a, pair.b));
    if (!slot) continue;
    const flipped = slot.left !== pair.a;
    const toChoice = (pick) => {
      const choice = PICK_TO_CHOICE[pick];
      if (!flipped || choice === 'tie') return choice;
      return choice === 'left' ? 'right' : 'left';
    };
    out[slot.key] = {
      choice: toChoice(pair.pick),
      reason: pair.reason,
      dims: Object.fromEntries(Object.entries(pair.dims ?? {}).map(([dimension, pick]) => [dimension, toChoice(pick)])),
    };
  }
  return out;
}

export function pairAnswerError(answer) {
  if (!answer || !CHOICE_TO_PICK[answer.choice]) return 'missing-choice';
  const length = [...String(answer.reason ?? '').trim()].length;
  if (length === 0) return 'missing-reason';
  if (length > MAX_REASON_CHARS) return 'reason-too-long';
  return null;
}

export function scheduleProgress(schedule, answers) {
  const done = schedule.filter((slot) => pairAnswerError(answers[slot.key]) === null).length;
  return { done, total: schedule.length, complete: schedule.length > 0 && done === schedule.length };
}

export function remainingParts(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (total < 60) return { kind: 'now', d: 0, h: 0, m: 0 };
  if (d > 0) return { kind: 'dh', d, h, m: 0 };
  if (h > 0) return { kind: 'hm', d: 0, h, m };
  return { kind: 'm', d: 0, h: 0, m };
}
