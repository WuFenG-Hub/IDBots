import path from 'path';

/**
 * Owner-approval gate for on-chain file uploads from chain-write tools
 * (post_buzz / post_simplenote). Uploading a file publishes it permanently
 * and publicly, so local paths OUTSIDE the session workspace require an
 * explicit owner confirmation before they ever leave the machine. Files
 * inside the workspace (the bot's own working directory) upload freely —
 * that is the tool's normal job. metafile:// URIs are already on-chain and
 * are never gated.
 *
 * The gate is ACTIVE only when the host provides both the workspace
 * resolver and the confirmation callback (coworkRunner does). Hosts that
 * provide neither keep the legacy ungated behavior — embedders should
 * provide both.
 */

/** True when filePath resolves inside dir (or equals it). Both OS-aware. */
export function isPathInsideDir(filePath: string, dir: string): boolean {
  if (!filePath || !dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Local absolute paths that lie outside the session workspace, if known. */
export function externalUploadPaths(localPaths: string[], workspaceDir: string | undefined): string[] {
  const absolute = localPaths.filter((p) => path.isAbsolute(p));
  if (!workspaceDir) return absolute;
  return absolute.filter((p) => !isPathInsideDir(p, workspaceDir));
}

export type UploadGateDeps = {
  /** Resolves the session workspace dir; undefined when the session has none. */
  getWorkspaceDir?: () => string | undefined;
  /** Asks the owner to approve publishing the listed files. True = approved. */
  confirmExternalUpload?: (files: string[]) => Promise<boolean>;
};

/**
 * Enforce the gate for one tool call: when any local file lies outside the
 * workspace (or the workspace is unknown), ask the owner once with the full
 * file list. Returns approved=false when the owner declined or when gating
 * is active but no confirmation channel exists.
 */
export async function guardExternalUploads(
  localPaths: string[],
  deps: UploadGateDeps
): Promise<{ approved: boolean; external: string[] }> {
  if (!deps.getWorkspaceDir || !deps.confirmExternalUpload) return { approved: true, external: [] };
  const workspaceDir = deps.getWorkspaceDir();
  const external = externalUploadPaths(localPaths, workspaceDir);
  if (!external.length) return { approved: true, external: [] };
  const approved = await deps.confirmExternalUpload(external);
  return { approved, external };
}
