import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotBrowserTabBridge } from '../src/main/services/botBrowserTabBridge.ts';

function createWindow() {
  const sent = [];
  const webContents = {
    isDestroyed: () => false,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  return {
    sent,
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    restore() {},
    show() {},
    focus() {},
  };
}

test('tab bridge relays a command and resolves only the target renderer response', async () => {
  const target = createWindow();
  const other = createWindow();
  const bridge = createBotBrowserTabBridge({ getWindows: () => [target], timeoutMs: 100 });
  const promise = bridge.execute({ action: 'get-active-tab' });
  const request = target.sent[0];

  assert.equal(request.channel, 'botBrowser:tab-command');
  assert.deepEqual(request.payload.command, { action: 'get-active-tab' });

  bridge.handleResponse(other.webContents, {
    requestId: request.payload.requestId,
    success: true,
    result: { action: 'get-active-tab', tabs: [], activeTab: null },
  });
  bridge.handleResponse(target.webContents, {
    requestId: request.payload.requestId,
    success: true,
    result: {
      action: 'get-active-tab',
      tabs: [{ id: 3, uri: 'metaid://idq1alice', title: 'Alice', isActive: true }],
      activeTab: { id: 3, uri: 'metaid://idq1alice', title: 'Alice', isActive: true },
    },
  });

  const result = await promise;
  assert.equal(result.activeTab?.uri, 'metaid://idq1alice');
  bridge.dispose();
});

test('tab bridge rejects commands when no renderer window is available', async () => {
  const bridge = createBotBrowserTabBridge({ getWindows: () => [] });
  await assert.rejects(
    bridge.execute({ action: 'get-tabs' }),
    /No IDBots window is available/,
  );
  bridge.dispose();
});
