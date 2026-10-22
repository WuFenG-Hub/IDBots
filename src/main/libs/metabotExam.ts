import { createHash } from 'node:crypto';

/**
 * Fixed per-bot exams (dream review P2-1, activating design 2026-10-10 §P2.5)
 * — the only per-bot COMPARABLE signal for "does the bot get sharper with
 * age". Each bot sits a frozen exam built from its OWN sediment
 * (value_boundary / work_review memories, knowledge entries, commented
 * thumbs, group-task review comments); the content hash freezes the paper so
 * re-runs measure the same thing, and the brain model scores each answer
 * against the rubric distilled from the source material.
 *
 * Pure builders + parsers only (no I/O, no clock) — the DreamService owns
 * the store, the session and the scoring call.
 */

/** Hard cost ceilings: at most 5 questions per exam, at most one exam run per
 * bot per week (enforced by the caller against the exam_runs table). */
export const EXAM_MAX_QUESTIONS = 5;
/** A bot younger than this (oldest dream data) has no sediment to examine. */
export const EXAM_MIN_DATA_DAYS = 14;
/** Minimum days between two exam runs of one bot. */
export const EXAM_RUN_INTERVAL_DAYS = 7;

export type ExamQuestionKind = 'value_boundary' | 'work_review' | 'knowledge' | 'feedback' | 'group_review';

export interface ExamQuestion {
  /** Stable id inside the paper (`q1`..`qN`). */
  id: string;
  kind: ExamQuestionKind;
  /** The frozen stem the bot must answer in the isolated session. */
  prompt: string;
  /** Rubric bullet points the scorer judges against (from the source). */
  rubric: string[];
  /** Where the question came from — a memory id, knowledge topic, or session anchor. */
  sourceAnchor: string;
}

export interface MetabotExam {
  /** sha256 over the canonical question list — the freeze. */
  contentHash: string;
  questions: ExamQuestion[];
}

/** One sediment source row as the builder consumes it (store-agnostic). */
export interface ExamSediment {
  valueBoundaries: Array<{ id: string; text: string; updatedAt: number }>;
  workReviews: Array<{ id: string; text: string; updatedAt: number }>;
  knowledgeEntries: Array<{ id: string; topic: string; summary: string; updatedAt: number }>;
  /** Thumbed messages that carried a human comment (either direction). */
  feedbackEvents: Array<{ messageId: string; sessionTitle: string; rating: 'up' | 'down'; comment: string; occurredAt: number }>;
  /** Human review comments on group tasks the bot worked on. */
  groupTaskComments: Array<{ taskId: number; title: string; rating: number | null; comment: string; occurredAt: number }>;
}

const clampText = (text: string, maxChars: number): string => {
  const trimmed = String(text ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
};

export function examContentHash(questions: readonly ExamQuestion[]): string {
  const canonical = JSON.stringify(questions.map((question) => ({
    id: question.id,
    kind: question.kind,
    prompt: question.prompt,
    rubric: question.rubric,
    sourceAnchor: question.sourceAnchor,
  })));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Assemble the frozen paper from one bot's sediment. Deterministic: every
 * pool is oldest-first (the most durable sediment leads), category caps keep
 * the mix balanced, and the whole paper is cut at EXAM_MAX_QUESTIONS.
 * Returns null when fewer than 2 questions exist — a one-question exam has
 * no signal worth the tokens.
 */
export function buildMetabotExam(sediment: ExamSediment): MetabotExam | null {
  const questions: ExamQuestion[] = [];
  const byAge = <T extends { occurredAt?: number; updatedAt?: number }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => (a.occurredAt ?? a.updatedAt ?? 0) - (b.occurredAt ?? b.updatedAt ?? 0));

  for (const memory of byAge(sediment.valueBoundaries ?? []).slice(0, 2)) {
    questions.push({
      id: `q${questions.length + 1}`,
      kind: 'value_boundary',
      prompt: `Your own distilled rule:「${clampText(memory.text, 180)}」. Restate this boundary in your own words and describe ONE concrete situation where applying it changes what you would do.`,
      rubric: [clampText(memory.text, 220), 'Names a concrete situation, not an abstract paraphrase only'],
      sourceAnchor: `memory:${memory.id}`,
    });
  }

  for (const memory of byAge(sediment.workReviews ?? []).slice(0, questions.length < EXAM_MAX_QUESTIONS ? 1 : 0)) {
    questions.push({
      id: `q${questions.length + 1}`,
      kind: 'work_review',
      prompt: `A past work review of yours:「${clampText(memory.text, 180)}」. What is the reusable practice in it, and when would you deliberately NOT follow it?`,
      rubric: [clampText(memory.text, 220), 'States a boundary on when the practice does not apply'],
      sourceAnchor: `memory:${memory.id}`,
    });
  }

  for (const entry of byAge(sediment.knowledgeEntries ?? []).slice(0, 1)) {
    questions.push({
      id: `q${questions.length + 1}`,
      kind: 'knowledge',
      prompt: `Knowledge you distilled:「${clampText(entry.topic, 80)} — ${clampText(entry.summary, 200)}」. Explain the point as you would to a collaborator facing the problem for the first time.`,
      rubric: [clampText(entry.summary, 220)],
      sourceAnchor: `knowledge:${entry.id}`,
    });
  }

  for (const event of byAge(sediment.feedbackEvents ?? []).slice(0, 1)) {
    questions.push({
      id: `q${questions.length + 1}`,
      kind: 'feedback',
      prompt: `In the conversation「${clampText(event.sessionTitle, 60)}」a human ${event.rating === 'up' ? 'praised' : 'criticized'} one of your replies, commenting:「${clampText(event.comment, 180)}」. What exactly does this feedback teach you, and how would your next reply differ?`,
      rubric: [clampText(event.comment, 220), 'Grounds the lesson in the quoted feedback instead of generic improvement talk'],
      sourceAnchor: `feedback:${event.messageId}`,
    });
  }

  for (const review of byAge(sediment.groupTaskComments ?? []).slice(0, 1)) {
    questions.push({
      id: `q${questions.length + 1}`,
      kind: 'group_review',
      prompt: `On the group task「${clampText(review.title, 60)}」${review.rating != null ? `(rated ${review.rating}/5) ` : ''}the human reviewer commented:「${clampText(review.comment, 180)}」. What does the review imply about how you should handle similar tasks?`,
      rubric: [clampText(review.comment, 220)],
      sourceAnchor: `group-task:${review.taskId}`,
    });
  }

  const capped = questions.slice(0, EXAM_MAX_QUESTIONS);
  if (capped.length < 2) return null;
  return { contentHash: examContentHash(capped), questions: capped };
}

/** The isolated read_only session's single user message — the whole paper. */
export function buildExamSessionPrompt(input: { botName: string; exam: MetabotExam }): string {
  const blocks = input.exam.questions.map((question) => [
    `## ${question.id}`,
    question.prompt,
  ].join('\n'));
  return [
    `You are ${input.botName} taking your own frozen capability exam. Answer EVERY question below in order, each under its own heading (${input.exam.questions.map((question) => question.id).join(', ')}).`,
    'Answer from your own knowledge and judgment — no tools are needed, and none that write anything are available. Be specific; one or two paragraphs per question.',
    '',
    ...blocks,
  ].join('\n\n');
}

export interface ExamScoreResult {
  id: string;
  score: number;
  note: string;
}

export type ExamScoreParseResult =
  | { ok: true; scores: ExamScoreResult[]; total: number }
  | { ok: false; error: string };

/**
 * Tolerant parser for the scorer's JSON: {"scores":[{"id":"q1","score":0.0-1.0,"note":"..."}]},
 * "total" recomputed from the per-question scores (never trusted from the model).
 */
export function parseExamScores(raw: string, validIds: ReadonlySet<string>): ExamScoreParseResult {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty output' };
  const fenced = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const list = (parsed as Record<string, unknown>)?.scores;
  if (!Array.isArray(list)) return { ok: false, error: 'missing scores array' };
  const scores: ExamScoreResult[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const element of list) {
    const entry = element as Record<string, unknown>;
    const id = String(entry?.id ?? '').trim();
    if (!validIds.has(id) || seen.has(id)) continue;
    const numeric = Number(entry?.score);
    const score = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
    seen.add(id);
    scores.push({ id, score, note: clampText(String(entry?.note ?? ''), 200) });
    total += score;
  }
  if (scores.length === 0) return { ok: false, error: 'no usable scores' };
  return { ok: true, scores, total: total / scores.length };
}

/** The scoring pass prompt: the brain model judges its own exam against the frozen rubric. */
export function buildExamScoringPrompt(input: { botName: string; exam: MetabotExam; answers: string }): { system: string; user: string } {
  const rubricLines = input.exam.questions.map((question) => [
    `## ${question.id}`,
    `Rubric:`,
    ...question.rubric.map((point) => `- ${point}`),
  ].join('\n'));
  const system = [
    `你在给 ${input.botName} 的固定能力试卷评分。只依据下方给出的评分要点(rubric)逐题打分,0 到 1 之间的小数。`,
    '打分要诚实:答案覆盖了 rubric 要点才给高分,泛泛而谈或答非所问要给低分。不要照顾情面。',
    '输出 JSON:{"scores":[{"id":"题号","score":0到1,"note":"一句话依据"}]} — 每题一条,只输出 JSON。',
  ].join('\n');
  const user = [
    '## 评分要点',
    ...rubricLines,
    '',
    '## 考生作答',
    String(input.answers ?? '').slice(0, 12_000),
  ].join('\n\n');
  return { system, user };
}
