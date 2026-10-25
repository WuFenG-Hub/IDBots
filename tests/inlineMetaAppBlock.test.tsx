// InlineMetaAppBlock — a MetaApp rendered in place inside an assistant-mode
// chat bubble, acting as the session Bot.
//
// Covers the block's testable surface without a DOM (this repo's renderer
// tests are server-rendered, no jsdom):
//   (a) parseMetaAppEmbedUri: the markdown image destination that triggers an
//       embed — metaapp://<pin> only, normalized to a lowercase pin id, with
//       percent-encoding / trailing path / query / fragment tolerated and
//       every other scheme or pin shape rejected;
//   (b) the AgentBrowser bridge v1 wire contract: parseInlineMetaAppBridgeMessage
//       enforces the per-instance source contract (exactly this block's iframe
//       contentWindow), the protocol version, and the request/navigate shapes;
//       buildInlineMetaAppBridgeResponse produces what the app's helper
//       resolves/rejects on;
//   (c) the two-phase confirmation extraction mirrors ABC: kind and resource
//       must match, so a foreign confirmation can never approve a write here;
//   (d) sandbox tokens mirror ABC's htmlFrameSandbox (allow-same-origin only
//       for a frame origin that differs from the host page);
//   (e) the resolve envelope → frame URL rule (metaapp + html-iframe + http);
//   (f) browser.actor.current snapshot shape;
//   (g) MarkdownContent: assistant mode turns `![name](metaapp://pin)` into the
//       block (SSR-loading shell, no iframe before resolve), professional mode
//       keeps a Bot Browser link, and a plain link form never embeds;
//   (h) source wiring pins: the block signs through the existing trusted-action
//       IPC with the session Bot as actor (CoworkSessionDetail provides the
//       context from the session metabot), frames the app by src (not srcdoc),
//       hands navigation off to the Bot Browser with the same actor, and the
//       assistant-mode prompt teaches the image-syntax choice.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import InlineMetaAppBlock from '../src/renderer/components/cowork/InlineMetaAppBlock';
import { InlineMetaAppActorContext } from '../src/renderer/components/cowork/InlineMetaAppActorContext';
import {
  INLINE_METAAPP_BROWSER_ONLY_METHODS,
  INLINE_METAAPP_DEFAULT_HEIGHT,
  INLINE_METAAPP_MAX_HEIGHT,
  INLINE_METAAPP_MIN_HEIGHT,
  INLINE_METAAPP_SUPPORTED_METHODS,
  bridgeErrorFromHostResult,
  bridgeResultFromHostResult,
  buildInlineMetaAppActorSnapshot,
  buildInlineMetaAppBridgeResponse,
  clampInlineMetaAppHeight,
  createInlineMetaAppSessionId,
  inlineMetaAppFrameUrl,
  inlineMetaAppSandbox,
  isAgentInternetNavigateUri,
  parseInlineMetaAppBridgeMessage,
  parseInlineMetaAppConfirmation,
  parseMetaAppEmbedUri,
} from '../src/renderer/components/cowork/inlineMetaAppBridge';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...segments: string[]): string => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');
const blockSource = read('src', 'renderer', 'components', 'cowork', 'InlineMetaAppBlock.tsx');
const markdownSource = read('src', 'renderer', 'components', 'MarkdownContent.tsx');
const sessionDetailSource = read('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const appSource = read('src', 'renderer', 'App.tsx');
const promptSource = read('src', 'main', 'libs', 'assistantModePrompt.ts');
const toolsSource = read('src', 'main', 'libs', 'botBrowserAgentTools.ts');

const PIN = '7dba6c2f36b224eb18ac3d54ad88b1ba3def56aeda56eb4c6f941eccf4fb5f28i0';
const URI = `metaapp://${PIN}`;

// The block reads window.location while rendering; SSR gets the same minimal
// stub the other renderer tests use.
const withWindowStub = (fn: () => void): void => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    fn();
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
};

// ─── (a) embed destination ──────────────────────────────────────────────────

test('parseMetaAppEmbedUri accepts metaapp://<pin> and normalizes the pin id', () => {
  assert.deepEqual(parseMetaAppEmbedUri(URI), { uri: URI, pinId: PIN });
  assert.deepEqual(parseMetaAppEmbedUri(`  METAAPP://${PIN.toUpperCase()}  `), { uri: URI, pinId: PIN });
  assert.deepEqual(parseMetaAppEmbedUri(`metaapp://${encodeURIComponent(PIN)}`), { uri: URI, pinId: PIN });
  assert.deepEqual(parseMetaAppEmbedUri(`${URI}/`), { uri: URI, pinId: PIN });
  assert.deepEqual(parseMetaAppEmbedUri(`${URI}?x=1#frag`), { uri: URI, pinId: PIN });
  assert.deepEqual(parseMetaAppEmbedUri(`${URI}/index.html`), { uri: URI, pinId: PIN });
});

test('parseMetaAppEmbedUri rejects other schemes and malformed pins', () => {
  assert.equal(parseMetaAppEmbedUri(`metaid://${PIN}`), null);
  assert.equal(parseMetaAppEmbedUri(`pin://${PIN}`), null);
  assert.equal(parseMetaAppEmbedUri(`https://example.com/${PIN}`), null);
  assert.equal(parseMetaAppEmbedUri('metaapp://'), null);
  assert.equal(parseMetaAppEmbedUri('metaapp://not-a-pin'), null);
  assert.equal(parseMetaAppEmbedUri(`metaapp://${PIN.slice(0, 60)}i0`), null);
  assert.equal(parseMetaAppEmbedUri(`metaapp://${PIN.replace(/i0$/, '')}`), null);
  assert.equal(parseMetaAppEmbedUri('metaapp://%E0%A4%A'), null);
  assert.equal(parseMetaAppEmbedUri(undefined), null);
  assert.equal(parseMetaAppEmbedUri(42), null);
});

// ─── (b) bridge wire contract ───────────────────────────────────────────────

test('parseInlineMetaAppBridgeMessage accepts only this frame as source and v1 frames', () => {
  const frame = {};
  const request = { type: 'agent-browser:request', version: 1, id: 'req-1', method: 'metaid.pin.write', params: { path: '/protocols/buzz' } };
  assert.deepEqual(parseInlineMetaAppBridgeMessage(request, frame, frame), {
    type: 'request',
    id: 'req-1',
    method: 'metaid.pin.write',
    params: { path: '/protocols/buzz' },
  });
  // Another window (sibling block, nested frame, the page itself) is ignored.
  assert.equal(parseInlineMetaAppBridgeMessage(request, {}, frame), null);
  assert.equal(parseInlineMetaAppBridgeMessage(request, frame, null), null);
  // Version, id and method are mandatory; params default to {}.
  assert.equal(parseInlineMetaAppBridgeMessage({ ...request, version: 2 }, frame, frame), null);
  assert.equal(parseInlineMetaAppBridgeMessage({ ...request, id: '' }, frame, frame), null);
  assert.equal(parseInlineMetaAppBridgeMessage({ ...request, method: '  ' }, frame, frame), null);
  assert.deepEqual(parseInlineMetaAppBridgeMessage({ ...request, params: 'nope' }, frame, frame)?.params, {});
  assert.equal(parseInlineMetaAppBridgeMessage('agent-browser:request', frame, frame), null);
  assert.equal(parseInlineMetaAppBridgeMessage(null, frame, frame), null);
  // Navigate frames carry a uri.
  assert.deepEqual(
    parseInlineMetaAppBridgeMessage({ type: 'agent-browser:navigate', version: 1, uri: ' metaid://abc ' }, frame, frame),
    { type: 'navigate', uri: 'metaid://abc' },
  );
  assert.equal(parseInlineMetaAppBridgeMessage({ type: 'agent-browser:navigate', version: 1 }, frame, frame), null);
  // Responses/events are host → app only; an app echoing one is ignored.
  assert.equal(parseInlineMetaAppBridgeMessage({ type: 'agent-browser:response', version: 1, id: 'x', ok: true }, frame, frame), null);
});

test('buildInlineMetaAppBridgeResponse shapes success and failure like ABC', () => {
  assert.deepEqual(buildInlineMetaAppBridgeResponse('req-1', true, { pinId: 'abc' }), {
    type: 'agent-browser:response',
    version: 1,
    id: 'req-1',
    ok: true,
    result: { pinId: 'abc' },
  });
  assert.deepEqual(buildInlineMetaAppBridgeResponse('req-2', true).result, {});
  assert.deepEqual(buildInlineMetaAppBridgeResponse('req-3', false, { code: 'user_cancelled', message: 'Cancelled.' }), {
    type: 'agent-browser:response',
    version: 1,
    id: 'req-3',
    ok: false,
    error: { code: 'user_cancelled', message: 'Cancelled.' },
  });
  assert.deepEqual(buildInlineMetaAppBridgeResponse('req-4', false).error, {
    code: 'invalid_request',
    message: 'Invalid bridge request.',
  });
});

test('method sets split what the bubble answers from what needs the Bot Browser', () => {
  for (const method of ['browser.actor.current', 'metaid.pin.write', 'metafile.upload', 'browser.llm.complete', 'browser.permissions.request']) {
    assert.ok(INLINE_METAAPP_SUPPORTED_METHODS.has(method), method);
    assert.ok(!INLINE_METAAPP_BROWSER_ONLY_METHODS.has(method), method);
  }
  for (const method of ['browser.privateChat.compose', 'browser.simplemsg.compose', 'browser.app.session.start', 'browser.app.session.stop']) {
    assert.ok(INLINE_METAAPP_BROWSER_ONLY_METHODS.has(method), method);
    assert.ok(!INLINE_METAAPP_SUPPORTED_METHODS.has(method), method);
  }
});

test('isAgentInternetNavigateUri mirrors ABC internal hrefs', () => {
  assert.ok(isAgentInternetNavigateUri('metaid://abc'));
  assert.ok(isAgentInternetNavigateUri(`METAAPP://${PIN}`));
  assert.ok(isAgentInternetNavigateUri('pin://abc'));
  assert.ok(isAgentInternetNavigateUri('map://x'));
  assert.ok(isAgentInternetNavigateUri('metafile://x'));
  assert.ok(!isAgentInternetNavigateUri('https://example.com'));
  assert.ok(!isAgentInternetNavigateUri('javascript:alert(1)'));
  assert.ok(!isAgentInternetNavigateUri('idbots://session/1'));
  assert.ok(!isAgentInternetNavigateUri(''));
});

// ─── (c) two-phase confirmation ─────────────────────────────────────────────

const manualAction = (kind: string, resourceUri: string, extra: Record<string, unknown> = {}) => ({
  ok: false,
  state: 'manual_action_required',
  code: 'manual_action_required',
  message: 'Confirm.',
  data: {
    confirmation: { operation: 'create', path: '/protocols/buzz', actor: { name: 'Bot' }, ...extra },
    confirmRequest: { resourceUri, kind, payload: { path: '/protocols/buzz', confirmed: true, hostConfirmation: { id: 'c1', token: 't' } } },
  },
});

test('parseInlineMetaAppConfirmation extracts a matching confirmation and nothing else', () => {
  const structured = parseInlineMetaAppConfirmation(manualAction('metaid-pin-write', URI), 'metaid-pin-write', URI);
  assert.ok(structured);
  assert.equal(structured?.confirmation.path, '/protocols/buzz');
  assert.equal(structured?.confirmRequest.kind, 'metaid-pin-write');
  assert.equal(structured?.confirmRequest.resourceUri, URI);
  assert.deepEqual((structured?.confirmRequest.payload as Record<string, unknown>).hostConfirmation, { id: 'c1', token: 't' });

  // Kind must match the action that was issued.
  assert.equal(parseInlineMetaAppConfirmation(manualAction('permissions-request', URI), 'metaid-pin-write', URI), null);
  assert.ok(parseInlineMetaAppConfirmation(manualAction('permissions-request', URI), 'permissions-request', URI));
  // A confirmation for another resource is dropped.
  assert.equal(parseInlineMetaAppConfirmation(manualAction('metaid-pin-write', 'metaapp://other'), 'metaid-pin-write', URI), null);
  // Only manual_action_required with both halves qualifies.
  assert.equal(parseInlineMetaAppConfirmation({ ok: true, data: { pinId: 'x' } }, 'metaid-pin-write', URI), null);
  assert.equal(parseInlineMetaAppConfirmation({ ok: false, state: 'failed', code: 'x', message: 'y' }, 'metaid-pin-write', URI), null);
  const missingPayload = manualAction('metaid-pin-write', URI);
  (missingPayload.data.confirmRequest as Record<string, unknown>).payload = 'nope';
  assert.equal(parseInlineMetaAppConfirmation(missingPayload, 'metaid-pin-write', URI), null);
  assert.equal(parseInlineMetaAppConfirmation(null, 'metaid-pin-write', URI), null);
});

test('host results map to bridge payloads the way ABC forwards them', () => {
  assert.deepEqual(bridgeResultFromHostResult({ ok: true, data: { pinId: 'p', txids: ['t'] } }), { pinId: 'p', txids: ['t'] });
  assert.deepEqual(bridgeResultFromHostResult({ ok: true }), { ok: true });
  assert.deepEqual(bridgeResultFromHostResult(undefined), {});
  assert.deepEqual(bridgeErrorFromHostResult({ ok: false, code: 'actor_locked', message: 'Locked.' }, 'pin_write_failed', 'Failed.'), {
    code: 'actor_locked',
    message: 'Locked.',
  });
  assert.deepEqual(bridgeErrorFromHostResult({ ok: false }, 'pin_write_failed', 'Failed.'), { code: 'pin_write_failed', message: 'Failed.' });
  assert.deepEqual(bridgeErrorFromHostResult(null, 'upload_failed', 'Upload failed.'), { code: 'upload_failed', message: 'Upload failed.' });
});

// ─── (d) sandbox ────────────────────────────────────────────────────────────

test('inlineMetaAppSandbox mirrors ABC htmlFrameSandbox', () => {
  const base = 'allow-scripts allow-downloads allow-forms';
  // Local MetaApp server vs dev renderer: different origins → keep the app's origin.
  assert.equal(inlineMetaAppSandbox('http://127.0.0.1:54321/app/index.html', 'http://localhost:5175'), `${base} allow-same-origin`);
  // Packaged renderer is file:// (opaque 'null' origin) → same rule.
  assert.equal(inlineMetaAppSandbox('http://127.0.0.1:54321/app/index.html', 'null'), `${base} allow-same-origin`);
  assert.equal(inlineMetaAppSandbox('http://127.0.0.1:54321/app/index.html', ''), `${base} allow-same-origin`);
  // Same origin as the host page stays fully opaque.
  assert.equal(inlineMetaAppSandbox('http://localhost:5175/app/index.html', 'http://localhost:5175'), base);
  // A non-http frame URL never gets allow-same-origin.
  assert.equal(inlineMetaAppSandbox('javascript:alert(1)', 'http://localhost:5175'), base);
});

// ─── (e) resolve envelope → frame url ───────────────────────────────────────

test('inlineMetaAppFrameUrl accepts only an http html-iframe metaapp renderer', () => {
  const envelope = { resourceType: 'metaapp', renderer: { type: 'html-iframe', url: 'http://127.0.0.1:54321/app/index.html' } };
  assert.equal(inlineMetaAppFrameUrl(envelope), 'http://127.0.0.1:54321/app/index.html');
  assert.equal(inlineMetaAppFrameUrl({ ...envelope, resourceType: 'bot' }), null);
  assert.equal(inlineMetaAppFrameUrl({ ...envelope, renderer: { type: 'bot-page', url: 'http://127.0.0.1:1/x' } }), null);
  assert.equal(inlineMetaAppFrameUrl({ ...envelope, renderer: { type: 'html-iframe', url: 'file:///tmp/index.html' } }), null);
  assert.equal(inlineMetaAppFrameUrl({ ...envelope, renderer: { type: 'html-iframe' } }), null);
  assert.equal(inlineMetaAppFrameUrl(null), null);
});

// ─── (f) actor snapshot ─────────────────────────────────────────────────────

test('buildInlineMetaAppActorSnapshot returns the sanitized ABC shape', () => {
  assert.deepEqual(
    buildInlineMetaAppActorSnapshot({ actorId: 'idbots-metabot-3', name: 'Alice', globalMetaId: 'gmid', avatarPinId: PIN.toUpperCase() }),
    { uri: 'metaid://gmid', globalMetaId: 'gmid', name: 'Alice', avatarPinId: PIN },
  );
  assert.deepEqual(
    buildInlineMetaAppActorSnapshot({ actorId: 'idbots-metabot-3', name: '', globalMetaId: 'gmid', avatarPinId: 'not-a-pin' }),
    { uri: 'metaid://gmid', globalMetaId: 'gmid', name: 'gmid' },
  );
  assert.equal(buildInlineMetaAppActorSnapshot({ actorId: 'idbots-metabot-3', name: 'Alice', globalMetaId: '' }), null);
  assert.equal(buildInlineMetaAppActorSnapshot(null), null);
});

test('height clamp and session id helpers', () => {
  assert.equal(clampInlineMetaAppHeight(INLINE_METAAPP_DEFAULT_HEIGHT), INLINE_METAAPP_DEFAULT_HEIGHT);
  assert.equal(clampInlineMetaAppHeight(10), INLINE_METAAPP_MIN_HEIGHT);
  assert.equal(clampInlineMetaAppHeight(99999), INLINE_METAAPP_MAX_HEIGHT);
  assert.equal(clampInlineMetaAppHeight(Number.NaN), INLINE_METAAPP_DEFAULT_HEIGHT);
  assert.equal(clampInlineMetaAppHeight(500.6), 501);
  assert.equal(createInlineMetaAppSessionId(() => 'abc'), 'inline-metaapp-abc');
  assert.match(createInlineMetaAppSessionId(), /^inline-metaapp-[A-Za-z0-9-]+$/);
});

// ─── (g) MarkdownContent branch + SSR shell ─────────────────────────────────

test('assistant mode renders ![name](metaapp://pin) as the inline MetaApp block', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={`Here it is: ![Agent Daily Portal](${URI})`} chatExperienceMode="assistant" />,
    );
    assert.match(markup, new RegExp(`data-inline-metaapp="${URI}"`));
    assert.match(markup, /Agent Daily Portal/);
    // Loading shell: no app frame until the pin resolves, no broken <img>.
    assert.doesNotMatch(markup, /<iframe/);
    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, /Loading MetaApp|正在加载 MetaApp/);
  });
});

test('professional mode keeps the embed as a Bot Browser link, never a broken image', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={`![Agent Daily Portal](${URI})`} chatExperienceMode="professional" />,
    );
    assert.doesNotMatch(markup, /data-inline-metaapp/);
    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, new RegExp(`<a[^>]*href="${URI}"`));
    assert.match(markup, /Agent Daily Portal/);
  });
});

test('the plain link form never embeds — it stays the Bot Browser link in assistant mode', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={`[Agent Daily Portal](${URI})`} chatExperienceMode="assistant" />,
    );
    assert.doesNotMatch(markup, /data-inline-metaapp/);
    assert.match(markup, new RegExp(`<a[^>]*href="${URI}"`));
  });
});

test('ordinary images are untouched by the embed branch', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content="![pic](https://example.com/a.png)" chatExperienceMode="assistant" />,
    );
    assert.match(markup, /<img[^>]*src="https:\/\/example\.com\/a\.png"/);
    assert.doesNotMatch(markup, /data-inline-metaapp/);
  });
});

test('the SSR shell shows the acting Bot from context and the actor-less notice without one', () => {
  withWindowStub(() => {
    const withActor = renderToStaticMarkup(
      <InlineMetaAppActorContext.Provider value={{ actorId: 'idbots-metabot-7', name: 'Alice', globalMetaId: 'gmid-7' }}>
        <InlineMetaAppBlock uri={URI} title="Portal" />
      </InlineMetaAppActorContext.Provider>,
    );
    assert.match(withActor, /Alice/);
    assert.match(withActor, /title="gmid-7"/);
    assert.match(withActor, /Portal/);
    const withoutActor = renderToStaticMarkup(<InlineMetaAppBlock uri={URI} />);
    assert.match(withoutActor, /No Bot identity|没有可用的 Bot 身份/);
    // Without a caption the URI is the title.
    assert.match(withoutActor, new RegExp(`>${URI}<`));
  });
});

// ─── (h) source wiring pins ─────────────────────────────────────────────────

test('MarkdownContent gates the embed on assistant mode and the image renderer', () => {
  assert.match(markdownSource, /img: \(\{ node, className, src, alt, \.\.\.props \}: any\) => \{/);
  assert.match(markdownSource, /const embed = parseMetaAppEmbedUri\(src\);/);
  assert.match(markdownSource, /if \(chatExperienceMode === 'assistant'\) \{\s*return <InlineMetaAppBlock uri=\{embed\.uri\} title=\{caption\} \/>;/);
  assert.match(markdownSource, /import InlineMetaAppBlock from '\.\/cowork\/InlineMetaAppBlock';/);
});

test('the block signs through the existing Bot Browser trusted-action IPC as the session Bot', () => {
  assert.match(blockSource, /window\.electron\.botBrowser\.resolveResource\(\{ uri, actorId: actorId \|\| undefined \}\)/);
  assert.match(blockSource, /window\.electron\.botBrowser\.writeMetaIdPin\(\{\s*actorId: requireActorId\(\),\s*resourceUri: targetUri,\s*sessionId,\s*payload,/);
  assert.match(blockSource, /window\.electron\.botBrowser\.requestPermissions\(\{\s*actorId: requireActorId\(\),/);
  assert.match(blockSource, /window\.electron\.botBrowser\.completeLlm\(\{\s*actorId: requireActorId\(\),/);
  assert.match(blockSource, /window\.electron\.botBrowser\.uploadMetaFile\(\{\s*actorId: requireActorId\(\),/);
  // Two-phase: approved confirmRequest is echoed back; one renewal re-prompts.
  assert.match(blockSource, /parseInlineMetaAppConfirmation\(phaseOne, 'metaid-pin-write', resourceUri\)/);
  assert.match(blockSource, /invoke\(structured\.confirmRequest\.resourceUri, structured\.confirmRequest\.payload\)/);
  assert.match(blockSource, /renewed && renewals < 1/);
  // No actor → explicit error, never a cross-signer fallback.
  assert.match(blockSource, /if \(!current\?\.actorId\) throw new BridgeFailure\(missingActorError\(\)\);/);
  // The actor comes from the context, not from the message.
  assert.match(blockSource, /const actor = useInlineMetaAppActor\(\);/);
});

test('the block frames the app by src with ABC-equivalent sandbox and strict message origin checks', () => {
  assert.match(blockSource, /src=\{frameUrl \?\? undefined\}/);
  assert.doesNotMatch(blockSource, /srcDoc=/);
  assert.match(blockSource, /sandbox=\{sandbox\}/);
  assert.match(blockSource, /inlineMetaAppSandbox\(frameUrl, hostOrigin\)/);
  assert.match(blockSource, /parseInlineMetaAppBridgeMessage\(event\.data, event\.source, iframeWindow\)/);
  assert.match(blockSource, /if \(expectedMessageOrigin && event\.origin !== expectedMessageOrigin\) return;/);
  assert.match(blockSource, /target\.postMessage\(message, frameOrigin\);/);
  // In-app navigation hands off to the Bot Browser with the same actor.
  assert.match(blockSource, /if \(isAgentInternetNavigateUri\(parsed\.uri\)\) openInBotBrowser\(parsed\.uri, actorRef\.current\);/);
  assert.match(blockSource, /detail: \{ uri, actorId: actor\?\.actorId \|\| undefined \}/);
  assert.match(appSource, /const actorId = typeof detail\?\.actorId === 'string' && detail\.actorId\.trim\(\) \? detail\.actorId\.trim\(\) : undefined;/);
  assert.match(appSource, /botBrowserShell\.openUri\(\{ uri: uri\.trim\(\), actorId, newTab: detail\?\.newTab !== false \}\)/);
});

test('CoworkSessionDetail provides the session Bot as the embedded-app actor', () => {
  assert.match(sessionDetailSource, /import \{ InlineMetaAppActorContext \} from '\.\/InlineMetaAppActorContext';/);
  assert.match(sessionDetailSource, /import \{ buildLocalMetabotActorId \} from '\.\.\/\.\.\/features\/botBrowser\/botBrowserIntent';/);
  assert.match(sessionDetailSource, /const actorId = typeof metabotId === 'number' \? buildLocalMetabotActorId\(metabotId\) : '';/);
  assert.match(sessionDetailSource, /globalMetaId: sessionMetabot\?\.globalmetaid \|\| '',/);
  assert.match(sessionDetailSource, /<InlineMetaAppActorContext\.Provider value=\{inlineMetaAppActor\}>/);
});

test('the assistant-mode prompt and the Bot Browser tool teach the image-syntax choice', () => {
  assert.match(promptSource, /!\[app name\]\(metaapp:\/\/<pinId>\)/);
  assert.match(promptSource, /!\[应用名称\]\(metaapp:\/\/<pinId>\)/);
  assert.match(promptSource, /at most one per reply/);
  assert.match(toolsSource, /embed the app in your reply with markdown image syntax `!\[app name\]\(metaapp:\/\/<pinId>\)`/);
});
