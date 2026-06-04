import path from 'path';

interface ResolveMetaFileUploadSharedModulePathInput {
  moduleDir: string;
  appPath: string;
  exists: (candidate: string) => boolean;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

export function getMetaFileUploadSharedCandidatePaths({
  moduleDir,
  appPath,
}: Pick<ResolveMetaFileUploadSharedModulePathInput, 'moduleDir' | 'appPath'>): string[] {
  return uniquePaths([
    path.join(moduleDir, 'metaFileUploadShared.js'),
    path.join(moduleDir, 'services', 'metaFileUploadShared.js'),
    path.join(moduleDir, 'main', 'services', 'metaFileUploadShared.js'),
    path.join(appPath, 'dist-electron', 'main', 'services', 'metaFileUploadShared.js'),
    path.join(appPath, 'dist-electron', 'services', 'metaFileUploadShared.js'),
    path.join(appPath, 'services', 'metaFileUploadShared.js'),
  ]);
}

export function resolveMetaFileUploadSharedModulePath({
  moduleDir,
  appPath,
  exists,
}: ResolveMetaFileUploadSharedModulePathInput): string | null {
  return getMetaFileUploadSharedCandidatePaths({ moduleDir, appPath }).find((entry) => exists(entry)) ?? null;
}
