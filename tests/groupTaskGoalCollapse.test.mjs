import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Goal-collapse static guard: the detail-view header goal renders COLLAPSED by
 * default so long goals cannot consume the fixed header block and push the
 * group transcript off-screen (Boss feedback 2026-08-24, task #33's goal is a
 * single 2528-char line). Source-level invariants:
 *   1. the collapsed state is the React default (useState(false));
 *   2. the preview = first paragraph (first line break) further capped by a
 *      character constant — a long single-line goal must fold too;
 *   3. the triangle toggle before the label and the inline expand toggle drive
 *      the SAME flag (either one expands the full text);
 *   4. the flag resets when the view is reused for another task.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'groupTasks', 'GroupTaskDetailView.tsx'),
  'utf8',
);

test('goal: collapses by default with a capped first-paragraph preview', () => {
  // 1 — default collapsed.
  assert.ok(
    source.includes('const [goalExpanded, setGoalExpanded] = useState(false)'),
    'goalExpanded defaults to false (collapsed)',
  );

  // 2 — first-paragraph split + character cap (single-line goals fold too).
  assert.ok(
    source.includes('GOAL_PREVIEW_MAX_CHARS'),
    'preview cap constant defined',
  );
  const capMatch = source.match(/GOAL_PREVIEW_MAX_CHARS = (\d+)/);
  assert.ok(capMatch, 'GOAL_PREVIEW_MAX_CHARS has a numeric value');
  assert.ok(Number(capMatch[1]) > 0 && Number(capMatch[1]) <= 400, 'cap stays in a sane range');
  assert.ok(
    source.includes('goalText.search(/\\r?\\n/)'),
    'preview cuts at the first line break (paragraph boundary)',
  );
  assert.ok(
    source.includes('goalHasMore = goalFirstBreak !== -1 || goalText.length > GOAL_PREVIEW_MAX_CHARS'),
    'toggle only appears when the goal actually overflows the preview',
  );
});

test('goal: triangle and inline toggle drive the same expand flag', () => {
  // 3 — one flag, two affordances: count setGoalExpanded call sites in the
  // goal block (triangle button + inline button).
  const goalBlockStart = source.indexOf('{/* Goal / acceptance */}');
  const block = source.slice(goalBlockStart, source.indexOf('{detail.stall === true'));
  const toggles = block.match(/setGoalExpanded\(\(expanded\) => !expanded\)/g) ?? [];
  assert.ok(toggles.length === 2, `expected triangle + inline toggles, found ${toggles.length}`);
  assert.ok(block.includes("i18nService.t('groupTasksGoalLabel')"), 'label rendered before the goal text');
  assert.ok(block.includes('aria-expanded={goalExpanded}'), 'triangle exposes expand state to a11y');

  // 4 — reuse across tasks never leaks an expanded goal into the next task
  //     (the reset effect is anchored by its comment; `}, [taskId]);` alone
  //     first matches refreshDetail's ending above it).
  const resetEffectIdx = source.indexOf('Reset per-task transcript state');
  const resetCallIdx = source.indexOf('setGoalExpanded(false)', resetEffectIdx);
  const resetEffectEnd = source.indexOf('}, [taskId]);', resetEffectIdx);
  assert.ok(resetEffectIdx >= 0, 'per-task reset effect found');
  assert.ok(
    resetCallIdx > resetEffectIdx && resetCallIdx < resetEffectEnd,
    'goalExpanded resets inside the per-task reset effect',
  );
});
