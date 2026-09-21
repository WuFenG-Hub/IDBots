export const DISABLE_SINGLE_INSTANCE_LOCK_ENV = 'IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK';
export const ALLOW_SHARED_USER_DATA_ENV = 'IDBOTS_ALLOW_SHARED_USERDATA';

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function shouldAcquireSingleInstanceLock(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isTruthy(env[DISABLE_SINGLE_INSTANCE_LOCK_ENV]);
}

/**
 * Lock-disabled + non-isolated userData is a two-instance hazard: both
 * instances run the same bot identity and daemons over one data directory,
 * colliding on the DSH session write locks (every turn for a session owned
 * by the other instance fails with 'session "…" is already owned by an
 * active write handle') and resetting each other's in-flight worker attempts
 * during startup recovery. Refuse to boot unless the operator explicitly
 * opts into the unsafe mode.
 */
export function shouldRefuseSharedUserData(env: NodeJS.ProcessEnv = process.env): boolean {
  if (shouldAcquireSingleInstanceLock(env)) {
    return false;
  }
  // Either override isolates this instance's userData: resolveRuntimeDataPaths
  // derives userData from the app-data override when no explicit one is set.
  if (env.IDBOTS_USER_DATA_PATH?.trim() || env.IDBOTS_APP_DATA_PATH?.trim()) {
    return false;
  }
  return !isTruthy(env[ALLOW_SHARED_USER_DATA_ENV]);
}
