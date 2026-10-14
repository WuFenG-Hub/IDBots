import { compareOrderKey, resolveRound, tallyRound } from './engine';
import { parseLesson } from './schemas';
import type { LessonBody, PreferenceChainEvent, TallyResult } from './types';

export type LessonVerdict = { ok: true; lesson: LessonBody } | { ok: false; reason: string };

export type CanonicalRoundResolution =
  | { state: 'decided'; roundPinId: string; result: TallyResult }
  | { state: 'pending'; roundPinId: string }
  | { state: 'none' };

export function checkLesson(body: unknown, tally: TallyResult): LessonVerdict {
  const parsed = parseLesson(body);
  if (parsed.ok === false) return parsed;
  const lesson = parsed.value;
  const { output, tallyHash } = tally;
  if (lesson.round !== output.round) return { ok: false, reason: 'lesson:round-mismatch' };
  if (output.status !== 'decided' || tallyHash === null) return { ok: false, reason: 'lesson:round-not-decided' };
  if (lesson.tallyHash !== tallyHash) return { ok: false, reason: 'lesson:tally-hash-mismatch' };
  if (lesson.exemplars.preferred !== output.winner) return { ok: false, reason: 'lesson:preferred-not-winner' };
  const candidateIds = new Set(output.ranking.map((entry) => entry.id));
  if (!lesson.exemplars.rejected.every((id) => candidateIds.has(id))) return { ok: false, reason: 'lesson:unknown-rejected' };
  const evidence = new Set(output.evidence);
  for (const principle of lesson.principles) {
    if (!principle.evidence.every((pinId) => evidence.has(pinId))) return { ok: false, reason: 'lesson:evidence-not-in-tally' };
  }
  return { ok: true, lesson };
}

export function verifyLessonPin(events: readonly PreferenceChainEvent[], lessonPinId: string, nowSec: number): LessonVerdict {
  const event = events.find((candidate) => candidate.path === 'lesson' && candidate.pinId === lessonPinId);
  if (!event) return { ok: false, reason: 'lesson:not-found' };
  const roundPinId = typeof event.body.round === 'string' ? event.body.round : '';
  const tally = tallyRound(events, roundPinId, { nowSec });
  if (tally.ok === false) return { ok: false, reason: tally.reason };
  return checkLesson(event.body, tally.result);
}

export function canonicalRoundForSubject(
  events: readonly PreferenceChainEvent[],
  subject: { taskid: string; node: string; rootAuthor: string },
  nowSec: number,
): CanonicalRoundResolution {
  const rounds = events
    .filter((event) => event.path === 'round' && event.author === subject.rootAuthor)
    .sort(compareOrderKey);
  for (const event of rounds) {
    const resolved = resolveRound(events, event.pinId);
    if (resolved.ok === false) continue;
    const roundSubject = resolved.round.subject;
    if (!roundSubject || roundSubject.taskid !== subject.taskid || roundSubject.node !== subject.node) continue;
    const tally = tallyRound(events, event.pinId, { nowSec });
    if (tally.ok === false) continue;
    const { status } = tally.result.output;
    if (status === 'no_decision') continue;
    if (status === 'decided') return { state: 'decided', roundPinId: event.pinId, result: tally.result };
    return { state: 'pending', roundPinId: event.pinId };
  }
  return { state: 'none' };
}
