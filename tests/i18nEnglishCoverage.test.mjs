import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadInferLanguageFromLocale() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-locale-'));
  const outputFile = path.join(tempDir, 'appLanguage.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { inferLanguageFromLocale } from './src/main/libs/inferLanguageFromLocale.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'inferLanguage-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    external: ['electron'],
  });
  return {
    tempDir,
    module: await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`),
  };
}

test('inferLanguageFromLocale uses Chinese only for Simplified Chinese locales', async (t) => {
  const loaded = await loadInferLanguageFromLocale();
  t.after(() => fs.rmSync(loaded.tempDir, { recursive: true, force: true }));
  const { inferLanguageFromLocale } = loaded.module;

  assert.equal(inferLanguageFromLocale('zh-CN'), 'zh');
  assert.equal(inferLanguageFromLocale('zh_CN'), 'zh');
  assert.equal(inferLanguageFromLocale('zh-Hans'), 'zh');
  assert.equal(inferLanguageFromLocale('zh-Hans-CN'), 'zh');
  assert.equal(inferLanguageFromLocale('zh-SG'), 'zh');
  assert.equal(inferLanguageFromLocale('zh'), 'zh');

  assert.equal(inferLanguageFromLocale('zh-TW'), 'en');
  assert.equal(inferLanguageFromLocale('zh-HK'), 'en');
  assert.equal(inferLanguageFromLocale('zh-MO'), 'en');
  assert.equal(inferLanguageFromLocale('zh-Hant'), 'en');
  assert.equal(inferLanguageFromLocale('zh-Hant-TW'), 'en');
  assert.equal(inferLanguageFromLocale('en-US'), 'en');
  assert.equal(inferLanguageFromLocale('ja-JP'), 'en');
  assert.equal(inferLanguageFromLocale(''), 'en');
});

test('English i18n dictionary has no Chinese characters and matches zh keys', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts'),
    'utf8',
  );
  const zhStart = source.indexOf('  zh: {');
  const enStart = source.indexOf('  en: {');
  const enEnd = source.indexOf('};\n\n', enStart);
  const zhBlock = source.slice(zhStart, enStart);
  const enBlock = source.slice(enStart, enEnd);
  const keyRe = /^\s{4}([A-Za-z0-9_]+):/gm;
  const zhKeys = new Set([...zhBlock.matchAll(keyRe)].map((match) => match[1]));
  const enKeys = new Set([...enBlock.matchAll(keyRe)].map((match) => match[1]));

  assert.equal(zhKeys.size, enKeys.size);
  assert.deepEqual([...zhKeys].filter((key) => !enKeys.has(key)), []);
  assert.deepEqual([...enKeys].filter((key) => !zhKeys.has(key)), []);
  assert.equal(/[\u4e00-\u9fff]/.test(enBlock), false);
});

test('required English UI keys exist', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts'),
    'utf8',
  );
  const required = [
    'mcpInstall',
    'discordTokenHint',
    'metabotWalletNativeAssets',
    'a2aDownloadFile',
    'a2aInternalStatus',
    'a2aMediaLoadingVideo',
    'a2aMediaLoadFailedVideo',
  ];
  for (const key of required) {
    assert.match(source, new RegExp(`^\\s{4}${key}:`, 'm'), `missing i18n key ${key}`);
  }
});
