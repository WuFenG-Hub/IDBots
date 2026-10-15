import { shiftDateKey } from './predictionLedger';

/**
 * Structured exploration (RRSI P4, design §6.4) — pure helpers, no I/O.
 *
 * When a bot's self-improvement stalls (three active 7-day windows with zero
 * validated drafts or promotions, or every recent practice proposal crowded
 * into one component), the nightly dream carries a directive asking that at
 * least one of tonight's proposals targets a component the bot has not
 * exercised recently. This module owns the deterministic halves: the component
 * vocabulary, stall detection (reads only nights strictly before the dreamed
 * date, so re-running the same night is stable), the under-explored listing,
 * the directive rendering, compliance judging, and the read-only approval
 * ordering. Storage lives in CoworkStore; orchestration lives in DreamService.
 */

export const PRACTICE_COMPONENTS = [
  'memory',
  'procedure',
  'skill',
  'remote_service',
  'collaboration',
  'metaweb',
  'metaapp',
] as const;
export type PracticeComponent = (typeof PRACTICE_COMPONENTS)[number];

/** The paper's ν set: the network-facing components a stalled bot drifts away from. */
export const STRUCTURAL_PRACTICE_COMPONENTS: readonly PracticeComponent[] = [
  'skill',
  'remote_service',
  'collaboration',
  'metaapp',
];

export type ExplorationStallReason = 'no_acceptance' | 'component_collapse';

export interface ExplorationNight {
  dreamDate: string;
  emptyDay: boolean;
  validated: number;
  promoted: number;
}

export interface ExplorationProposal {
  dreamDate: string;
  component: PracticeComponent | null;
}

export interface ExplorationStall {
  stalled: boolean;
  reason: ExplorationStallReason | null;
  dominantComponent: PracticeComponent | null;
}

/** Stall window length and count: three trailing 7-day windows before the dreamed date. */
export const STALL_WINDOW_DAYS = 7;
export const STALL_WINDOW_COUNT = 3;
/** A window only counts as active when at least this many of its nights ran a dream. */
export const STALL_MIN_ACTIVE_NIGHTS_PER_WINDOW = 3;
/** Component collapse lookback: the trailing 14 days of proposals. */
export const COLLAPSE_LOOKBACK_DAYS = 14;
export const COLLAPSE_MIN_PROPOSALS = 4;
/** Under-explored lookback: components with no proposal in the trailing 30 days. */
export const UNDER_EXPLORED_LOOKBACK_DAYS = 30;

const COMPONENT_LABELS: Record<PracticeComponent, string> = {
  memory: 'memory(整理与运用记忆)',
  procedure: 'procedure(固定流程)',
  skill: 'skill(调用或组合技能)',
  remote_service: 'remote_service(调用其他 Bot 的付费服务)',
  collaboration: 'collaboration(与其他 Bot 协作完成任务)',
  metaweb: 'metaweb(阅读与引用链上内容)',
  metaapp: 'metaapp(使用或发布 MetaApp)',
};

export function normalizePracticeComponent(value: unknown): PracticeComponent | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (PRACTICE_COMPONENTS as readonly string[]).includes(normalized)
    ? normalized as PracticeComponent
    : null;
}

/**
 * Deterministic stall detection. Windows are strictly before `date`: window w
 * (w = 1…STALL_WINDOW_COUNT) covers [date − 7w, date − 7w + 6].
 * - no_acceptance: every window has ≥ STALL_MIN_ACTIVE_NIGHTS_PER_WINDOW
 *   non-empty nights AND the windows' nights together produced zero
 *   validated drafts and zero promotions.
 * - component_collapse: ≥ COLLAPSE_MIN_PROPOSALS proposals with a component in
 *   [date − COLLAPSE_LOOKBACK_DAYS, date − 1], all sharing one component.
 * no_acceptance outranks component_collapse; the dominant component is still
 * reported when both hold.
 */
export function detectEvolutionStall(input: {
  date: string;
  nights: readonly ExplorationNight[];
  proposals: readonly ExplorationProposal[];
}): ExplorationStall {
  const windows: Array<{ from: string; to: string }> = [];
  for (let w = 1; w <= STALL_WINDOW_COUNT; w += 1) {
    windows.push({
      from: shiftDateKey(input.date, -STALL_WINDOW_DAYS * w),
      to: shiftDateKey(input.date, -STALL_WINDOW_DAYS * w + STALL_WINDOW_DAYS - 1),
    });
  }
  const unionFrom = shiftDateKey(input.date, -STALL_WINDOW_DAYS * STALL_WINDOW_COUNT);
  const unionTo = shiftDateKey(input.date, -1);
  const beforeDate = input.nights.filter((night) => night.dreamDate >= unionFrom && night.dreamDate <= unionTo);
  const acceptanceSum = beforeDate.reduce(
    (sum, night) => sum + (night.validated || 0) + (night.promoted || 0),
    0,
  );
  const everyWindowActive = windows.every((window) => beforeDate.filter(
    (night) => night.dreamDate >= window.from && night.dreamDate <= window.to && night.emptyDay === false,
  ).length >= STALL_MIN_ACTIVE_NIGHTS_PER_WINDOW);
  const noAcceptance = everyWindowActive && acceptanceSum === 0;

  const collapseFrom = shiftDateKey(input.date, -COLLAPSE_LOOKBACK_DAYS);
  const collapseTo = shiftDateKey(input.date, -1);
  const recentComponents = input.proposals
    .filter((proposal): proposal is ExplorationProposal & { component: PracticeComponent } =>
      proposal.component != null && proposal.dreamDate >= collapseFrom && proposal.dreamDate <= collapseTo)
    .map((proposal) => proposal.component);
  const distinct = new Set<PracticeComponent>(recentComponents);
  const collapse = recentComponents.length >= COLLAPSE_MIN_PROPOSALS && distinct.size === 1;
  const dominantComponent = collapse ? recentComponents[0] : null;

  if (noAcceptance) return { stalled: true, reason: 'no_acceptance', dominantComponent };
  if (collapse) return { stalled: true, reason: 'component_collapse', dominantComponent };
  return { stalled: false, reason: null, dominantComponent: null };
}

/**
 * Components (vocabulary order) with no proposal in the trailing
 * UNDER_EXPLORED_LOOKBACK_DAYS days, excluding `dominantComponent`. When every
 * component was exercised recently, the structural set takes over so the
 * directive still points somewhere meaningful.
 */
export function listUnderExploredComponents(input: {
  date: string;
  proposals: readonly ExplorationProposal[];
  dominantComponent?: PracticeComponent | null;
}): PracticeComponent[] {
  const from = shiftDateKey(input.date, -UNDER_EXPLORED_LOOKBACK_DAYS);
  const to = shiftDateKey(input.date, -1);
  const used = new Set<PracticeComponent>();
  for (const proposal of input.proposals) {
    if (proposal.component != null && proposal.dreamDate >= from && proposal.dreamDate <= to) {
      used.add(proposal.component);
    }
  }
  const missing = PRACTICE_COMPONENTS.filter(
    (component) => !used.has(component) && component !== input.dominantComponent,
  );
  if (missing.length > 0) return [...missing];
  return STRUCTURAL_PRACTICE_COMPONENTS.filter((component) => component !== input.dominantComponent);
}

export function renderExplorationDirective(input: {
  reason: ExplorationStallReason;
  underExplored: readonly PracticeComponent[];
  dominantComponent?: PracticeComponent | null;
}): string {
  const dominantLabel = input.dominantComponent != null ? COMPONENT_LABELS[input.dominantComponent] : '';
  const reasonText = input.reason === 'component_collapse'
    ? `最近两周的练习都集中在 ${dominantLabel}`
    : '连续三周有活动,但没有新的能力通过验证或固化';
  const labels = input.underExplored.map((component) => COMPONENT_LABELS[component]).join('、');
  return [
    `## 探索提示(你的自我进化最近停滞了:${reasonText})`,
    `最近 30 天里你还没有在这些方向上出过练习:${labels}…`,
    '今晚的 practice_proposals 里,至少一条的 component 要从上面这些方向里选;另一条照常针对记录在案的薄弱点。',
    '出处规则不变:每条提案仍然必须有 target_refs,risk_class 照实填写;找不到有出处的目标时,宁可少出一条,也不要编造。',
  ].join('\n');
}

/** true iff some proposal targets an under-explored component; null when not directed. */
export function judgeExplorationCompliance(input: {
  directed: boolean;
  underExplored: readonly PracticeComponent[];
  proposals: ReadonlyArray<{ component: PracticeComponent | null }>;
}): boolean | null {
  if (!input.directed) return null;
  const wanted = new Set<PracticeComponent>(input.underExplored);
  return input.proposals.some((proposal) => proposal.component != null && wanted.has(proposal.component));
}

/**
 * Ordering-only novelty bonus (design §6.4): while stalled, read-only approval
 * drains under-explored proposals first. A stable partition keeps each part in
 * its input (oldest-first) order; not stalled returns the input unchanged.
 */
export function orderPracticeProposalsForApproval<T extends { component: PracticeComponent | null }>(
  oldestFirst: readonly T[],
  input: { stalled: boolean; underExplored: readonly PracticeComponent[] },
): T[] {
  if (!input.stalled) return [...oldestFirst];
  const wanted = new Set<PracticeComponent>(input.underExplored);
  const matches: T[] = [];
  const rest: T[] = [];
  for (const proposal of oldestFirst) {
    if (proposal.component != null && wanted.has(proposal.component)) {
      matches.push(proposal);
    } else {
      rest.push(proposal);
    }
  }
  return [...matches, ...rest];
}
