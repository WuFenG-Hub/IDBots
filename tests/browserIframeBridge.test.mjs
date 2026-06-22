import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBrowserIframeBridgeScript } from '../src/renderer/features/botBrowser/browserIframeBridge.ts';

test('bridge gates browser-ready on runtime readiness without DOM timer readiness', () => {
  const script = buildBrowserIframeBridgeScript();

  assert.match(script, /function ensureRuntimeReady\(options\)/);
  assert.match(script, /await globalThis\.loadRuntime\(\);[\s\S]*postReady\(\);/);
  assert.doesNotMatch(script, /setTimeout\(postReady,\s*0\)/);
});

test('bridge waits for runtime readiness before actor selection and navigation', () => {
  const script = buildBrowserIframeBridgeScript();

  assert.match(
    script,
    /async function handleOpenUri\(input\) \{[\s\S]*await ensureRuntimeReady\(\);[\s\S]*await globalThis\.selectUsingIdentity\(actorId\);[\s\S]*await globalThis\.navigateTo\(uri\);[\s\S]*\}/,
  );
});

test('bridge clears failed runtime readiness state so later intents can retry', () => {
  const script = buildBrowserIframeBridgeScript();

  assert.match(script, /if \(!forceReload && runtimeReadyPromise\) \{\s*return runtimeReadyPromise;\s*\}/);
  assert.match(script, /runtimeReadyPromise = null;/);
  assert.match(script, /\.catch\(function \(error\) \{[\s\S]*runtimeReadyPromise = null;[\s\S]*throw error;[\s\S]*\}\)/);
});

test('bridge refresh-runtime forceReload bypasses cached runtimeReadyPromise', () => {
  const script = buildBrowserIframeBridgeScript();

  assert.match(
    script,
    /function ensureRuntimeReady\(options\) \{[\s\S]*var forceReload = Boolean\(options && options\.forceReload\);[\s\S]*if \(!forceReload && runtimeReadyPromise\) \{\s*return runtimeReadyPromise;\s*\}[\s\S]*await globalThis\.loadRuntime\(\);/,
  );
});
