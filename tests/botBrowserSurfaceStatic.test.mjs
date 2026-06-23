import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/renderer/features/botBrowser/BotBrowserSurface.tsx', import.meta.url),
  'utf8',
);

function getSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);

  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);

  return source.slice(start, end);
}

test('surface gates pending intent flushing on browser-ready', () => {
  assert.match(
    source,
    /const flushPendingOpenUris = useCallback\(\(\) => \{\s*if \(!readyRef\.current\) return;/,
  );
  assert.match(
    source,
    /const flushPendingRefreshRuntime = useCallback\(\(\) => \{\s*if \(!readyRef\.current\) return;/,
  );
});

test('surface does not post open-uri before browser-ready', () => {
  const openUriSection = getSection(
    'async openUri(input: BotBrowserOpenUriInput): Promise<void> {',
    '      async refreshRuntime(): Promise<void> {',
  );

  assert.match(openUriSection, /if \(!readyRef\.current\) \{/);
  assert.ok(
    openUriSection.indexOf('if (!readyRef.current) {') < openUriSection.indexOf('postOpenUri(input)'),
    'ready gate should run before postOpenUri',
  );
});

test('surface does not post refresh-runtime before browser-ready', () => {
  const refreshRuntimeSection = getSection(
    'async refreshRuntime(): Promise<void> {',
    '    }), [ensureSrcDoc, postOpenUri, postToIframe]);',
  );

  assert.match(refreshRuntimeSection, /if \(!readyRef\.current\) \{/);
  assert.ok(
    refreshRuntimeSection.indexOf('if (!readyRef.current) {') < refreshRuntimeSection.indexOf("postToIframe({ type: 'refresh-runtime' })"),
    'ready gate should run before refresh-runtime post',
  );
});

test('surface does not flush pending intents from iframe load events', () => {
  assert.doesNotMatch(source, /const handleIframeLoad = useCallback\(/);
  assert.doesNotMatch(source, /onLoad=\{handleIframeLoad\}/);
});
