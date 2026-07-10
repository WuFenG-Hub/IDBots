import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Electron CSP allows accelerated and fallback media previews', () => {
  const source = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes('"media-src \'self\' blob: https://file.metaid.io https://metafs.oss-cn-beijing.aliyuncs.com"'),
    'media-src must allow accelerated metafile URLs, OSS redirects, and blob fallbacks',
  );
});

test('production CSP allows Bot Browser srcDoc runtime scripts', () => {
  const mainSource = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const surfaceSource = fs.readFileSync(
    new URL('../src/renderer/features/botBrowser/BotBrowserSurface.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    surfaceSource,
    /renderBrowserPageHtml\(definition, getBrowserLanguagePreference\(\)\)/,
    'Bot Browser should still render the upstream browser HTML into the iframe document',
  );
  assert.match(
    surfaceSource,
    /<iframe[\s\S]*srcDoc=\{srcDoc\}/,
    'Bot Browser still uses an iframe srcDoc document for the Browser runtime',
  );
  assert.match(
    mainSource,
    /: "script-src 'self' 'unsafe-inline'"/,
    'production CSP must allow inline scripts so the Bot Browser srcDoc runtime can initialize',
  );
});
