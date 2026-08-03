import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotCreateForm from '../src/renderer/components/metabots/MetaBotCreateForm';

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
  assert.match(markup, /<select[^>]*id="metabot-llm"/);
  assert.match(markup, /<select[^>]*id="metabot-fallback-llm"/);

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

test('MetaBot create form fallback LLM select offers None plus every provider', () => {
  const markup = renderCreateFormMarkup();
  const selectMatch = markup.match(/<select[^>]*id="metabot-fallback-llm"[\s\S]*?<\/select>/);
  assert.ok(selectMatch, 'fallback select should render');

  const options = selectMatch[0].match(/<option[^>]*>/g) ?? [];
  // 1 None option + one per provider.
  assert.equal(options.length, llmOptions.length + 1);
  assert.match(options[0], /value=""/);
  assert.match(selectMatch[0], /value="openai"/);
  assert.match(selectMatch[0], /value="ollama"/);
});

test('MetaBot create form primary LLM select lists providers without a None entry', () => {
  const markup = renderCreateFormMarkup();
  const selectMatch = markup.match(/<select[^>]*id="metabot-llm"[\s\S]*?<\/select>/);
  assert.ok(selectMatch, 'primary select should render');

  const options = selectMatch[0].match(/<option[^>]*>/g) ?? [];
  // 1 placeholder option + one per provider (primary LLM stays required).
  assert.equal(options.length, llmOptions.length + 1);
  assert.match(options[0], /value=""/);
  assert.match(selectMatch[0], /value="openai"/);
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
