import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const presentationPath = new URL('../src/renderer/components/metabots/metaBotCardPresentation.js', import.meta.url);
const editTabsPath = new URL('../src/renderer/components/metabots/MetaBotEditTabs.tsx', import.meta.url);

function loadCanShowMetabotTwinSwitch() {
  const src = fs.readFileSync(presentationPath, 'utf8');
  const start = src.indexOf('export function canShowMetabotTwinSwitch');
  const end = src.indexOf('export function buildMetaBotToggleViewModel');
  assert.ok(start >= 0 && end > start, 'canShowMetabotTwinSwitch should be exported from metaBotCardPresentation.js');
  const fnSrc = src.slice(start, end).replace('export function', 'function');
  return new Function(`${fnSrc}\nreturn canShowMetabotTwinSwitch;`)();
}

test('canShowMetabotTwinSwitch hides Welcome always and Workers when a Twin exists', () => {
  const canShow = loadCanShowMetabotTwinSwitch();
  assert.equal(canShow({ metabotType: 'welcome', hasOtherTwin: false }), false);
  assert.equal(canShow({ metabotType: 'welcome', hasOtherTwin: true }), false);
  assert.equal(canShow({ metabotType: 'twin', hasOtherTwin: false }), true);
  assert.equal(canShow({ metabotType: 'twin', hasOtherTwin: true }), true);
  assert.equal(canShow({ metabotType: 'worker', hasOtherTwin: true }), false);
  assert.equal(canShow({ metabotType: 'worker', hasOtherTwin: false }), true);
});

test('MetaBot edit form gates the Twin switch on canShowMetabotTwinSwitch', () => {
  const src = fs.readFileSync(editTabsPath, 'utf8');
  assert.match(src, /canShowMetabotTwinSwitch/);
  assert.match(src, /showTwinSwitch &&/);
  assert.match(src, /data-slot="metabot-twin-switch-row"/);
  assert.match(src, /handleChange\('metabot_type', 'worker'\)/);
  assert.match(src, /data-slot="metabot-twin-demote-confirm"/);
  assert.doesNotMatch(src, /aria-disabled=\{isTwin\}/);
});
