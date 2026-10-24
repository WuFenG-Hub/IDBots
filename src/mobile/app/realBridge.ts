import { GatewayClient } from '../bridge/gatewayClient';
import { installShim } from '../bridge/installShim';
import { uploadFile } from '../bridge/upload';
import type { MockElectronAPI } from '../bridge/types';
import type { AppBridge } from './appBridge';
import { toBannerState, toTerminalState } from './appBridge';

/**
 * Real mobile bridge (REQ-E-3 wiring): the C2 gateway client over
 * `ws(s)://{host}/ws` — the tenant serves the app bundle and the gateway on
 * the same origin, and the dev proxy (REQ-E-9) forwards /ws to
 * 127.0.0.1:8790/gateway/v1/ws with the secret header.
 *
 * `installShim` builds `window.electron` from the generated IPC contract on
 * top of the client (S-tier channels answered locally, everything else
 * invoked over the socket), and the returned facade adapts the client's
 * state union onto the banner's five ConnectionStates with the terminal
 * states exposed separately for the shell's dedicated screens.
 */

function gatewayUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws`;
}

export function installRealBridge(): AppBridge {
  const client = new GatewayClient({ url: gatewayUrl(), logger: console });
  installShim({ gateway: client, uploadFile });
  return {
    electron: window.electron as unknown as MockElectronAPI,
    connection: {
      getState: () => toBannerState(client.getState()),
      onChange: (callback) => client.onStateChange((state) => callback(toBannerState(state))),
    },
    gateway: {
      getTerminalState: () => toTerminalState(client.getState()),
      onTerminalChange: (callback) => client.onStateChange((state) => callback(toTerminalState(state))),
      getVersionMismatch: () => client.getVersionMismatch(),
      onReconnected: (callback) => client.onReconnected(() => callback()),
      reconnectNow: () => client.reconnectNow(),
      close: () => client.close(),
    },
  };
}
