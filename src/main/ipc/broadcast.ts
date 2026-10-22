import { BrowserWindow } from 'electron';

/**
 * Extra sinks for broadcast events. The desktop renderer fan-out below never
 * changes; the gateway (server mode / desktop dev mode) subscribes here to
 * forward allowlisted events to connected mobile clients (REQ-A-14).
 */
export type BroadcastListener = (channel: string, args: unknown[]) => void;

const listeners = new Set<BroadcastListener>();

export function addBroadcastListener(listener: BroadcastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Send an event to every live renderer window (desktop behavior, unchanged)
 * and to every registered broadcast listener (the gateway, when active).
 *
 * Sends addressed to one specific window (for example the Bot Browser
 * bridges) intentionally do NOT go through this helper and stay desktop-only.
 */
export function broadcastToRenderers(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, ...args);
    } catch (error) {
      console.error(`Failed to broadcast "${channel}" to a window:`, error);
    }
  }
  for (const listener of listeners) {
    try {
      listener(channel, args);
    } catch (error) {
      console.error(`Failed to forward "${channel}" to a broadcast listener:`, error);
    }
  }
}
