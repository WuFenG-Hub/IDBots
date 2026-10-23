/**
 * Mobile app entry (REQ-E-1). `./installBridgeFirst` must stay the first
 * import: it installs the mock bridge before any app module evaluates.
 */

import './installBridgeFirst';
import { mountMobileApp } from './bootstrap';

mountMobileApp();
