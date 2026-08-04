import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CoworkSessionAvatars } from '../src/renderer/components/cowork/CoworkSessionItem';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

const makeSession = (overrides: Partial<CoworkSessionSummary> = {}): CoworkSessionSummary => ({
  id: 'session-1',
  title: 'Some task',
  status: 'completed',
  pinned: false,
  createdAt: 1000,
  updatedAt: 1000,
  sessionType: 'standard',
  ...overrides,
});

test('standard session renders the executing MetaBot avatar image', () => {
  const markup = renderToStaticMarkup(
    <CoworkSessionAvatars
      session={makeSession({
        metabotId: 3,
        metabotName: 'Alice Bot',
        metabotAvatar: 'data:image/png;base64,AAAA',
      })}
    />,
  );
  assert.equal((markup.match(/<img/g) ?? []).length, 1);
  assert.match(markup, /data:image\/png;base64,AAAA/);
  assert.match(markup, /title="Alice Bot"/);
});

test('standard session without an avatar falls back to the MetaBot initial', () => {
  const markup = renderToStaticMarkup(
    <CoworkSessionAvatars session={makeSession({ metabotId: 3, metabotName: 'alice bot' })} />,
  );
  assert.equal((markup.match(/<img/g) ?? []).length, 0);
  assert.match(markup, />A</);
});

test('standard session without any MetaBot attribution renders nothing', () => {
  const markup = renderToStaticMarkup(<CoworkSessionAvatars session={makeSession()} />);
  assert.equal(markup, '');
});

test('a2a session renders both local and peer avatars', () => {
  const markup = renderToStaticMarkup(
    <CoworkSessionAvatars
      session={makeSession({
        sessionType: 'a2a',
        metabotName: 'Local Bot',
        metabotAvatar: 'data:image/png;base64,BBBB',
        peerName: 'WuFenGBot',
        peerAvatar: 'https://file.metaid.io/avatar.png',
      })}
    />,
  );
  assert.equal((markup.match(/<img/g) ?? []).length, 2);
  assert.match(markup, /data:image\/png;base64,BBBB/);
  assert.match(markup, /https:\/\/file.metaid.io\/avatar.png/);
  assert.match(markup, /title="Local Bot"/);
  assert.match(markup, /title="WuFenGBot"/);
});

test('a2a session falls back to initials for non-renderable avatar sources', () => {
  const markup = renderToStaticMarkup(
    <CoworkSessionAvatars
      session={makeSession({
        sessionType: 'a2a',
        metabotName: 'Local Bot',
        peerName: 'WuFenGBot',
        peerAvatar: 'metafile://some-pin-id',
      })}
    />,
  );
  assert.equal((markup.match(/<img/g) ?? []).length, 0);
  assert.match(markup, />L</);
  assert.match(markup, />W</);
});
