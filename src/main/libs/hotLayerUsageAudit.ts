import { truncateUtf16Units } from './llmSafeText';

/** At most this many exposed items face one audit call (RRSI P3). */
export const USAGE_AUDIT_MAX_ITEMS = 12;
/** Hard ceiling across ALL kinds in one audit call (dream review P1): the
 * per-kind lists fill technique/procedure first, then knowledge, then memory —
 * the cap keeps the single LLM call bounded. */
export const USAGE_AUDIT_MAX_ITEMS_TOTAL = 16;
/** At most this many assistant excerpts ride one audit prompt. */
export const USAGE_AUDIT_MAX_EXCERPTS = 40;
/** One excerpt is cut to this many UTF-16 units. */
export const USAGE_AUDIT_EXCERPT_CHARS = 280;
/** An item gist (technique description / procedure trigger+first step). */
export const USAGE_AUDIT_ITEM_GIST_CHARS = 160;

/** One assistant reply sampled for the audit, labeled `S{n}.M{k}`. */
export interface UsageAuditExcerpt {
  label: string;
  channel: 'owner' | 'external';
  text: string;
}

/** One exposed hot-layer item as the audit prompt shows it. */
export interface UsageAuditItem {
  ref: string;
  kind: 'technique' | 'procedure' | 'knowledge' | 'memory';
  itemId: string;
  title: string;
  gist: string;
}

/**
 * Sample the day's assistant replies (design §6.3 P3.1): labels count EVERY
 * message (so `S1.M2` points at the real position), the channel is `external`
 * for A2A / service-order sessions, text has whitespace runs collapsed and is
 * cut to the excerpt budget. Beyond the cap the list is evenly sampled
 * (deterministic — indices `floor(i * total / max)`).
 */
export function sampleUsageAuditExcerpts(
  sessions: ReadonlyArray<{
    sessionType: string;
    isOrder: boolean;
    messages: ReadonlyArray<{ type: 'user' | 'assistant'; content: string }>;
  }>,
  maxExcerpts: number = USAGE_AUDIT_MAX_EXCERPTS,
  maxChars: number = USAGE_AUDIT_EXCERPT_CHARS,
): UsageAuditExcerpt[] {
  const cap = Math.max(0, Math.floor(maxExcerpts));
  const chars = Math.max(0, Math.floor(maxChars));
  const kept: UsageAuditExcerpt[] = [];
  (sessions ?? []).forEach((session, sessionIndex) => {
    const channel: 'owner' | 'external' = session.isOrder || session.sessionType === 'a2a' ? 'external' : 'owner';
    (session.messages ?? []).forEach((message, messageIndex) => {
      if (message?.type !== 'assistant') return;
      const content = String(message.content ?? '');
      if (!content.trim()) return;
      kept.push({
        label: `S${sessionIndex + 1}.M${messageIndex + 1}`,
        channel,
        text: truncateUtf16Units(content.replace(/\s+/g, ' '), chars),
      });
    });
  });
  if (cap === 0 || kept.length <= cap) return kept;
  const picked: UsageAuditExcerpt[] = [];
  for (let i = 0; i < cap; i += 1) {
    picked.push(kept[Math.floor((i * kept.length) / cap)]);
  }
  return picked;
}

/**
 * The audit reads at most the first `maxItems` exposures — the caller's list
 * is already ordered hot-first, then by repeat count (listHotLayerExposures).
 */
export function selectUsageAuditItems<T extends { kind: 'technique' | 'procedure' | 'knowledge' | 'memory'; itemId: string }>(
  exposures: readonly T[],
  maxItems: number = USAGE_AUDIT_MAX_ITEMS,
): T[] {
  return (exposures ?? []).slice(0, Math.max(0, Math.floor(maxItems)));
}

/**
 * The 使用核查 prompt (design §6.3 P3.1). The system text is fixed; the user
 * text lists the memory items and the reply excerpts the verdict must cite.
 */
export function buildHotLayerUsageAuditPrompt(input: {
  date: string;
  items: readonly UsageAuditItem[];
  excerpts: readonly UsageAuditExcerpt[];
}): { system: string; user: string } {
  const date = String(input.date ?? '');
  const system = `你在做使用核查:判断这个 MetaBot 在 ${date} 的回复里,是否真的用上了它记忆中的某条做法。
只依据下面给出的回复摘录判断,不要猜测摘录之外的内容。
"用上"指回复中的做法、步骤或检查明显体现了这条记忆;只是话题相关、或只是提到了名字,都不算。
输出 JSON:{"items":[{"ref":"<条目编号>","applied":true 或 false,"evidence":["S1.M2"]}]}
applied 为 true 时,evidence 必须列出能体现它的摘录编号;没有摘录能证明就写 false。
每个条目都给出结论,只输出 JSON。`;
  const user = [
    `日期:${date}`,
    '',
    '## 记忆条目',
    ...(input.items ?? []).map((item) => `- ${item.ref}「${item.title}」:${item.gist}`),
    '',
    '## 回复摘录',
    ...(input.excerpts ?? []).map((excerpt) => `[${excerpt.label}](${excerpt.channel}) ${excerpt.text}`),
  ].join('\n');
  return { system, user };
}

export type UsageAuditParseResult =
  | { ok: true; verdicts: Array<{ ref: string; applied: boolean; labels: string[] }> }
  | { ok: false; error: string };

/**
 * Tolerant parser mirroring parseCapabilityValidationOutput: strip fences,
 * take the outermost braces, then filter — unknown or duplicate refs drop,
 * evidence labels must be strings from the excerpt list (deduplicated, input
 * order), and `applied: true` without at least one valid label is coerced to
 * false. Unknown keys are ignored. Items missing from the verdict list stay
 * unaudited — they neither earn nor lose standing.
 */
export function parseHotLayerUsageAuditOutput(
  raw: string,
  validRefs: ReadonlySet<string>,
  validLabels: ReadonlySet<string>,
): UsageAuditParseResult {
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
  if (!Array.isArray(root?.items)) return { ok: false, error: 'missing items array' };
  const verdicts: Array<{ ref: string; applied: boolean; labels: string[] }> = [];
  const seen = new Set<string>();
  for (const element of root.items) {
    const entry = element as Record<string, unknown>;
    const ref = String(entry?.ref ?? '');
    if (!validRefs.has(ref) || seen.has(ref)) continue;
    const evidence = Array.isArray(entry?.evidence) ? entry.evidence : [];
    const labels: string[] = [];
    for (const label of evidence) {
      if (typeof label !== 'string') continue;
      if (validLabels.has(label) && !labels.includes(label)) labels.push(label);
    }
    seen.add(ref);
    verdicts.push({
      ref,
      applied: entry?.applied === true && labels.length > 0,
      labels,
    });
  }
  return { ok: true, verdicts };
}
