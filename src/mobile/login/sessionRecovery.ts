import type { GetMeResult } from './loginApi';

export type SessionRecoveryAction = 'open-app' | 'preparing' | 'login' | 'retry';

export async function probeSessionRecovery(readMe: () => Promise<GetMeResult>): Promise<SessionRecoveryAction> {
  try {
    const me = await readMe();
    return me.tenant.status === 'ready' || me.tenant.status === 'degraded' ? 'open-app' : 'preparing';
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'UNAUTHORIZED' ? 'login' : 'retry';
  }
}
