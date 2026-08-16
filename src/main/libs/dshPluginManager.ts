// User-managed DSH plugin directory: install official @deepseek-ai packages
// into <userData>/dsh-plugins and expose them as runtime composition entries.
//
// Mechanism (validated end-to-end against the rc.6 runtime):
//  - `npm install <pkg> --legacy-peer-deps` into the plugin dir — legacy mode
//    because the official 0.0.1-rc plugin packages peer on 0.0.1-rc core
//    ranges that don't cover the 0.1.0-rc.6 runtime, and we do NOT want npm
//    nesting its own copies of cordis/dsh-* (a second cordis instance breaks
//    the single-context contract).
//  - Peer symlinks: every peerDependency of an installed package is symlinked
//    from <plugins>/node_modules/<peer> to the RUNTIME's node_modules copy, so
//    the external package's imports resolve against the same instances the
//    runtime itself uses (the classic extension-host pattern).
//  - Composition entries reference the package ENTRY FILE (a bare package
//    directory cannot be imported as an ES module — ERR_UNSUPPORTED_DIR_IMPORT).
//
// The registry (registry.json) lives NEXT to the installed packages rather
// than in app_config: the directory is the source of truth, so a manually
// populated dir (no npm available — e.g. a packaged app) still works; the
// registry only records how/when the app itself installed things.
//
// Windows note: symlinks need elevated privileges there — plugin installs are
// darwin/linux for now (the Windows P2 item tracks the gap).

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface DshPluginRegistryEntry {
  version: string;
  installedAt: number;
}

export interface DshPluginRegistry {
  plugins: Record<string, DshPluginRegistryEntry>;
}

export interface DshPluginEntry {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

const SCOPED = /^@[^/]+\/[^/]+$/;

export function dshPluginsDirFor(userDataPath: string): string {
  return path.join(userDataPath, 'dsh-plugins');
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Composition entries for every installed @deepseek-ai package under the
 * plugin dir: { id: 'plugin-<name>', name: <entry file>, config: {} }.
 * Packages missing a readable package.json or entry file are skipped (a
 * partially copied dir must not fail the runtime boot).
 */
export function resolveDshPluginEntries(pluginsDir: string): DshPluginEntry[] {
  const scoped = path.join(pluginsDir, 'node_modules', '@deepseek-ai');
  let packages: string[] = [];
  try {
    packages = fs.readdirSync(scoped).filter((name) => {
      const pkgJson = path.join(scoped, name, 'package.json');
      return fs.existsSync(pkgJson);
    });
  } catch {
    return [];
  }
  const entries: DshPluginEntry[] = [];
  for (const name of packages) {
    const pkgDir = path.join(scoped, name);
    const pkg = readJson(path.join(pkgDir, 'package.json'));
    const main = typeof pkg?.main === 'string' ? pkg.main : 'lib/index.js';
    const entryFile = path.join(pkgDir, main);
    if (!fs.existsSync(entryFile)) continue;
    entries.push({
      id: `plugin-${name}`,
      name: entryFile,
      config: {},
    });
  }
  return entries;
}

/**
 * Symlink every peerDependency of the installed packages to the runtime's
 * copy, unless something already occupies the slot (a real dependency of the
 * plugin, or a previous symlink). Returns the linked peer names.
 */
export function linkDshPluginPeers(pluginsDir: string, runtimeNodeModules: string): string[] {
  const localNodeModules = path.join(pluginsDir, 'node_modules');
  const linked: string[] = [];
  let packages: string[] = [];
  try {
    packages = fs.readdirSync(path.join(localNodeModules, '@deepseek-ai'));
  } catch {
    return linked;
  }
  const peers = new Set<string>();
  for (const name of packages) {
    const pkg = readJson(path.join(localNodeModules, '@deepseek-ai', name, 'package.json'));
    const peerDeps = pkg?.peerDependencies;
    if (peerDeps && typeof peerDeps === 'object') {
      for (const peer of Object.keys(peerDeps as Record<string, string>)) peers.add(peer);
    }
  }
  for (const peer of peers) {
    const runtimeCopy = path.join(runtimeNodeModules, ...peer.split('/'));
    if (!fs.existsSync(runtimeCopy)) continue;
    const localSlot = path.join(localNodeModules, ...peer.split('/'));
    if (fs.existsSync(localSlot) || fs.existsSync(`${localSlot}.broken`)) continue;
    fs.mkdirSync(path.dirname(localSlot), { recursive: true });
    try {
      fs.symlinkSync(runtimeCopy, localSlot, 'junction');
      linked.push(peer);
    } catch {
      // Symlink unavailable (e.g. Windows without privileges): the package's
      // own dependency resolution may still find nothing — surfaces as a boot
      // error naming the missing module, not a silent wrong copy.
    }
  }
  return linked;
}

export function readDshPluginRegistry(pluginsDir: string): DshPluginRegistry {
  const raw = readJson(path.join(pluginsDir, 'registry.json'));
  const plugins = raw?.plugins;
  if (plugins && typeof plugins === 'object') {
    const clean: Record<string, DshPluginRegistryEntry> = {};
    for (const [name, value] of Object.entries(plugins as Record<string, unknown>)) {
      if (value && typeof value === 'object' && typeof (value as any).version === 'string') {
        clean[name] = {
          version: (value as any).version,
          installedAt: typeof (value as any).installedAt === 'number' ? (value as any).installedAt : Date.now(),
        };
      }
    }
    return { plugins: clean };
  }
  return { plugins: {} };
}

function writeDshPluginRegistry(pluginsDir: string, registry: DshPluginRegistry): void {
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'registry.json'), JSON.stringify(registry, null, 2));
}

/**
 * Install one official package into the plugin dir. Uses the system npm
 * (dev-grade surface: a packaged app has no bundled node — a manually
 * populated directory works regardless, see resolveDshPluginEntries).
 */
export async function installDshPlugin(
  pluginsDir: string,
  runtimeNodeModules: string,
  pkg: string,
  version?: string
): Promise<{ registry: DshPluginRegistry; linkedPeers: string[] }> {
  if (!pkg.startsWith('@deepseek-ai/') || !SCOPED.test(pkg)) {
    throw new Error(`dsh plugin installs accept @deepseek-ai scoped packages only, got ${JSON.stringify(pkg)}`);
  }
  fs.mkdirSync(pluginsDir, { recursive: true });
  const manifest = path.join(pluginsDir, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({ name: 'idbots-dsh-plugins', private: true, version: '0.0.1' }, null, 2));
  }
  const spec = version ? `${pkg}@${version}` : `${pkg}@latest`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['install', spec, '--legacy-peer-deps', '--no-audit', '--no-fund'], {
      cwd: pluginsDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install ${spec} failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
  const linkedPeers = linkDshPluginPeers(pluginsDir, runtimeNodeModules);
  const registry = readDshPluginRegistry(pluginsDir);
  const installed = readJson(path.join(pluginsDir, 'node_modules', pkg, 'package.json'));
  registry.plugins[pkg] = {
    version: typeof installed?.version === 'string' ? installed.version : version ?? 'unknown',
    installedAt: Date.now(),
  };
  writeDshPluginRegistry(pluginsDir, registry);
  return { registry, linkedPeers };
}

/** Remove a package (npm uninstall) and drop its registry row. */
export async function uninstallDshPlugin(
  pluginsDir: string,
  pkg: string
): Promise<DshPluginRegistry> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['uninstall', pkg, '--legacy-peer-deps', '--no-audit', '--no-fund'], {
      cwd: pluginsDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm uninstall ${pkg} failed (exit ${code}): ${stderr.slice(-500)}`));
    });
  });
  const registry = readDshPluginRegistry(pluginsDir);
  delete registry.plugins[pkg];
  writeDshPluginRegistry(pluginsDir, registry);
  return registry;
}
