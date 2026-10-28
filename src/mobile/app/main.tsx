/**
 * Mobile app entry (REQ-E-1). Native bootstrap is validated first, then the
 * C2/mock bridge is installed before any other app module evaluates.
 */

import '../native/installNativeBootstrapFirst';
import './installBridgeFirst';
import { mountMobileApp } from './bootstrap';

void mountMobileApp();
