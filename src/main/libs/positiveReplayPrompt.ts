import type { DreamDayActivity } from '../dreamStore';

/**
 * Positive replay — the 👍-symmetric counterpart of the counterfactual replay
 * (dream review P0, 2026-10-23).
 *
 * A thumbs-up today is only a transcript annotation; nothing reinforces the
 * praised behavior. This pass replays the day's praised decision points and
 * asks the bot's own LLM what exactly was praiseworthy and should be repeated.
 * A lesson is only kept when it clears a conservative deterministic quality
 * gate (repeatable + specific + grounded in the quoted reply) — generic
 * flattery never becomes memory. Passing lessons are written as
 * capability_drafts (origin 'positive_replay') so they flow through the
 * EXISTING validation/promotion pipeline instead of going straight to the
 * hot layer.
 *
 * Pure extraction + prompt builder + tolerant parser + gate; the DreamService
 * owns the LLM call and the draft writes. Mirrors counterfactualReplayPrompt.
 */

export const POSITIVE_REPLAY_MAX_POINTS = 3;
const CONTEXT_MESSAGE_MAX_CHARS = 300;
const PRAISED_ACTION_MAX_CHARS = 800;
const CONTEXT_WINDOW_MESSAGES = 6;
/** A kept lesson must be a real practice statement, not a one-line cheer. */
export const POSITIVE_LESSON_MIN_CHARS = 10;
/** A kept lesson must stay a single concise practice, not an essay. */
export const POSITIVE_LESSON_MAX_CHARS = 400;
export const POSITIVE_GROUNDING_MAX_CHARS = 300;

export interface PositiveDecisionPoint {
  /** Stable id echoed back by the LLM (`msg:...`). */
  id: string;
  /** What led up to the praised reply (up to 6 prior context messages). */
  situation: string;
  /** The praised assistant reply itself. */
  botAction: string;
  /** The recorded praise (thumbs-up, with the human's comment when present). */
  outcome: string;
}

export interface PositiveReplayPointResult {
  id: string;
  /** The LLM must explicitly affirm the practice is worth repeating. */
  repeatable: boolean;
  lesson: string;
  /** What exactly in the quoted reply was praiseworthy (the grounding). */
  grounding: string;
}

export type PositiveReplayParseResult =
  | { ok: true; results: PositiveReplayPointResult[] }
  | { ok: false; error: string };

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;

/**
 * Generic-flattery fragments: a lesson made only of these carries no
 * practice, so it never ships. Deliberately narrow — the deterministic gate,
 * not taste.
 */
const POSITIVE_FLATTERY_PATTERNS = [
  '做得很好',
  '做得不错',
  '回复很好',
  '表现很好',
  '值得表扬',
  '值得肯定',
  '继续保持',
  '用户满意',
  '令人满意',
  '回复得不错',
  '非常棒',
];

const stripFlattery = (text: string): string => {
  let remaining = text;
  for (const pattern of POSITIVE_FLATTERY_PATTERNS) {
    remaining = remaining.split(pattern).join('');
  }
  return remaining.replace(/[\s,。,.!！?？~～、;；:："“”'‘’()（）\[\]【】]/g, '');
};

/** Character bigrams over letters/CJK runs; grounding-overlap evidence. */
const contentBigrams = (text: string): Set<string> => {
  const chars = [...text].filter((char) => /[\p{L}\p{N}]/u.test(char));
  const grams = new Set<string>();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    grams.add(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
};

/**
 * Pull the day's praised decision points out of the dream activity: assistant
 * messages the human thumbed UP, conversational context included. Commented
 * thumbs-up sort first (the comment is ground truth for what to repeat);
 * capped at POSITIVE_REPLAY_MAX_POINTS per day.
 */
export function extractPositiveDecisionPoints(
  activity: DreamDayActivity,
  maxPoints: number = POSITIVE_REPLAY_MAX_POINTS,
): PositiveDecisionPoint[] {
  const praised: Array<{ point: PositiveDecisionPoint; hasComment: boolean }> = [];
  for (const session of activity.sessions) {
    session.messages.forEach((message, index) => {
      if (message.type !== 'assistant' || message.feedbackRating !== 'up') return;
      const context = session.messages
        .slice(Math.max(0, index - CONTEXT_WINDOW_MESSAGES), index)
        .map((entry) => `${entry.type === 'user' ? '对方' : '我'}: ${truncate(entry.content.replace(/\s+/g, ' ').trim(), CONTEXT_MESSAGE_MAX_CHARS)}`)
        .join('\n');
      const comment = message.feedbackComment?.trim() ?? '';
      praised.push({
        hasComment: comment.length > 0,
        point: {
          id: `msg:${session.sessionId}:${index}`,
          situation: [
            `会话「${session.title}」${session.peerName ? `(与 ${session.peerName})` : ''}:`,
            context || '(该回复之前没有更多上下文)',
          ].join('\n'),
          botAction: truncate(message.content.replace(/\s+/g, ' ').trim(), PRAISED_ACTION_MAX_CHARS),
          outcome: `人类对这条回复点了赞${comment ? `,并留言:「${truncate(comment, 200)}」` : '。(无留言)'}`,
        },
      });
    });
  }
  praised.sort((a, b) => Number(b.hasComment) - Number(a.hasComment));
  return praised
    .map((entry) => entry.point)
    .slice(0, Math.max(1, maxPoints));
}

export function buildPositiveReplayPrompt(input: {
  botName: string;
  date: string;
  points: PositiveDecisionPoint[];
}): { system: string; user: string } {
  const system = [
    `你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`,
    '现在是你的夜间整理时间(做梦)的「正向重放」环节。下面列出今天几个人类明确点赞的决策点。',
    '对每个决策点,你要做两件事:',
    '1. 仔细对照被点赞的那条回复原文,指出它具体好在哪里——「grounding」必须引用回复里的具体做法(结构、措辞、步骤、时机),不许写泛泛的夸奖。',
    '2. 判断这个做法是否值得在未来重复:只有当你能说出「下次遇到什么情况,照这个做法做」时,repeatable 才为 true;任何犹豫都写 false,lesson 留空。',
    'lesson 要写成一条具体、可操作的复用做法(什么情况下、怎么做),不要写成自我表扬。',
    '以置身事外的观察者视角审视,不要夸大,也不要为了产出而强行提炼。',
  ].join('\n');

  const pointBlocks = input.points.map((point, index) => [
    `### 决策点 ${point.id}(第 ${index + 1} 个)`,
    '情境:',
    point.situation,
    '被点赞的回复:',
    point.botAction,
    '记录的认可:',
    point.outcome,
  ].join('\n'));

  const user = [
    `今天是 ${input.date}。请对以下 ${input.points.length} 个被点赞的决策点做正向重放。`,
    '',
    ...pointBlocks,
    '',
    '## 输出契约(严格只输出一个 JSON 对象,不要输出任何其他文字)',
    '{',
    '  "results": [',
    '    {',
    '      "id": "决策点id(原样照抄)",',
    '      "repeatable": true或false,',
    '      "lesson": "值得重复的具体做法(仅当 repeatable 为 true,否则为空字符串)",',
    '      "grounding": "被赞回复里具体好在哪里的对照说明(必须引用回复原文)"',
    '    }',
    '  ]',
    '}',
    '每个决策点一条 result;id 必须来自上方列表;没有值得重复的做法时,该点的 repeatable 写 false。',
  ].join('\n');

  return { system, user };
}

/**
 * Tolerant parser mirroring parseCounterfactualReplayOutput: strips code
 * fences, takes the outermost braces, drops results with unknown ids.
 */
export function parsePositiveReplayOutput(
  raw: string,
  validIds: ReadonlySet<string>,
): PositiveReplayParseResult {
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
  const root = parsed as Record<string, unknown>;
  const list = Array.isArray(root?.results) ? root.results : null;
  if (!list) return { ok: false, error: 'missing results array' };

  const results: PositiveReplayPointResult[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const id = String(entry?.id ?? '').trim();
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      repeatable: entry?.repeatable === true,
      lesson: String(entry?.lesson ?? '').trim(),
      grounding: String(entry?.grounding ?? '').trim(),
    });
  }
  if (results.length === 0) return { ok: false, error: 'no usable results' };
  return { ok: true, results };
}

/**
 * The conservative promotion decision, kept pure for tests: a lesson ships
 * only when the model affirmed repeatability, the lesson has substance beyond
 * generic flattery, stays inside the size window, and the grounding is
 * actually anchored in the quoted reply (character-bigram overlap).
 */
export function pickPositiveLesson(
  result: PositiveReplayPointResult,
  point: PositiveDecisionPoint,
): string | null {
  if (!result.lesson) return null;
  if (result.repeatable !== true) return null;
  if (result.lesson.length < POSITIVE_LESSON_MIN_CHARS) return null;
  if (result.lesson.length > POSITIVE_LESSON_MAX_CHARS) return null;
  if (stripFlattery(result.lesson).length < 8) return null;
  const grounding = result.grounding.trim();
  if (grounding.length < 4 || grounding.length > POSITIVE_GROUNDING_MAX_CHARS) return null;
  const replyGrams = contentBigrams(point.botAction);
  if (replyGrams.size === 0) return grounding ? result.lesson : null;
  const groundingGrams = contentBigrams(grounding);
  let shared = 0;
  for (const gram of groundingGrams) {
    if (replyGrams.has(gram)) shared += 1;
  }
  if (shared === 0) return null;
  return result.lesson;
}
