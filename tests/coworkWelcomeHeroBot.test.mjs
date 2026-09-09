// Static anchor for the New Task welcome hero: the avatar above the
// "Start Collaborating" heading must follow the locked MetaBot selection
// (bot avatar + bot name, enlarged ~1/3 vs the old 64px logo), and the
// description line must switch copy by bot type (TwinBot vs professional
// Bot). The legacy generic line is kept only as the no-selection fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coworkView = readFileSync(join(here, '../src/renderer/components/cowork/CoworkView.tsx'), 'utf8');
const i18n = readFileSync(join(here, '../src/renderer/services/i18n.ts'), 'utf8');

test('welcome hero renders the selected MetaBot avatar and name', () => {
  // The hero avatar follows the selector's selection (data:/http sources only,
  // mirroring MetaBotSelector), sized 85px (64px logo grown by ~1/3) with the
  // app-wide rounded-xl bot-avatar convention and a chip-icon fallback.
  assert.match(coworkView, /selectedNewTaskBot\.avatar/);
  assert.match(coworkView, /w-\[85px\] h-\[85px\] rounded-xl object-cover/);
  assert.match(coworkView, /selectedNewTaskBot\.name/);
  // The generic logo survives only as the no-selection fallback.
  assert.match(coworkView, /<img src="logo\.png"/);
});

test('description copy switches by bot type with the generic line as fallback', () => {
  assert.match(
    coworkView,
    /metabot_type === 'twin'\s*\?\s*'coworkDescriptionTwin'\s*:\s*'coworkDescriptionPro'/,
  );
  assert.match(coworkView, /'coworkDescription'/);
});

test('twin and professional description keys exist in both locales', () => {
  assert.match(i18n, /coworkDescriptionTwin: '你选择的是 TwinBot，你可以和他说出你任何想法，他会帮你搞定一切'/);
  assert.match(i18n, /coworkDescriptionPro: '你选择是专业 Bot，可以让他做其所擅长的工作'/);
  assert.match(i18n, /coworkDescriptionTwin: "You've chosen your TwinBot/);
  assert.match(i18n, /coworkDescriptionPro: "You've chosen a specialized Bot/);
});
