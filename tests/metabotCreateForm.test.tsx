import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotCreateForm from '../src/renderer/components/metabots/MetaBotCreateForm';
import { configService } from '../src/renderer/services/config';
import type { AppConfig } from '../src/renderer/config';

// The model+effort picker reads the live app_config; seed the in-memory
// singleton so the catalog has providers in the Node test environment.
(configService as unknown as { config: AppConfig }).config = {
  ...(configService.getConfig() as AppConfig),
  providers: {
    openai: {
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      apiFormat: 'openai',
      models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }],
    },
    ollama: {
      enabled: true,
      apiKey: '',
      baseUrl: 'http://localhost:11434',
      apiFormat: 'openai',
      models: [{ id: 'llama3', name: 'Llama 3' }],
    },
  } as AppConfig['providers'],
};

const llmOptions = [
  { id: 'openai', label: 'Openai' },
  { id: 'ollama', label: 'Ollama' },
];

function renderCreateFormMarkup(props: Partial<React.ComponentProps<typeof MetaBotCreateForm>> = {}) {
  return renderToStaticMarkup(
    <MetaBotCreateForm
      onCancel={() => {}}
      onSave={async () => {}}
      saveLabel="Save"
      llmOptions={llmOptions}
      onRequestModelSettings={() => {}}
      onCheckNameExists={async () => false}
      {...props}
    />,
  );
}

test('MetaBot create form renders only name, primary LLM and fallback LLM fields', () => {
  const markup = renderCreateFormMarkup();

  assert.match(markup, /<input[^>]*id="metabot-name"/);
  assert.match(markup, /<button[^>]*id="metabot-llm"/);
  assert.match(markup, /<button[^>]*id="metabot-fallback-llm"/);

  // Fields deferred to the edit view must not render in the minimal create form.
  assert.doesNotMatch(markup, /id="metabot-role"/);
  assert.doesNotMatch(markup, /id="metabot-soul"/);
  assert.doesNotMatch(markup, /id="metabot-goal"/);
  assert.doesNotMatch(markup, /id="metabot-bio"/);
  assert.doesNotMatch(markup, /id="metabot-homepage"/);
  assert.doesNotMatch(markup, /id="metabot-allow-chat-skills"/);
  assert.doesNotMatch(markup, /id="metabot-boss-metaid"/);
  assert.doesNotMatch(markup, /metabotAvatarUpload/);
  assert.doesNotMatch(markup, /data-slot="metabot-homepage-control-row"/);
});

test('MetaBot create form fallback brain starts unset behind a setup button', () => {
  const markup = renderCreateFormMarkup();
  // Fallback is optional: until configured it renders as a single setup
  // button (seeding from the primary brain), not a picker.
  const setupMatch = markup.match(/<button[^>]*id="metabot-fallback-llm"[^>]*>/);
  assert.ok(setupMatch, 'fallback setup button should render');
  assert.doesNotMatch(markup, /<select[^>]*id="metabot-fallback-llm"/);
});

test('MetaBot create form primary brain uses the model+effort picker, not a select', () => {
  const markup = renderCreateFormMarkup();
  assert.match(markup, /<button[^>]*id="metabot-llm"/);
  assert.doesNotMatch(markup, /<select[^>]*id="metabot-llm"/);
});

test('MetaBot create form shows model-settings guidance when no LLM is available', () => {
  const markup = renderCreateFormMarkup({ llmOptions: [] });

  assert.match(markup, /data-slot="metabot-no-llm-guidance"/);
  assert.doesNotMatch(markup, /<select[^>]*id="metabot-llm"/);
  assert.doesNotMatch(markup, /<select[^>]*id="metabot-fallback-llm"/);
  // Submit stays disabled without an available LLM.
  const submitMatch = markup.match(/<button[^>]*type="submit"[^>]*>/);
  assert.ok(submitMatch, 'submit button should render');
  assert.match(submitMatch[0], /disabled/);
});
