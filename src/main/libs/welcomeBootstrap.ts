/**
 * Welcome Bot onboarding guide (Bootstrap.md) plumbing.
 *
 * The Welcome Bot answers new-user questions and drives the "create your first
 * Twin Bot" onboarding flow. Its product knowledge lives in a Markdown guide
 * shipped read-only inside the app bundle; a writable per-user copy is seeded
 * into userData so the guide can be removed again once onboarding completes
 * (the Welcome Bot retires). Keeping the writable copy in userData also means
 * the guide survives app updates and is never touched across restarts until
 * the Welcome Bot is actually deleted.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const BOOTSTRAP_DOC_NAME = 'Bootstrap.md';

/** Read-only canonical copy bundled next to AGENT_SYSTEM_PROMPT.md. */
function bundledBootstrapPath(): string {
  return path.join(app.getAppPath(), 'sandbox', 'agent-runner', BOOTSTRAP_DOC_NAME);
}

/** Writable per-user copy; removed when the Welcome Bot retires. */
export function runtimeBootstrapPath(): string {
  return path.join(app.getPath('userData'), BOOTSTRAP_DOC_NAME);
}

/**
 * Read the Welcome Bot onboarding guide, seeding the writable userData copy
 * from the bundled canonical file on first use. Returns '' when no guide is
 * available (e.g. bundled file missing) so callers can drop the section.
 */
export function readBootstrapDoc(): string {
  const target = runtimeBootstrapPath();
  if (!fs.existsSync(target)) {
    const source = bundledBootstrapPath();
    try {
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, target);
      }
    } catch (error) {
      console.warn('[welcome-bootstrap] failed to seed Bootstrap.md:', error);
    }
  }

  if (fs.existsSync(target)) {
    try {
      return fs.readFileSync(target, 'utf-8');
    } catch (error) {
      console.warn('[welcome-bootstrap] failed to read Bootstrap.md from userData:', error);
    }
  }

  // Fall back to the bundled copy if the userData copy could not be seeded.
  try {
    const source = bundledBootstrapPath();
    return fs.existsSync(source) ? fs.readFileSync(source, 'utf-8') : '';
  } catch {
    return '';
  }
}

/** Remove the per-user guide once the Welcome Bot has retired. */
export function deleteBootstrapDoc(): void {
  const target = runtimeBootstrapPath();
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  } catch (error) {
    console.warn('[welcome-bootstrap] failed to delete Bootstrap.md:', error);
  }
}
