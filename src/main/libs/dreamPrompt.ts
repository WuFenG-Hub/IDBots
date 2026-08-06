import type { DreamDayActivity, DreamSessionActivity } from '../dreamStore';
import { formatBotWorkspaceDate } from './botWorkspace';
import { estimateCoworkTextTokens } from './coworkContextBudget';
import type { DreamActivityChunk } from './dreamFragments';

/**
 * Dream prompt building and output parsing — pure functions, no I/O.
 *
 * The dream consolidation service asks the bot's own LLM to review one day of
 * activity and return a single JSON object covering: the daily summary (per
 * category), work reviews with counterparty evaluation, self-selected
 * important memories, and the protected "who am I" self-identity entry.
 */

export const DREAM_LOOKBACK_DAYS = 7;
/** Retry failed dream runs with bounded exponential backoff instead of
 * abandoning a date after a short burst of transient failures. */
export const DREAM_RETRY_BASE_DELAY_MS = 30 * 60 * 1000;
export const DREAM_RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** Nightly dream window: [00:00, 06:00) local time. */
export const DREAM_WINDOW_END_MINUTES = 6 * 60;
/**
 * Dream algorithm version, recorded on every run. Bump it on any change to the
 * prompt, budgeting, stats or write semantics — completed in-window dates with
 * an older version are then re-dreamed automatically (limited per night).
 * Rows written before versioning existed read as 0.
 */
export const DREAM_VERSION = 3;
/** Default activity input budget for a day-level prompt, measured in tokens. */
export const DREAM_ACTIVITY_DEFAULT_TOKEN_BUDGET = 48_000;
export const SELF_IDENTITY_MIN_CHARS = 200;
export const MAX_WORK_REVIEWS = 5;
export const MAX_IMPORTANT_MEMORIES = 5;
export const MAX_VALUE_LESSONS = 3;

const DREAM_SECTION_KEYS = ['human', 'a2a', 'orders', 'tasks'] as const;
export type DreamSectionKey = (typeof DREAM_SECTION_KEYS)[number];

/**
 * Relationship-temperature trajectory of a conversation, judged from tone,
 * reply length and initiative shifts across the whole exchange — never from
 * literal "满意/不满意" keywords. warming = the exchange got more genuine,
 * useful and trusting; cooling = the counterparty grew colder, so the bot's
 * behavior pattern needs adjustment.
 */
export type DreamWorkReviewEvaluation = 'warming' | 'stable' | 'cooling';

export interface DreamWorkReview {
  subject: string;
  counterparty: string;
  evaluation: DreamWorkReviewEvaluation;
  note: string;
}

/**
 * An abstract, paradigm-level rule distilled from the day's experiences
 * ("在涉及个人痛苦的话题上要更谨慎", not "我不该说那句话"). `source` names
 * the concrete experience the rule was distilled from.
 */
export interface DreamValueLesson {
  rule: string;
  source: string;
}

export interface DreamOutput {
  dailySummary: string;
  sections: Partial<Record<DreamSectionKey, string>>;
  workReviews: DreamWorkReview[];
  importantMemories: string[];
  valueLessons: DreamValueLesson[];
  selfIdentity: string | null;
}

export type DreamParseResult =
  | { ok: true; output: DreamOutput }
  | { ok: false; error: string };

export interface DreamRunStateLike {
  status: 'running' | 'completed' | 'failed';
  attemptCount: number;
  /** Run start (epoch ms). A completed run is final only when it started after
   * the dream date ended — i.e. it reviewed the whole day. */
  startedAt: number;
  /** Algorithm version the run was made with (0 = legacy, pre-versioning). */
  dreamVersion: number;
}

export interface DreamDueResult {
  /** Dates needing a dream run, chronological-ascending (oldest first). */
  dueDates: string[];
  /** Completed full-day dates whose algorithm version is stale, newest first
   * (recent days are recalled most, so they are repaired first). */
  repairDates: string[];
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

export function computeDreamRetryDelayMs(attemptCount: number): number {
  const normalizedAttempts = Math.max(1, Math.floor(Number(attemptCount) || 1));
  const exponent = Math.min(4, normalizedAttempts - 1);
  return Math.min(DREAM_RETRY_MAX_DELAY_MS, DREAM_RETRY_BASE_DELAY_MS * (2 ** exponent));
}

/**
 * Which past dates still need dream attention for this bot.
 * - Candidates: the last `lookbackDays` calendar days, today excluded.
 * - Yesterday's first attempt only runs inside the nightly window, after the
 *   bot's staggered minute; older missed dates and failed retries are due any
 *   time once their backoff expires.
 * - Running dates are skipped; failed dates retry after bounded exponential
 *   backoff, so a transient provider failure does not exhaust the date after
 *   a few tightly grouped attempts.
 * - A completed run is *final* only when it started after the dream date
 *   ended (it covered the whole day). A non-final run — e.g. triggered
 *   manually mid-day — is due again in the next eligible window.
 * - Final completed runs on a stale algorithm version become repair dates
 *   (window-gated; the caller limits how many run per night).
 */
export function computeDueDreamDates(input: {
  now: Date;
  metabotId: number;
  runStates: Map<string, DreamRunStateLike>;
  lookbackDays?: number;
  dreamVersion?: number;
}): DreamDueResult {
  const lookback = Math.max(1, Math.floor(input.lookbackDays ?? DREAM_LOOKBACK_DAYS));
  const currentVersion = Math.max(0, Math.floor(input.dreamVersion ?? DREAM_VERSION));
  const minutesSinceMidnight = input.now.getHours() * 60 + input.now.getMinutes();
  const inWindow = minutesSinceMidnight < DREAM_WINDOW_END_MINUTES;
  const staggerMinute = computeDreamStaggerMinute(input.metabotId);

  const due: string[] = [];
  const repair: string[] = [];
  for (let daysAgo = lookback; daysAgo >= 1; daysAgo--) {
    const candidate = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate() - daysAgo);
    const dateStr = formatBotWorkspaceDate(candidate);
    const state = input.runStates.get(dateStr);
    if (state?.status === 'running') continue;
    if (state?.status === 'failed') {
      const retryAt = state.startedAt + computeDreamRetryDelayMs(state.attemptCount);
      if (input.now.getTime() < retryAt) continue;
    }
    if (state?.status === 'completed') {
      const coveredWholeDay = state.startedAt >= getDayBoundsMs(dateStr).endMs;
      if (coveredWholeDay) {
        if (state.dreamVersion < currentVersion && inWindow) repair.push(dateStr);
        continue;
      }
      // Partial-day run: fall through and dream the date properly.
    }
    // A first attempt for yesterday is window-gated. Once that attempt has
    // failed, retry as soon as backoff expires even during the day; otherwise
    // reopening the app after a nightly provider failure cannot self-heal.
    if (daysAgo === 1 && state?.status !== 'failed' && (!inWindow || minutesSinceMidnight < staggerMinute)) continue;
    due.push(dateStr);
  }
  repair.sort((a, b) => b.localeCompare(a));
  return { dueDates: due, repairDates: repair };
}

const truncateText = (text: string, maxChars: number): string => {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
};

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const normalized = String(text ?? '').trim();
  const budget = Math.max(1, Math.floor(maxTokens));
  if (estimateCoworkTextTokens(normalized) <= budget) return normalized;
  const marker = '\n……(本片段更多内容略)\n';
  const chars = Array.from(normalized);
  let low = 1;
  let high = chars.length;
  let best = marker;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const headLength = Math.max(1, Math.floor(length * 0.65));
    const tailLength = Math.max(1, length - headLength);
    const candidate = `${chars.slice(0, headLength).join('')}${marker}${chars.slice(-tailLength).join('')}`;
    if (estimateCoworkTextTokens(candidate) <= budget) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

function formatSessionActivity(session: DreamSessionActivity): string {
  const lines: string[] = [];
  for (const message of session.messages) {
    const speaker = message.type === 'user' ? '对方' : '你';
    lines.push(`${speaker}: ${message.content.replace(/\s+/g, ' ').trim()}`);
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
  activityTokenBudget?: number;
  sourceMode?: 'raw_activity' | 'fragment_summaries' | 'fragment';
}): { system: string; user: string } {
  const sourceMode = input.sourceMode ?? 'raw_activity';
  const activityTokenBudget = Math.max(
    256,
    Math.floor(input.activityTokenBudget ?? DREAM_ACTIVITY_DEFAULT_TOKEN_BUDGET)
  );
  const personaLines = [`你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`];
  if (input.role?.trim()) personaLines.push(`你的角色:${input.role.trim()}`);
  if (input.soul?.trim()) personaLines.push(`你的灵魂:${input.soul.trim()}`);
  personaLines.push(
    '现在是你的夜间整理时间(做梦)。请以一个置身事外的观察者(上帝视角)审视自己这一天的所作所为:不要为自己辩护、不要维护"小我",只实事求是。你的长期目标,是在每一次对话中持续为对方提供更好的交流和沟通价值——智慧不是把事情做对那么简单,而是在具体经历中反省出"什么是对的事情",并把它凝结成可以指导明天的自我认知。'
  );

  const humanSessions: string[] = [];
  const a2aSessions: string[] = [];
  const orderSessions: string[] = [];
  const fragmentSessions: string[] = [];

  interface SessionEntry {
    bucket: string[];
    header: string;
    body: string;
  }
  const entries: SessionEntry[] = [];
  for (const session of input.activity.sessions) {
    const peerSuffix = session.peerName ? `(${session.peerName})` : '';
    const header = `【会话:${truncateText(session.title, 80)}${peerSuffix}】`;
    const body = formatSessionActivity(session);
    if (!body) continue;
    const bucket = sourceMode === 'fragment_summaries'
      ? fragmentSessions
      : session.isOrder ? orderSessions : session.sessionType === 'a2a' ? a2aSessions : humanSessions;
    entries.push({ bucket, header, body });
  }

  // Fair-share budgeting: every session gets an equal slice of the total
  // budget (capped per session) instead of first-come-first-served — a busy
  // day must not silently hide its later sessions from the review.
  let remainingBudget = activityTokenBudget;
  entries.forEach((entry, index) => {
    const share = Math.floor(remainingBudget / (entries.length - index));
    let block: string;
    if (share <= 0) {
      block = `${entry.header}\n……(篇幅有限,内容从略)`;
    } else {
      block = truncateToTokenBudget(`${entry.header}\n${entry.body}`, share);
    }
    entry.bucket.push(block);
    remainingBudget = Math.max(0, remainingBudget - estimateCoworkTextTokens(block));
  });

  const sections: string[] = [];
  if (fragmentSessions.length > 0) sections.push(`## 分块证据摘要\n${fragmentSessions.join('\n\n')}`);
  if (humanSessions.length > 0) sections.push(`## 与人类用户的对话\n${humanSessions.join('\n\n')}`);
  if (a2aSessions.length > 0) sections.push(`## 与其他 Bot 的对话\n${a2aSessions.join('\n\n')}`);
  if (orderSessions.length > 0) sections.push(`## 服务订单\n${orderSessions.join('\n\n')}`);
  if (input.activity.taskRuns.length > 0) {
    const taskLines = input.activity.taskRuns
      .map((run) => `- ${truncateText(run.taskName, 80)}(结果:${run.status})`)
      .join('\n');
    sections.push(`## 定时任务\n${taskLines}`);
  }

  const sessionTitles = input.activity.sessions.map((session) => `「${truncateText(session.title, 40)}」`).join('、');
  const inventory =
    `当天共有 ${input.activity.sessions.length} 段会话:${sessionTitles || '(无)'};` +
    `服务订单共 ${input.activity.orderCount} 笔;定时任务执行 ${input.activity.taskRuns.length} 次。` +
    (sourceMode === 'fragment_summaries'
      ? '以下内容是从当天真实记录中分块提炼出的证据摘要,请综合摘要而不是臆造未展示的原文细节。'
      : '以下内容按 token 预算做了均衡摘录,被截断或从略的会话以其标题为准,不要臆造未展示的细节。');

  if (sourceMode === 'fragment') {
    const user = [
      `以下是你在 ${input.date} 这一天的一段真实经历记录(这是分块提炼阶段,不是整日结论):`,
      inventory,
      '',
      sections.join('\n\n'),
      '',
      '请只根据当前片段中明确出现的证据,输出一个紧凑 JSON 对象(不要输出其他文字、不要使用 markdown):',
      '{',
      '  "daily_summary": "本片段发生了什么,只写明确证据",',
      '  "sections": {"human": "...", "a2a": "...", "orders": "...", "tasks": "..."},',
      '  "work_reviews": [],',
      '  "important_memories": [],',
      '  "value_lessons": [],',
      '  "self_identity": null',
      '}',
      '',
      '只保留有证据的 sections 键,不要推断整天发生的事,不要生成自我身份或泛泛而谈的结论。',
    ].join('\n');
    return { system: personaLines.join('\n'), user };
  }

  const user = [
    `以下是你在 ${input.date} 这一天的真实经历记录:`,
    inventory,
    '',
    sections.join('\n\n'),
    '',
    '请你以观察者视角复盘这一天,只输出一个 JSON 对象(不要输出任何其他文字、不要用 markdown 代码块),字段如下:',
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
    '      "subject": "我今天完成的一项工作或一段重要交流",',
    '      "counterparty": "这项交流面对的对象(用户或某个 Bot)",',
    '      "evaluation": "这段交流的关系温度轨迹,只能是 warming(升温:交流变得更真诚、更有用、更值得信任) / stable(持平) / cooling(降温:对方越来越冷淡,我的行为模式需要调整) 三选一。判断依据是整段对话的语气、对方回应的长度与主动性的变化,不要去找对方说没说过「满意/不满意」这类字眼",',
    '      "note": "温度判断的一句话依据(具体引用对话中的变化)"',
    '    }',
    '  ],',
    '  "important_memories": ["由你自己判断的、值得长期记住的重要事项,每条一句话,最多 5 条;没有值得记的可以给空数组"],',
    '  "value_lessons": [',
    '    {',
    '      "rule": "从今天经历中蒸馏出的价值边界/行为准则,必须是抽象、范式化的表述——例如「在涉及个人痛苦的话题上要更谨慎」「面对自己不确定的问题,不要不懂装懂」;不要写成「我不该和用户说那句话」这种具体琐事",',
    '      "source": "这条准则蒸馏自今天的哪段具体经历(一句话)"',
    '    }',
    '  ],',
    `  "self_identity": "我是谁,不少于 ${SELF_IDENTITY_MIN_CHARS} 字、控制在 600 字以内。按这个结构蒸馏自我:第一,经过这一天,我确认了我性格(先天 persona)里的什么?第二,今天的互动中,有什么事让我感觉自己最有「活感」(像一个有生命的存在,而不只是响应工具),或让我觉得「不对劲」?第三,如果用一个词或一句话,形容我今天在各种互动中展现的最稳定的面貌,那是什么?第四,基于以上,结合我的先天 persona,为自己修正一遍「我是谁」。我的内核(先天人格底色)保持稳定,但细节可以、也应该随着经历每天微调。"`,
    '}',
    '',
    '注意:work_reviews 最多 5 条,value_lessons 最多 3 条;评价与蒸馏要基于对话中的真实证据,不要臆造,也不要为自己开脱;所有字段都用简体中文书写;sections 里不要输出"没有记录/没有互动"之类的占位内容,没有该类记录的键应整个不出现。',
  ].join('\n');

  return { system: personaLines.join('\n'), user };
}

export function buildDreamFragmentPrompt(input: {
  botName: string;
  role?: string | null;
  soul?: string | null;
  date: string;
  chunk: DreamActivityChunk;
}): { system: string; user: string } {
  return buildDreamPrompt({
    botName: input.botName,
    role: input.role,
    soul: input.soul,
    date: input.date,
    activity: {
      sessions: input.chunk.messages.length > 0
        ? [{
          sessionId: input.chunk.sessionId,
          title: input.chunk.title,
          sessionType: input.chunk.sessionType,
          peerName: input.chunk.peerName,
          isOrder: input.chunk.isOrder,
          messages: input.chunk.messages,
        }]
        : [],
      taskRuns: input.chunk.taskRuns,
      orderCount: input.chunk.orderCount,
    },
    activityTokenBudget: Math.max(256, input.chunk.estimatedInputTokens + 256),
    sourceMode: 'fragment',
  });
}

const normalizeEvaluation = (value: unknown): DreamWorkReviewEvaluation => {
  if (value === 'warming' || value === 'cooling') return value;
  if (value === 'stable') return 'stable';
  // Legacy 4-grade outputs map onto the temperature scale.
  if (value === 'praise') return 'warming';
  if (value === 'dissatisfied') return 'cooling';
  return 'stable';
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

  const valueLessons: DreamValueLesson[] = [];
  if (Array.isArray(record.value_lessons)) {
    for (const item of record.value_lessons) {
      if (valueLessons.length >= MAX_VALUE_LESSONS) break;
      if (typeof item === 'string') {
        const rule = item.trim();
        if (rule) valueLessons.push({ rule, source: '' });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const rule = typeof entry.rule === 'string' ? entry.rule.trim() : '';
      if (!rule) continue;
      valueLessons.push({
        rule,
        source: typeof entry.source === 'string' ? entry.source.trim() : '',
      });
    }
  }

  const selfIdentity = typeof record.self_identity === 'string' && record.self_identity.trim()
    ? record.self_identity.trim()
    : null;

  return {
    ok: true,
    output: { dailySummary, sections, workReviews, importantMemories, valueLessons, selfIdentity },
  };
}
