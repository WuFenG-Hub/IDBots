import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBotSessionCounts,
  formatMonthLabel,
  groupSessionsByBot,
  groupSessionsByTimeline,
  type BotViewBot,
} from '../src/renderer/utils/sessionViewGrouping';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(SRC_DIR, relative), 'utf8');
const listSourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listSourceFiles(path.join(dir, entry.name))
      : /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [path.join(dir, entry.name)]
        : [],
  );

const mkSession = (
  overrides: Partial<CoworkSessionSummary> & Pick<CoworkSessionSummary, 'id'>,
): CoworkSessionSummary => ({
  title: `Session ${overrides.id}`,
  status: 'idle',
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

// Fixed "now": Aug 29 2026, 12:00 local time.
const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime();
const at = (year: number, monthIndex: number, day: number, hour = 12): number =>
  new Date(year, monthIndex, day, hour).getTime();

test('timeline buckets follow the display order today → yesterday → this week → last week → this month → months', () => {
  const result = groupSessionsByTimeline(
    [
      mkSession({ id: 'a', updatedAt: at(2026, 7, 29, 8), createdAt: at(2026, 7, 29, 8) }),
      mkSession({ id: 'b', updatedAt: at(2026, 7, 28, 23), createdAt: at(2026, 7, 28, 23) }),
      mkSession({ id: 'c', updatedAt: at(2026, 7, 26), createdAt: at(2026, 7, 26) }),
      mkSession({ id: 'd', updatedAt: at(2026, 7, 19), createdAt: at(2026, 7, 19) }),
      mkSession({ id: 'e', updatedAt: at(2026, 7, 9), createdAt: at(2026, 7, 9) }),
      mkSession({ id: 'f', updatedAt: at(2026, 6, 20), createdAt: at(2026, 6, 20) }),
    ],
    'updatedAt',
    NOW,
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'month:2026-07'],
  );
  assert.equal(result.groups[0].labelKey, 'timelineToday');
  assert.equal(result.groups[5].monthLabel, 'Jul 2026');
  assert.equal(result.pinned.length, 0);
});

test('timeline bucket timestamps follow the active sort mode', () => {
  // Created 3 days ago but active today: lands in Today when sorting by
  // update time, This Week when sorting by creation time.
  const session = mkSession({
    id: 'a',
    createdAt: at(2026, 7, 26),
    updatedAt: at(2026, 7, 29, 9),
  });
  assert.equal(
    groupSessionsByTimeline([session], 'updatedAt', NOW).groups[0].key,
    'today',
  );
  assert.equal(
    groupSessionsByTimeline([session], 'createdAt', NOW).groups[0].key,
    'thisWeek',
  );
});

test('timeline keeps pinned sessions in a leading section and sorts groups newest first', () => {
  const result = groupSessionsByTimeline(
    [
      mkSession({ id: 'pinned-old', pinned: true, updatedAt: at(2026, 6, 1), createdAt: at(2026, 6, 1) }),
      mkSession({ id: 'new', updatedAt: at(2026, 7, 29, 10), createdAt: at(2026, 7, 29, 10) }),
      mkSession({ id: 'older-today', updatedAt: at(2026, 7, 29, 7), createdAt: at(2026, 7, 29, 7) }),
    ],
    'updatedAt',
    NOW,
  );
  assert.deepEqual(result.pinned.map((session) => session.id), ['pinned-old']);
  assert.deepEqual(
    result.groups[0].sessions.map((session) => session.id),
    ['new', 'older-today'],
  );
});

test('month labels render per language', () => {
  assert.equal(formatMonthLabel(2026, 7, 'zh'), '2026年7月');
  assert.equal(formatMonthLabel(2026, 7, 'en'), 'Jul 2026');
});

const mkBot = (overrides: Partial<BotViewBot> & Pick<BotViewBot, 'id'>): BotViewBot => ({
  name: `Bot ${overrides.id}`,
  avatar: null,
  isTwin: false,
  createdAt: 0,
  ...overrides,
});

test('bot grouping seeds every local bot a group and orders Twin first, then oldest-created first', () => {
  const result = groupSessionsByBot(
    [
      mkSession({ id: 's1', metabotId: 7, createdAt: at(2026, 7, 28), updatedAt: at(2026, 7, 28, 9) }),
      mkSession({ id: 's2', metabotId: 1, cwd: '/Users/tusm/work/custom-dir', createdAt: at(2026, 7, 29), updatedAt: at(2026, 7, 29, 10) }),
    ],
    'updatedAt',
    [
      // Youngest bot (id 7, newest createdAt) but the Twin: still first.
      mkBot({ id: 7, isTwin: true, name: 'Twin Bot', createdAt: 900 }),
      mkBot({ id: 3, name: 'Worker C', createdAt: 300 }),
      mkBot({ id: 1, name: 'Worker A', createdAt: 100 }),
      mkBot({ id: 2, name: 'Worker B', createdAt: 200 }),
      // A tie on createdAt breaks by id ascending.
      mkBot({ id: 5, name: 'Worker E', createdAt: 300 }),
    ],
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['bot:7', 'bot:1', 'bot:2', 'bot:3', 'bot:5'],
  );
  // Every seeded bot keeps a group, empty ones included (20 local bots means
  // 20 groups); no trailing bucket appears when nothing is left unmatched.
  assert.deepEqual(
    result.groups.map((group) => group.sessions.length),
    [1, 1, 0, 0, 0],
  );
  assert.equal(result.groups[0].bot?.name, 'Twin Bot');
  // The custom working directory plays no role anymore: the row lands under
  // its bot (id 1), not under a directory group.
  assert.deepEqual(result.groups[1].sessions.map((session) => session.id), ['s2']);
});

test('bot grouping files rows no live bot claims into one trailing other group', () => {
  const result = groupSessionsByBot(
    [
      mkSession({ id: 'live', metabotId: 1, createdAt: 1, updatedAt: 1 }),
      mkSession({ id: 'gone', metabotId: 42, createdAt: 2, updatedAt: 2 }),
      mkSession({ id: 'legacy', createdAt: 3, updatedAt: 3 }),
    ],
    'updatedAt',
    [mkBot({ id: 1, createdAt: 100 })],
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['bot:1', 'other'],
  );
  assert.deepEqual(
    result.groups[1].sessions.map((session) => session.id),
    ['legacy', 'gone'],
  );
});

test('bot grouping keeps pinned sessions out of the groups and sorts rows by the active mode', () => {
  const result = groupSessionsByBot(
    [
      mkSession({ id: 'pinned', pinned: true, metabotId: 1, createdAt: 3, updatedAt: 3 }),
      mkSession({ id: 'newer', metabotId: 1, createdAt: 1, updatedAt: 20 }),
      mkSession({ id: 'older', metabotId: 1, createdAt: 2, updatedAt: 10 }),
    ],
    'updatedAt',
    [mkBot({ id: 1, createdAt: 100 })],
  );
  assert.deepEqual(result.pinned.map((session) => session.id), ['pinned']);
  assert.deepEqual(
    result.groups[0].sessions.map((session) => session.id),
    ['newer', 'older'],
  );
  const byCreation = groupSessionsByBot(
    [
      mkSession({ id: 'newer', metabotId: 1, createdAt: 1, updatedAt: 20 }),
      mkSession({ id: 'older', metabotId: 1, createdAt: 2, updatedAt: 10 }),
    ],
    'createdAt',
    [mkBot({ id: 1, createdAt: 100 })],
  );
  assert.deepEqual(
    byCreation.groups[0].sessions.map((session) => session.id),
    ['older', 'newer'],
  );
});

test('an empty roster degrades to session-derived bot groups, newest activity first, freshest snapshot identity', () => {
  const result = groupSessionsByBot(
    [
      mkSession({ id: 't1', metabotId: 1, metabotName: 'Twin Bot', metabotAvatar: 'data:image/png;base64,AAA', createdAt: 1, updatedAt: 100 }),
      mkSession({ id: 't2', metabotId: 1, createdAt: 2, updatedAt: 50 }),
      // A newer row without a name must not erase the fresher snapshot's name.
      mkSession({ id: 't3', metabotId: 1, createdAt: 3, updatedAt: 200 }),
      mkSession({ id: 'w1', metabotId: 2, metabotName: 'Worker', createdAt: 4, updatedAt: 90 }),
      mkSession({ id: 'legacy', createdAt: 5, updatedAt: 60 }),
    ],
    'updatedAt',
    [],
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['bot:1', 'bot:2', 'other'],
  );
  assert.deepEqual(result.groups[0].bot, { id: 1, name: 'Twin Bot', avatar: 'data:image/png;base64,AAA' });
  assert.deepEqual(
    result.groups[2].sessions.map((session) => session.id),
    ['legacy'],
  );
});

// ---------------------------------------------------------------------------
// Round 4: the online-chats Bot selector reuses the shared MetaBotSelector.
// ---------------------------------------------------------------------------

const selectorSessions = (): CoworkSessionSummary[] => [
  mkSession({ id: 'twin-a', metabotId: 1, metabotName: '小峰', createdAt: 300, updatedAt: 300 }),
  mkSession({ id: 'twin-b', metabotId: 1, createdAt: 200, updatedAt: 200 }),
  mkSession({ id: 'worker-c', metabotId: 2, metabotName: '小红', createdAt: 400, updatedAt: 400 }),
  mkSession({ id: 'legacy-d', createdAt: 500, updatedAt: 500 }),
];

test('bot session counts seed every live bot and total every row under 全部 Bot', () => {
  const counts = buildBotSessionCounts(selectorSessions(), [1, 2, 7]);
  assert.equal(counts.all, 4, 'All Bots carries every row, legacy ones included');
  assert.equal(counts[1], 2);
  assert.equal(counts[2], 1);
  assert.equal(counts[7], 0, 'a live bot with no sessions still shows a 0');
  assert.equal(counts[3], undefined, 'a bot that is not in the live list gets no entry');
});

test('the card strip is gone: no dead symbol survives anywhere in src', () => {
  const dead = [
    'buildBotFilterCards',
    'shouldShowBotFilterBar',
    'BotFilterCard',
    'ALL_BOTS_FILTER_KEY',
    'groupSessionsByMetabot',
    'SessionBotGroup',
    'BotGroupAccumulator',
    'bot-filter-unread-badge',
    'botFilterBar',
    'botFilter=',
    // NOTE: `viewMode === 'bot'` was in this list while the directory-based
    // project view held the grouped slot; the by-Bot view is back by design
    // (one group per local bot, Twin first) and owns that string again.
    // The "Bot:" caption was dropped when the native <select> became the
    // avatar-led popover; its i18n key must not come back.
    'sessionBotSelectorCaption',
    // The self-drawn popover was replaced by the shared MetaBotSelector, so
    // its component and its session-derived option builder are gone for good.
    'BotSelectorPopover',
    'buildBotSelectorOptions',
    'ALL_BOTS_OPTION_KEY',
    'sessionBotKey',
    'shouldShowBotSelector',
    'defaultBotSelectorKey',
    'unreadOutsideBotSelection',
    'BotSelectorOption',
    // Dead i18n keys (colon-terminated so the live sessionBotFilterAllBots
    // key does not match the dead sessionBotFilterAll one).
    'sessionBotFilterAll:',
    'sessionBotFilterLabel:',
    'sessionBotFilterUnread:',
    'sessionBotSelectorTitle:',
  ];
  const hits: string[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const symbol of dead) {
      if (text.includes(symbol)) hits.push(`${path.relative(SRC_DIR, file)}: ${symbol}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the online list reuses the shared MetaBotSelector as its only selector', () => {
  const list = readSource('renderer/components/cowork/CoworkSessionList.tsx');
  const selector = readSource('renderer/components/cowork/MetaBotSelector.tsx');
  // The online-chats tab renders the SAME component the composers use, with
  // the All Bots entry, the per-bot conversation counts, and the fixed
  // dropdown mode the sidebar's scroll container requires.
  assert.ok(list.includes('<MetaBotSelector'), 'the shared selector is rendered by the list');
  assert.ok(list.includes('allowAll'), 'the list turns on the All Bots entry');
  assert.ok(list.includes('sessionCounts='), 'the list feeds the per-bot conversation counts');
  assert.ok(list.includes('useFixedDropdown'), 'the dropdown escapes the sidebar scroll container');
  assert.ok(list.includes('{botSelectorRow}'), 'the control sits above the flat list');
  assert.equal(/<select\b/.test(list), false, 'no native select came back');
  // The bots come from the live metabot list (enabled bots, Twin first), so a
  // deleted bot can never linger as an option, and the default is the Twin.
  assert.ok(list.includes('getMetaBots'), 'the bot options come from the live metabot list');
  assert.ok(list.includes("metabot_type === 'twin'"), 'the default selection is the Twin');
  assert.ok(selector.includes('allowAll'), 'the shared component owns the All Bots entry');
  assert.ok(selector.includes('ALL_METABOTS_SELECTOR_ID'), 'the All entry reports its sentinel id');
  // A2A stays flat: the selector branch renders rows straight, with no group
  // header and no collapse control.
  const flatBranch = list.slice(list.indexOf('if (botSelectorRow)'));
  assert.ok(flatBranch.includes('sortedSessions.map(renderItem)'));
  assert.equal(flatBranch.includes('groupHeaderLabelClass'), false);
  assert.equal(flatBranch.includes('aria-expanded'), false);
});

test('a hidden bot selector never leaves the online list filtered', () => {
  const list = readSource('renderer/components/cowork/CoworkSessionList.tsx');
  // Below two enabled bots the selector is hidden — with no control on
  // screen there is no way to escape a filter, so the list must fall back
  // to All Bots (legacy A2A rows with no metabotId and sessions of
  // since-disabled bots included) instead of silently scoping to the Twin.
  const fallback = list.slice(
    list.indexOf('const activeBotId'),
    list.indexOf('const visibleSessions'),
  );
  assert.ok(
    fallback.includes(': ALL_METABOTS_SELECTOR_ID'),
    'a hidden selector forces the All Bots selection',
  );
});

test('the A2A title fallback is untouched by the selector change', () => {
  const item = readSource('renderer/components/cowork/CoworkSessionItem.tsx');
  assert.ok(item.includes('isPrivatePlaceholderTitle'));
  assert.match(item, /\^Private-\[A-Za-z0-9\]\{6,12\}\$/);
  assert.ok(item.includes('storedTitle || session.peerName ||'));
});
