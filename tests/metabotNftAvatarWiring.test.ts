// NFT-avatar wiring — static + contract guards for the four-piece feature:
//   1. avatarNormalize metafile branch          (tests/avatarNormalize.test.mjs)
//   2. metabot:setNftAvatar IPC                 (tests/metabotNftIpc.test.mjs)
//   3. NFT Wallet modal per-item action         (this file, structural + SSR)
//   4. editor avatar area "choose from NFTs"    (this file, structural)
//
// The UI half is pinned structurally (the established repo convention for
// renderer wiring: no DOM harness here) plus a server-render smoke test, so a
// refactor that drops the action, the visible feedback or the i18n keys fails
// loudly instead of silently regressing the feature.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotNftWalletModal from '../src/renderer/components/metabots/MetaBotNftWalletModal';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const read = (relative: string): string => fs.readFileSync(path.join(projectRoot, relative), 'utf8');

const MODAL = 'src/renderer/components/metabots/MetaBotNftWalletModal.tsx';
const EDIT_TABS = 'src/renderer/components/metabots/MetaBotEditTabs.tsx';
const I18N = 'src/renderer/services/i18n.ts';
const PRESENTATION = 'src/renderer/components/metabots/metabotNftPresentation.js';

test('the NFT Wallet modal gives every item a "use as avatar" action with visible feedback', () => {
  const source = read(MODAL);

  // Per-tile action (sibling of the tile button, never nested inside it).
  assert.match(source, /data-slot="metabot-nft-use-avatar"/, 'per-tile action button');
  assert.match(source, /data-slot="metabot-nft-detail-use-avatar"/, 'detail-pane action button');
  assert.match(source, /buildNftAvatarImageRef/, 'the action resolves the item artwork reference');
  assert.match(source, /window\.electron\.metabot\.setNftAvatar\(\{ metabotId: metabot\.id, imageRef \}\)/);
  // Visible outcome: a persistent status/alert line plus a toast.
  assert.match(source, /data-slot="metabot-nft-avatar-notice"/);
  assert.match(source, /role=\{avatarNotice\.tone === 'error' \? 'alert' : 'status'\}/);
  assert.match(source, /showToast\(message\)/);
  // Success and failure both surface; a failed call is never swallowed.
  assert.match(source, /response\?\.error \|\| i18nService\.t\('metabotNftAvatarFailed'\)/);
  assert.match(source, /i18nService\.t\('metabotNftAvatarApplied'\)/);
  // The action updates the editor through the new callback.
  assert.match(source, /onAvatarUpdated\?\.\(response\.metabot\)/);
});

test('the editor avatar area exposes "choose from NFTs" and mounts the wallet modal', () => {
  const source = read(EDIT_TABS);
  assert.match(source, /data-slot="metabot-avatar-pick-nft"/);
  assert.match(source, /i18nService\.t\('metabotAvatarPickNft'\)/);
  assert.match(source, /setNftAvatarModalOpen\(true\)/);
  assert.match(source, /<MetaBotNftWalletModal/);
  assert.match(source, /onAvatarUpdated=\{handleNftAvatarUpdated\}/);
  // The picked avatar lands in both the live values and the baseline, so an
  // already-applied avatar never re-publishes on the next Basic-tab save.
  assert.match(source, /setValues\(\(prev\) => \(\{ \.\.\.prev, avatar \}\)\)/);
  assert.match(source, /setBaseline\(\(prev\) => \(\{ \.\.\.prev, avatar \}\)\)/);
});

test('new UI copy exists in both language blocks', () => {
  const source = read(I18N);
  const keys = [
    'metabotNftUseAsAvatar',
    'metabotNftAvatarWorking',
    'metabotNftAvatarApplied',
    'metabotNftAvatarFailed',
    'metabotNftAvatarNoArtwork',
    'metabotNftAvatarSyncPending',
    'metabotAvatarPickNft',
  ];
  for (const key of keys) {
    const hits = source.match(new RegExp(`^\\s+${key}:`, 'gm')) || [];
    assert.equal(hits.length, 2, `${key} must exist once in zh and once in en`);
  }
});

test('the avatar reference helper is exported for the modal', () => {
  assert.match(read(PRESENTATION), /export function buildNftAvatarImageRef\(item\)/);
});

test('metabot:setNftAvatar is exposed on the preload surface and tiered in the allowlist', () => {
  assert.match(read('src/main/preload.ts'), /setNftAvatar: \(input: \{ metabotId: number; imageRef: string \}\)/);
  assert.match(read('src/main/preload.ts'), /ipcRenderer\.invoke\('metabot:setNftAvatar', input\)/);
  assert.match(read('src/main/services/metabotNftIpc.ts'), /'metabot:setNftAvatar'/);
  assert.match(read('src/main/main.ts'), /registerMetabotNftIpcHandlers\(\{/);
  assert.match(
    read('src/main/main.ts'),
    /updateMetabotAvatar: \(metabotId, input\) => updateMetaBotCore\(metabotId, input, getMetabotManageDeps\(\)\)/,
  );

  // Compiled allowlist: the channel resolves to an EXACT P1 rule (never the
  // default-deny fallback).
  const allowlist = require('../dist-electron/main/gateway/allowlist.js');
  const { entry, matched } = allowlist.lookupInvokeChannelWithSource('metabot:setNftAvatar');
  assert.equal(matched, 'exact');
  assert.equal(entry.tier, 'P1');

  // Generated contract carries the method.
  const contract = JSON.parse(read('src/mobile/generated/ipc-contract.json'));
  const method = contract.methods.find((candidate: { path: string }) => candidate.path === 'metabot.setNftAvatar');
  assert.ok(method, 'ipc-contract.json must carry metabot.setNftAvatar');
  assert.equal(method.channel, 'metabot:setNftAvatar');
});

test('the NFT Wallet modal renders (SSR smoke) without a live electron bridge', () => {
  const html = renderToStaticMarkup(
    React.createElement(MetaBotNftWalletModal, {
      metabot: { id: 7, name: 'Alice' } as never,
      onClose: () => {},
    }),
  );
  assert.match(html, /data-slot="metabot-nft-wallet-modal"/);
  assert.match(html, /Alice/);
});
