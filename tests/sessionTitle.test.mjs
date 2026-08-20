import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const require = Module.createRequire(import.meta.url);
const { deriveSessionTitle, sanitizeGeneratedSessionTitle } = loadCompiledModule(
  '../dist-electron/main/libs/coworkUtil.js'
);

test('deriveSessionTitle keeps short same-language input and truncates long input', () => {
  assert.equal(deriveSessionTitle('帮我改登录页'), '帮我改登录页');
  assert.equal(deriveSessionTitle('   hello   world  '), 'hello world');
  assert.equal(deriveSessionTitle('x'.repeat(60)).length, 53);
  assert.match(deriveSessionTitle('x'.repeat(60)), /\.\.\.$/);
});

test('sanitizeGeneratedSessionTitle strips quotes and uses fallback when empty', () => {
  assert.equal(sanitizeGeneratedSessionTitle('"Fix login page"', 'fallback'), 'Fix login page');
  assert.equal(sanitizeGeneratedSessionTitle('「修登录页」\nextra', 'fallback'), '修登录页');
  assert.equal(sanitizeGeneratedSessionTitle('   ', 'fallback'), 'fallback');
  assert.equal(sanitizeGeneratedSessionTitle('New Session', 'fallback'), 'fallback');
  assert.equal(sanitizeGeneratedSessionTitle('a'.repeat(80), 'fallback').length, 50);
});
