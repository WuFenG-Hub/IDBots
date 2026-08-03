import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotEditTabs, {
  EDIT_TAB_FIELDS,
  EDIT_TAB_SYNC_GROUPS,
  type MetaBotEditValues,
} from '../src/renderer/components/metabots/MetaBotEditTabs';
import {
  composeHomepageForSave,
  type HomepageSectionValues,
} from '../src/renderer/components/metabots/MetaBotHomepageSection';

const baseInitialValues: Partial<MetaBotEditValues> = {
  name: 'Alice Bot',
  role: 'Assistant',
  soul: 'Direct',
  goal: 'Help',
  bio: 'Bio',
  llm_id: 'codex',
  fallback_llm_id: '',
  homepage_source: 'default',
  homepage_metaapp_pin: '',
  homepage_metafile_uri: '',
  homepage_metafile_content_type: '',
  homepage_initial: null,
};

function renderTabsMarkup(initialValues: Partial<MetaBotEditValues> = {}) {
  return renderToStaticMarkup(
    <MetaBotEditTabs
      initialValues={{ ...baseInitialValues, ...initialValues }}
      metabotId={1}
      onCancel={() => {}}
      onSaveTab={async () => {}}
      llmOptions={[{ id: 'codex', label: 'Codex' }]}
      skillOptions={[]}
      onOpenDefaultHomepage={() => {}}
      onPreviewMetaAppHomepage={() => true}
    />,
  );
}

/** Slice one panel's markup: from its data-slot marker to the next panel's marker (or end). */
function panelMarkup(markup: string, tab: string): string {
  const marker = `data-slot="metabot-edit-panel-${tab}"`;
  const start = markup.indexOf(marker);
  assert.ok(start >= 0, `panel ${tab} should render`);
  const rest = markup.slice(start);
  const nextPanel = rest.indexOf('data-slot="metabot-edit-panel-', marker.length);
  return nextPanel > 0 ? rest.slice(0, nextPanel) : rest;
}

const homepageValues = (overrides: Partial<HomepageSectionValues>): HomepageSectionValues => ({
  homepage_source: 'default',
  homepage_metafile_uri: '',
  homepage_metafile_content_type: '',
  homepage_metaapp_pin: '',
  ...overrides,
});

test('MetaBot edit tabs render all four tab buttons in order', () => {
  const markup = renderTabsMarkup();

  const basic = markup.indexOf('data-slot="metabot-edit-tab-basic"');
  const persona = markup.indexOf('data-slot="metabot-edit-tab-persona"');
  const chatSettings = markup.indexOf('data-slot="metabot-edit-tab-chatSettings"');
  const advanced = markup.indexOf('data-slot="metabot-edit-tab-advanced"');

  assert.ok(basic >= 0 && persona >= 0 && chatSettings >= 0 && advanced >= 0, 'all four tabs render');
  assert.ok(basic < persona && persona < chatSettings && chatSettings < advanced, 'tab order is basic/persona/chatSettings/advanced');
});

test('Basic panel hosts identity, owner and LLM fields plus its own save button', () => {
  const panel = panelMarkup(renderTabsMarkup(), 'basic');

  assert.match(panel, /id="metabot-name"/);
  assert.match(panel, /id="metabot-bio"/);
  assert.match(panel, /id="metabot-boss-metaid"/);
  assert.match(panel, /id="metabot-llm"/);
  assert.match(panel, /id="metabot-fallback-llm"/);
  assert.match(panel, /data-slot="metabot-edit-save-basic"/);
});

test('Persona panel keeps role/soul/goal optional with no required markers', () => {
  const panel = panelMarkup(renderTabsMarkup(), 'persona');

  assert.match(panel, /id="metabot-role"/);
  assert.match(panel, /id="metabot-soul"/);
  assert.match(panel, /id="metabot-goal"/);
  assert.match(panel, /data-slot="metabot-edit-save-persona"/);
  assert.doesNotMatch(panel, /<span class="ml-1 text-red-500">/);
});

test('Chat Settings panel hosts the allow-chat-skills editor and Advanced panel the homepage section', () => {
  const markup = renderTabsMarkup();

  const chatPanel = panelMarkup(markup, 'chatSettings');
  assert.match(chatPanel, /id="metabot-allow-chat-skills"/);
  assert.match(chatPanel, /data-slot="metabot-edit-save-chatSettings"/);

  const advancedPanel = panelMarkup(markup, 'advanced');
  assert.match(advancedPanel, /data-slot="metabot-homepage-control-row"/);
  assert.match(advancedPanel, /data-slot="metabot-edit-save-advanced"/);
});

test('tab field and sync group mappings pin each editable field to its tab', () => {
  assert.deepEqual(EDIT_TAB_FIELDS.basic, ['name', 'avatar', 'bio', 'metabot_type', 'boss_global_metaid', 'llm_id', 'fallback_llm_id']);
  assert.deepEqual(EDIT_TAB_FIELDS.persona, ['role', 'soul', 'goal']);
  assert.deepEqual(EDIT_TAB_FIELDS.chatSettings, ['allow_chat_skills']);
  assert.deepEqual(EDIT_TAB_FIELDS.advanced, ['homepage_source', 'homepage_metafile_uri', 'homepage_metafile_content_type', 'homepage_metaapp_pin']);

  assert.deepEqual(EDIT_TAB_SYNC_GROUPS.basic, ['name', 'avatar', 'bio', 'owner', 'llm']);
  assert.deepEqual(EDIT_TAB_SYNC_GROUPS.persona, ['persona']);
  assert.deepEqual(EDIT_TAB_SYNC_GROUPS.chatSettings, ['chatSkills']);
  assert.deepEqual(EDIT_TAB_SYNC_GROUPS.advanced, ['homepage']);

  // The Twin/Worker role is editable on the Basic tab but never published on-chain.
  const allSyncGroups = Object.values(EDIT_TAB_SYNC_GROUPS).flat();
  assert.ok(!allSyncGroups.includes('metabot_type'), 'metabot_type must stay out of the chain sync groups');
});

test('Basic panel renders the Twin switch, locked on for the current Twin', () => {
  const workerPanel = panelMarkup(renderTabsMarkup({ metabot_type: 'worker' }), 'basic');
  assert.match(workerPanel, /data-slot="metabot-twin-switch"/);
  assert.match(workerPanel, /role="switch"/);
  assert.match(workerPanel, /aria-checked="false"/);
  assert.doesNotMatch(workerPanel, /aria-disabled="true"/);

  const twinPanel = panelMarkup(renderTabsMarkup({ metabot_type: 'twin' }), 'basic');
  assert.match(twinPanel, /data-slot="metabot-twin-switch"/);
  assert.match(twinPanel, /aria-checked="true"/);
  assert.match(twinPanel, /aria-disabled="true"/);
});

test('composeHomepageForSave builds protocol JSON and rejects invalid pins', () => {
  assert.equal(composeHomepageForSave(homepageValues({ homepage_source: 'default' })), null);

  const metafile = composeHomepageForSave(homepageValues({
    homepage_source: 'metafile',
    homepage_metafile_uri: 'metafile://pin-1.html',
    homepage_metafile_content_type: 'text/html',
  }));
  assert.deepEqual(JSON.parse(metafile as string), {
    uri: 'metafile://pin-1.html',
    renderer: 'auto',
    contentType: 'text/html',
  });

  const metaapp = composeHomepageForSave(homepageValues({
    homepage_source: 'metaapp',
    homepage_metaapp_pin: 'metaapp://pin-2',
  }));
  assert.deepEqual(JSON.parse(metaapp as string), {
    uri: 'metaapp://pin-2',
    renderer: 'metaapp',
    contentType: 'application/vnd.metaapp',
  });

  assert.throws(() => composeHomepageForSave(homepageValues({ homepage_source: 'metafile' })));
  assert.throws(() => composeHomepageForSave(homepageValues({ homepage_source: 'metaapp', homepage_metaapp_pin: 'a b' })));
});
