const path = require('node:path');
const { builtinModules } = require('node:module');
const packageJson = require('../package.json');

const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, ''), `node:${name.replace(/^node:/, '')}`]),
);

const EXTRA_EXTERNALS = [
  'electron',
  '@discordjs/opus',
  'zlib-sync',
];

const DEPENDENCY_EXTERNALS = [
  ...Object.keys(packageJson.dependencies || {}),
  ...EXTRA_EXTERNALS,
];

function getPackageName(id) {
  if (!id || id.startsWith('.') || id.startsWith('/') || id.startsWith('\0')) {
    return null;
  }

  if (path.isAbsolute(id)) {
    return null;
  }

  if (id.startsWith('node:')) {
    return id;
  }

  const parts = id.split('/');
  if (id.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : id;
  }
  return parts[0] || null;
}

function createElectronMainExternalPredicate(extraExternals = []) {
  const externals = new Set([...DEPENDENCY_EXTERNALS, ...extraExternals]);

  return function electronMainExternal(id) {
    const packageName = getPackageName(id);
    if (!packageName) {
      return false;
    }
    return BUILTIN_MODULES.has(packageName) || externals.has(packageName);
  };
}

module.exports = {
  createElectronMainExternalPredicate,
  getPackageName,
};
