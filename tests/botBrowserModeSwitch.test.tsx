import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BotBrowserModeSwitch from '../src/renderer/features/botBrowser/BotBrowserModeSwitch';
import type { BotBrowserSurfaceMode } from '../src/renderer/features/botBrowser/types';

function renderSwitch(mode: BotBrowserSurfaceMode) {
  return renderToStaticMarkup(
    <BotBrowserModeSwitch
      mode={mode}
      onSelectHome={() => {}}
      onSelectBrowser={() => {}}
    />,
  );
}

test('BotBrowserModeSwitch renders a full-width sidebar segmented control', () => {
  const markup = renderSwitch('home');

  assert.match(
    markup,
    /data-slot="bot-browser-mode-bar"[^>]*class="[^"]*\bw-full\b/,
  );
  assert.match(
    markup,
    /data-slot="bot-browser-mode-segments"[^>]*class="[^"]*\bgrid\b[^"]*\bgrid-cols-2\b[^"]*\brounded-lg\b/,
  );
  assert.ok(markup.indexOf('Bot Browser') < markup.indexOf('Bot Home'));
});

test('BotBrowserModeSwitch exposes pressed state with the IDBots filled primary style', () => {
  const markup = renderSwitch('browser');

  assert.match(markup, />Bot Browser<\/button>/);
  assert.match(markup, /aria-pressed="true"[^>]*class="[^"]*\bbtn-idchat-primary-filled\b[^"]*\bstill\b[^"]*"[^>]*>Bot Browser<\/button>/);
  assert.match(markup, /aria-pressed="false"[^>]*>Bot Home<\/button>/);
  assert.doesNotMatch(markup, /aria-pressed="true"[^>]*class="[^"]*\bbg-claude-accentMuted\b[^"]*"[^>]*>Bot Browser<\/button>/);
});
