/**
 * Memory reconciliation pass (Dream-RSI exploration P1, design 2026-10-10 §4).
 *
 * Drafts are validated individually against 14 days of diaries, then promoted.
 * What was missing is the reconciliation step (the paper's P6): before a
 * memory update hardens, check the WHOLE memory bank for conflicting
 * assertions and record the rule's conditions and residual uncertainty instead
 * of an overgeneralized claim. The dream-time LLM judges; the host computes
 * the evidence (conflict candidates by token overlap) and executes the
 * verdicts by fixed template — the LLM never edits the store directly.
 *
 * RRSI P5 (design §6.5 P5.2): the same pass also returns a scope verdict —
 * general / situational / scorer_fitted — with the host-detected instance
 * markers shown per draft as mechanical evidence.
 *
 * Pure prompt builder + tolerant output parser, mirroring
 * capabilityValidationPrompt.ts conventions.
 */

import {
  detectInstanceMarkers,
  formatInstanceMarkers,
  normalizeCapabilityScope,
  type CapabilityScope,
  type InstanceMarker,
} from './capabilitySpecificity';

export const RECONCILE_MAX_DRAFTS_PER_NIGHT = 5;
export const RECONCILE_MAX_CONFLICT_CANDIDATES = 10;
/** conditions/uncertainty are capped at parse time (design §9). */
export const RECONCILE_FIELD_MAX_CHARS = 300;
const CONFLICT_EXCERPT_MAX_CHARS = 200;
const SUMMARY_EVIDENCE_MAX_CHARS = 400;

export interface ReconciliationDraftInput {
  id: number;
  dreamDate: string;
  title: string;
  description: string;
  capabilityType: string;
  validationScore: number | null;
  /** RRSI P5: host-detected instance markers; derived from title+description
   * when the caller does not precompute them. */
  markers?: InstanceMarker[];
}

/** One host-computed candidate conflict for a draft (procedures + drafts). */
export interface ReconciliationConflictCandidate {
  /** 'procedure:<id>' | 'draft:<id>' — the reference vocabulary of conflicts_with. */
  ref: string;
  kind: 'procedure' | 'draft';
  title: string;
  excerpt: string;
}

export type ReconciliationAction = 'keep' | 'narrow' | 'merge' | 'dispute';

export interface ReconciliationVerdict {
  id: number;
  action: ReconciliationAction;
  /** RRSI P5 scope verdict; missing/unknown values parse as 'general'. */
  scope: CapabilityScope;
  /** Required unless action=dispute; '' when the model broke the contract. */
  conditions: string;
  /** May be '' only when the evidence is exhaustive. */
  uncertainty: string;
  /** 'procedure:<id>' / 'draft:<id>' refs, capped and shape-checked. */
  conflictsWith: string[];
  note: string;
}

export type ReconciliationParseResult =
  | { ok: true; verdicts: ReconciliationVerdict[] }
  | { ok: false; error: string };

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;

export function buildCapabilityReconciliationPrompt(input: {
  botName: string;
  date: string;
  /** Tonight's newly validated drafts (≤ RECONCILE_MAX_DRAFTS_PER_NIGHT). */
  drafts: ReconciliationDraftInput[];
  /** Host-computed conflict candidates per draft id. */
  conflictsByDraftId: ReadonlyMap<number, ReconciliationConflictCandidate[]>;
  /** Recent daily summaries (newest first) — the drafts' source evidence pool. */
  recentSummaries: Array<{ summaryDate: string; summaryText: string }>;
}): { system: string; user: string } {
  const system = [
    `你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`,
    '现在是你的夜间整理时间(做梦)的「记忆核对」环节。今晚有几条能力草案刚通过了历史重放验证(validated),在它们晋升为稳定技能之前,必须逐条与既有记忆库核对。',
    '请以置身事外的观察者视角裁决每条草案:',
    '- keep:与既有记忆没有冲突。必须写出它的适用条件(conditions)与尚未验证的不确定点(uncertainty)——一条没有记录适用条件的规则,明天就会被过度泛化。',
    '- narrow:规则成立但表述过宽——只在特定条件下被观察到。给出更窄的适用条件与不确定点,宿主会把它们附加到条文上。',
    '- merge:草案的内容已被某条既有 procedure 覆盖。conflicts_with 里必须给出该 procedure 的引用(procedure:<id>)。',
    '- dispute:草案与既有记忆存在真实冲突,你无法裁决。该草案会被挂起(disputed),明晚带着冲突证据重审;不要强行给结论。',
    '除了 dispute,conditions 必填;uncertainty 只有在证据已经足够完备时才允许留空。宁可 dispute,不可硬判。',
    '另外,逐条判断草案的适用范围 scope:',
    '- general:换一个任务、换一个对象也成立的做法;',
    '- situational:只对某个具体的人、订单、pin、日期或对端 Bot 成立;',
    '- scorer_fitted:只是在复述「怎样拿到好评、点赞或高分」,并没有改变工作本身该怎么做。',
    '每条草案下方的「实例标记」是宿主从文本里机械找出的具体 ID 和日期,只作参考:有标记不等于一定是 situational,没有标记也可能是 situational。',
  ].join('\n');

  const draftLines = input.drafts.map((draft) => {
    const candidates = input.conflictsByDraftId.get(draft.id) ?? [];
    const candidateLines = candidates.length > 0
      ? candidates.map((candidate) =>
        `  - ${candidate.ref}【${candidate.kind === 'procedure' ? '既有procedure' : '已验证草案'}】${candidate.title}:${truncate(candidate.excerpt.replace(/\s+/g, ' '), CONFLICT_EXCERPT_MAX_CHARS)}`,
      ).join('\n')
      : '  (没有找到标题/触发词重叠的既有记忆)';
    return [
      `### 草案 #${draft.id}(${draft.dreamDate} 梦中提炼,类型:${draft.capabilityType},验证分:${draft.validationScore ?? '无'})`,
      `标题:${draft.title}`,
      `描述:${draft.description}`,
      `实例标记:${formatInstanceMarkers(draft.markers ?? detectInstanceMarkers(`${draft.title}\n${draft.description}`))}`,
      '可能冲突的既有记忆:',
      candidateLines,
    ].join('\n');
  });

  const summaryLines = input.recentSummaries.map((summary) =>
    `- [${summary.summaryDate}] ${truncate(summary.summaryText.replace(/\s+/g, ' ').trim(), SUMMARY_EVIDENCE_MAX_CHARS)}`,
  );

  const user = [
    `今天是 ${input.date}。请核对以下 ${input.drafts.length} 条刚通过验证的能力草案。`,
    '',
    '## 待核对的能力草案',
    draftLines.join('\n\n'),
    '',
    '## 草案的来源证据(近期梦境日记,新→旧)',
    summaryLines.length > 0 ? summaryLines.join('\n') : '(暂无历史日记)',
    '',
    '## 输出契约(严格只输出一个 JSON 对象,不要输出任何其他文字)',
    '{',
    '  "verdicts": [',
    '    {',
    '      "id": 草案数字id,',
    '      "action": "keep" | "narrow" | "merge" | "dispute",',
    '      "scope": "general" | "situational" | "scorer_fitted",',
    '      "conditions": "该规则被观察到成立的适用条件(dispute 时可为空字符串)",',
    '      "uncertainty": "尚未验证的地方(证据完备时可留空字符串)",',
    '      "conflicts_with": ["只许引用上方候选列表里出现的 procedure:<id> 或 draft:<id>,没有就给空数组"],',
    '      "note": "一句话裁决依据"',
    '    }',
    '  ]',
    '}',
    '每条草案都必须有且仅有一条 verdict;id 必须来自上方草案列表;conflicts_with 里的引用必须来自该草案的候选列表。',
  ].join('\n');

  return { system, user };
}

/**
 * Tolerant parser mirroring parseCapabilityValidationOutput: strips fences,
 * takes the outermost braces, drops unknown actions/ids, caps the fields.
 * A keep/narrow/merge verdict without conditions breaks the contract and is
 * dropped; merge without a procedure ref is dropped.
 */
export function parseCapabilityReconciliationOutput(
  raw: string,
  validIds: ReadonlySet<number>,
): ReconciliationParseResult {
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

  const verdicts: ReconciliationVerdict[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const id = Number(entry?.id);
    if (!Number.isInteger(id) || !validIds.has(id) || seen.has(id)) continue;
    const rawAction = String(entry?.action ?? '').trim().toLowerCase();
    const action: ReconciliationAction | null =
      rawAction === 'keep' || rawAction === 'narrow' || rawAction === 'merge' || rawAction === 'dispute'
        ? rawAction
        : null;
    if (!action) continue;
    const conditions = truncate(String(entry?.conditions ?? '').trim(), RECONCILE_FIELD_MAX_CHARS);
    const uncertainty = truncate(String(entry?.uncertainty ?? '').trim(), RECONCILE_FIELD_MAX_CHARS);
    const rawConflicts = entry?.conflicts_with ?? entry?.conflictsWith;
    const conflictsWith = (Array.isArray(rawConflicts) ? rawConflicts : [])
      .filter((ref): ref is string => typeof ref === 'string')
      .map((ref) => ref.trim())
      .filter((ref) => /^(procedure|draft):\S+$/.test(ref))
      .slice(0, RECONCILE_MAX_CONFLICT_CANDIDATES);
    // Contract gates: a non-dispute verdict must name its conditions; a merge
    // must name the procedure it merges into. Violations are dropped, not
    // coerced — a half-formed reconciliation is worse than none.
    if (action !== 'dispute' && !conditions) continue;
    if (action === 'merge' && !conflictsWith.some((ref) => ref.startsWith('procedure:'))) continue;
    seen.add(id);
    verdicts.push({
      id,
      action,
      scope: normalizeCapabilityScope(entry?.scope) ?? 'general',
      conditions,
      uncertainty,
      conflictsWith,
      note: truncate(String(entry?.note ?? '').trim(), RECONCILE_FIELD_MAX_CHARS),
    });
  }
  if (verdicts.length === 0) return { ok: false, error: 'no usable verdicts' };
  return { ok: true, verdicts };
}
