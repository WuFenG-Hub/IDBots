// Verifies the "no avatar" marker handling that fixes the
// `https://so.metaid.io/content/` 404 shown on the Bot Home tab.
// The renderer guard (`src/renderer/utils/avatarSource.ts`) mirrors this
// logic exactly, so exercising the main-side helper also validates the guard.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRenderableAvatarSource,
  normalizeProfileAvatarUrl,
} from '../dist-electron/main/utils/avatarSource.js';
import { fetchLatestBotProfileInfo } from '../dist-electron/main/services/botBrowserHostService.js';

test('isRenderableAvatarSource accepts real avatar URLs', () => {
  assert.equal(isRenderableAvatarSource('https://file.metaid.io/metafile-indexer/content/abc123i0'), true);
  assert.equal(isRenderableAvatarSource('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isRenderableAvatarSource('blob:https://idbots.app/uuid'), true);
});

test('isRenderableAvatarSource rejects empty values and bare references', () => {
  assert.equal(isRenderableAvatarSource(''), false);
  assert.equal(isRenderableAvatarSource(null), false);
  assert.equal(isRenderableAvatarSource(undefined), false);
  assert.equal(isRenderableAvatarSource('metafile://abc123i0'), false);
  assert.equal(isRenderableAvatarSource('/content/abc123i0'), false);
});

test('isRenderableAvatarSource rejects the no-avatar marker and the 404 it gets promoted to', () => {
  // On-chain "no avatar" markers must never be rendered.
  assert.equal(isRenderableAvatarSource('/content/'), false);
  assert.equal(isRenderableAvatarSource('/content'), false);
  assert.equal(isRenderableAvatarSource('/metafile-indexer/content'), false);
  // The upstream fetcher turns `/content/` into `<p2pBase>/content/` -> a 404.
  assert.equal(isRenderableAvatarSource('https://so.metaid.io/content/'), false);
  assert.equal(isRenderableAvatarSource('https://file.metaid.io/metafile-indexer/content'), false);
});

test('normalizeProfileAvatarUrl nulls no-avatar markers but keeps real URLs', () => {
  assert.equal(normalizeProfileAvatarUrl('/content/'), null);
  assert.equal(normalizeProfileAvatarUrl('https://so.metaid.io/content/'), null);
  assert.equal(
    normalizeProfileAvatarUrl('https://file.metaid.io/metafile-indexer/content/abc123i0'),
    'https://file.metaid.io/metafile-indexer/content/abc123i0',
  );
  assert.equal(normalizeProfileAvatarUrl(''), null);
  assert.equal(normalizeProfileAvatarUrl('  /content/  '), null);
});

test('fetchLatestBotProfileInfo drops the no-avatar marker instead of returning the 404 URL', async () => {
  const globalMetaId = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
  // Simulate the on-chain record for a Bot with no avatar: the upstream
  // fetcher would otherwise turn `/content/` into `https://so.metaid.io/content/`.
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 0,
        data: { globalMetaId, name: 'NoAvatar Bot', avatar: '/content/' },
      };
    },
  });

  const profile = await fetchLatestBotProfileInfo(globalMetaId, { fetch: mockFetch });

  assert.ok(profile, 'profile should be returned');
  assert.equal(profile.name, 'NoAvatar Bot');
  assert.equal(profile.avatar, null, 'no-avatar marker must not leak as a URL');
});
