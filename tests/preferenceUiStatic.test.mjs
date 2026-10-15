import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const componentDir = path.join(repoRoot, 'src/renderer/components/preference');
const components = fs
  .readdirSync(componentDir)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(componentDir, name), 'utf8') }));

const i18n = fs.readFileSync(path.join(repoRoot, 'src/renderer/services/i18n.ts'), 'utf8');
const enStart = i18n.indexOf('\n  en: {');
const zhBlock = i18n.slice(0, enStart);
const enBlock = i18n.slice(enStart);

const STATUS_KEYS = ['collecting', 'revealing', 'settling', 'decided', 'no_decision', 'pending'].map(
  (status) => `preference.status.${status}`,
);
const BALLOT_KEYS = ['committing', 'committed', 'commit_failed', 'superseded', 'revealed', 'reveal_failed', 'expired'].map(
  (status) => `preference.ballotStatus.${status}`,
);

test('every preference key used by the components exists in zh and en', () => {
  const used = new Set([...STATUS_KEYS, ...BALLOT_KEYS, 'preference.panel.desktop', 'preference.panel.mobile']);
  for (const { text } of components) {
    for (const match of text.matchAll(/'(preference\.[a-zA-Z_.]+)'/g)) used.add(match[1]);
  }
  assert.ok(used.size > 40);
  for (const key of used) {
    assert.ok(zhBlock.includes(`'${key}':`), `zh missing ${key}`);
    assert.ok(enBlock.includes(`'${key}':`), `en missing ${key}`);
  }
});

test('preference components follow the theme and privacy rules', () => {
  assert.ok(components.length >= 3);
  for (const { name, text } of components) {
    assert.equal(/\bdark:/.test(text), false, `${name} uses dark: utilities`);
    assert.equal(/window\.(confirm|alert)\(/.test(text), false, `${name} uses window.confirm/alert`);
    assert.equal(/\.author\b|ownerGlobalMetaId/.test(text), false, `${name} renders builder identity`);
    assert.equal(/allow-popups|allow-top-navigation/.test(text), false, `${name} loosens the iframe sandbox`);
  }
});

test('compare panel is escapable, portaled, and guards duplicate seals', () => {
  const panel = components.find(({ name }) => name === 'PreferenceComparePanel.tsx');
  assert.ok(panel, 'PreferenceComparePanel.tsx not found');
  // Docked DevTools covers the overlay's top-right close button in dev builds;
  // Escape must dismiss the modal first, then the panel.
  assert.ok(/'Escape'/.test(panel.text), 'panel lacks an Escape key handler');
  // The overlay must escape any ancestor stacking context.
  assert.ok(/createPortal/.test(panel.text) && /document\.body/.test(panel.text), 'panel is not portaled to document.body');
  // After a successful seal the review button stays disabled until the ballot changes.
  assert.ok(/sealedSignature/.test(panel.text), 'panel lacks the sealed-signature guard');
});
