/**
 * `gateway:file:sign` channel (REQ-A-24, C2 "File Download").
 *
 * Thin adapter from the IPC/gateway invoke shape to the pure fileSign core:
 * resolves the running gateway's context through an injected getter (the
 * wiring owns that state), returns the signed download descriptor on success,
 * and a structured `{ success: false, ... }` envelope — never a throw — when
 * the gateway is not running or the path fails confinement.
 *
 * Pure module: node:fs plus sibling gateway modules only; the context getter
 * is injected so plain-node tests can drive the handler without electron.
 */

import * as fs from 'node:fs';
import { signFileDownload, isSignedFileDownload } from './fileSign';
import type { ActiveGatewayContext } from './wiring';

export type GatewayContextGetter = () => ActiveGatewayContext | null;

export interface GatewayFileSignInput {
  path?: unknown;
  disposition?: unknown;
}

/**
 * Build the `gateway:file:sign` handler around a context getter. The handler
 * takes the standard `(event, input)` IPC shape and returns `{ url,
 * expiresAt, size, mime }` on success; `{ success: false, error }` when the
 * gateway is not running; or the GatewayError fields (`{ success: false,
 * error, code, retryable }`) for confinement/arg failures, so gateway clients
 * can map `code` onto C2 error codes.
 */
export function createGatewayFileSignHandler(getContext: GatewayContextGetter) {
  return async (_event: unknown, input: GatewayFileSignInput) => {
    const context = getContext();
    if (!context) {
      return { success: false, error: 'gateway not running' };
    }
    const result = signFileDownload(
      {
        secret: context.secret,
        tenantId: context.tenantId,
        paths: context.paths,
        realpathSync: fs.realpathSync,
      },
      {
        path: typeof input?.path === 'string' ? input.path : '',
        disposition: input?.disposition === 'inline' ? 'inline' : 'attachment',
      },
    );
    if (isSignedFileDownload(result)) {
      return result;
    }
    return { success: false, error: result.message, code: result.code, retryable: result.retryable };
  };
}
