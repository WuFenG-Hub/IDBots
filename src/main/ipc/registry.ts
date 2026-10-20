import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

/**
 * Synthetic event passed to handlers when an invoke arrives over the mobile
 * gateway instead of a renderer. Shape is frozen by REQ-A-13: handlers may
 * rely on `sender`/`senderFrame` being null and on `gateway.clientId`.
 */
export interface GatewayInvokeContext {
  clientId: string;
}

export interface SyntheticGatewayInvokeEvent {
  sender: null;
  senderFrame: null;
  gateway: GatewayInvokeContext;
}

export type RegisteredIpcHandler = (
  event: IpcMainInvokeEvent | SyntheticGatewayInvokeEvent,
  ...args: any[]
) => any;

const handlers = new Map<string, RegisteredIpcHandler>();

/**
 * Single registration point for every invoke channel in the main process.
 * Desktop behavior is identical to calling `ipcMain.handle` directly; the
 * handler is additionally recorded so the gateway can dispatch to it without
 * a renderer (REQ-A-12).
 */
export function registerIpcHandler(channel: string, handler: RegisteredIpcHandler): void {
  ipcMain.handle(channel, handler);
  handlers.set(channel, handler);
}

export function getRegisteredIpcHandler(channel: string): RegisteredIpcHandler | undefined {
  return handlers.get(channel);
}

export function hasRegisteredIpcHandler(channel: string): boolean {
  return handlers.has(channel);
}

export function listRegisteredIpcChannels(): string[] {
  return [...handlers.keys()];
}

/**
 * Invoke a registered handler from the gateway with a synthetic event.
 * The return value is whatever the handler returns (already a promise of the
 * IPC result, as with a real renderer invoke).
 */
export async function invokeRegisteredHandler(
  channel: string,
  clientId: string,
  args: unknown[],
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No IPC handler registered for channel: ${channel}`);
  }
  const event: SyntheticGatewayInvokeEvent = {
    sender: null,
    senderFrame: null,
    gateway: { clientId },
  };
  return handler(event, ...args);
}
