/**
 * Capability draft validation — the Dream-RSI "replay gate" (P0).
 *
 * Every nightly dream writes capability_learnings as status='draft' rows, but
 * a draft only becomes injectable hot-layer guidance after it survives a
 * validation pass against the bot's OWN recorded history: recent dream
 * diaries, acceptance ratings, and human feedback. A draft that is grounded
 * in what actually happened and corroborated by recorded outcomes is promoted
 * to 'validated'; one contradicted by recorded outcomes is demoted to
 * 'rejected'. This mirrors Dream-RSI's selection guarantee — a lesson only
 * ships when it is consistent with what actually happened.
 *
 * Pure prompt builders + a tolerant output parser; the DreamService owns the
 * LLM call and the store writes.
 */

export const CAPABILITY_VALIDATION_MAX_DRAFTS = 10;
export const CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE = 0.6;
/** Recent dream diaries handed to the validator as the replayable history. */
export const CAPABILITY_VALIDATION_SUMMARY_DAYS = 14;
/**
 * Nightly promotion pass (Dream-RSI P2): only top-scored validated drafts
 * harden into procedure memory — and only after they survived at least one
 * night of calendar distance (see coworkStore.listPromotableCapabilityDrafts).
 */
export const CAPABILITY_PROMOTION_MIN_SCORE = 0.85;
/** Per-bot per-night promotion cap (flood guard). */
export const CAPABILITY_PROMOTION_MAX_PER_NIGHT = 3;
/**
 * Periodic re-review (Dream-RSI P1): a VALIDATED draft whose last verdict-
 * panel contact is older than this faces the same verdict panel again —
 * techniques must keep surviving the bot's recorded history to keep their
 * injection slots (validated was previously a lifetime appointment).
 */
export const CAPABILITY_REVIEW_INTERVAL_DAYS = 30;
/** Per-bot per-night re-review cap; runs after the fresh-draft batch. */
export const CAPABILITY_REVIEW_MAX_PER_NIGHT = 5;
/**
 * Disputed drafts (design 2026-10-10 §4.4) re-enter the nightly validation
 * gate with their conflict evidence attached; a draft that stays unresolved
 * this many days is auto-rejected (the existing purge removes the corpse).
 */
export const DISPUTED_AUTO_REJECT_DAYS = 7;
const SUMMARY_EVIDENCE_MAX_CHARS = 400;

export interface CapabilityValidationDraftInput {
  id: number;
  dreamDate: string;
  title: string;
  description: string;
  capabilityType: string;
  /** Disputed re-entry (design §4.3): the conflict evidence recorded when the
   * reconciliation pass suspended this draft; rendered so tonight's panel
   * judges WITH the conflict in view. */
  conflictNote?: string | null;
  /** Chain refs this draft's text cites (design §5.3): only these drafts get
   * the chain-grounded judging rules. */
  chainRefs?: string[];
  /**
   * RRSI P1 falsified-history line (design §6.1 P1.3): the most similar
   * ledger entry for this draft's title, when one exists — the panel judges
   * with the prior falsification in view.
   */
  similarFalsified?: { title: string; reason: string; falsifiedDate: string } | null;
}

export type CapabilityValidationVerdict = 'validated' | 'rejected' | 'keep_draft';

export interface CapabilityValidationVerdictEntry {
  id: number;
  verdict: CapabilityValidationVerdict;
  /** 0..1 — validated verdicts below PROMOTE_MIN_SCORE stay drafts. */
  score: number;
  rationale: string;
}

export type CapabilityValidationParseResult =
  | { ok: true; verdicts: CapabilityValidationVerdictEntry[] }
  | { ok: false; error: string };

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;

export function buildCapabilityValidationPrompt(input: {
  botName: string;
  date: string;
  drafts: CapabilityValidationDraftInput[];
  /** Recent daily summaries (newest first) — the replayable history pool. */
  recentSummaries: Array<{ summaryDate: string; summaryText: string }>;
  /** One-line digest of today's activity stats (session/order/task counts). */
  todayDigest?: string;
  /** Chain-grounded evidence digest (design §5.2, host-rendered). Present only
   * when tonight's refs were verified; the chain judging rules ride along. */
  chainEvidence?: string | null;
  /**
   * RRSI P1 prospective rule (design §6.1 P1.1): when true, the prompt tells
   * the panel that the draft's origin-day diary is not independent evidence.
   * Default false — existing callers and tests keep the unchanged prompt.
   */
  prospective?: boolean;
}): { system: string; user: string } {
  const system = [
    `你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`,
    '现在是你的夜间整理时间(做梦)的「能力验证」环节。你在过去的梦里提炼过一些能力草案(自以为学会的技巧/流程)。',
    '这些草案不一定靠谱:可能是事后合理化的错觉,可能只在特定情境成立,也可能确实被后续实践反复验证。',
    '请以置身事外的观察者视角,拿草案逐条对照你真实 recorded 的历史(下方梦境日记),实事求是地裁决:',
    '- validated:草案有明确的真实事件支撑,且与记录的结果(人类评价、验收评分、后续实践)一致或因此变好。',
    '- rejected:草案与记录的事实矛盾,或照着做曾导致差评/失败/返工。',
    '- keep_draft:证据不足,无法判定——既不晋升也不否决,留待以后的梦继续观察。',
    '不要为草案辩护,不要因为"听起来有用"就判 validated。宁可 keep_draft,不可错判。',
    ...(input.prospective === true
      ? ['独立证据规则:草案提炼当天的日记是它的来源,不算独立证据。判 validated 时,rationale 必须至少引用一篇日期晚于该草案提炼日期、且出现在下方日记列表中的日记;做不到就判 keep_draft。']
      : []),
  ].join('\n');

  const draftLines = input.drafts.map((draft) => [
    `### 草案 #${draft.id}(${draft.dreamDate} 梦中提炼,类型:${draft.capabilityType})`,
    `标题:${draft.title}`,
    `描述:${draft.description}`,
    draft.similarFalsified
      ? `曾被证伪的相似做法:「${draft.similarFalsified.title}」(${draft.similarFalsified.falsifiedDate} 否决:${truncate(draft.similarFalsified.reason, 120)})`
      : '',
    draft.conflictNote?.trim()
      ? `存疑待裁决:${truncate(draft.conflictNote.trim().replace(/\s+/g, ' '), SUMMARY_EVIDENCE_MAX_CHARS)}`
      : '',
    // The chain-ref mark exists to scope the chain judging rules — without a
    // digest there are no rules in play, so the mark stays out.
    (input.chainEvidence?.trim() && (draft.chainRefs ?? []).length > 0)
      ? `链上引用:${draft.chainRefs!.join(', ')}`
      : '',
  ].filter(Boolean).join('\n'));

  const summaryLines = input.recentSummaries.map((summary) =>
    `- [${summary.summaryDate}] ${truncate(summary.summaryText.replace(/\s+/g, ' ').trim(), SUMMARY_EVIDENCE_MAX_CHARS)}`,
  );

  const hasFalsifiedMark = input.drafts.some((draft) => draft.similarFalsified);
  const user = [
    `今天是 ${input.date}。请验证以下 ${input.drafts.length} 条能力草案。`,
    '',
    '## 待验证的能力草案',
    draftLines.join('\n\n'),
    '',
    '## 可重放的历史(近期梦境日记,新→旧)',
    summaryLines.length > 0 ? summaryLines.join('\n') : '(暂无历史日记)',
    ...(input.todayDigest ? ['', '## 当日活动概况', input.todayDigest] : []),
    ...(input.chainEvidence?.trim()
      ? [
        '',
        '## 链上证据(宿主在裁决前已核验,链上事实,比日记更硬)',
        input.chainEvidence.trim(),
        '涉链裁决规则(只对标注了「链上引用」的草案适用):',
        '- 草案的声明与链上证据矛盾(引用的 pin/txid 是 NOT FOUND,或关联订单处于失败终态) ⇒ 该草案 rejected,无论日记如何支持。',
        '- 涉链声明但证据缺失或未核验成功(UNVERIFIED,或未出现在证据列表) ⇒ 该草案至多 keep_draft,不得 validated。',
        '- rationale 中引用任何 pin id / txid 前,必须确认它出现在上方证据列表中。',
      ]
      : []),
    ...(hasFalsifiedMark
      ? [
        '标注了「曾被证伪的相似做法」的草案:除非日记里出现了那次否决日期之后的新证据,否则不得判 validated。',
        '',
      ]
      : []),
    '## 输出契约(严格只输出一个 JSON 对象,不要输出任何其他文字)',
    '{',
    '  "verdicts": [',
    '    {',
    '      "id": 草案数字id,',
    '      "verdict": "validated" | "rejected" | "keep_draft",',
    '      "score": 0到1的小数,表示证据强度(1=铁证如山,0=毫无根据),',
    '      "rationale": "一句话裁决依据,引用具体的日记日期或事件"',
    '    }',
    '  ]',
    '}',
    '每条草案都必须有且仅有一条 verdict;id 必须来自上方草案列表。',
    ...(input.prospective === true
      ? ['validated 的 rationale 里必须写出那篇较晚日记的日期(YYYY-MM-DD)。']
      : []),
  ].join('\n');

  return { system, user };
}

/**
 * Tolerant parser mirroring parseDreamOutput: strips code fences, takes the
 * outermost braces, accepts snake_case aliases, clamps scores into [0, 1],
 * drops verdicts with unknown ids or unknown verdict words.
 */
export function parseCapabilityValidationOutput(
  raw: string,
  validIds: ReadonlySet<number>,
): CapabilityValidationParseResult {
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
  const list = Array.isArray(root?.verdicts) ? root.verdicts : null;
  if (!list) return { ok: false, error: 'missing verdicts array' };

  const verdicts: CapabilityValidationVerdictEntry[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const id = Number(entry?.id);
    if (!Number.isInteger(id) || !validIds.has(id) || seen.has(id)) continue;
    const rawVerdict = String(entry?.verdict ?? '').trim().toLowerCase();
    const verdict: CapabilityValidationVerdict | null =
      rawVerdict === 'validated' || rawVerdict === 'validate' ? 'validated'
        : rawVerdict === 'rejected' || rawVerdict === 'reject' ? 'rejected'
          : rawVerdict === 'keep_draft' || rawVerdict === 'keep' ? 'keep_draft'
            : null;
    if (!verdict) continue;
    const rawScore = Number(entry?.score);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(1, rawScore)) : 0;
    const rationale = String(entry?.rationale ?? entry?.reason ?? '').trim();
    seen.add(id);
    verdicts.push({ id, verdict, score, rationale });
  }
  if (verdicts.length === 0) return { ok: false, error: 'no usable verdicts' };
  return { ok: true, verdicts };
}
