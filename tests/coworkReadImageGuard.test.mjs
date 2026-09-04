/**
 * GT#12 N1/N2 unit tests: evaluateReadImageGuard decision logic.
 *
 * N1 — non-vision models must never Read/View image files (base64 never
 *      enters session history); vision-capable models are unaffected.
 * N2 — re-reading the same unchanged image/large file inside one session is
 *      denied with a hint; a file whose mtime/size changed is allowed again.
 *
 * The decision function is pure (stat supplied by the caller), so no file
 * system or runner instance is needed here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'cowork-read-image-guard-test-user-data'),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
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

const { evaluateReadImageGuard } = loadCompiledModule('../dist-electron/main/libs/coworkRunner.js');

const PNG_PATH = '/tmp/screenshot.png';
const JPEG_PATH = '/tmp/photo.jpeg';
const TXT_PATH = '/tmp/notes.txt';

function stat(mtimeMs = 1000, size = 120000) {
  return { mtimeMs, size };
}

// ---------------------------------------------------------------------------
// N1: non-vision model image guard
// ---------------------------------------------------------------------------

test('N1: non-vision model Read of an image is denied with a path hint', () => {
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: PNG_PATH,
    fileStat: stat(1000, 120000),
    supportsVision: false,
  });

  assert.equal(decision.action, 'deny');
  assert.equal(decision.reason, 'no-vision-image');
  assert.match(decision.message, /不支持读图/);
  assert.match(decision.message, /screenshot\.png/);
  assert.match(decision.message, /117KB/); // 120000 bytes / 1024 = 117
});

test('N1: non-vision model View of an image is denied too (same path)', () => {
  const decision = evaluateReadImageGuard({
    toolName: 'View',
    absolutePath: JPEG_PATH,
    fileStat: stat(),
    supportsVision: false,
  });

  assert.equal(decision.action, 'deny');
  assert.equal(decision.reason, 'no-vision-image');
});

test('N1: non-vision model Read of a text file is still allowed', () => {
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: TXT_PATH,
    fileStat: stat(1000, 2048),
    supportsVision: false,
  });

  assert.equal(decision.action, 'allow');
});

test('N1: non-vision model Read of an image with a missing file still denies (stat null)', () => {
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: PNG_PATH,
    fileStat: null,
    supportsVision: false,
  });

  assert.equal(decision.action, 'deny');
  assert.equal(decision.reason, 'no-vision-image');
  assert.doesNotMatch(decision.message, /KB/); // no size label when unstat-able
});

test('N1: vision model Read of an image is allowed and registered', () => {
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: PNG_PATH,
    fileStat: stat(2000, 120000),
    supportsVision: true,
  });

  assert.equal(decision.action, 'allow');
  assert.deepEqual(decision.register, { path: PNG_PATH, mtimeMs: 2000, size: 120000 });
});

test('N1: non-Read/View tools are never touched by the guard', () => {
  const decision = evaluateReadImageGuard({
    toolName: 'Bash',
    absolutePath: PNG_PATH,
    fileStat: stat(),
    supportsVision: false,
  });

  assert.equal(decision.action, 'allow');
});

// ---------------------------------------------------------------------------
// N2: same-file read dedupe within a session
// ---------------------------------------------------------------------------

test('N2: unchanged image read twice in a session is denied with a dedupe hint', () => {
  const priorReads = new Map([[PNG_PATH, { mtimeMs: 1000, size: 120000 }]]);
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: PNG_PATH,
    fileStat: stat(1000, 120000), // identical mtime+size
    supportsVision: true,
    priorReads,
  });

  assert.equal(decision.action, 'deny');
  assert.equal(decision.reason, 'duplicate-read');
  assert.match(decision.message, /读取过/);
});

test('N2: same image with a CHANGED mtime is allowed again and re-registered', () => {
  const priorReads = new Map([[PNG_PATH, { mtimeMs: 1000, size: 120000 }]]);
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: PNG_PATH,
    fileStat: stat(2000, 120000), // mtime moved, same size
    supportsVision: true,
    priorReads,
  });

  assert.equal(decision.action, 'allow');
  assert.deepEqual(decision.register, { path: PNG_PATH, mtimeMs: 2000, size: 120000 });
});

test('N2: same image with a CHANGED size is allowed again', () => {
  const priorReads = new Map([[PNG_PATH, { mtimeMs: 1000, size: 120000 }]]);
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: PNG_PATH,
    fileStat: stat(1000, 150000), // size grew, mtime same
    supportsVision: true,
    priorReads,
  });

  assert.equal(decision.action, 'allow');
});

test('N2: different path with identical stat is allowed (dedupe is per file)', () => {
  const priorReads = new Map([[PNG_PATH, { mtimeMs: 1000, size: 120000 }]]);
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: JPEG_PATH,
    fileStat: stat(1000, 120000),
    supportsVision: true,
    priorReads,
  });

  assert.equal(decision.action, 'allow');
});

test('N2: large text file (>50KB) is deduped, small text file is not', () => {
  const bigLog = '/tmp/big.log';
  const priorReads = new Map([[bigLog, { mtimeMs: 1000, size: 200000 }]]);

  // Same large file unchanged -> denied (would be pure context waste).
  const denied = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: bigLog,
    fileStat: stat(1000, 200000),
    supportsVision: true,
    priorReads,
  });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.reason, 'duplicate-read');

  // Small text file, already read -> still allowed (avoid hurting normal reads).
  const smallReads = new Map([[TXT_PATH, { mtimeMs: 1000, size: 2048 }]]);
  const allowed = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: TXT_PATH,
    fileStat: stat(1000, 2048),
    supportsVision: true,
    priorReads: smallReads,
  });
  assert.equal(allowed.action, 'allow');
});

test('N2: first read of a large file registers without denying', () => {
  const decision = evaluateReadImageGuard({
    toolName: 'Read',
    absolutePath: '/tmp/first.log',
    fileStat: stat(3000, 60000),
    supportsVision: true,
    priorReads: undefined,
  });

  assert.equal(decision.action, 'allow');
  assert.deepEqual(decision.register, { path: '/tmp/first.log', mtimeMs: 3000, size: 60000 });
});

// ---------------------------------------------------------------------------
// 2026-09-04 vision regression: the guard composes with
// resolveCoworkModelLimits. A vision route reads pixels; a non-vision or
// uncatalogued route must deny LOUDLY — the message names describe_image,
// the relay-backed alternative that works on every route — instead of the
// silent metadata-only read the glm-5.3-flash incident produced.
// ---------------------------------------------------------------------------

test('regression: guard composed with model limits — vision route allows, non-vision and unknown routes deny explicitly', async () => {
  const { resolveCoworkModelLimits } = await import('../dist-electron/main/libs/coworkModelLimits.js');
  const appConfig = { model: { defaultModel: '', availableModels: [] }, providers: {} };
  const limitsFor = (modelId) => resolveCoworkModelLimits(appConfig, modelId);

  // Vision route: image read allowed — the kernel returns the image block.
  const vision = evaluateReadImageGuard({
    toolName: 'read',
    absolutePath: PNG_PATH,
    fileStat: stat(1000, 120000),
    supportsVision: limitsFor('kimi-k2.6').supportsVision,
  });
  assert.equal(vision.action, 'allow');

  // The incident model: glm-5.3-flash must deny with an explicit, actionable
  // message instead of a silent metadata-only result.
  const incident = evaluateReadImageGuard({
    toolName: 'read',
    absolutePath: PNG_PATH,
    fileStat: stat(1000, 120000),
    supportsVision: limitsFor('glm-5.3-flash').supportsVision,
  });
  assert.equal(incident.action, 'deny');
  assert.equal(incident.reason, 'no-vision-image');
  assert.match(incident.message, /describe_image/);
  assert.match(incident.message, /NOT loaded/);

  // Uncatalogued models fail safe the same way.
  const unknown = evaluateReadImageGuard({
    toolName: 'read',
    absolutePath: PNG_PATH,
    fileStat: stat(1000, 120000),
    supportsVision: limitsFor('some-future-uncatalogued-model').supportsVision,
  });
  assert.equal(unknown.action, 'deny');
  assert.equal(unknown.reason, 'no-vision-image');
});
