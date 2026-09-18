import React from 'react';
import { i18nService } from '../../services/i18n';
import {
  ArrowTopRightOnSquareIcon,
  XMarkIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import type { TrackedCardDetail } from '../../types/trackedTask';
import {
  STATE_CHIP_CLASS,
  columnLabel,
  formatIsoShort,
  sessionRoleLabel,
  sourceKindLabel,
} from './trackedTaskPresentation';
import { reasonText, suggestionTextForCard } from './trackedTaskFactText';
import MetaWebUriLink from './MetaWebUriLink';

interface TrackedTaskDrawerProps {
  detail: TrackedCardDetail;
  /** metabotId → 名称；缺失时回落为 #id，不臆造名字。 */
  metabotNames: Map<number, string>;
  onClose: () => void;
  onRequestCloseCard: (cardId: string) => void;
  /** v1.3 手工归档：仅 state==='closed' 且未归档的卡展示入口。 */
  onArchiveCard?: (cardId: string) => void;
  archiving?: boolean;
}

/** 「目标」节默认截断行数（owner 2026-09-18 反馈②：约 6 行）。 */
const GOAL_COLLAPSED_LINES = 6;
/** 抽屉标题折叠行数：标题 = owner_intent 原文，可 1600+ 字，必须折叠（owner 2026-09-18 反馈②）。 */
const TITLE_COLLAPSED_LINES = 3;
/** 展开态文本容器的限高：长文在区域内自己滚，不把抽屉连同页脚顶出屏幕。 */
const EXPANDED_TEXT_MAX_HEIGHT_CLASS = 'max-h-[40vh]';

/**
 * 可折叠文本（标题与「目标」共用）：whitespace-pre-wrap 保留原始换行；
 * 默认 -webkit-line-clamp 截断，是否给展开/收起由 ref 实测（scrollHeight > clientHeight）决定，
 * 不用字数启发式。展开期间保留上一次的实测值，按钮不闪烁；text 变化（换卡）时用 key 重挂载复位。
 * 展开态的限高滚动容器只包文本本身，展开/收起按钮渲染在容器之外——按钮永远可见（owner 反馈②）。
 */
const ExpandableText: React.FC<{
  text: string;
  /** 折叠行数：标题 3 行 / 目标 6 行。 */
  collapsedLines: number;
  textClassName: string;
  /** 标题保留 h2 语义，正文用 p。 */
  as?: 'h2' | 'p';
}> = ({ text, collapsedLines, textClassName, as = 'p' }) => {
  const textRef = React.useRef<HTMLElement | null>(null);
  const setTextRef = React.useCallback((node: HTMLElement | null) => {
    textRef.current = node;
  }, []);
  const [expanded, setExpanded] = React.useState(false);
  const [collapsedOverflow, setCollapsedOverflow] = React.useState(false);

  React.useLayoutEffect(() => {
    if (expanded) return;
    const el = textRef.current;
    if (!el) return;
    setCollapsedOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  const collapsedStyle: React.CSSProperties = {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: collapsedLines,
    overflow: 'hidden',
  };

  return (
    <div>
      <div className={expanded ? `${EXPANDED_TEXT_MAX_HEIGHT_CLASS} overflow-y-auto` : undefined}>
        {as === 'h2' ? (
          <h2 ref={setTextRef} className={textClassName} style={expanded ? undefined : collapsedStyle}>
            {text}
          </h2>
        ) : (
          <p ref={setTextRef} className={textClassName} style={expanded ? undefined : collapsedStyle}>
            {text}
          </p>
        )}
      </div>
      {(expanded || collapsedOverflow) && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-1 text-[11px] text-claude-accent transition-colors hover:underline"
        >
          {i18nService.t(expanded ? 'trackedTask.drawer.collapse' : 'trackedTask.drawer.expand')}
        </button>
      )}
    </div>
  );
};

/**
 * 交付物类型徽章配色（owner 2026-09-18 反馈③）：metaapp 紫 / metafile 绿 / pin 蓝 / url 琥珀；
 * other/none 走中性边框色。徽章文案走 i18n（中英同键），不在组件里写死英文。
 */
const DELIVERABLE_KIND_BADGE_CLASS: Record<string, string> = {
  metaapp: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  metafile: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  pin: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  url: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  other:
    'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary',
};

const DELIVERABLE_KIND_LABEL_KEY: Record<string, string> = {
  metaapp: 'trackedTask.uriKind.metaapp',
  metafile: 'trackedTask.uriKind.metafile',
  pin: 'trackedTask.uriKind.pin',
  url: 'trackedTask.uriKind.url',
  other: 'trackedTask.uriKind.other',
};

function deliverableKindBadgeClass(kind: string): string {
  return DELIVERABLE_KIND_BADGE_CLASS[kind] ?? DELIVERABLE_KIND_BADGE_CLASS.other;
}

function deliverableKindLabel(kind: string): string {
  return i18nService.t(DELIVERABLE_KIND_LABEL_KEY[kind] ?? DELIVERABLE_KIND_LABEL_KEY.other);
}

/** 抽屉里的一节：统一节奏，避免九节各写一套间距。 */
const Section: React.FC<{ labelKey: string; children: React.ReactNode }> = ({ labelKey, children }) => (
  <section className="border-b dark:border-claude-darkBorder border-claude-border py-3">
    <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
      {i18nService.t(labelKey)}
    </h3>
    {children}
  </section>
);

const Empty: React.FC = () => (
  <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">—</div>
);

function personName(metabotId: number | null, names: Map<number, string>): string | null {
  if (metabotId === null || metabotId === undefined) return null;
  return names.get(metabotId) ?? `#${metabotId}`;
}

function criterionText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && 'text' in item) {
    const text = (item as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

/**
 * 任务卡抽屉（验收④九字段）。
 * 状态摘要严格取台账投影的 reasons（后端已截前 5 条）；抽屉不自行汇总，避免出现第二套状态口径。
 */
const TrackedTaskDrawer: React.FC<TrackedTaskDrawerProps> = ({
  detail,
  metabotNames,
  onClose,
  onRequestCloseCard,
  onArchiveCard,
  archiving,
}) => {
  /** 卡 → 会话跳转：复用既有 scheduledTask:viewSession 通道（App.tsx 已在监听）。 */
  const jumpToSession = (sessionId: string) => {
    window.dispatchEvent(new CustomEvent('scheduledTask:viewSession', { detail: { sessionId } }));
  };

  // 摘要与建议：结构化事实 → i18n 文案；后端 reasons 仅作 fallback（日志串，不是 UI 文案）。
  const summaryLines = (detail.reasonCodes?.length ? detail.reasonCodes.slice(0, 5).map((fact, index) => reasonText(fact, detail.reasons?.[index])) : (detail.reasons ?? []).slice(0, 5));
  const suggestion = suggestionTextForCard(detail);

  const ownerName = personName(detail.owner.twinMetabotId, metabotNames);
  // 参与席 = 后端给的 participants（metabotId 列表）；负责人来自 owner.twinMetabotId。
  const stepsByAssignee = new Map<number, { title: string; status: string }>();
  detail.steps.forEach((step) => {
    if (step.assigneeMetabotId === null) return;
    if (!stepsByAssignee.has(step.assigneeMetabotId)) {
      stepsByAssignee.set(step.assigneeMetabotId, { title: step.title, status: step.status });
    }
  });
  const participants = detail.participants
    .filter((metabotId) => metabotId !== detail.owner.twinMetabotId)
    .map((metabotId) => {
      const step = stepsByAssignee.get(metabotId);
      return {
        key: `participant-${metabotId}`,
        name: personName(metabotId, metabotNames) ?? `#${metabotId}`,
        stepTitle: step?.title ?? '',
        status: step?.status ?? '',
      };
    });

  return (
    // non-draggable：抽屉盖住 48px 拖拽头条带（ScheduledTasksView header），
    // 不标 no-drag 的话整个 fixed 覆盖层里的点击仍落在窗口拖拽区里——
    // 右上角 X 恰好在条带内，点击被拖拽吞掉（owner 2026-09-18 反馈①）。
    <div className="non-draggable fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative flex h-full w-[560px] max-w-[92vw] flex-col border-l dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-2xl">
        <div className="flex shrink-0 items-start gap-2 border-b dark:border-claude-darkBorder border-claude-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`inline-flex items-center rounded-full border px-1.5 py-[1px] text-[10px] font-semibold ${STATE_CHIP_CLASS[detail.state]}`}
              >
                {columnLabel(detail.stateLabelKey, detail.state)}
              </span>
              <span className="text-[11px] font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {detail.ledgerStatus} · {detail.id.slice(0, 8)}
              </span>
              <span className="rounded border dark:border-claude-darkBorder border-claude-border px-1 py-[1px] text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {sourceKindLabel(detail.sourceKind)}
              </span>
            </div>
            {/* 标题 = owner_intent 原文，可 1600+ 字：3 行折叠 + 实测展开（反馈②）。 */}
            <ExpandableText
              key={`title-${detail.id}`}
              as="h2"
              text={detail.title}
              collapsedLines={TITLE_COLLAPSED_LINES}
              textClassName="mt-1.5 break-words text-sm font-semibold leading-snug dark:text-claude-darkText text-claude-text"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={i18nService.t('close')}
            className="shrink-0 rounded-lg p-1.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        {/* min-h-0：flex 列子项默认 min-height:auto，缺它时超长内容把抽屉（连同窗口）撑大而不滚动（反馈②）。 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {/* 1 目标：默认截断 + 溢出实测展开；原始换行用 pre-wrap 保留 */}
          <Section labelKey="trackedTask.drawer.goal">
            <ExpandableText
              key={`goal-${detail.id}`}
              text={detail.goal}
              collapsedLines={GOAL_COLLAPSED_LINES}
              textClassName="break-words whitespace-pre-wrap text-sm leading-snug dark:text-claude-darkText text-claude-text"
            />
            {detail.enrichedGoal && detail.enrichedGoal !== detail.goal && (
              <p className="mt-1 break-words whitespace-pre-wrap text-xs leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {detail.enrichedGoal}
              </p>
            )}
          </Section>

          {/* 2 当前权威状态摘要（≤5 行，来源 = 台账投影 reasons） */}
          <Section labelKey="trackedTask.drawer.statusSummary">
            {summaryLines.length === 0 ? (
              <Empty />
            ) : (
              <ol className="space-y-1">
                {summaryLines.map((line, index) => (
                  <li
                    key={`${index}-${line}`}
                    className="flex gap-2 text-xs leading-snug dark:text-claude-darkText text-claude-text"
                  >
                    <span className="shrink-0 font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {index + 1}
                    </span>
                    <span className="break-words">{line}</span>
                  </li>
                ))}
              </ol>
            )}
            {detail.reasonOverflow > 0 && (
              <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('trackedTask.reasonOverflow').replace(
                  '{count}',
                  String(detail.reasonOverflow)
                )}
              </div>
            )}
            {suggestion && (
              <div className="mt-2 rounded-md border border-dashed border-red-500/40 bg-red-500/5 px-2 py-1 text-[11px] leading-snug text-red-500">
                {suggestion}
              </div>
            )}
          </Section>

          {/* 3 验收标准 */}
          <Section labelKey="trackedTask.drawer.acceptance">
            {detail.acceptanceCriteria.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1">
                {detail.acceptanceCriteria.map((item, index) => (
                  <li
                    key={`${index}-${criterionText(item)}`}
                    className="flex gap-2 text-xs leading-snug dark:text-claude-darkText text-claude-text"
                  >
                    <span className="shrink-0 font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="break-words">{criterionText(item)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* 4 负责人与参与 */}
          <Section labelKey="trackedTask.drawer.participants">
            <div className="flex flex-wrap gap-1.5">
              {ownerName && (
                <span className="inline-flex items-center gap-1 rounded-full border border-claude-accent/50 bg-claude-accent/10 px-2 py-[2px] text-[11px] dark:text-claude-darkText text-claude-text">
                  {ownerName}
                  <span className="font-mono opacity-70">{i18nService.t('trackedTask.seat.owner')}</span>
                </span>
              )}
              {participants.map((person) => (
                <span
                  key={person.key}
                  title={person.stepTitle ? `${person.stepTitle} · ${person.status}` : undefined}
                  className="inline-flex items-center gap-1 rounded-full border dark:border-claude-darkBorder border-claude-border px-2 py-[2px] text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
                >
                  {person.name}
                  <span className="font-mono opacity-70">{i18nService.t('trackedTask.seat.worker')}</span>
                </span>
              ))}
              {!ownerName && participants.length === 0 && <Empty />}
            </div>
          </Section>

          {/* 5 前置依赖 */}
          <Section labelKey="trackedTask.drawer.dependencies">
            {detail.dependencies.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1">
                {detail.dependencies.map((dep) => {
                  const resolved = dep.unmet.length === 0 && dep.status === 'completed';
                  return (
                    <li key={dep.stepId} className="flex items-center gap-2 text-xs">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${resolved ? 'bg-emerald-500' : 'bg-amber-500'}`}
                      />
                      <span className="break-words dark:text-claude-darkText text-claude-text">{dep.title}</span>
                      <span className="shrink-0 font-mono text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {dep.status}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t(
                          resolved ? 'trackedTask.dependency.resolved' : 'trackedTask.dependency.open'
                        )}
                        {dep.unmet.length > 0 ? ` ${dep.unmet.length}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {/* 6 下一次检查点 */}
          <Section labelKey="trackedTask.drawer.checkpoint">
            {detail.nextCheckpointAt ? (
              <div className="flex items-baseline gap-2 text-xs">
                <span className="font-mono dark:text-claude-darkText text-claude-text">
                  {formatIsoShort(detail.nextCheckpointAt)}
                </span>
                {detail.checkpoints.length > 0 && (
                  <span className="truncate text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {detail.checkpoints[0].topic ?? detail.checkpoints[0].status}
                  </span>
                )}
              </div>
            ) : (
              <Empty />
            )}
          </Section>

          {/* 7 关联会话（卡 → 全部关联会话，可跳转） */}
          <Section labelKey="trackedTask.drawer.sessions">
            {detail.sessions.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1">
                {detail.sessions.map((session) => (
                  <li key={`${session.role}-${session.sessionId}`}>
                    <button
                      type="button"
                      onClick={() => jumpToSession(session.sessionId)}
                      className="group flex w-full items-center gap-2 rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1.5 text-left transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                    >
                      <span className="shrink-0 rounded border dark:border-claude-darkBorder border-claude-border px-1 py-[1px] text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {sessionRoleLabel(session.role)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs dark:text-claude-darkText text-claude-text">
                        {session.sessionId}
                      </span>
                      <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* 8 交付物（uri 由主进程唯一解析器命中后入库） */}
          <Section labelKey="trackedTask.drawer.deliverables">
            {detail.deliverables.length === 0 ? (
              <Empty />
            ) : (
              <ul className="space-y-1">
                {detail.deliverables.map((item, index) => (
                  <li
                    key={`${index}-${item.uri}`}
                    className="flex items-start gap-2 rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1.5"
                  >
                    {/* 类型徽章（按 URI scheme 分色）取代原来的「kind 原文」chip（反馈③）。 */}
                    <span
                      className={`shrink-0 rounded border px-1 py-[1px] text-[10px] font-semibold ${deliverableKindBadgeClass(item.kind)}`}
                    >
                      {deliverableKindLabel(item.kind)}
                    </span>
                    {/* 原状态 chip 保留为次要中性 chip，原信息不丢。 */}
                    {item.status && (
                      <span className="shrink-0 rounded border dark:border-claude-darkBorder border-claude-border px-1 py-[1px] text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {item.status}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 break-all font-mono text-[11px] dark:text-claude-darkText text-claude-text">
                      <MetaWebUriLink text={item.uri} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* 9 事件流 */}
          <Section labelKey="trackedTask.drawer.events">
            {detail.events.length === 0 ? (
              <Empty />
            ) : (
              <ol className="space-y-1.5">
                {detail.events.map((event, index) => (
                  <li key={`${index}-${event.at}`} className="flex gap-2">
                    <span className="shrink-0 pt-[2px] font-mono text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {formatIsoShort(event.at)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mr-1 rounded border dark:border-claude-darkBorder border-claude-border px-1 py-[1px] text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {event.kind}
                      </span>
                      <span className="break-words text-xs leading-snug dark:text-claude-darkText text-claude-text">
                        {event.detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {/* 收口结论（来源 = orchestration_tasks.closure_* 四列） */}
          {detail.closure.conclusion && (
            <Section labelKey="trackedTask.drawer.closure">
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-500">
                  <CheckCircleIcon className="w-3.5 h-3.5" />
                  <span className="font-medium">
                    {i18nService.t(
                      detail.closure.by === 'twin'
                        ? 'trackedTask.closure.byTwin'
                        : 'trackedTask.closure.byOwner'
                    )}
                  </span>
                  <span className="ml-auto font-mono">{formatIsoShort(detail.closure.at)}</span>
                </div>
                <p className="mt-1 break-words text-xs leading-snug dark:text-claude-darkText text-claude-text">
                  {detail.closure.conclusion}
                </p>
                {detail.closure.pinId && (
                  <p className="mt-1 break-all font-mono text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {/* 裸 pinId 由 MetaWebUriLink 拼成 pin://<pinId> 打开 */}
                    <MetaWebUriLink text={detail.closure.pinId} />
                  </p>
                )}
              </div>
            </Section>
          )}
        </div>

        {/* 收口入口（验收⑥：单按钮，不做验收/拒绝二选一）；已收口的卡给「归档」（反馈⑥） */}
        <div className="flex shrink-0 items-center gap-2 border-t dark:border-claude-darkBorder border-claude-border px-4 py-3">
          <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('trackedTask.drawer.footerHint')}
          </span>
          {detail.state !== 'closed' && (
            <button
              type="button"
              onClick={() => onRequestCloseCard(detail.id)}
              className="btn-idchat-primary-filled ml-auto px-3 py-1.5 text-sm font-medium"
            >
              {i18nService.t('trackedTask.close.button')}
            </button>
          )}
          {detail.state === 'closed' && detail.admitted && onArchiveCard && (
            <button
              type="button"
              disabled={archiving}
              onClick={() => onArchiveCard(detail.id)}
              className="ml-auto rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {archiving
                ? i18nService.t('trackedTask.archive.archiving')
                : i18nService.t('trackedTask.archive.action')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default TrackedTaskDrawer;
