import { i18nService } from '../../services/i18n';
import type { TrackedFact, TrackedFactCode, TrackedSuggestionCode } from '../../types/trackedTask';

/**
 * 结构化事实 → 界面文案（**文案归 renderer**）。
 *
 * 主进程只回事实：`reasonCodes: [{ code, params }]` 与
 * `closureSuggestionCode + closureSuggestionParams`（字段名以附录 B 为准）。
 * 文案一律在这里按 i18n 渲染；**不直接显示后端返回的 `reasons` / `closureSuggestion` 原文**
 * ——那两个字段已降级为诊断串（日志/排障用），不是 UI 文案。
 *
 * 键名以主进程常量 **`TRACKED_FACT_CODE_I18N_KEY`** 为唯一权威（14 条）。
 * 本文件镜像该常量，并由 `tests/trackedTaskFactText.test.ts` 做**跨文件表驱动断言**：
 * 镜像与主进程常量不一致、或 zh/en 缺任一键，测试即红。改 code 必须同改三处（主进程常量、
 * 本镜像、zh/en 文案），否则红。
 */
export const TRACKED_FACT_CODE_I18N_KEY: Record<TrackedFactCode, string> = {
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
  terminal_no_conclusion: 'trackedTask.suggestion.terminalNoConclusion',
  unresolved_dependencies: 'trackedTask.suggestion.unresolvedDependencies',
  session_ended: 'trackedTask.suggestion.sessionEnded',
  stale_inactivity: 'trackedTask.suggestion.staleInactivity',
};

/**
 * **建议侧**的 code → 文案键。
 *
 * 为什么需要第二张表：主进程的 `TRACKED_FACT_CODE_I18N_KEY` 是**一张扁平表**，而
 * `deliverables_verifiable` 这类 code 在「理由」与「建议」两处共用（同一个事实一个 code）。
 * 一张表无法同时给出两种措辞——用它渲染建议会拿到理由措辞（实测：横幅上出现
 * 「3 条交付物可核」而非「交付物已可核（3 条），建议直接收口并写一句结论。」）。
 * 因此：**理由侧照抄主进程常量（权威）**，**建议侧**在本文件独立映射，并由单测锁住
 * 「建议 code 全覆盖 + zh/en 键齐」。这是分工，不是第二套事实。
 */
export const TRACKED_SUGGESTION_CODE_I18N_KEY: Record<TrackedSuggestionCode, string> = {
  terminal_no_conclusion: 'trackedTask.suggestion.terminalNoConclusion',
  deliverables_verifiable: 'trackedTask.suggestion.deliverablesVerifiable',
  unresolved_dependencies: 'trackedTask.suggestion.unresolvedDependencies',
  session_ended: 'trackedTask.suggestion.sessionEnded',
  stale_inactivity: 'trackedTask.suggestion.staleInactivity',
};

/** 极小的模板填充：只认 `{name}` 占位，不做表达式。缺值时保留占位符（便于发现）。 */
function fill(template: string, params: Record<string, string | number> | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    if (value === undefined || value === null) return whole;
    return typeof value === 'number' ? formatNumber(value) : String(value);
  });
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 一条状态摘要事实的文案。未知 code 回落到诊断串，不吞掉信息。 */
export function reasonText(fact: TrackedFact, fallback?: string): string {
  const key = TRACKED_FACT_CODE_I18N_KEY[fact?.code];
  if (!key) return fallback ?? String(fact?.code ?? '');
  return fill(i18nService.t(key), fact.params);
}

/** 一句话收口建议的文案；code 为空表示无建议。 */
export function suggestionText(
  code: TrackedSuggestionCode | null | undefined,
  params?: Record<string, string | number>
): string {
  if (!code) return '';
  const key = TRACKED_SUGGESTION_CODE_I18N_KEY[code];
  if (!key) return String(code);
  return fill(i18nService.t(key), params);
}

/**
 * 带参数的收口建议。
 * 参数优先用后端给的 `closureSuggestionParams`（权威）；缺失时从卡自身的 `idleMs`
 * 与 `reasonCodes` 里补（不新起统计），再不行才留空占位。
 */
export function suggestionTextForCard(card: {
  closureSuggestionCode: TrackedSuggestionCode | null;
  closureSuggestionParams?: Record<string, string | number>;
  idleMs: number | null;
  reasonCodes?: TrackedFact[];
}): string {
  const code = card.closureSuggestionCode;
  if (!code) return '';

  const params: Record<string, string | number> = { ...(card.closureSuggestionParams ?? {}) };
  if (params.days === undefined && card.idleMs !== null) {
    params.days = Math.round((card.idleMs / 86_400_000) * 10) / 10;
  }
  if (params.count === undefined) {
    const fromFacts = card.reasonCodes?.find((fact) => fact.code === 'deliverables_verifiable')
      ?.params?.count;
    if (typeof fromFacts === 'number') params.count = fromFacts;
  }
  return suggestionText(code, params);
}
