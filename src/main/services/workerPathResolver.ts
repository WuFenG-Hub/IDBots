import path from 'path';

interface MainWorkerPathInput {
  moduleDir: string;
  appPath: string;
  workerBasename: string;
}

interface ResolveMainWorkerPathInput extends MainWorkerPathInput {
  exists: (candidate: string) => boolean;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

export function getMainWorkerCandidatePaths({
  moduleDir,
  appPath,
  workerBasename,
}: MainWorkerPathInput): string[] {
  return uniquePaths([
    path.join(moduleDir, '..', 'libs', workerBasename),
    path.join(moduleDir, 'main', 'libs', workerBasename),
    path.join(moduleDir, 'libs', workerBasename),
    path.join(appPath, 'dist-electron', 'main', 'libs', workerBasename),
    path.join(appPath, 'dist-electron', 'libs', workerBasename),
    path.join(appPath, 'libs', workerBasename),
  ]);
}

export function resolveMainWorkerPath({
  moduleDir,
  appPath,
  workerBasename,
  exists,
}: ResolveMainWorkerPathInput): string | null {
  return getMainWorkerCandidatePaths({ moduleDir, appPath, workerBasename }).find((entry) => exists(entry)) ?? null;
}
