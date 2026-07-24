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
    '    }), [controlTabs, ensureSrcDoc, postOpenUri, postToIframe]);',
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

test('surface wires Bot Browser MetaApp cache IPC into the host adapter', () => {
  const adapterSection = getSection(
    'const adapter = createIdbotsBrowserHostAdapter({',
    '      endpointShimRef.current = createBrowserEndpointShim(adapter);',
  );

  assert.match(adapterSection, /resolveMetaAppPin:\s*async \(pinId\) =>/);
  assert.match(adapterSection, /window\.electron\.botBrowser\.resolveMetaAppPin\(\{ pinId \}\)/);
  assert.match(adapterSection, /getMetaAppCache:\s*\(\) => window\.electron\.botBrowser\.getMetaAppCache\(\)/);
  assert.match(adapterSection, /clearMetaAppCache:\s*\(input\) => window\.electron\.botBrowser\.clearMetaAppCache\(input\)/);
});

test('surface relaxes MetaAPP iframe sandbox after rendering the packaged Browser HTML', () => {
  assert.match(
    source,
    /import \{ injectBrowserIframeBridge,\s*relaxMetaAppIframeSandbox \} from '\.\/browserIframeBridge';/,
  );
  assert.match(source, /const html = relaxMetaAppIframeSandbox\(\s*await renderBrowserPageHtml\(\s*definition,\s*getBrowserLanguagePreference\(\),\s*\{ theme: themeService\.getEffectiveTheme\(\) \},\s*\),\s*\);/);
});

test('surface uses the ABC theme contract for initial paint and runtime changes', () => {
  assert.match(source, /createBrowserThemeMessage/);
  assert.match(source, /themeService\.subscribe/);
  assert.match(source, /target\.postMessage\(createBrowserThemeMessage\(themeService\.getEffectiveTheme\(\)\), '\*'\)/);
  assert.match(source, /postThemeToIframe\(\);\s*callbacksRef\.current\.onReady/);
});

test('surface exposes request-response tab control without storing tab state', () => {
  assert.match(source, /controlTabs\(command: BotBrowserTabCommand\)/);
  assert.match(source, /pendingTabResponsesRef\.current\.get\(data\.id\)/);
  assert.match(source, /postToIframe\(\{ type: 'tab-command', id, command: pending\.command \}\)/);
  assert.doesNotMatch(source, /useState<BotBrowserTabInfo/);
});
