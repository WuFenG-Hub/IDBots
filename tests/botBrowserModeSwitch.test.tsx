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
      isBrowserVisible={false}
      onSelectHome={() => {}}
      onSelectBrowser={() => {}}
    />,
  );
}

test('BotBrowserModeSwitch renders a taller centered segmented toggle bar', () => {
  const markup = renderSwitch('home');

  assert.match(
    markup,
    /data-slot="bot-browser-mode-bar"[^>]*class="[^"]*\brelative\b[^"]*\bh-11\b[^"]*\bjustify-center\b/,
  );
  assert.match(
    markup,
    /data-slot="bot-browser-mode-segments"[^>]*class="[^"]*\brounded-full\b[^"]*\bshadow-sm\b/,
  );
});

test('BotBrowserModeSwitch exposes pressed state with the IDBots filled primary style', () => {
  const markup = renderSwitch('browser');

  assert.match(markup, />Bot Home<\/button>/);
  assert.match(markup, />Bot Browser<\/button>/);
  assert.match(markup, /aria-pressed="false"[^>]*>Bot Home<\/button>/);
  assert.match(markup, /aria-pressed="true"[^>]*class="[^"]*\bbtn-idchat-primary-filled\b[^"]*\bstill\b[^"]*"[^>]*>Bot Browser<\/button>/);
  assert.doesNotMatch(markup, /aria-pressed="true"[^>]*class="[^"]*\bbg-claude-accentMuted\b[^"]*"[^>]*>Bot Browser<\/button>/);
});
