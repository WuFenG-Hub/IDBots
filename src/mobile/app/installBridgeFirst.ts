/**
 * Side-effect module that installs a bridge before any other app module
 * evaluates. `src/mobile/app/main.tsx` imports this file FIRST; ES modules
 * evaluate imports in source order, so by the time bootstrap.tsx (and
 * anything it imports) runs, `window.electron` already exists.
 *
 * VITE_MOBILE_MOCK=1 keeps the mock bridge (REQ-E-8) as the dev default;
 * otherwise the real gateway client + contract shim (REQ-E-2/REQ-E-3) is
 * installed against ws(s)://{host}/ws. Either way setAppBridge records the
 * facade screens read through.
 */

import { installMockBridge } from '../bridge/installMockBridge';
import { setAppBridge } from './appBridge';
import { installRealBridge } from './realBridge';

if (import.meta.env.VITE_MOBILE_MOCK === '1') {
  const mock = installMockBridge();
  if (mock) {
    setAppBridge({ electron: mock.electron, connection: mock.connection, mock: mock.control });
  }
} else {
  // A WS that refuses immediately is not detectable synchronously: the
  // client enters 'connecting' and its state listeners drive the UI (banner,
  // terminal screens). BridgeUnavailable remains only for "shim not
  // installed", which this path never hits.
  setAppBridge(installRealBridge());
}
