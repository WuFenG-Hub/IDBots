import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Per-probe budget for one `git` invocation. The renderer polls the branch
 * every 3s, so a probe must never outlive the poll interval: a hung git call
 * (network drive, antivirus hook) would otherwise pile up overlapping
 * probes faster than they settle.
 */
const GIT_PROBE_TIMEOUT_MS = 2000;

/**
 * Best-effort current git branch for a workspace directory.
 *
 * Returns the branch name (e.g. "master") when the directory lives inside a
 * git repository, or null when it does not (or git is unavailable / the call
 * fails for any reason). Detection never throws — a missing repo is a normal,
 * non-error state for arbitrary working directories.
 */
export async function getGitBranch(cwd: string | null | undefined): Promise<string | null> {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (!trimmed) return null;
  try {
    // `--show-current` is empty for detached HEAD; fall back to `symbolic-ref`
    // so a detached checkout at least surfaces the raw ref rather than nothing.
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: trimmed,
      timeout: GIT_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    return null;
  }
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: trimmed,
      timeout: GIT_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}
