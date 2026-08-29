import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMonthLabel,
  groupSessionsByProject,
  groupSessionsByTimeline,
} from '../src/renderer/utils/sessionViewGrouping';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

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
