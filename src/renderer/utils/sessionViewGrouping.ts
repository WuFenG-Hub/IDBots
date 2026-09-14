/**
 * Grouping and ordering for the bot-home sidebar session list's "filter & sort"
 * modes. Pure functions only (no React / i18n / electron imports) so they can
 * be unit-tested with tsx directly.
 *
 * Two view modes, both for the local-chats list:
 *  - timeline: buckets sessions by last-activity (or creation) date into
 *    Today / Yesterday / This Week (2-7 days) / Last Week (8-14 days) /
 *    This Month / calendar-month groups. Time buckets are static headers.
 *  - project: buckets sessions by working directory. Bot-workspace sessions
 *    (<root>/bots/<botId>/<date>, the "current bot's working directory"
 *    default) collapse to one group per bot keyed by the bot identity, not the
 *    per-day folder; every other directory is its own group, ordered by when
 *    the project's first session appeared (newest first). Project groups are
 *    collapsible in the UI.
 *
 * Sorting within every bucket (and the pinned section) follows the chosen sort
 * mode: updatedAt (default) or createdAt. Pinned sessions are always pulled
 * into a leading section, mirroring the historic flat-list behavior.
 */

import type { CoworkSessionSummary } from '../types/cowork';

export type SessionViewMode = 'timeline' | 'project';
export type SessionSortMode = 'updatedAt' | 'createdAt';

/** The timeline bucket a session lands in; month buckets carry a `YYYY-MM` key. */
export interface SessionTimelineGroup {
  key: string;
  /** i18n key for the fixed buckets; null for calendar-month buckets. */
  labelKey: string | null;
  /** Preformatted label for calendar-month buckets (e.g. "Jul 2026" / "2026年7月"). */
  monthLabel?: string;
  sessions: CoworkSessionSummary[];
}

export interface SessionProjectGroup {
  key: string;
  kind: 'bot' | 'directory' | 'other';
  /** Bot identity for kind === 'bot' (drives the avatar + name header). */
  bot?: { id: number; name: string | null; avatar: string | null };
  /** Directory display name (last path segment) for kind === 'directory'. */
  directoryName?: string;
  /** Full working-directory path (tooltip) for kind === 'directory'. */
  directoryPath?: string;
  sessions: CoworkSessionSummary[];
  /** When this group's first session was created; orders groups, newest first. */
  firstSeenAt: number;
}

export interface GroupedSessions<TGroup> {
  /** Pinned sessions first, ordered by the active sort mode. */
  pinned: CoworkSessionSummary[];
  groups: TGroup[];
}

export const DEFAULT_SESSION_VIEW_MODE: SessionViewMode = 'timeline';
export const DEFAULT_SESSION_SORT_MODE: SessionSortMode = 'updatedAt';

/** Latest-first ordering for one sort mode; timestamps tie-break each other,
 * then id, so the order is deterministic across renders. */
export const compareSessionsBySortMode = (
  a: CoworkSessionSummary,
  b: CoworkSessionSummary,
  sortMode: SessionSortMode,
): number => {
  const primary = sortMode === 'createdAt' ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt;
  if (primary !== 0) return -primary;
  const secondary = sortMode === 'createdAt' ? a.updatedAt - b.updatedAt : a.createdAt - b.createdAt;
  if (secondary !== 0) return -secondary;
  return b.id.localeCompare(a.id);
};

export const sortSessionsByMode = (
  sessions: CoworkSessionSummary[],
  sortMode: SessionSortMode,
): CoworkSessionSummary[] => [...sessions].sort((a, b) => compareSessionsBySortMode(a, b, sortMode));

const splitPinned = (
  sessions: CoworkSessionSummary[],
  sortMode: SessionSortMode,
): { pinned: CoworkSessionSummary[]; rest: CoworkSessionSummary[] } => {
  const pinned: CoworkSessionSummary[] = [];
  const rest: CoworkSessionSummary[] = [];
  for (const session of sessions) {
    (session.pinned ? pinned : rest).push(session);
  }
  return { pinned: sortSessionsByMode(pinned, sortMode), rest };
};

const startOfDayLocal = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Start of the local day `days` days before `t`; uses calendar-date math so
 * DST transitions cannot shift the boundary by an hour. */
const daysAgoStartLocal = (t: number, days: number): number => {
  const d = new Date(t);
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Jul 2026" (en) / "2026年7月" (zh) label for a calendar-month bucket. */
export const formatMonthLabel = (year: number, month: number, language: string): string => {
  if (language === 'zh') return `${year}年${month}月`;
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, month - 1, 15)));
  return `${monthName} ${year}`;
};

/**
 * Bucket sessions into the timeline groups, in display order: Today,
 * Yesterday, This Week (2-7 days back), Last Week (8-14 days back), This
 * Month (same calendar month, older), then one group per older month, newest
 * month first. The bucket timestamp follows the active sort mode so a session
 * lands in the group matching the position it sorts to.
 */
export const groupSessionsByTimeline = (
  sessions: CoworkSessionSummary[],
  sortMode: SessionSortMode,
  now: number = Date.now(),
  language: string = 'en',
): GroupedSessions<SessionTimelineGroup> => {
  const { pinned, rest } = splitPinned(sessions, sortMode);
  const todayStart = startOfDayLocal(now);
  const yesterdayStart = daysAgoStartLocal(now, 1);
  const weekStart = daysAgoStartLocal(now, 7);
  const twoWeeksStart = daysAgoStartLocal(now, 14);
  const nowDate = new Date(now);

  const byKey = new Map<string, SessionTimelineGroup>();
  const ensureGroup = (key: string, labelKey: string | null, monthLabel?: string): SessionTimelineGroup => {
    let group = byKey.get(key);
    if (!group) {
      group = { key, labelKey, monthLabel, sessions: [] };
      byKey.set(key, group);
    }
    return group;
  };

  for (const session of rest) {
    const t = sortMode === 'createdAt' ? session.createdAt : session.updatedAt;
    if (t >= todayStart) {
      ensureGroup('today', 'timelineToday').sessions.push(session);
      continue;
    }
    if (t >= yesterdayStart) {
      ensureGroup('yesterday', 'timelineYesterday').sessions.push(session);
      continue;
    }
    if (t >= weekStart) {
      ensureGroup('thisWeek', 'timelineThisWeek').sessions.push(session);
      continue;
    }
    if (t >= twoWeeksStart) {
      ensureGroup('lastWeek', 'timelineLastWeek').sessions.push(session);
      continue;
    }
    const date = new Date(t);
    if (date.getFullYear() === nowDate.getFullYear() && date.getMonth() === nowDate.getMonth()) {
      ensureGroup('thisMonth', 'timelineThisMonth').sessions.push(session);
      continue;
    }
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `month:${year}-${String(month).padStart(2, '0')}`;
    ensureGroup(monthKey, null, formatMonthLabel(year, month, language)).sessions.push(session);
  }

  const fixedOrder = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth'];
  const fixedGroups = fixedOrder
    .map((key) => byKey.get(key))
    .filter((group): group is SessionTimelineGroup => Boolean(group));
  const monthGroups = [...byKey.values()]
    .filter((group) => group.key.startsWith('month:'))
    .sort((a, b) => b.key.localeCompare(a.key));

  const groups = [...fixedGroups, ...monthGroups];
  for (const group of groups) {
    group.sessions = sortSessionsByMode(group.sessions, sortMode);
  }
  return { pinned, groups };
};

/**
 * Matches the per-bot dated workspace layout produced by main's
 * libs/botWorkspace: <root>/bots/<metabotId>/<YYYY-MM-DD> (the date segment is
 * optional so a manually picked <root>/bots/<id> folder groups the same way).
 */
const BOT_WORKSPACE_PATH_RE = /[\\/]bots[\\/](\d+)(?:[\\/]\d{4}-\d{2}-\d{2})?$/;

interface ProjectKeyResolution {
  kind: 'bot' | 'directory' | 'other';
  key: string;
  botId?: number;
  directoryPath?: string;
}

const resolveProjectKey = (session: CoworkSessionSummary): ProjectKeyResolution => {
  const rawCwd = session.cwd?.trim();
  if (rawCwd) {
    const normalized = rawCwd.replace(/[\\/]+$/, '') || rawCwd;
    const botMatch = BOT_WORKSPACE_PATH_RE.exec(normalized);
    if (botMatch) {
      // The dated folder is keyed by the session's own bot id; only then does
      // the group become the bot itself (avatar + name, no path).
      if (session.metabotId != null && Number(botMatch[1]) === session.metabotId) {
        return { kind: 'bot', key: `bot:${session.metabotId}`, botId: session.metabotId };
      }
      // A bot-workspace folder picked manually for another bot stays a
      // directory group, keyed by its date-stripped root so per-day folders do
      // not fragment the group.
      const directoryPath = normalized.replace(/[\\/]\d{4}-\d{2}-\d{2}$/, '');
      return { kind: 'directory', key: `dir:${directoryPath}`, directoryPath };
    }
    return { kind: 'directory', key: `dir:${normalized}`, directoryPath: normalized };
  }
  // Legacy rows without a persisted cwd: the bot workspace has always been the
  // default chain, so attribute by bot when possible.
  if (session.metabotId != null) {
    return { kind: 'bot', key: `bot:${session.metabotId}`, botId: session.metabotId };
  }
  return { kind: 'other', key: 'other' };
};

/** Accumulator used while folding sessions into project groups. */
interface ProjectGroupAccumulator extends SessionProjectGroup {
  /** updatedAt of the row the current bot snapshot came from (freshness). */
  botSnapshotUpdatedAt: number;
}

/**
 * Group sessions by working directory. Bot-workspace sessions form one group
 * per bot (avatar + name header, no path); other directories form one group
 * per path. Groups are ordered by their first session's creation time, newest
 * first, so a newly used project rises to the top.
 */
export const groupSessionsByProject = (
  sessions: CoworkSessionSummary[],
  sortMode: SessionSortMode,
): GroupedSessions<SessionProjectGroup> => {
  const { pinned, rest } = splitPinned(sessions, sortMode);
  const byKey = new Map<string, ProjectGroupAccumulator>();

  for (const session of rest) {
    const resolution = resolveProjectKey(session);
    let entry = byKey.get(resolution.key);
    if (!entry) {
      entry = {
        key: resolution.key,
        kind: resolution.kind,
        sessions: [],
        firstSeenAt: Number.MAX_SAFE_INTEGER,
        botSnapshotUpdatedAt: -1,
      };
      byKey.set(resolution.key, entry);
    }
    entry.sessions.push(session);
    if (resolution.directoryPath && !entry.directoryPath) {
      entry.directoryPath = resolution.directoryPath;
    }
    if (session.createdAt < entry.firstSeenAt) {
      entry.firstSeenAt = session.createdAt;
    }
    if (resolution.kind === 'bot') {
      // Prefer the freshest snapshot in the group so a renamed/re-avatar'd
      // bot updates the header as soon as any session row refreshes; fields
      // the fresher row lacks fall back to the previous snapshot.
      const hasIdentity = Boolean(session.metabotName || session.metabotAvatar);
      if (hasIdentity && session.updatedAt >= entry.botSnapshotUpdatedAt) {
        entry.bot = {
          id: resolution.botId ?? session.metabotId ?? 0,
          name: session.metabotName ?? entry.bot?.name ?? null,
          avatar: session.metabotAvatar ?? entry.bot?.avatar ?? null,
        };
        entry.botSnapshotUpdatedAt = session.updatedAt;
      }
    }
  }

  const directoryNameOf = (dirPath: string): string =>
    dirPath.split(/[\\/]/).filter(Boolean).pop() ?? dirPath;

  const groups: SessionProjectGroup[] = [...byKey.values()].map((entry) => ({
    key: entry.key,
    kind: entry.kind,
    sessions: sortSessionsByMode(entry.sessions, sortMode),
    firstSeenAt: entry.firstSeenAt,
    ...(entry.bot ? { bot: entry.bot } : {}),
    ...(entry.directoryPath
      ? { directoryPath: entry.directoryPath, directoryName: directoryNameOf(entry.directoryPath) }
      : {}),
  }));

  groups.sort((a, b) => {
    if (a.firstSeenAt !== b.firstSeenAt) return b.firstSeenAt - a.firstSeenAt;
    return a.key.localeCompare(b.key);
  });
  return { pinned, groups };
};

/** Option key of the leading entry, which always means "no bot filter". */
export const ALL_BOTS_OPTION_KEY = 'all';

/** Stable selector key for the LOCAL bot that owns a session. Rows without a
 * metabotId land in one shared bucket, so the filter can never hide them
 * silently — they stay reachable through 全部 and have an option of their own. */
export const sessionBotKey = (session: CoworkSessionSummary): string =>
  session.metabotId != null ? `bot:${session.metabotId}` : 'bot:unknown';

/** One entry of the online-chats Bot selector: 全部 first, then one per bot. */
export interface BotSelectorOption {
  /** ALL_BOTS_OPTION_KEY for the 全部 option, else a sessionBotKey. */
  key: string;
  /** Bot identity; absent on the 全部 option (which already contains the rest). */
  bot?: { id: number; name: string | null; avatar: string | null };
  /** Sessions behind the option — pinned rows INCLUDED (the selector counts a
   * bot's whole workload, while group headers only see the unpinned remainder). */
  sessionCount: number;
  /** Of those, how many are unread; drives the option's unread marker. */
  unreadCount: number;
  /** createdAt of the option's oldest session; orders the options. */
  firstSeenAt: number;
}

/** Accumulator: adds the freshness stamp used to pick a bot's name/avatar. */
interface BotSelectorAccumulator extends BotSelectorOption {
  botSnapshotUpdatedAt: number;
}

/**
 * Build the online-chats Bot selector: the leading 全部 option first, then one
 * option per local bot (newest-first, mirroring the group order so the menu does
 * not reshuffle as sessions update).
 *
 * The unread counts come from the caller's existing `unreadSessionIds` — this
 * helper invents no state of its own; it only folds what the list already has.
 */
export const buildBotSelectorOptions = (
  sessions: CoworkSessionSummary[],
  unreadSessionIds: readonly string[],
): BotSelectorOption[] => {
  const unreadSet = new Set(unreadSessionIds);
  const all: BotSelectorOption = {
    key: ALL_BOTS_OPTION_KEY,
    sessionCount: 0,
    unreadCount: 0,
    firstSeenAt: Number.MAX_SAFE_INTEGER,
  };
  const byKey = new Map<string, BotSelectorAccumulator>();

  for (const session of sessions) {
    const key = sessionBotKey(session);
    let option = byKey.get(key);
    if (!option) {
      const botId = session.metabotId ?? null;
      option = {
        key,
        sessionCount: 0,
        unreadCount: 0,
        firstSeenAt: Number.MAX_SAFE_INTEGER,
        botSnapshotUpdatedAt: -1,
        // A known bot always gets an identity so its option reads as a bot even
        // before a session row carries the name/avatar snapshot.
        ...(botId != null ? { bot: { id: botId, name: null, avatar: null } } : {}),
      };
      byKey.set(key, option);
    }
    const unread = unreadSet.has(session.id);
    option.sessionCount += 1;
    all.sessionCount += 1;
    if (unread) {
      option.unreadCount += 1;
      all.unreadCount += 1;
    }
    if (session.createdAt < option.firstSeenAt) {
      option.firstSeenAt = session.createdAt;
    }
    if (option.bot && (session.metabotName || session.metabotAvatar) && session.updatedAt >= option.botSnapshotUpdatedAt) {
      // Freshest snapshot wins; fields the fresher row lacks fall back.
      option.bot = {
        id: option.bot.id,
        name: session.metabotName ?? option.bot.name,
        avatar: session.metabotAvatar ?? option.bot.avatar,
      };
      option.botSnapshotUpdatedAt = session.updatedAt;
    }
  }

  const botOptions: BotSelectorOption[] = [...byKey.values()]
    .map((option) => ({
      key: option.key,
      sessionCount: option.sessionCount,
      unreadCount: option.unreadCount,
      firstSeenAt: option.firstSeenAt,
      ...(option.bot ? { bot: option.bot } : {}),
    }))
    .sort((a, b) => {
      if (a.firstSeenAt !== b.firstSeenAt) return b.firstSeenAt - a.firstSeenAt;
      return a.key.localeCompare(b.key);
    });

  return [all, ...botOptions];
};

/**
 * Whether the selector earns its space: it needs at least two LOCAL bots. With
 * a single bot the lone option would only repeat what the list already shows,
 * so the control is dropped entirely (the single-bot degradation that mirrors
 * the single-group rule). Rows with no metabotId do not count — a stray legacy
 * row must not switch the selector on for a single-bot install.
 */
export const shouldShowBotSelector = (options: BotSelectorOption[]): boolean =>
  options.filter((option) => option.bot).length > 1;

/**
 * The option the selector opens on: the Twin — the bot you hold conversations
 * with, while workers are picked deliberately. Falls back to 全部 when the twin
 * is unknown or has no A2A sessions yet, so the list is never scoped to an
 * option that does not exist.
 */
export const defaultBotSelectorKey = (
  options: BotSelectorOption[],
  twinMetabotId: number | null | undefined,
): string => {
  if (twinMetabotId == null) return ALL_BOTS_OPTION_KEY;
  const twinKey = `bot:${twinMetabotId}`;
  return options.some((option) => option.key === twinKey) ? twinKey : ALL_BOTS_OPTION_KEY;
};

/**
 * Unread sessions the CURRENT selection keeps off screen — the aggregate the
 * selector itself must carry. A native <select> shows one option at a time and
 * its menu is closed in the normal case, so without this number work waiting
 * under another bot would be invisible. 全部 renders every row, so nothing is
 * hidden and the signal is 0.
 */
export const unreadOutsideBotSelection = (
  options: BotSelectorOption[],
  activeKey: string,
): number => {
  if (activeKey === ALL_BOTS_OPTION_KEY) return 0;
  return options.reduce(
    (total, option) =>
      option.key === activeKey || option.key === ALL_BOTS_OPTION_KEY
        ? total
        : total + option.unreadCount,
    0,
  );
};
