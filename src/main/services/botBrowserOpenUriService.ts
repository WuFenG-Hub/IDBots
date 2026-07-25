/**
 * Shared helper to deliver a Bot Browser open-uri request to all live renderer
 * windows and focus the first one. Used by the MetaID RPC server and by the
 * cowork Agent's bot_browser_* tools.
 */

import { BrowserWindow } from 'electron';

export type BotBrowserOpenUriInput = {
  uri: string;
  actorId?: string | null;
};

export function sendBotBrowserOpenUri(input: BotBrowserOpenUriInput): void {
  const windows = BrowserWindow.getAllWindows();
  let delivered = 0;

  for (const win of windows) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed()) continue;
    win.webContents.send('botBrowser:openUri', input);
    delivered += 1;
  }

  const firstWindow = windows.find((win) => !win.isDestroyed());
  if (firstWindow) {
    if (firstWindow.isMinimized()) firstWindow.restore();
    if (!firstWindow.isVisible()) firstWindow.show();
    firstWindow.focus();
  }

  if (delivered === 0) {
    throw new Error('No IDBots window is available to open Bot Browser');
  }
}
