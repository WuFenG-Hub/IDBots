// The cowork composer's textarea auto-resize must not force a synchronous
// document layout on every keystroke: reading `scrollHeight` measures the
// whole transcript (hundreds of session rows plus thousands of message
// nodes), so the read and the height write share one coalesced rAF callback
// and are skipped while the rendered row count provably cannot change.
//
// These tests cover the skip proof (pure, in composerTextareaResize.ts) and
// pin the coalescing wiring in CoworkPromptInput.tsx.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const loadResizeHelpers = async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-composer-resize-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'composer-textarea-resize.mjs');

  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export * from './src/renderer/components/cowork/composerTextareaResize.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'composer-resize-test-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);
};

const promptInputSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx');

test('a textarea that cannot wrap keeps the cached height for every keystroke', async (t) => {
  const { mayChangeRowCount } = await loadResizeHelpers(t);
  const bound = 40;

  assert.equal(mayChangeRowCount('hello', 'hello!', bound), false, 'typing inside a short line cannot add a row');
  assert.equal(mayChangeRowCount('hello!', 'hello', bound), false, 'backspacing inside a short line cannot add a row');
  assert.equal(mayChangeRowCount('', 'a', bound), false, 'the first character keeps the empty-composer height');
  assert.equal(mayChangeRowCount('hello', 'hello', bound), false, 'an unchanged value is never re-measured');
  assert.equal(
    mayChangeRowCount('first\nsecond', 'first\nsecond!', bound),
    false,
    'short multi-line drafts keep one row per line',
  );
});

test('the cached height is dropped as soon as a row may appear or disappear', async (t) => {
  const { mayChangeRowCount } = await loadResizeHelpers(t);
  const bound = 40;

  assert.equal(mayChangeRowCount('hello', 'hello\n', bound), true, 'a new line adds a row');
  assert.equal(mayChangeRowCount('first\nsecond', 'first second', bound), true, 'joining lines removes a row');
  assert.equal(mayChangeRowCount('a'.repeat(bound), `${'a'.repeat(bound)}a`, bound), true, 'crossing the row bound may wrap');
  assert.equal(
    mayChangeRowCount(`${'a'.repeat(bound)}a`, 'a'.repeat(bound), bound),
    true,
    'a shrinking long line may unwrap',
  );
  assert.equal(
    mayChangeRowCount('a'.repeat(10), '', 0),
    true,
    'without a usable row bound nothing may be skipped',
  );
});

test('row bounds stay conservative for wide glyphs and unreadable metrics', async (t) => {
  const { charsPerRowBound } = await loadResizeHelpers(t);

  assert.equal(charsPerRowBound(500, 14), 35, 'a glyph is at most one font size wide');
  assert.equal(charsPerRowBound(500, 14.5), 34, 'letter spacing widens the glyph');
  assert.equal(charsPerRowBound(140, 14), 10, 'floor keeps the bound on the safe side');
  assert.equal(charsPerRowBound(0, 14), 0, 'a hidden textarea has no usable bound');
  assert.equal(charsPerRowBound(500, 0), 0, 'unreadable font metrics have no usable bound');
  assert.equal(charsPerRowBound(Number.NaN, 14), 0, 'unreadable width has no usable bound');
});

test('the applied height keeps the composer clamps: floor, content height, ceiling', async (t) => {
  const { composerTextareaHeight } = await loadResizeHelpers(t);

  assert.equal(composerTextareaHeight(96, 60, 336), 96, 'a taller draft grows the box');
  assert.equal(composerTextareaHeight(24, 60, 336), 60, 'a cleared composer falls back to the floor');
  assert.equal(composerTextareaHeight(60, 60, 336), 60, 'the floor is inclusive');
  assert.equal(composerTextareaHeight(336, 60, 336), 336, 'the ceiling is inclusive');
  assert.equal(composerTextareaHeight(400, 60, 336), 336, 'an overlong draft caps at the ceiling and scrolls inside');
  assert.equal(composerTextareaHeight(24, 24, 200), 24, 'the compact composer keeps its own floor');
});

test('a measurement is reused for its own value and clamp, and dropped otherwise', async (t) => {
  const { shouldRemeasureComposerHeight } = await loadResizeHelpers(t);
  const measurement = {
    value: 'hello',
    contentWidth: 500,
    glyphWidth: 14,
    minHeight: 60,
    maxHeight: 336,
  };
  const base = { currentWidth: null, minHeight: 60, maxHeight: 336 };

  assert.equal(shouldRemeasureComposerHeight(null, { ...base, value: 'hello' }), true, 'nothing measured yet');
  assert.equal(shouldRemeasureComposerHeight(measurement, { ...base, value: 'hello!' }), false, 'short line, same rows');
  assert.equal(
    shouldRemeasureComposerHeight(measurement, { ...base, value: 'hello\nworld' }),
    true,
    'a new line needs a fresh height',
  );
  assert.equal(
    shouldRemeasureComposerHeight(measurement, { ...base, value: 'hello', minHeight: 42 }),
    true,
    'a size/single-line switch changes the clamp and must be re-applied',
  );
  assert.equal(
    shouldRemeasureComposerHeight(measurement, { ...base, value: 'hello', maxHeight: 200 }),
    true,
    'a smaller max clamp must be re-applied',
  );
});

test('a resized textarea drops the cached height in both directions', async (t) => {
  const { shouldRemeasureComposerHeight } = await loadResizeHelpers(t);
  // 500px / 14px = 35 characters per row, so a 34-character draft is cached.
  const measurement = {
    value: 'a'.repeat(34),
    contentWidth: 500,
    glyphWidth: 14,
    minHeight: 60,
    maxHeight: 336,
  };
  const at = (currentWidth, value) => shouldRemeasureComposerHeight(
    measurement,
    { value, currentWidth, minHeight: 60, maxHeight: 336 },
  );

  assert.equal(at(500, 'a'.repeat(35)), false, 'an unchanged width keeps the cached height');
  assert.equal(
    at(500.4, 'a'.repeat(35)),
    false,
    'sub-pixel rounding differences between the recorded and observed width are not a resize',
  );
  assert.equal(
    at(420, 'a'.repeat(35)),
    true,
    'a narrower box may wrap a line that used to fit',
  );
  assert.equal(
    at(900, 'a'.repeat(35)),
    true,
    'a wider box may unwrap a line and must not keep the taller height',
  );
  assert.equal(
    at(null, 'a'.repeat(35)),
    false,
    'without an observed width the value proof stands on its own',
  );
});

test('the keystroke path schedules the height measurement instead of reading layout', () => {
  const effectStart = promptInputSource.indexOf('  useEffect(() => {\n    const textarea = textareaRef.current;');
  assert.ok(effectStart > 0, 'the value-driven auto-resize effect must exist');
  const effect = promptInputSource.slice(effectStart, promptInputSource.indexOf('}, [value, minHeight, maxHeight, scheduleTextareaHeight]);', effectStart));

  assert.ok(effect.includes('shouldRemeasureComposerHeight('), 'the effect must ask the skip proof before measuring');
  assert.ok(effect.includes('scheduleTextareaHeight();'), 'the effect must defer the measurement to the frame');
  assert.ok(!effect.includes('scrollHeight'), 'no keystroke may force a synchronous layout read');
  assert.ok(!effect.includes('style.height'), 'no keystroke may write the height synchronously');
});

test('height measurements are coalesced into one rAF per frame and cancelled on unmount', () => {
  const scheduleStart = promptInputSource.indexOf('  const scheduleTextareaHeight = useCallback(');
  assert.ok(scheduleStart > 0, 'the frame scheduler must exist');
  const scheduler = promptInputSource.slice(scheduleStart, promptInputSource.indexOf('  }, [applyTextareaHeight]);', scheduleStart));

  assert.ok(
    scheduler.includes('if (resizeFrameRef.current !== null) return;'),
    'an in-flight frame must absorb every further keystroke',
  );
  assert.ok(
    /resizeFrameRef\.current = requestAnimationFrame\(\(\) => \{[\s\S]*?resizeFrameRef\.current = null;[\s\S]*?applyTextareaHeight\(\);/.test(scheduler),
    'the frame applies the height after the read and clears its own handle',
  );
  assert.ok(
    promptInputSource.includes('useEffect(() => cancelScheduledTextareaHeight, [cancelScheduledTextareaHeight]);'),
    'a pending frame must be cancelled when the composer unmounts',
  );
  assert.ok(
    promptInputSource.includes("textarea.style.height = 'auto';") &&
      promptInputSource.indexOf("textarea.style.height = 'auto';") > promptInputSource.indexOf('const applyTextareaHeight = useCallback('),
    'the auto+scrollHeight dance lives in the frame-applied measurement only',
  );
});

test('the imperative setValue path shares the same measurement pipeline', () => {
  const setValueStart = promptInputSource.indexOf('setValue: (newValue: string) => {');
  assert.ok(setValueStart > 0, 'setValue must exist');
  const setValue = promptInputSource.slice(setValueStart, promptInputSource.indexOf('    focus: () => {', setValueStart));

  assert.ok(setValue.includes('scheduleTextareaHeight();'), 'prefills and clears must reuse the frame-coalesced measurement');
  assert.ok(!setValue.includes('scrollHeight'), 'setValue must not read layout on its own');
  assert.ok(
    !promptInputSource.includes('// 触发自动调整高度'),
    'the old hand-rolled rAF in setValue must be gone',
  );
});
