import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotForm, { type MetaBotFormValues } from '../src/renderer/components/metabots/MetaBotForm';

const metaBotFormPath = new URL('../src/renderer/components/metabots/MetaBotForm.tsx', import.meta.url);

const baseInitialValues: Partial<MetaBotFormValues> = {
  name: 'Alice Bot',
  role: 'Assistant',
  soul: 'Direct',
  llm_id: 'codex',
  homepage_source: 'default',
  homepage_metaapp_pin: '',
  homepage_metafile_uri: '',
  homepage_metafile_content_type: '',
  homepage_initial: null,
};

function renderFormMarkup(initialValues: Partial<MetaBotFormValues>, isEdit = true) {
  return renderToStaticMarkup(
    <MetaBotForm
      initialValues={{ ...baseInitialValues, ...initialValues }}
      isEdit={isEdit}
      onCancel={() => {}}
      onSave={async () => {}}
      saveLabel="Save"
      llmOptions={[{ id: 'codex', label: 'Codex' }]}
      skillOptions={[]}
      metabotId={1}
      onOpenDefaultHomepage={() => {}}
      onPreviewMetaAppHomepage={() => true}
    />,
  );
}

function renderHomepageMarkup(initialValues: Partial<MetaBotFormValues>) {
  return renderFormMarkup(initialValues, true);
}

function homepageControlRow(markup: string): string {
  const match = markup.match(/<div data-slot="metabot-homepage-control-row"[\s\S]*?<p data-slot="metabot-homepage-hint"/);
  assert.ok(match, 'Homepage controls should render in a dedicated row before the hint');
  return match[0];
}

test('MetaBot create form hides homepage controls', () => {
  const markup = renderFormMarkup({}, false);

  assert.doesNotMatch(markup, /id="metabot-homepage"/);
  assert.doesNotMatch(markup, /data-slot="metabot-homepage-control-row"/);
  assert.doesNotMatch(markup, /data-slot="metabot-homepage-hint"/);
});

test('MetaBot Homepage default template keeps source and view action in one control row', () => {
  const row = homepageControlRow(renderHomepageMarkup({ homepage_source: 'default' }));

  assert.match(row, /<select[^>]*id="metabot-homepage"/);
  assert.match(row, /<button[^>]*data-slot="metabot-homepage-view"/);
  assert.ok(row.indexOf('id="metabot-homepage"') < row.indexOf('data-slot="metabot-homepage-view"'));
  assert.doesNotMatch(row, /\bspace-y-2\b/);
});

test('MetaBot Homepage MetaApp source keeps pin input next to the source selector', () => {
  const row = homepageControlRow(renderHomepageMarkup({
    homepage_source: 'metaapp',
    homepage_metaapp_pin: 'metaapp-pin-123',
  }));

  assert.match(row, /<select[^>]*id="metabot-homepage"/);
  assert.match(row, /<input[^>]*data-slot="metabot-homepage-metaapp-pin"/);
  assert.match(row, /<button[^>]*data-slot="metabot-homepage-metaapp-select"/);
  assert.match(row, /<button[^>]*data-slot="metabot-homepage-metaapp-preview"/);
  assert.ok(row.indexOf('id="metabot-homepage"') < row.indexOf('data-slot="metabot-homepage-metaapp-pin"'));
  assert.ok(row.indexOf('data-slot="metabot-homepage-metaapp-pin"') < row.indexOf('data-slot="metabot-homepage-metaapp-select"'));
  assert.doesNotMatch(row, /\bspace-y-2\b/);
});

test('MetaBot Homepage MetaFile source keeps pin input and upload action next to the source selector', () => {
  const row = homepageControlRow(renderHomepageMarkup({ homepage_source: 'metafile' }));

  assert.match(row, /<select[^>]*id="metabot-homepage"/);
  assert.match(row, /<input[^>]*data-slot="metabot-homepage-metafile-pin"/);
  assert.match(row, /<button[^>]*data-slot="metabot-homepage-metafile-upload"/);
  assert.ok(row.indexOf('id="metabot-homepage"') < row.indexOf('data-slot="metabot-homepage-metafile-pin"'));
  assert.ok(row.indexOf('data-slot="metabot-homepage-metafile-pin"') < row.indexOf('data-slot="metabot-homepage-metafile-upload"'));
  assert.doesNotMatch(row, /\bspace-y-2\b/);
});

test('MetaBot Homepage MetaApp selector loads the current bot owner MetaApps', () => {
  const source = fs.readFileSync(metaBotFormPath, 'utf8');

  assert.match(source, /window\.electron\.metaappOwner\.list\(\{\s*metabotId,\s*size:\s*24\s*\}\)/);
  assert.match(source, /setHomepageMetaAppPickerOpen\(true\)/);
  assert.match(source, /handleChange\('homepage_metaapp_pin',\s*record\.pinId\)/);
});
