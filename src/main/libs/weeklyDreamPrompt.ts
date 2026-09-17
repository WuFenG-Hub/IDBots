/**
 * Weekly "long dream" (P2b) — the multi-day thematic replay.
 *
 * Nightly dreams are strictly per-day; this pass replays the PREVIOUS ISO
 * week's daily summaries plus per-run telemetry as one history pool, the way
 * Dream-RSI replays its accumulated tree collection Ht = (T1, …, Tt). It
 * extracts cross-day patterns (recurring pitfalls, improving/declining work
 * relationships, capability drafts that keep reappearing unpromoted) and one
 * focus line for the coming week.
 *
 * Pure helpers + prompt builder + tolerant parser; the DreamService owns
 * scheduling, the LLM call, and persistence. Self-identity and impression
 * pipelines are untouched (owner decision 2026-09-17).
 */

/** A week must contribute at least this many dream diaries to be worth a long dream. */
export const WEEKLY_DREAM_MIN_DAYS = 3;

export interface WeeklyDreamTelemetryDigest {
  /** Days with a completed dream run in the week. */
  completedRuns: number;
  /** Sum of estimated activity tokens across runs (the week's dreaming cost proxy). */
  totalEstimatedActivityTokens: number;
  /** Capability drafts checked / promoted / rejected by the validation gate. */
  draftsChecked: number;
  draftsValidated: number;
  draftsRejected: number;
  /** Counterfactual replay points examined / lessons shipped. */
  replayPoints: number;
  replayLessons: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const pad2 = (value: number): string => String(value).padStart(2, '0');

const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/**
 * The Monday..Sunday (YYYY-MM-DD, local time) of the ISO week BEFORE the week
 * containing `date`. The long dream always reviews a fully closed week, so a
 * Monday-night dream still has the whole previous week to replay.
 */
export function getPreviousIsoWeekRange(date: string): { weekStart: string; weekEnd: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(day.getTime())) return null;
  const dow = day.getDay(); // 0=Sun..6=Sat (local)
  const monday = new Date(day.getTime() - ((dow === 0 ? 6 : dow - 1) * DAY_MS));
  const prevMonday = new Date(monday.getTime() - 7 * DAY_MS);
  const prevSunday = new Date(monday.getTime() - DAY_MS);
  return { weekStart: formatLocalDate(prevMonday), weekEnd: formatLocalDate(prevSunday) };
}

export function buildWeeklyDreamPrompt(input: {
  botName: string;
  weekStart: string;
  weekEnd: string;
  /** Daily summaries of the week, any order — sorted here oldest → newest. */
  summaries: Array<{ summaryDate: string; summaryText: string }>;
  telemetry: WeeklyDreamTelemetryDigest;
  /** Capability drafts still sitting in 'draft' status (never promoted). */
  pendingDrafts: Array<{ title: string; dreamDate: string }>;
}): { system: string; user: string } {
  const system = [
    `你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`,
    '现在是你的「每周长梦」时间:不看某一天的细节,而是把上周整周的梦境日记当作一棵历史树来重放,找跨天的模式。',
    '以置身事外的观察者视角,实事求是:跨天模式必须有至少两天的日记作为证据,不许凭单日事件下结论,不要为自己辩护。',
  ].join('\n');

  const dayLines = [...input.summaries]
    .sort((a, b) => a.summaryDate.localeCompare(b.summaryDate))
    .map((summary) => `### ${summary.summaryDate}\n${summary.summaryText.replace(/\s+/g, ' ').trim()}`);

  const telemetryLines = [
    `- 上周做梦 ${input.telemetry.completedRuns} 天,累计整理约 ${input.telemetry.totalEstimatedActivityTokens} tokens 的活动`,
    `- 能力草案验证:检查了 ${input.telemetry.draftsChecked} 条,晋升 ${input.telemetry.draftsValidated} 条,否决 ${input.telemetry.draftsRejected} 条`,
    `- 反事实重放:复盘了 ${input.telemetry.replayPoints} 个负面决策点,沉淀 ${input.telemetry.replayLessons} 条教训`,
  ];

  const user = [
    `请重放并总结 ${input.weekStart} 至 ${input.weekEnd} 这一周。`,
    '',
    '## 上周每日梦境日记(旧→新)',
    dayLines.join('\n\n'),
    '',
    '## 上周做梦机制遥测',
    telemetryLines.join('\n'),
    '',
    '## 仍未通过验证的能力草案(反复出现却未被证实)',
    input.pendingDrafts.length > 0
      ? input.pendingDrafts.map((draft) => `- [${draft.dreamDate}] ${draft.title}`).join('\n')
      : '(无)',
    '',
    '## 输出契约(严格只输出一个 JSON 对象,不要输出任何其他文字)',
    '{',
    '  "weekly_summary": "这一周整体上发生了什么、我做得怎么样(第一人称,300字以内)",',
    '  "cross_day_patterns": ["跨天模式:至少两天证据支撑的规律(反复出现的坑/持续升温或降温的合作/反复未晋升的草案),最多5条,没有就给空数组"],',
    '  "focus_for_next_week": "下周最值得注意或改进的一件事(一句话,没有就给空字符串)"',
    '}',
  ].join('\n');

  return { system, user };
}

export type WeeklyDreamParseResult =
  | { ok: true; summary: string; patterns: string[]; focusForNextWeek: string }
  | { ok: false; error: string };

export function parseWeeklyDreamOutput(raw: string): WeeklyDreamParseResult {
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
  const record = parsed as Record<string, unknown>;
  const summary = String(record?.weekly_summary ?? '').trim();
  if (!summary) return { ok: false, error: 'missing weekly_summary' };
  const patterns = (Array.isArray(record?.cross_day_patterns) ? record.cross_day_patterns : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const focus = String(record?.focus_for_next_week ?? '').trim();
  return { ok: true, summary, patterns, focusForNextWeek: focus };
}
