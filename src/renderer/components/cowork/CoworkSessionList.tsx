import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem, { SessionAvatarCircle, formatRelativeTime } from './CoworkSessionItem';
import BotSelectorPopover from './BotSelectorPopover';
import { i18nService } from '../../services/i18n';
import { useStableCallback } from '../../utils/useStableCallback';
import { useProgressiveRowReveal } from './sessionListRevealBudget';
import {
  ALL_BOTS_OPTION_KEY,
  buildBotSelectorOptions,
  defaultBotSelectorKey,
  groupSessionsByProject,
  groupSessionsByTimeline,
  sessionBotKey,
  shouldShowBotSelector,
  sortSessionsByMode,
  unreadOutsideBotSelection,
  type SessionSortMode,
  type SessionViewMode,
} from '../../utils/sessionViewGrouping';
import {
  AUTO_TASKS_EXPANDED_STORAGE_KEY,
  parseAutoTasksExpandedPreference,
  serializeAutoTasksExpandedPreference,
} from '../../utils/sessionAutoGrouping';
import { ChevronDownIcon, FolderIcon } from '@heroicons/react/24/outline';

interface CoworkSessionListProps {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  /** Empty-state message; defaults to the generic "no tasks" text. */
  emptyText?: string;
  /** Batch-selection mode (batch archive): rows render a checkbox and clicking
   * a row toggles its selection instead of opening the session. */
  selectionMode?: boolean;
  selectedSessionIds?: string[];
  onToggleSessionSelected?: (sessionId: string) => void;
  /** Grouping mode for the sidebar's local-chats list. Undefined keeps the
   * historic flat list (search modal, A2A tab). */
  viewMode?: SessionViewMode;
  /** Ordering within the flat list and inside every group. */
  sortMode?: SessionSortMode;
  /**
   * Auto-folded sessions (long-term task runs, orchestration/delegation runs)
   * for the local-chats list — scheduled-task runs are NOT folded, they stay in
   * the main list. Folded rows are NEVER mixed into the main list: they render
   * as one collapsed "Auto Tasks" folder directly under the pinned
   * section and above the content groups, independent of the view mode — tucked
   * out of the human conversations, but visible at a glance instead of buried
   * at the bottom. Only the local tab passes this; every other caller leaves
   * it off and its output is unchanged.
   */
  autoSessions?: CoworkSessionSummary[];
  /** Online-chats (A2A) Bot selector — that list's ONLY selector. When on, one
   * avatar-led control renders above the flat list (BotSelectorPopover: avatar +
   * current value + ▾, no "Bot:" label), listing 全部 and one entry per local bot
   * in a self-drawn 我的 Bot popover. It opens on the Twin (the
   * bot you converse with; workers are picked on purpose), and picking an entry
   * scopes the flat list to that bot while 全部 restores it. The control carries
   * the unread count of the bots that are NOT selected, so focusing one bot can
   * never hide work waiting under another. There is no grouping header and no
   * view mode behind it, and a lone local bot gets no control (a single option
   * would only repeat the list). The control is demoted to the host's "row above
   * the list" weight — left aligned, width fitted to its content, background
   * only on hover — and a hairline separates the control area from the rows.
   * Every other caller leaves it off, so their output is unchanged. */
  botSelector?: boolean;
  /**
   * i18n generation marker. The rows and the group headers read their copy from
   * i18nService at render time, so a memoized list needs the language among its
   * props — without it, switching language would leave every label in this list
   * in the previous language until the session data happened to change. Callers
   * pass i18nService.getLanguage() (they re-render on a language switch through
   * App's i18n subscription).
   */
  language?: string;
}

const groupHeaderLabelClass =
  'text-[11px] font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary';

/**
 * Cadence of the shared clock the rows stamp their relative time with. One
 * minute matches the "5m" granularity of the label: a row that is memoized no
 * longer recomputes anything on its own, so the list is what turns "5m" into
 * "6m" (and the group-memo timestamp into the current minute).
 */
const RELATIVE_TIME_TICK_MS = 60_000;

/**
 * Stand-in for an omitted `onToggleSessionSelected` (a caller that never enters
 * batch-selection mode leaves it out), so the rows always receive a callable.
 */
const noopToggleSelected = (): void => {};

/**
 * Shallow equality, one level deep: `Object.is` per key, and for nested objects
 * a key-wise comparison of their own fields (session summaries carry at most
 * `serviceOrderSummary`, which is an object). Deliberately conservative — any
 * field that differs, at any depth, reports unequal, so a changed session is
 * never mistaken for an unchanged one. It only has to be good enough to reuse
 * the previous object when nothing changed.
 */
const sameSummaryValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.is(
    (a as Record<string, unknown>)[key],
    (b as Record<string, unknown>)[key],
  ));
};

const sameSessionSummary = (a: CoworkSessionSummary, b: CoworkSessionSummary): boolean =>
  sameSummaryValue(a, b);

/**
 * Hold on to the previous summary object for every session whose fields did not
 * change. `coworkSlice.setSessions` replaces the whole array — and each summary
 * with it — on every list read, so without this the row-level memo would compare
 * unequal on every refresh and nothing would ever bail out. Reusing the object
 * for unchanged rows is what lets a refresh re-render only the rows that moved;
 * changed rows keep their fresh object, so no update can be swallowed.
 *
 * The returned arrays are new whenever the inputs are (the list has to re-derive
 * its sorting and grouping then anyway); only the row objects are stabilized.
 */
const useStableSessionSummaries = (
  sessions: CoworkSessionSummary[],
  autoSessions?: CoworkSessionSummary[],
): [CoworkSessionSummary[], CoworkSessionSummary[] | undefined] => {
  const cacheRef = useRef<Map<string, CoworkSessionSummary>>(new Map());
  return useMemo(() => {
    const nextCache = new Map<string, CoworkSessionSummary>();
    const stabilize = (list: CoworkSessionSummary[]): CoworkSessionSummary[] =>
      list.map((session) => {
        const previous = cacheRef.current.get(session.id);
        const kept = previous && sameSessionSummary(previous, session) ? previous : session;
        nextCache.set(session.id, kept);
        return kept;
      });
    const result: [CoworkSessionSummary[], CoworkSessionSummary[] | undefined] = [
      stabilize(sessions),
      autoSessions ? stabilize(autoSessions) : undefined,
    ];
    cacheRef.current = nextCache;
    return result;
  }, [sessions, autoSessions]);
};

/** Remembered open/closed state of the Auto Tasks fold, read once on mount. */
const loadAutoTasksExpanded = (): boolean => {
  try {
    return parseAutoTasksExpandedPreference(window.localStorage.getItem(AUTO_TASKS_EXPANDED_STORAGE_KEY));
  } catch {
    // localStorage unavailable; fall through to the collapsed default.
  }
  return false;
};

const CoworkSessionListRow: React.FC<CoworkSessionListProps> = ({
  sessions: incomingSessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  emptyText,
  selectionMode = false,
  selectedSessionIds,
  onToggleSessionSelected,
  viewMode,
  sortMode = 'updatedAt',
  botSelector = false,
  autoSessions: incomingAutoSessions,
  language: languageProp,
}) => {
  // Same summary objects for the rows whose fields did not change (see the
  // hook); everything below reads these instead of the raw props.
  const [sessions, autoSessions] = useStableSessionSummaries(incomingSessions, incomingAutoSessions);
  // One shared clock for the rows' relative-time stamps, ticked once a minute.
  // Rows are memoized, so a row that recomputed Date.now() itself would freeze
  // its label until its data changed; the tick is what keeps "5m" turning into
  // "6m" on its own (and what the group memo stamps with).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  /**
   * The rows are memoized, so the action callbacks they receive must keep one
   * identity: a fresh closure per render (which is what a parent's inline
   * handler gives us) would re-render every mounted row on every list render.
   */
  const selectSession = useStableCallback(onSelectSession);
  const deleteSession = useStableCallback(onDeleteSession);
  const togglePin = useStableCallback(onTogglePin);
  const renameSession = useStableCallback(onRenameSession);
  // Batch selection is the one optional action (the search modal never enters
  // selection mode). A no-op keeps the memoized prop a function, so the row's
  // guard cannot silently let an undefined callback through to a click.
  const toggleSessionSelected = useStableCallback(onToggleSessionSelected ?? noopToggleSelected);
  // How many rows may mount right now (see useProgressiveRowReveal), and the
  // cursor renderItem consumes it with.
  const rootRef = useRef<HTMLDivElement>(null);
  const revealedRows = useProgressiveRowReveal(rootRef);
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds ?? []), [selectedSessionIds]);
  // Project-group collapse state lives here (not in the parent) so the search
  // modal and A2A tab, which render flat, never see it. Defaults to expanded.
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set);
  // The Auto Tasks fold, unlike the project groups, remembers its state across
  // restarts: it holds background runs, so it opens collapsed every launch.
  const [isAutoTasksExpanded, setIsAutoTasksExpanded] = useState<boolean>(loadAutoTasksExpanded);
  const toggleAutoTasksExpanded = () => {
    setIsAutoTasksExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(
          AUTO_TASKS_EXPANDED_STORAGE_KEY,
          serializeAutoTasksExpandedPreference(next),
        );
      } catch {
        // localStorage unavailable; the fold still toggles for this session.
      }
      return next;
    });
  };
  const [pickedBotKey, setPickedBotKey] = useState<string | null>(null);
  // undefined = the Twin lookup has not settled yet, null = no Twin on this
  // install. The control waits for the answer: while it is pending the row is
  // held open by a value-less placeholder (same boxes as the trigger), so the
  // control never paints 全部 and then jumps to the Twin a frame later — the
  // default-Twin promise is kept on the very first painted frame.
  const [twinMetabotId, setTwinMetabotId] = useState<number | null | undefined>(undefined);
  const twinSettled = twinMetabotId !== undefined;
  // The caller's language, with a standalone fallback (see the prop's docs).
  const language = languageProp ?? i18nService.getLanguage();

  // Which local bot is the Twin comes from the same read-only IPC the rest of
  // the renderer uses. Best effort: any failure leaves the selector on 全部.
  useEffect(() => {
    if (!botSelector) return;
    let cancelled = false;
    window.electron?.idbots
      ?.getMetaBots?.()
      .then((result) => {
        if (cancelled) return;
        const twin = result?.success
          ? result.list?.find((bot) => bot.metabot_type === 'twin')
          : undefined;
        setTwinMetabotId(twin?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setTwinMetabotId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [botSelector]);

  // Selector options. Built from the sessions the list already has plus the
  // existing redux unread ids — no new store, no new data source. They exist
  // only for the online list; for every other caller the array stays empty and
  // nothing below changes.
  const botSelectorOptions = useMemo(
    () => (botSelector ? buildBotSelectorOptions(sessions, unreadSessionIds) : []),
    [botSelector, sessions, unreadSessionIds],
  );
  // A lone local bot needs no selector (the same "zero noise" rule as the
  // single-group degradation), so the control stays off below two local bots.
  const showBotSelector = shouldShowBotSelector(botSelectorOptions);
  // The filter only ever engages behind the control: with no control the list
  // is the plain flat list, so a single-bot install (and every other caller)
  // keeps rendering exactly the rows it rendered before.
  const defaultBotKey = showBotSelector
    ? defaultBotSelectorKey(botSelectorOptions, twinMetabotId)
    : ALL_BOTS_OPTION_KEY;
  // An explicit pick wins while its option still exists; otherwise the list
  // falls back to the default, so the filtered state cannot get stuck.
  const activeBotKey =
    showBotSelector && pickedBotKey && botSelectorOptions.some((option) => option.key === pickedBotKey)
      ? pickedBotKey
      : defaultBotKey;
  // Unread under the bots that are NOT selected: the one signal the control
  // itself has to carry (see unreadOutsideBotSelection).
  const unreadElsewhere = unreadOutsideBotSelection(botSelectorOptions, activeBotKey);
  const visibleSessions = useMemo(
    () =>
      activeBotKey === ALL_BOTS_OPTION_KEY
        ? sessions
        : sessions.filter((session) => sessionBotKey(session) === activeBotKey),
    [sessions, activeBotKey],
  );

  const sortedSessions = useMemo(() => {
    const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
      if (b.updatedAt !== a.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return b.createdAt - a.createdAt;
    };

    const pinnedSessions = visibleSessions
      .filter((session) => session.pinned)
      .sort(sortByRecentActivity);
    const unpinnedSessions = visibleSessions
      .filter((session) => !session.pinned)
      .sort(sortByRecentActivity);
    return [...pinnedSessions, ...unpinnedSessions];
  }, [visibleSessions]);

  // Buckets are day-relative ("Today" / "Yesterday"), so the grouping has to be
  // re-derived as the clock moves on: it now depends on the shared tick, not
  // only on the session list. Without that, a sidebar left open past midnight
  // kept filing the new day's sessions under "Today" until something else
  // changed the list.
  const timelineGrouped = useMemo(
    () => (viewMode === 'timeline'
      ? groupSessionsByTimeline(visibleSessions, sortMode, nowMs, language)
      : null),
    [visibleSessions, viewMode, sortMode, language, nowMs],
  );

  const projectGrouped = useMemo(
    () => (viewMode === 'project' ? groupSessionsByProject(visibleSessions, sortMode) : null),
    [visibleSessions, viewMode, sortMode],
  );

  // The Auto Tasks fold: machine-started runs, ordered like the main list
  // (pinned first, then the active sort mode) inside ONE flat section that
  // always sits directly under the pinned block, whatever the view mode. A pin
  // keeps its place inside the fold — it never rescues a background run back
  // into the human list.
  const sortedAutoSessions = useMemo(() => {
    const list = autoSessions ?? [];
    if (list.length === 0) return [];
    return [
      ...sortSessionsByMode(list.filter((session) => session.pinned), sortMode),
      ...sortSessionsByMode(list.filter((session) => !session.pinned), sortMode),
    ];
  }, [autoSessions, sortMode]);
  // Newest activity in the fold (updatedAt is the session's last-activity
  // anchor, the same value the row's own timestamp shows).
  const autoLatestActivityAt = useMemo(
    () => sortedAutoSessions.reduce((latest, session) => Math.max(latest, session.updatedAt), 0),
    [sortedAutoSessions],
  );

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // The row takes the session id for every action and one shared clock/language,
  // so that two consecutive renders of an unchanged row produce referentially
  // equal props and the memo on CoworkSessionItem bails out.
  //
  // It also spends the render budget: the maps below still walk the whole list,
  // but every row past the budget returns null and never mounts. Sections check
  // the budget before rendering their header (revealBudgetLeft), so an exhausted
  // budget cannot leave a header with no rows under it.
  let remainingRows = revealedRows;
  const revealBudgetLeft = () => remainingRows > 0;
  const renderItem = (session: CoworkSessionSummary) => {
    if (remainingRows <= 0) return null;
    remainingRows -= 1;
    return (
      <CoworkSessionItem
        key={session.id}
        session={session}
        hasUnread={unreadSessionIdSet.has(session.id)}
        isActive={session.id === currentSessionId}
        selectionMode={selectionMode}
        isSelected={selectedSessionIdSet.has(session.id)}
        nowMs={nowMs}
        language={language}
        onSelect={selectSession}
        onDelete={deleteSession}
        onTogglePin={togglePin}
        onRename={renameSession}
        onToggleSelected={toggleSessionSelected}
      />
    );
  };

  const renderPinnedSection = (pinned: CoworkSessionSummary[]) =>
    pinned.length > 0 && revealBudgetLeft() && (
      <section key="pinned">
        <div className={`px-2.5 pb-1 pt-2 ${groupHeaderLabelClass}`}>
          {i18nService.t('coworkPinnedGroup')}
        </div>
        {pinned.map(renderItem)}
      </section>
    );

  /**
   * The Auto Tasks fold. Rendered in every view mode directly under the pinned
   * block (above the timeline/project groups, where it is seen without
   * scrolling), and only when there is something to fold — an empty folder
   * would be noise of its own. The header
   * is styled like the project groups' folder header (subdued secondary text +
   * folder glyph) so it reads as a container, not as a conversation, and carries
   * only label + count + the fold's newest activity time: an unread number here
   * was pure noise (assistant stream chunks carry no `metadata.origin`, so a
   * heartbeat exemption cannot cover the replies and an active folded session
   * looks unread almost permanently). Per-row dots inside the EXPANDED fold stay
   * — that is where "which run has news" is actually traceable.
   */
  const renderAutoTasksSection = () =>
    revealBudgetLeft() && sortedAutoSessions.length > 0 && (
      <section data-testid="auto-tasks-section">
        <button
          type="button"
          aria-expanded={isAutoTasksExpanded}
          onClick={toggleAutoTasksExpanded}
          title={i18nService.t('coworkAutoTasksCount').replace('{count}', String(sortedAutoSessions.length))}
          className={`flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-left transition-colors hover:text-claude-text dark:hover:text-claude-darkText ${groupHeaderLabelClass}`}
        >
          <ChevronDownIcon
            className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${isAutoTasksExpanded ? '' : '-rotate-90'}`}
          />
          <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{i18nService.t('coworkAutoTasks')}</span>
          <span className="flex-shrink-0 font-normal tabular-nums">{sortedAutoSessions.length}</span>
          {autoLatestActivityAt > 0 && (
            <span className="ml-auto flex-shrink-0 font-normal tabular-nums" title={formatRelativeTime(autoLatestActivityAt).full}>
              {formatRelativeTime(autoLatestActivityAt).compact}
            </span>
          )}
        </button>
        {isAutoTasksExpanded && sortedAutoSessions.map(renderItem)}
      </section>
    );

  // The online list's only selector: ONE self-drawn control holding 全部 and
  // every local bot, so the whole picker is a single line at any bot count. The
  // control carries the current bot's avatar instead of a "Bot:" label, its
  // popover lists each bot with avatar / name / session count / unread dot, and
  // the badge beside it carries the unread of the bots that are NOT selected — a
  // closed picker must never be the reason pending work is invisible.
  const botSelectorRow = showBotSelector ? (
    twinSettled ? (
      <BotSelectorPopover
        options={botSelectorOptions}
        activeKey={activeBotKey}
        onPick={setPickedBotKey}
        unreadElsewhere={unreadElsewhere}
      />
    ) : (
      /* Twin pending: hold the control's row open with an inert placeholder
       * instead of painting it as 全部. The boxes (row padding, 16px avatar,
       * 24px label slot, 12px chevron) mirror the real trigger, so settling
       * swaps the content in place — nothing below the row moves, and no value
       * the Twin lookup has not confirmed is ever shown. aria-hidden: a
       * loading shell must not enter the accessibility tree as a fake value;
       * the real control arrives with its own name one tick later. */
      <div
        data-testid="bot-selector-row"
        data-pending="true"
        aria-hidden="true"
        className="flex items-center gap-1.5 px-2.5 pb-1 pt-0.5"
      >
        <span className="flex w-fit items-center gap-1.5 rounded-md py-0.5 pl-0 pr-1.5">
          <span className="h-4 w-4 flex-shrink-0 animate-pulse rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover" />
          <span className="h-3 w-6 flex-shrink-0 animate-pulse rounded-sm dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover" />
          <span className="h-3 w-3 flex-shrink-0 animate-pulse rounded-sm dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover" />
        </span>
      </div>
    )
  ) : null;

  // An empty human list still renders the fold when background runs exist:
  // showing "no chats yet" above a folder of them would be a lie. Every caller
  // that passes no autoSessions (A2A tab, search modal) keeps the old empty
  // state exactly — the fold belongs to the local list only, so the selector
  // path never counts it either.
  const hasAutoTasks = sortedAutoSessions.length > 0 && !showBotSelector;
  if (visibleSessions.length === 0 && !hasAutoTasks) {
    return (
      <div ref={rootRef} className="text-center py-8">
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {emptyText ?? i18nService.t('coworkNoSessions')}
        </p>
      </div>
    );
  }

  // Timeline view: static time headers (never collapsible), pinned first.
  if (timelineGrouped) {
    return (
      <div ref={rootRef}>
        {renderPinnedSection(timelineGrouped.pinned)}
        {renderAutoTasksSection()}
        {timelineGrouped.groups.map((group) => {
          if (!revealBudgetLeft()) return null;
          return (
            <section key={group.key}>
              <div className={`px-2.5 pb-1 pt-2.5 ${groupHeaderLabelClass}`}>
                {group.labelKey ? i18nService.t(group.labelKey) : group.monthLabel}
              </div>
              {group.sessions.map(renderItem)}
            </section>
          );
        })}
      </div>
    );
  }

  // Project view: collapsible per-project / per-bot groups, pinned first.
  if (projectGrouped) {
    return (
      <div ref={rootRef}>
        {renderPinnedSection(projectGrouped.pinned)}
        {renderAutoTasksSection()}
        {projectGrouped.groups.map((group) => {
          if (!revealBudgetLeft()) return null;
          const collapsed = collapsedGroupKeys.has(group.key);
          let headerLabel: React.ReactNode;
          if (group.kind === 'bot' && group.bot) {
            headerLabel = (
              <>
                <SessionAvatarCircle
                  src={group.bot.avatar}
                  name={group.bot.name}
                  sizeClass="h-4 w-4"
                />
                <span className="truncate">{group.bot.name || `Bot ${group.bot.id}`}</span>
              </>
            );
          } else if (group.kind === 'directory') {
            headerLabel = (
              <>
                <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate" title={group.directoryPath}>
                  {group.directoryName}
                </span>
              </>
            );
          } else {
            headerLabel = (
              <>
                <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{i18nService.t('sessionGroupOther')}</span>
              </>
            );
          }
          return (
            <section key={group.key}>
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={() => toggleGroupCollapsed(group.key)}
                className={`flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-left transition-colors hover:text-claude-text dark:hover:text-claude-darkText ${groupHeaderLabelClass}`}
              >
                <ChevronDownIcon
                  className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
                />
                {headerLabel}
              </button>
              {!collapsed && group.sessions.map(renderItem)}
            </section>
          );
        })}
      </div>
    );
  }

  // Flat list — what the online-chats (A2A) tab renders: no grouping header and
  // no view mode. When the selector is shown it sits directly above the list and
  // is its sole selector: 全部 renders every session, an entry narrows the list
  // to that bot. A lone local bot gets no control at all (see
  // shouldShowBotSelector), and the list is then simply flat.
  if (botSelectorRow) {
    return (
      <div ref={rootRef}>
        {botSelectorRow}
        {/* Hairline between the control area and the list area, using the host's
         * own separator token (SessionViewOptionsMenu.tsx:149). It is a plain
         * static line inside the scroll container — NOT sticky — so the control
         * and its boundary scroll away with the rows and never compete with the
         * list for attention. */}
        <div
          data-testid="bot-selector-divider"
          className="mt-0.5 border-t dark:border-claude-darkBorder border-claude-border"
        />
        <div className="space-y-1">{sortedSessions.map(renderItem)}</div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="space-y-1">
      {/* Flat mode has no group headers, so the fold's anchor is the pinned
       * block itself: pinned rows first, then the fold, then the rest —
       * the same "under pinned, above everything else" spot the grouped
       * views give it. */}
      {sortedSessions.filter((session) => session.pinned).map(renderItem)}
      {renderAutoTasksSection()}
      {sortedSessions.filter((session) => !session.pinned).map(renderItem)}
    </div>
  );
};

/**
 * Memoized: the sidebar re-renders for reasons that have nothing to do with the
 * session list (long-term-task board pushes, the open-team poll), and this list
 * renders hundreds of rows. With the memo, such a re-render stops at the list —
 * provided the parent's props are stable, which is why Sidebar hands over
 * useStableCallback-wrapped handlers and state-backed arrays instead of inline
 * closures and freshly mapped lists.
 */
const CoworkSessionList = React.memo(CoworkSessionListRow);

export default CoworkSessionList;
