import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export const SKILLS_DIR_NAME = 'SKILLs';

export type WritableSkillsRootInput = {
  env?: NodeJS.ProcessEnv;
  userDataPath?: string;
};

export type BundledSkillsRootInput = {
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
};

/**
 * Writable skill install directory. Always the IDBots user-data SKILLs folder
 * (the same place a packaged app uses), even when running `electron:dev`.
 * Source-tree SKILLs/ stays the bundled/read-only set so test installs do not
 * pollute the repo. IDBOTS_SKILLS_ROOT / SKILLS_ROOT still override for tests.
 */
export function resolveWritableSkillsRoot(input?: WritableSkillsRootInput): string {
  const env = input?.env ?? process.env;
  const override = env.IDBOTS_SKILLS_ROOT?.trim() || env.SKILLS_ROOT?.trim();
  if (override) {
    return path.resolve(override);
  }
  const userDataPath = input?.userDataPath ?? app.getPath('userData');
  return path.resolve(userDataPath, SKILLS_DIR_NAME);
}

/**
 * Bundled/shipped skills: Resources/SKILLs in a packaged app, project SKILLs/
 * in development. Never used as the install target.
 */
export function resolveBundledSkillsRoot(input?: BundledSkillsRootInput): string {
  const isPackaged = input?.isPackaged ?? app.isPackaged;
  const resourcesPath = input?.resourcesPath ?? process.resourcesPath;
  const appPath = input?.appPath ?? app.getAppPath();
  if (isPackaged) {
    const resourcesRoot = path.resolve(resourcesPath, SKILLS_DIR_NAME);
    if (fs.existsSync(resourcesRoot)) {
      return resourcesRoot;
    }
    return path.resolve(appPath, SKILLS_DIR_NAME);
  }
  return path.resolve(appPath, SKILLS_DIR_NAME);
}
