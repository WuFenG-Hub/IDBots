import type { IdbotsMobileInfo } from '../bridge/types';

export function isRechargeAllowed(facts: Pick<IdbotsMobileInfo, 'os' | 'shell'> | null | undefined): boolean {
  return !(facts?.shell === 'capacitor' && facts.os === 'ios');
}
