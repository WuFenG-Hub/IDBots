import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupSessionsByDay, resolveSessionBot } from '../src/mobile/app/sessionList';
import { isRenderableAvatar, IPC_TRUNCATION_MARKER } from '../src/mobile/app/avatar';
import type { CoworkSessionSummary } from '../src/types/cowork';
import type { MobileMetabot } from '../src/mobile/bridge/types';

/** Minimal session summary factory — only the fields grouping reads. */
function session(id: string, updatedAt: number): CoworkSessionSummary {
  return {
    id,
    title: `session ${id}`,
    status: 'idle',
    pinned: false,
    createdAt: updatedAt - 1000,
    updatedAt,
    metabotId: 1,
  } as CoworkSessionSummary;
}

/** Fixed "now": 2026-10-29 12:00 local. */
const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime();
const THIS_MORNING = new Date(2026, 9, 29, 0, 30).getTime();
const YESTERDAY_EVENING = new Date(2026, 9, 28, 21, 0).getTime();
const THREE_DAYS_AGO = new Date(2026, 9, 26, 8, 0).getTime();

function bot(id: number, name: string, avatar: string | null): MobileMetabot {
  return {
    id,
    name,
    avatar,
  } as MobileMetabot;
}

describe('groupSessionsByDay', () => {
  it('groups into today / yesterday / earlier by local updatedAt', () => {
    const groups = groupSessionsByDay(
      [
        session('old', THREE_DAYS_AGO),
        session('yesterday', YESTERDAY_EVENING),
        session('today', THIS_MORNING),
      ],
      NOW,
    );
    assert.deepEqual(
      groups.map((group) => group.key),
      ['today', 'yesterday', 'earlier'],
    );
    assert.deepEqual(
      groups.map((group) => group.sessions.map((entry) => entry.id)),
      [['today'], ['yesterday'], ['old']],
    );
  });

  it('treats the local midnight boundary: 00:30 today is today, 23:59 yesterday is yesterday', () => {
    const justBeforeMidnight = new Date(2026, 9, 28, 23, 59).getTime();
    const groups = groupSessionsByDay(
      [session('late', justBeforeMidnight), session('early', THIS_MORNING)],
      NOW,
    );
    assert.deepEqual(groups.map((group) => group.key), ['today', 'yesterday']);
  });

  it('keeps input order inside a group and never mutates the input', () => {
    const input = [session('b', THIS_MORNING), session('a', THIS_MORNING - 1)];
    const snapshot = [...input];
    const groups = groupSessionsByDay(input, NOW);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.sessions.map((entry) => entry.id), ['b', 'a']);
    assert.deepEqual(input, snapshot);
  });

  it('lands malformed timestamps in "earlier" instead of throwing', () => {
    const dirty = { ...session('dirty', Number.NaN) } as CoworkSessionSummary;
    const negative = session('negative', -5);
    const groups = groupSessionsByDay([dirty, negative], NOW);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.key, 'earlier');
    assert.deepEqual(groups[0]?.sessions.map((entry) => entry.id), ['dirty', 'negative']);
  });

  it('returns an empty list for no sessions', () => {
    assert.deepEqual(groupSessionsByDay([], NOW), []);
  });
});

describe('isRenderableAvatar (A1 gateway-truncation gate)', () => {
  it('accepts complete data:image URLs and http(s) URLs', () => {
    assert.equal(isRenderableAvatar('data:image/png;base64,iVBORw0KGgo='), true);
    assert.equal(isRenderableAvatar('https://example.com/a.png'), true);
    assert.equal(isRenderableAvatar('http://example.com/a.png'), true);
  });

  it('rejects sanitizer-truncated strings even when they start with data:image', () => {
    const truncated = `data:image/png;base64,${'A'.repeat(6000)}\n${IPC_TRUNCATION_MARKER}`;
    assert.equal(truncated.length > 4000, true);
    assert.equal(isRenderableAvatar(truncated), false);
  });

  it('rejects non-string and non-image values', () => {
    assert.equal(isRenderableAvatar(null), false);
    assert.equal(isRenderableAvatar(undefined), false);
    assert.equal(isRenderableAvatar(42), false);
    assert.equal(isRenderableAvatar(''), false);
    assert.equal(isRenderableAvatar('   '), false);
    assert.equal(isRenderableAvatar('data:text/html;base64,PGI+'), false);
    assert.equal(isRenderableAvatar('javascript:alert(1)'), false);
    assert.equal(isRenderableAvatar('metafile://abc'), false);
  });
});

describe('resolveSessionBot', () => {
  const bots = [
    bot(1, 'Twin Bot', 'data:image/png;base64,AAA'),
    bot(2, 'Researcher', `data:image/png;base64,${'B'.repeat(6000)}\n${IPC_TRUNCATION_MARKER}`),
  ];

  it('prefers the session summary avatar, then falls back to the roster row', () => {
    const sessions = [session('s1', THIS_MORNING)];
    const summary = {
      ...sessions[0],
      metabotId: 2,
      metabotAvatar: 'data:image/gif;base64,R0lGODlh',
    } as CoworkSessionSummary;
    const view = resolveSessionBot([summary], 's1', 1, bots);
    assert.equal(view.metabotId, 2);
    assert.equal(view.avatar, 'data:image/gif;base64,R0lGODlh');
  });

  it('falls back to the roster avatar of the session\'s bot', () => {
    const sessions = [session('s1', THIS_MORNING)];
    const view = resolveSessionBot(sessions, 's1', null, bots);
    assert.equal(view.name, 'Twin Bot');
    assert.equal(view.avatar, 'data:image/png;base64,AAA');
  });

  it('degrades a gateway-truncated roster avatar to null (letter fallback)', () => {
    const sessions = [{ ...session('s1', THIS_MORNING), metabotId: 2 } as CoworkSessionSummary];
    const view = resolveSessionBot(sessions, 's1', 1, bots);
    assert.equal(view.name, 'Researcher');
    assert.equal(view.avatar, null);
  });

  it('uses the selected metabotId when no session is open', () => {
    const view = resolveSessionBot([], null, 2, bots);
    assert.equal(view.metabotId, 2);
    assert.equal(view.name, 'Researcher');
    assert.equal(view.avatar, null);
  });
});
