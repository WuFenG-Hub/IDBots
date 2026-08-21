/**
 * Windows PATH helpers for child-process env maps.
 *
 * `{ ...process.env, PATH: injected }` on Windows often keeps the inherited
 * `Path` key alongside the new `PATH`. Node spawn lookup is then undefined,
 * so a packaged Git bash sitting on the injected PATH never wins.
 */

function isPathKey(key: string): boolean {
  return key.toUpperCase() === 'PATH';
}

/** Read PATH regardless of whether the object stored `PATH` or `Path`. */
export function pathValueOf(env: Record<string, string | undefined>): string | undefined {
  if (typeof env.PATH === 'string' && env.PATH.length > 0) return env.PATH;
  if (typeof env.Path === 'string' && env.Path.length > 0) return env.Path;
  for (const [key, value] of Object.entries(env)) {
    if (isPathKey(key) && typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Drop every PATH/Path casing, then write a single `PATH`. */
export function assignPathValue(
  env: Record<string, string | undefined>,
  value: string | undefined,
): void {
  for (const key of Object.keys(env)) {
    if (isPathKey(key)) delete env[key];
  }
  if (value !== undefined) env.PATH = value;
}

/**
 * After spreading `process.env` on Windows, keep one `PATH` so spawn/`bash`
 * lookup sees the injected mingit dirs. Later PATH-like keys win (the
 * injected value, not the Start-menu system Path).
 */
export function collapseWindowsPathKeys(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  if (platform !== 'win32') return env;
  let value: string | undefined;
  for (const key of Object.keys(env)) {
    if (!isPathKey(key)) continue;
    const current = env[key];
    if (typeof current === 'string' && current.length > 0) value = current;
  }
  assignPathValue(env, value);
  return env;
}

/** Env handed to the DSH runtime subprocess (Electron-as-Node + host overrides). */
export function mergeDshRuntimeProcessEnv(parts: {
  parentEnv?: NodeJS.ProcessEnv
  configEnv?: Record<string, string>
  platform?: NodeJS.Platform
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...(parts.parentEnv ?? process.env),
    ELECTRON_RUN_AS_NODE: '1',
    ...(parts.configEnv ?? {}),
  };
  collapseWindowsPathKeys(env, parts.platform ?? process.platform);
  return env;
}
