import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_BOTS_OPTION_KEY,
  buildBotSelectorOptions,
  defaultBotSelectorKey,
  formatMonthLabel,
  groupSessionsByProject,
  groupSessionsByTimeline,
  shouldShowBotSelector,
  unreadOutsideBotSelection,
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

test('project grouping collapses dated bot-workspace folders into one bot group', () => {
  const result = groupSessionsByProject(
    [
      mkSession({
        id: 's1',
        cwd: '/Users/tusm/idbots/project/bots/1/2026-08-28',
        metabotId: 1,
        metabotName: 'Twin Bot',
        metabotAvatar: 'data:image/png;base64,AAA',
        createdAt: at(2026, 7, 28),
        updatedAt: at(2026, 7, 28, 9),
      }),
      mkSession({
        id: 's2',
        cwd: '/Users/tusm/idbots/project/bots/1/2026-08-29',
        metabotId: 1,
        metabotName: 'Twin Bot',
        createdAt: at(2026, 7, 29),
        updatedAt: at(2026, 7, 29, 10),
      }),
    ],
    'updatedAt',
  );
  assert.equal(result.groups.length, 1);
  const group = result.groups[0];
  assert.equal(group.kind, 'bot');
  assert.equal(group.key, 'bot:1');
  assert.deepEqual(group.bot, { id: 1, name: 'Twin Bot', avatar: 'data:image/png;base64,AAA' });
  // Newest first inside the group.
  assert.deepEqual(group.sessions.map((session) => session.id), ['s2', 's1']);
});

test('a dated bots folder belonging to another bot id stays a directory group keyed by its date-stripped root', () => {
  const result = groupSessionsByProject(
    [
      mkSession({
        id: 's1',
        cwd: '/Users/tusm/idbots/project/bots/2/2026-08-01',
        metabotId: 1,
        createdAt: at(2026, 7, 1),
        updatedAt: at(2026, 7, 1),
      }),
      mkSession({
        id: 's2',
        cwd: '/Users/tusm/idbots/project/bots/2/2026-08-02',
        metabotId: 1,
        createdAt: at(2026, 7, 2),
        updatedAt: at(2026, 7, 2),
      }),
    ],
    'updatedAt',
  );
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].kind, 'directory');
  assert.equal(result.groups[0].directoryPath, '/Users/tusm/idbots/project/bots/2');
  assert.equal(result.groups[0].directoryName, '2');
});

test('directory groups key by normalized path and expose the last segment as label', () => {
  const result = groupSessionsByProject(
    [
      mkSession({ id: 's1', cwd: '/Users/tusm/work/IDBots', createdAt: 1, updatedAt: 1 }),
      mkSession({ id: 's2', cwd: '/Users/tusm/work/IDBots/', createdAt: 2, updatedAt: 2 }),
    ],
    'updatedAt',
  );
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].directoryName, 'IDBots');
  assert.equal(result.groups[0].directoryPath, '/Users/tusm/work/IDBots');
});

test('project groups order by their first session creation time, newest first', () => {
  const result = groupSessionsByProject(
    [
      mkSession({ id: 'a1', cwd: '/work/project-a', createdAt: at(2026, 7, 1), updatedAt: at(2026, 7, 20) }),
      mkSession({ id: 'b1', cwd: '/work/project-b', createdAt: at(2026, 7, 10), updatedAt: at(2026, 7, 11) }),
      mkSession({ id: 'a2', cwd: '/work/project-a', createdAt: at(2026, 7, 5), updatedAt: at(2026, 7, 6) }),
    ],
    'updatedAt',
  );
  assert.deepEqual(
    result.groups.map((group) => group.directoryName),
    ['project-b', 'project-a'],
  );
});

test('legacy rows without cwd fall back to bot grouping, then a shared other group', () => {
  const result = groupSessionsByProject(
    [
      mkSession({ id: 's1', metabotId: 3, metabotName: 'Bot 3', createdAt: 1, updatedAt: 1 }),
      mkSession({ id: 's2', createdAt: 2, updatedAt: 2 }),
    ],
    'updatedAt',
  );
  assert.deepEqual(
    result.groups.map((group) => group.kind),
    // The other-group session appeared later, so it sorts first.
    ['other', 'bot'],
  );
  assert.equal(result.groups[1].bot?.id, 3);
});

test('project grouping keeps pinned sessions out of the groups', () => {
  const result = groupSessionsByProject(
    [
      mkSession({ id: 'pinned', pinned: true, cwd: '/work/a', createdAt: 3, updatedAt: 3 }),
      mkSession({ id: 'plain', cwd: '/work/a', createdAt: 1, updatedAt: 1 }),
    ],
    'updatedAt',
  );
  assert.deepEqual(result.pinned.map((session) => session.id), ['pinned']);
  assert.deepEqual(
    result.groups[0].sessions.map((session) => session.id),
    ['plain'],
  );
});

// ---------------------------------------------------------------------------
// Round 4: the online-chats card strip became ONE "Bot: [...]" selector.
// ---------------------------------------------------------------------------

const selectorSessions = (): CoworkSessionSummary[] => [
  mkSession({ id: 'twin-a', metabotId: 1, metabotName: '小峰', createdAt: 300, updatedAt: 300 }),
  mkSession({ id: 'twin-b', metabotId: 1, createdAt: 200, updatedAt: 200 }),
  mkSession({ id: 'worker-c', metabotId: 2, metabotName: '小红', createdAt: 400, updatedAt: 400 }),
  mkSession({ id: 'legacy-d', createdAt: 500, updatedAt: 500 }),
];

test('selector options list 全部 first, then one entry per local bot, newest-first', () => {
  const options = buildBotSelectorOptions(selectorSessions(), ['twin-b', 'worker-c']);
  assert.deepEqual(
    options.map((option) => option.key),
    [ALL_BOTS_OPTION_KEY, 'bot:unknown', 'bot:2', 'bot:1'],
  );
  assert.equal(options[0].bot, undefined, '全部 carries no bot identity');
  assert.deepEqual(
    options.map((option) => option.sessionCount),
    [4, 1, 1, 2],
  );
  assert.deepEqual(
    options.map((option) => option.unreadCount),
    [2, 0, 1, 1],
  );
  const byKey = new Map(options.map((option) => [option.key, option]));
  assert.equal(byKey.get('bot:1')?.bot?.name, '小峰');
  assert.equal(byKey.get('bot:2')?.bot?.name, '小红');
  assert.equal(byKey.get('bot:unknown')?.bot, undefined, 'legacy rows still get an option');
});

test('the selector appears from two local bots up, and never from legacy rows alone', () => {
  const one = buildBotSelectorOptions(
    [mkSession({ id: 'a', metabotId: 1 }), mkSession({ id: 'b', metabotId: 1 })],
    [],
  );
  assert.equal(shouldShowBotSelector(one), false, 'single-bot install shows no control');
  const two = buildBotSelectorOptions(
    [mkSession({ id: 'a', metabotId: 1 }), mkSession({ id: 'b', metabotId: 2 })],
    [],
  );
  assert.equal(shouldShowBotSelector(two), true);
  const legacyOnly = buildBotSelectorOptions([mkSession({ id: 'a' }), mkSession({ id: 'b' })], []);
  assert.equal(shouldShowBotSelector(legacyOnly), false, 'no local bot -> no control');
});

test('the selector opens on the Twin, and on 全部 when the Twin has no A2A sessions', () => {
  const options = buildBotSelectorOptions(selectorSessions(), []);
  assert.equal(defaultBotSelectorKey(options, 1), 'bot:1');
  assert.equal(defaultBotSelectorKey(options, 2), 'bot:2');
  assert.equal(defaultBotSelectorKey(options, 99), ALL_BOTS_OPTION_KEY, 'unknown twin id falls back');
  assert.equal(defaultBotSelectorKey(options, null), ALL_BOTS_OPTION_KEY);
  assert.equal(defaultBotSelectorKey(options, undefined), ALL_BOTS_OPTION_KEY);
});

test('the control carries exactly the unread of the bots the selection hides', () => {
  const options = buildBotSelectorOptions(selectorSessions(), ['twin-b', 'worker-c']);
  assert.equal(unreadOutsideBotSelection(options, ALL_BOTS_OPTION_KEY), 0, '全部 hides nothing');
  assert.equal(unreadOutsideBotSelection(options, 'bot:1'), 1, "worker's unread is the signal");
  assert.equal(unreadOutsideBotSelection(options, 'bot:2'), 1, "twin's unread is the signal");
  assert.equal(
    unreadOutsideBotSelection(options, 'bot:unknown'),
    2,
    'the legacy bucket hides both bots',
  );
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
    "viewMode === 'bot'",
    // The "Bot:" caption was dropped when the native <select> became the
    // avatar-led popover; its i18n key must not come back.
    'sessionBotSelectorCaption',
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

test('the online list renders the self-drawn popover as its only selector', () => {
  const list = readSource('renderer/components/cowork/CoworkSessionList.tsx');
  const popover = readSource('renderer/components/cowork/BotSelectorPopover.tsx');
  // The control moved out of the list into its own component when the native
  // <select> was replaced, so the trigger's testid is asserted on the component
  // that actually renders it — and the native <select> must be gone for good.
  assert.equal(/<select\b/.test(list), false, 'the native select it replaced is gone');
  assert.ok(list.includes('<BotSelectorPopover'), 'the control component is rendered by the list');
  assert.ok(popover.includes('data-testid="bot-selector"'), 'the trigger carries the control testid');
  assert.ok(popover.includes('role="listbox"'), 'the popover is the listbox the trigger points at');
  assert.ok(list.includes('{botSelectorRow}'), 'the control sits above the flat list');
  assert.equal(
    list.includes("t('sessionBotSelectorCaption')"),
    false,
    'the dead "Bot:" caption is not rendered by the control row',
  );
  assert.ok(list.includes('data-testid="bot-selector-unread"') || popover.includes('data-testid="bot-selector-unread"'),
    'the aggregate badge is present');
  assert.ok(
    list.includes('defaultBotSelectorKey(botSelectorOptions, twinMetabotId)'),
    'the default is the Twin, resolved from getMetaBots',
  );
  // The old card bar rendered one BUTTON per bot inside a wrapping row; the
  // selector must not contain a per-bot button any more.
  assert.equal(/\{botSelectorOptions\.map[\s\S]*?<button/.test(list), false);
  // A2A stays flat: the selector branch renders rows straight, with no group
  // header and no collapse control.
  const flatBranch = list.slice(list.indexOf('if (botSelectorRow)'));
  assert.ok(flatBranch.includes('sortedSessions.map(renderItem)'));
  assert.equal(flatBranch.includes('groupHeaderLabelClass'), false);
  assert.equal(flatBranch.includes('aria-expanded'), false);
});

test('the A2A title fallback is untouched by the selector change', () => {
  const item = readSource('renderer/components/cowork/CoworkSessionItem.tsx');
  assert.ok(item.includes('isPrivatePlaceholderTitle'));
  assert.match(item, /\^Private-\[A-Za-z0-9\]\{6,12\}\$/);
  assert.ok(item.includes('storedTitle || session.peerName ||'));
});
