import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBrowserIframeBridgeScript,
  relaxMetaAppIframeSandbox,
} from '../src/renderer/features/botBrowser/browserIframeBridge.ts';

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

test('bridge opens user-clicked URIs in a new tab and keeps agent opens in place', () => {
  const script = buildBrowserIframeBridgeScript();
  const openUriBody = script.slice(
    script.indexOf('async function handleOpenUri(input)'),
    script.indexOf('async function handleOpenNewTab()'),
  );

  // newTab opens ride AgentBrowserTabs.openTab(uri, actorId) — the runtime
  // creates + activates the tab and seeds the actor onto it directly — and
  // must return before the selectUsingIdentity/navigateTo fallback.
  assert.match(openUriBody, /var newTab = Boolean\(input && input\.newTab\);/);
  assert.match(
    openUriBody,
    /if \(newTab && typeof globalThis\.AgentBrowserTabs\.openTab === 'function'\) \{[\s\S]*globalThis\.AgentBrowserTabs\.openTab\(uri, actorId \|\| undefined\);[\s\S]*return;\s*\}/,
  );
  assert.ok(
    openUriBody.indexOf('AgentBrowserTabs.openTab(uri') < openUriBody.indexOf('await globalThis.selectUsingIdentity(actorId)'),
    'the new-tab branch must run before the navigate-in-place fallback',
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

test('relaxes only MetaAPP preview iframe sandbox to preserve local preview same-origin behavior', () => {
  const html = [
    '<iframe class="browser-html-frame" sandbox="allow-scripts" src="http://127.0.0.1:23456/browser-cache/metaapp-preview/session/index.html"></iframe>',
    '<iframe class="browser-pdf" sandbox="" src="http://127.0.0.1:23456/file.pdf"></iframe>',
  ].join('\n');

  const relaxed = relaxMetaAppIframeSandbox(html);

  assert.match(relaxed, /class="browser-html-frame" sandbox="allow-scripts allow-same-origin"/);
  assert.match(relaxed, /class="browser-pdf" sandbox=""/);
});
