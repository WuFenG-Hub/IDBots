import { formatBotWorkspaceDate } from './botWorkspace';

/**
 * Experience prompt blocks — the hot layer of the tiered experience system.
 *
 * Pure builders for the two always-on blocks injected into a bot's system
 * prompt: the protected self-identity entry ("我是谁", written by the dream
 * service) and the last few days' daily summaries. Warm/cold layers are not
 * injected; they are reached through the experience_recall tool, whose query
 * defaults and result formatting also live here.
 */

export const RECENT_SUMMARIES_PROMPT_DAYS = 7;
export const RECENT_SUMMARIES_MAX_CHARS = 2000;
export const RECALL_WARM_DAYS = 30;
export const RECALL_MAX_LIMIT = 30;
const RECALL_ENTRY_MAX_CHARS = 600;

export interface ExperienceSummarySessionRef {
  sessionId: string;
  title: string;
}

export interface ExperienceSummaryLike {
  summaryDate: string;
  summaryText: string;
  sessionRefs?: ExperienceSummarySessionRef[];
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * The bot's own dream-written "who am I" entry. Present in every context
 * (cowork UI and A2A) — it describes the bot itself, not the user, so it does
 * not fall under the external-channel owner-memory privacy block.
 */
export function buildSelfIdentityBlock(identityText: string): string {
  const trimmed = identityText?.trim();
  if (!trimmed) return '';
  return [
    '<metabot_self_identity>',
    escapeXml(trimmed),
    '</metabot_self_identity>',
    '<instruction>',
    'The &lt;metabot_self_identity&gt; block above is your own self-cognition, written and refined by',
    'yourself in your nightly dreams: its core is stable, its details evolve with your experiences.',
    'Do not recite it to the user — ALIGN your behavior with it. Let what you say and do live up to',
    'who you believe you are.',
    '</instruction>',
  ].join('\n');
}

/**
 * The bot's self-grown code of conduct: abstract value boundaries distilled
 * from its own experiences during nightly dreams. Injected so they actively
 * constrain behavior, not just sit in storage.
 */
export function buildValueBoundariesBlock(entries: Array<{ text: string }>, maxItems = 5): string {
  const items = entries
    .map((entry) => entry.text?.trim())
    .filter((text): text is string => Boolean(text))
    .slice(0, Math.max(1, maxItems));
  if (items.length === 0) return '';
  return [
    '<value_boundaries>',
    ...items.map((text) => `  <rule>${escapeXml(text)}</rule>`),
    '</value_boundaries>',
    '<instruction>',
    'The &lt;value_boundaries&gt; block lists rules you distilled from your own past experiences.',
    'They are your self-grown code of conduct: honor them in how you act and respond.',
    '</instruction>',
  ].join('\n');
}

/**
 * Hot layer: the bot's last few days of dream summaries, newest first,
 * oldest dropped when over the char budget.
 */
export function buildRecentDailySummariesBlock(
  summaries: ExperienceSummaryLike[],
  maxChars: number = RECENT_SUMMARIES_MAX_CHARS
): string {
  if (!summaries.length) return '';
  const dayBlocks: string[] = [];
  let used = 0;
  for (const summary of summaries) {
    const text = summary.summaryText?.trim();
    if (!text) continue;
    const block = `  <day date="${escapeXml(summary.summaryDate)}">${escapeXml(text)}</day>`;
    if (dayBlocks.length > 0 && used + block.length > maxChars) break;
    dayBlocks.push(block);
    used += block.length;
  }
  if (dayBlocks.length === 0) return '';
  return [
    '<recent_daily_summaries>',
    ...dayBlocks,
    '</recent_daily_summaries>',
    '<instruction>',
    'The &lt;recent_daily_summaries&gt; block lists what you did on each recent day — these summaries',
    'ARE your dreams (做梦), written by yourself during the nightly dream consolidation. When the user',
    'asks whether you dreamed, what you dreamed about, or whether you remember a certain day',
    '(做梦/梦境/梦到/还记得), answer from these summaries, and call the experience_recall tool for',
    'any earlier date range or a full-history search.',
    '</instruction>',
  ].join('\n');
}

export function buildExperiencePromptBlocksXml(input: {
  identityText?: string | null;
  summaries: ExperienceSummaryLike[];
  valueBoundaries?: Array<{ text: string }>;
  maxChars?: number;
}): string {
  return [
    input.identityText ? buildSelfIdentityBlock(input.identityText) : '',
    buildValueBoundariesBlock(input.valueBoundaries ?? []),
    buildRecentDailySummariesBlock(input.summaries, input.maxChars),
  ]
    .filter((block) => block.trim())
    .join('\n\n');
}

export interface ExperienceRecallArgs {
  query?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeDateArg = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && DATE_RE.test(trimmed) ? trimmed : undefined;
};

/**
 * Warm/cold defaults for the recall tool: a bare call looks back
 * RECALL_WARM_DAYS (warm); a keyword query searches the full history (cold),
 * unless the caller pins explicit dates. Args use the tool schema's
 * snake_case names; the result is normalized to camelCase.
 */
export function resolveExperienceRecallQuery(
  args: ExperienceRecallArgs,
  today: Date = new Date()
): { query?: string; dateFrom?: string; dateTo?: string; limit: number } {
  const limit = Math.max(1, Math.min(RECALL_MAX_LIMIT, Math.floor(args.limit ?? 10)));
  const query = args.query?.trim() || undefined;
  let dateFrom = normalizeDateArg(args.date_from);
  const dateTo = normalizeDateArg(args.date_to);
  if (!query && !dateFrom) {
    dateFrom = formatBotWorkspaceDate(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - RECALL_WARM_DAYS)
    );
  }
  return { query, dateFrom, dateTo, limit };
}

/** Plain-text rendering of recall results for the tool response. */
export function formatExperienceRecallResults(summaries: ExperienceSummaryLike[]): string {
  if (!summaries.length) {
    return 'No experience summaries found for the given range or query. Days before your first dream run have no summary; recent days may not have been consolidated yet.';
  }
  const lines: string[] = [];
  for (const summary of summaries) {
    const text = summary.summaryText.replace(/\s+/g, ' ').trim();
    const truncated = text.length > RECALL_ENTRY_MAX_CHARS ? `${text.slice(0, RECALL_ENTRY_MAX_CHARS)}…` : text;
    lines.push(`${summary.summaryDate}: ${truncated}`);
    for (const ref of summary.sessionRefs ?? []) {
      const title = ref.title?.trim();
      lines.push(`  - IDBots://${ref.sessionId}${title ? ` ${title}` : ''}`);
    }
  }
  return [
    ...lines,
    '',
    'These daily summaries index your full experience records, and the IDBots:// links above point at the complete conversations behind them. When a task resembles something you did before, read the relevant session with idbots_session_read_all first: reuse the approaches that worked, and avoid the pitfalls you already stepped into.',
  ].join('\n');
}
