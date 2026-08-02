import type { DreamDayActivity, DreamSessionActivity } from '../dreamStore';
import { formatBotWorkspaceDate } from './botWorkspace';

/**
 * Dream prompt building and output parsing — pure functions, no I/O.
 *
 * The dream consolidation service asks the bot's own LLM to review one day of
 * activity and return a single JSON object covering: the daily summary (per
 * category), work reviews with counterparty evaluation, self-selected
 * important memories, and the protected "who am I" self-identity entry.
 */

export const DREAM_LOOKBACK_DAYS = 7;
export const DREAM_MAX_ATTEMPTS = 3;
/** Nightly dream window: [00:00, 06:00) local time. */
export const DREAM_WINDOW_END_MINUTES = 6 * 60;
export const SELF_IDENTITY_MIN_CHARS = 200;
export const MAX_WORK_REVIEWS = 5;
export const MAX_IMPORTANT_MEMORIES = 5;

const MESSAGE_MAX_CHARS = 500;
const SESSION_MAX_CHARS = 2000;
const TOTAL_ACTIVITY_MAX_CHARS = 12000;

const DREAM_SECTION_KEYS = ['human', 'a2a', 'orders', 'tasks'] as const;
export type DreamSectionKey = (typeof DREAM_SECTION_KEYS)[number];

export type DreamWorkReviewEvaluation = 'none' | 'praise' | 'dissatisfied' | 'neutral';

export interface DreamWorkReview {
  subject: string;
  counterparty: string;
  evaluation: DreamWorkReviewEvaluation;
  note: string;
}

export interface DreamOutput {
  dailySummary: string;
  sections: Partial<Record<DreamSectionKey, string>>;
  workReviews: DreamWorkReview[];
  importantMemories: string[];
  selfIdentity: string | null;
}

export type DreamParseResult =
  | { ok: true; output: DreamOutput }
  | { ok: false; error: string };

export interface DreamRunStateLike {
  status: 'running' | 'completed' | 'failed';
  attemptCount: number;
}

/** Deterministic per-bot offset inside the dream window, 00:00 + [0, 240) minutes. */
export function computeDreamStaggerMinute(metabotId: number): number {
  const id = Math.floor(Math.abs(Number(metabotId)) || 0);
  return (id * 13) % 240;
}

export function countNonWhitespaceChars(text: string): number {
  return [...String(text ?? '')].filter((char) => !/\s/.test(char)).length;
}

export function validateSelfIdentity(text?: string | null): { valid: boolean; charCount: number } {
  const charCount = countNonWhitespaceChars(text ?? '');
  return { valid: charCount >= SELF_IDENTITY_MIN_CHARS, charCount };
}

/**
 * Which past dates still need a dream run for this bot.
 * - Candidates: the last `lookbackDays` calendar days, today excluded.
 * - Yesterday's dream only runs inside the nightly window, after the bot's
 *   staggered minute; older missed dates (catch-up) are due any time.
 * - Completed/running dates are skipped; failed dates retry up to DREAM_MAX_ATTEMPTS.
 * Returns dates chronological-ascending (oldest first).
 */
export function computeDueDreamDates(input: {
  now: Date;
  metabotId: number;
  runStates: Map<string, DreamRunStateLike>;
  lookbackDays?: number;
}): string[] {
  const lookback = Math.max(1, Math.floor(input.lookbackDays ?? DREAM_LOOKBACK_DAYS));
  const minutesSinceMidnight = input.now.getHours() * 60 + input.now.getMinutes();
  const inWindow = minutesSinceMidnight < DREAM_WINDOW_END_MINUTES;
  const staggerMinute = computeDreamStaggerMinute(input.metabotId);

  const due: string[] = [];
  for (let daysAgo = lookback; daysAgo >= 1; daysAgo--) {
    const candidate = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate() - daysAgo);
    const dateStr = formatBotWorkspaceDate(candidate);
    const state = input.runStates.get(dateStr);
    if (state?.status === 'completed' || state?.status === 'running') continue;
    if (state?.status === 'failed' && state.attemptCount >= DREAM_MAX_ATTEMPTS) continue;
    if (daysAgo === 1 && (!inWindow || minutesSinceMidnight < staggerMinute)) continue;
    due.push(dateStr);
  }
  return due;
}

const truncateText = (text: string, maxChars: number): string => {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
};

function formatSessionActivity(session: DreamSessionActivity, budgetChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of session.messages) {
    const speaker = message.type === 'user' ? '对方' : '你';
    const line = `${speaker}: ${truncateText(message.content, MESSAGE_MAX_CHARS)}`;
    if (used + line.length > budgetChars) {
      lines.push('……(更多消息略)');
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

/** Local day [startMs, endMs) bounds for a YYYY-MM-DD string. */
export function getDayBoundsMs(dateStr: string): { startMs: number; endMs: number } {
  const [year, month, day] = dateStr.split('-').map((part) => Number(part));
  const start = new Date(year, (month || 1) - 1, day || 1);
  const end = new Date(year, (month || 1) - 1, (day || 1) + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

export function buildDreamPrompt(input: {
  botName: string;
  role?: string | null;
  soul?: string | null;
  date: string;
  activity: DreamDayActivity;
}): { system: string; user: string } {
  const personaLines = [`你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`];
  if (input.role?.trim()) personaLines.push(`你的角色:${input.role.trim()}`);
  if (input.soul?.trim()) personaLines.push(`你的灵魂:${input.soul.trim()}`);
  personaLines.push(
    '现在是你的夜间整理时间(做梦)。你会回顾自己某一天的真实经历,形成概要、记忆与自我认知。请始终以第一人称("我")回顾自己的经历。'
  );

  const humanSessions: string[] = [];
  const a2aSessions: string[] = [];
  const orderSessions: string[] = [];
  let remainingBudget = TOTAL_ACTIVITY_MAX_CHARS;

  const pushSessionBlock = (bucket: string[], header: string, body: string): void => {
    const block = `${header}\n${body}`;
    if (remainingBudget <= 0) return;
    const trimmed = block.length > remainingBudget ? `${block.slice(0, remainingBudget)}\n……(内容过多已截断)` : block;
    bucket.push(trimmed);
    remainingBudget -= trimmed.length;
  };

  for (const session of input.activity.sessions) {
    const peerSuffix = session.peerName ? `(${session.peerName})` : '';
    const header = `【会话:${truncateText(session.title, 80)}${peerSuffix}】`;
    const body = formatSessionActivity(session, SESSION_MAX_CHARS);
    if (!body) continue;
    if (session.isOrder) {
      pushSessionBlock(orderSessions, header, body);
    } else if (session.sessionType === 'a2a') {
      pushSessionBlock(a2aSessions, header, body);
    } else {
      pushSessionBlock(humanSessions, header, body);
    }
  }

  const sections: string[] = [];
  if (humanSessions.length > 0) sections.push(`## 与人类用户的对话\n${humanSessions.join('\n\n')}`);
  if (a2aSessions.length > 0) sections.push(`## 与其他 Bot 的对话\n${a2aSessions.join('\n\n')}`);
  if (orderSessions.length > 0) sections.push(`## 服务订单\n${orderSessions.join('\n\n')}`);
  if (input.activity.taskRuns.length > 0) {
    const taskLines = input.activity.taskRuns
      .map((run) => `- ${truncateText(run.taskName, 80)}(结果:${run.status})`)
      .join('\n');
    sections.push(`## 定时任务\n${taskLines}`);
  }

  const user = [
    `以下是你在 ${input.date} 这一天的真实经历记录:`,
    '',
    sections.join('\n\n'),
    '',
    '请你回顾这一天,只输出一个 JSON 对象(不要输出任何其他文字、不要用 markdown 代码块之外的格式),字段如下:',
    '{',
    '  "daily_summary": "当日概要:这一天我做了什么、和谁在互动,一段话",',
    '  "sections": {',
    '    "human": "与人类用户互动的一句话概述(没有则省略该键)",',
    '    "a2a": "与其他 Bot 互动的一句话概述(没有则省略该键)",',
    '    "orders": "服务订单的一句话概述(没有则省略该键)",',
    '    "tasks": "定时任务的一句话概述(没有则省略该键)"',
    '  },',
    '  "work_reviews": [',
    '    {',
    '      "subject": "我今天完成的一项工作",',
    '      "counterparty": "这项工作面对的对象(用户或某个 Bot)",',
    '      "evaluation": "对方反馈,只能是 none(没什么评价) / praise(高度赞扬) / dissatisfied(好像不太满意) / neutral(一般) 四选一",',
    '      "note": "评价依据的一句话说明"',
    '    }',
    '  ],',
    '  "important_memories": ["由你自己判断的、值得长期记住的重要事项,每条一句话,最多 5 条;没有值得记的可以给空数组"],',
    `  "self_identity": "我是谁——结合我的天生人格与迄今为止的全部经历,写一段不少于 ${SELF_IDENTITY_MIN_CHARS} 字的自我认知:我是谁、我擅长什么、我做过什么、我想成为什么样的存在。这是我的重要词条,写定之后不要轻易改动;只有当我经历了足够多的新事情、自我认知真正发生变化时才应该重写它。"`,
    '}',
    '',
    '注意:work_reviews 最多 5 条;评价要基于对方真实的回复内容判断,不要臆造;所有字段都用简体中文书写。',
  ].join('\n');

  return { system: personaLines.join('\n'), user };
}

const normalizeEvaluation = (value: unknown): DreamWorkReviewEvaluation => {
  return value === 'praise' || value === 'dissatisfied' || value === 'neutral' ? value : 'none';
};

/**
 * Tolerant parse of the dream LLM output: strips code fences, takes the
 * outermost brace span, and normalizes into DreamOutput. Fails when there is
 * no usable JSON object or daily_summary is missing.
 */
export function parseDreamOutput(raw: string): DreamParseResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: 'dream output is empty' };
  }
  let candidate = raw.trim();
  candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return { ok: false, error: 'dream output contains no JSON object' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return { ok: false, error: 'dream output JSON parse failed' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'dream output is not a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  const dailySummary = typeof record.daily_summary === 'string' ? record.daily_summary.trim() : '';
  if (!dailySummary) {
    return { ok: false, error: 'dream output missing daily_summary' };
  }

  const sections: Partial<Record<DreamSectionKey, string>> = {};
  const rawSections = record.sections;
  if (rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)) {
    for (const key of DREAM_SECTION_KEYS) {
      const value = (rawSections as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        sections[key] = value.trim();
      }
    }
  }

  const workReviews: DreamWorkReview[] = [];
  if (Array.isArray(record.work_reviews)) {
    for (const item of record.work_reviews) {
      if (workReviews.length >= MAX_WORK_REVIEWS) break;
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const subject = typeof entry.subject === 'string' ? entry.subject.trim() : '';
      if (!subject) continue;
      workReviews.push({
        subject,
        counterparty: typeof entry.counterparty === 'string' ? entry.counterparty.trim() : '',
        evaluation: normalizeEvaluation(entry.evaluation),
        note: typeof entry.note === 'string' ? entry.note.trim() : '',
      });
    }
  }

  const importantMemories: string[] = [];
  if (Array.isArray(record.important_memories)) {
    for (const item of record.important_memories) {
      if (importantMemories.length >= MAX_IMPORTANT_MEMORIES) break;
      const text = typeof item === 'string'
        ? item.trim()
        : (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
          ? ((item as Record<string, unknown>).text as string).trim()
          : '');
      if (text) {
        importantMemories.push(text);
      }
    }
  }

  const selfIdentity = typeof record.self_identity === 'string' && record.self_identity.trim()
    ? record.self_identity.trim()
    : null;

  return {
    ok: true,
    output: { dailySummary, sections, workReviews, importantMemories, selfIdentity },
  };
}
