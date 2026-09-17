import { i18nService } from '../../services/i18n';
import type { TrackedFact, TrackedSuggestionCode } from '../../types/trackedTask';

/**
 * 结构化事实 → 界面文案（**文案归 renderer**）。
 *
 * 主进程只回事实：`reasonCodes: [{code, args}]` 与 `closureSuggestionCode`（见
 * `trackedTaskBoard.ts` 的 TrackedReasonCode / TrackedSuggestionCode）。
 * 界面文案一律在这里按 i18n 渲染，**不直接显示后端返回的 `reasons` 英文串**——
 * 那是事实串（保留给日志与排障），不是 UI 文案。
 */

const REASON_TEXT_KEYS: Record<string, string> = {
  ledger_review: 'trackedTask.reason.ledgerReview',
  steps_waiting_input: 'trackedTask.reason.stepsWaitingInput',
  open_checkpoints: 'trackedTask.reason.openCheckpoints',
  blocked_unmet_dependencies: 'trackedTask.reason.blockedUnmetDependencies',
  steps_active: 'trackedTask.reason.stepsActive',
  attempts_open: 'trackedTask.reason.attemptsOpen',
  deliverables_verifiable: 'trackedTask.reason.deliverablesVerifiable',
  terminal_without_conclusion: 'trackedTask.reason.terminalWithoutConclusion',
  idle_days: 'trackedTask.reason.idleDays',
  linked_sessions: 'trackedTask.reason.linkedSessions',
};

const SUGGESTION_TEXT_KEYS: Record<TrackedSuggestionCode, string> = {
  terminal_no_conclusion: 'trackedTask.suggestion.terminalNoConclusion',
  deliverables_verifiable: 'trackedTask.suggestion.deliverablesVerifiable',
  unresolved_dependencies: 'trackedTask.suggestion.unresolvedDependencies',
  session_ended: 'trackedTask.suggestion.sessionEnded',
  stale_inactivity: 'trackedTask.suggestion.staleInactivity',
};

/** 极小的模板填充：只认 `{name}` 占位，不做表达式。缺值时保留占位符（便于发现）。 */
function fill(template: string, args: Record<string, string | number> | undefined): string {
  if (!args) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = args[key];
    if (value === undefined || value === null) return whole;
    return typeof value === 'number' ? formatNumber(value) : String(value);
  });
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 一条状态摘要事实的文案。未知 code 回落到英文事实串，不吞掉信息。 */
export function reasonText(fact: TrackedFact, fallback?: string): string {
  const key = REASON_TEXT_KEYS[fact?.code];
  if (!key) return fallback ?? String(fact?.code ?? '');
  return fill(i18nService.t(key), fact.args);
}

/** 一句话收口建议的文案；code 为空表示无建议。 */
export function suggestionText(code: TrackedSuggestionCode | null | undefined): string {
  if (!code) return '';
  return i18nService.t(SUGGESTION_TEXT_KEYS[code]);
}

/**
 * 带参数的收口建议：`days` / `count` 由卡片事实补齐
 * （后端只发 code，参数从卡的 idleMs / deliverables 计数取，避免第二份统计）。
 */
export function suggestionTextForCard(
  card: {
    closureSuggestionCode: TrackedSuggestionCode | null;
    idleMs: number | null;
    reasonCodes?: TrackedFact[];
  },
  verifiableDeliverables?: number
): string {
  const code = card.closureSuggestionCode;
  if (!code) return '';
  const days = card.idleMs === null ? 0 : Math.round((card.idleMs / 86_400_000) * 10) / 10;
  // 交付物条数优先用调用方给的（来自 detail），否则从卡自己的 reasonCodes 里取
  // —— 不在前端新起一份统计。
  const countFromFacts = card.reasonCodes?.find((fact) => fact.code === 'deliverables_verifiable')
    ?.args?.count;
  const count = verifiableDeliverables ?? (typeof countFromFacts === 'number' ? countFromFacts : 0);
  return fill(i18nService.t(SUGGESTION_TEXT_KEYS[code]), { days, count });
}
