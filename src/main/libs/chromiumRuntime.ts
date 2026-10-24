import fs from 'fs';

export type SystemChromiumResolution = { executablePath: string } | Record<string, never>;

type ResolveSystemChromiumOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (candidate: string) => boolean;
};

export function resolveSystemChromium(options: ResolveSystemChromiumOptions = {}): SystemChromiumResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const candidates = platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : platform === 'win32'
      ? [env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe', env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const hit = candidates.find((candidate) => candidate && existsSync(candidate));
  return hit ? { executablePath: hit } : {};
}

let systemChromiumCache: SystemChromiumResolution | null = null;

// App-bundle probes are TCC-visible on macOS. Cache the result so every
// session setup does not repeat the same privacy prompt.
export function detectSystemChromium(): SystemChromiumResolution {
  if (systemChromiumCache) return systemChromiumCache;
  systemChromiumCache = resolveSystemChromium();
  return systemChromiumCache;
}
