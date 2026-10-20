/**
 * Side-effect module that installs the mock bridge before any other app
 * module evaluates. `src/mobile/app/main.tsx` imports this file FIRST;
 * ES modules evaluate imports in source order, so by the time bootstrap.tsx
 * (and anything it imports) runs, `window.electron` already exists. T2 will
 * pull in desktop renderer services that assume exactly this ordering.
 */

import { installMockBridge } from '../bridge/installMockBridge';
import { setAppBridge } from './appBridge';

const bridge = installMockBridge();
if (!bridge) {
  throw new Error(
    'VITE_MOBILE_MOCK is not set to 1; the mobile demo only runs against the mock bridge (T1).',
  );
}
setAppBridge(bridge);
