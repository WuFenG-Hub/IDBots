// Vite plugin: invalidate the optimizeDeps cache when scoped node_modules
// packages change content without changing their version/lockfile entry.
//
// Root cause: Vite's cache validity (loadCachedDepOptimizationMetadata) only
// compares lockfileHash + configHash, neither of which reflects the actual
// file content/mtime of node_modules packages. When a package's content
// changes but its version string stays the same (e.g. patch-package, a
// re-install of the same version, or a local file: dep), the stale pre-bundled
// cache is reused and the dev server serves old code.
//
// Fix: at dev-server startup (the `config` hook, which runs before the deps
// optimizer initializes), compute a content fingerprint of the watched scoped
// packages and compare it to the last recorded value. If it changed, return
// { optimizeDeps: { force: true } } — the same lever Vite itself uses on
// restart — to force a clean re-bundle. Otherwise do nothing (zero overhead).
//
// The fingerprint manifest lives at the project root (NOT inside
// node_modules/.vite) so clearing the Vite cache never wipes our state.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Packages under these node_modules scopes are fingerprinted. Add more scopes
// here if other vendored module families exhibit the same stale-cache problem.
const WATCHED_SCOPES = ['@openagentinternet'];

// Dist subdirectories whose .js output is what Vite actually pre-bundles.
const DIST_DIRS = ['dist', 'dist-cjs'];

// Manifest path is resolved against the project root at plugin-creation time.
const MANIFEST_FILENAME = '.vite-deps-fingerprint.json';

function listDirFiles(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listDirFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

function statKey(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    return `${filePath}:missing:0`;
  }
}

function discoverScopedPackages(nodeModulesDir) {
  const packages = [];
  for (const scope of WATCHED_SCOPES) {
    const scopeDir = path.join(nodeModulesDir, scope);
    let members = [];
    try {
      members = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const member of members) {
      if (member.isDirectory()) {
        packages.push(path.join(scopeDir, member.name));
      }
    }
  }
  return packages;
}

function computePackagesFingerprint(packages) {
  const hasher = crypto.createHash('sha256');
  for (const pkgDir of packages) {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    let version = '';
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      version = String(pkg.version ?? '');
    } catch {
      version = '';
    }
    // name + version captures version bumps; dist file stats capture same-version
    // content changes (patch-package, re-installs, local edits).
    hasher.update(`${pkgDir}@${version}`);

    for (const distName of DIST_DIRS) {
      const distDir = path.join(pkgDir, distName);
      const files = listDirFiles(distDir).sort();
      for (const file of files) {
        hasher.update(statKey(file));
      }
    }
  }
  return hasher.digest('hex');
}

function loadSavedFingerprint(manifestPath) {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return typeof data?.fingerprint === 'string' ? data.fingerprint : '';
  } catch {
    return '';
  }
}

function saveFingerprint(manifestPath, fingerprint) {
  try {
    fs.writeFileSync(manifestPath, JSON.stringify({ fingerprint }, null, 2));
  } catch {
    // best-effort: a missing manifest only means the next start re-evaluates.
  }
}

/**
 * Decide whether optimizeDeps should be force-re-run this startup.
 * Returns true only when the fingerprint differs from the last recorded value.
 * First-ever run (no manifest) records the fingerprint and returns false.
 */
function shouldForceReoptimize(projectRoot) {
  const nodeModulesDir = path.join(projectRoot, 'node_modules');
  const manifestPath = path.join(projectRoot, MANIFEST_FILENAME);

  const packages = discoverScopedPackages(nodeModulesDir);
  if (packages.length === 0) {
    return false;
  }

  const current = computePackagesFingerprint(packages);
  const saved = loadSavedFingerprint(manifestPath);

  // Always refresh the recorded fingerprint so the next run compares against
  // this state (including after a forced re-bundle).
  saveFingerprint(manifestPath, current);

  if (!saved) {
    // First run or manifest was removed: nothing to compare, don't force.
    return false;
  }
  return current !== saved;
}

/**
 * Vite plugin factory. Register in vite.config.ts plugins array.
 * Only acts during `vite`/dev-server (command === 'serve'); builds are unaffected.
 */
function createDepsCacheBusterPlugin() {
  return {
    name: 'idbots-deps-cache-buster',
    apply: 'serve',
    config(_config, { command }) {
      if (command !== 'serve') return undefined;
      // __dirname is scripts/ when required from vite.config.ts at the project root.
      const projectRoot = path.resolve(__dirname, '..');
      let force = false;
      try {
        force = shouldForceReoptimize(projectRoot);
      } catch (error) {
        // Never let a fingerprinting failure block dev startup.
        console.warn('[idbots-deps-cache-buster] fingerprint check failed:', error?.message || error);
      }
      if (force) {
        console.warn('[idbots-deps-cache-buster] node_modules package content changed since last run — forcing optimizeDeps re-bundle.');
        return { optimizeDeps: { force: true } };
      }
      return undefined;
    },
  };
}

module.exports = {
  createDepsCacheBusterPlugin,
  shouldForceReoptimize,
  computePackagesFingerprint,
  discoverScopedPackages,
  MANIFEST_FILENAME,
  WATCHED_SCOPES,
};
