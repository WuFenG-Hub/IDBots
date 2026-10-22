/**
 * Side-effect module that installs the mock bridge before any other app
 * module evaluates. `src/mobile/app/main.tsx` imports this file FIRST;
 * ES modules evaluate imports in source order, so by the time bootstrap.tsx
 * (and anything it imports) runs, `window.electron` already exists. T2 will
 * pull in desktop renderer services that assume exactly this ordering.
 */

import { installMockBridge } from '../bridge/installMockBridge';
import { setAppBridge } from './appBridge';

// No mock and no real bridge (T3) must never crash the bundle: the app
// renders a "not connected" screen instead (MobileApp checks hasAppBridge).
setAppBridge(installMockBridge());
