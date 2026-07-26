import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBrowserIframeBridgeScript } from '../src/renderer/features/botBrowser/browserIframeBridge';

/**
 * The bridge script is a plain-JS string injected into the Bot Browser iframe.
 * A syntax error inside it (e.g. an unescaped sequence produced by the TS
 * template literal) silently kills the whole browser module — the script must
 * always parse.
 */
test('generated iframe bridge script parses as valid JavaScript', () => {
  const script = buildBrowserIframeBridgeScript();
  assert.doesNotThrow(() => new Function(script));
});

test('generated bridge script contains the expected install markers and features', () => {
  const script = buildBrowserIframeBridgeScript();
  assert.match(script, /idbots-browser-iframe-bridge/);
  assert.match(script, /get-content/);
  assert.match(script, /get-tab-info/);
  assert.match(script, /window-drag-move/);
});
