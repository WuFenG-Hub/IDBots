/**
 * Optional base URL of an externally-run indexer. The bundled man-p2p runtime
 * was removed; reads go straight to the remote indexer unless this override
 * points at a self-hosted indexer.
 */
export const P2P_LOCAL_BASE_ENV = 'IDBOTS_MAN_P2P_LOCAL_BASE';

export function getConfiguredP2PLocalBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[P2P_LOCAL_BASE_ENV]?.trim();
  if (!override) {
    return null;
  }
  return override.replace(/\/+$/, '');
}
