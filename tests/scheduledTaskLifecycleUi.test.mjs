import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');

const formSource = read('src', 'renderer', 'components', 'scheduledTasks', 'TaskForm.tsx');
const detailSource = read('src', 'renderer', 'components', 'scheduledTasks', 'TaskDetail.tsx');
const i18nSource = read('src', 'renderer', 'services', 'i18n.ts');
const typesSource = read('src', 'renderer', 'types', 'scheduledTask.ts');

test('the form exposes exit condition and fire budget for recurring schedules only', () => {
  assert.match(formSource, /exitCondition/);
  assert.match(formSource, /maxFires/i);
  // The fields only render for recurring schedules — one-shot tasks retire
  // themselves after execution and need no death clause.
  assert.match(formSource, /buildSchedule\(\)\?\.type !== 'at'/);
  // The submitted payload carries the lifecycle fields.
  assert.match(formSource, /exitCondition: isRecurring/);
  assert.match(formSource, /maxFires: isRecurring/);
});

test('the detail view surfaces origin, fire budget, exit clause, and the retired status', () => {
  assert.match(detailSource, /scheduledTasksDetailOrigin/);
  assert.match(detailSource, /scheduledTasksDetailFireBudget/);
  assert.match(detailSource, /scheduledTasksDetailExitCondition/);
  assert.match(detailSource, /scheduledTasksDetailOriginSession/);
  // 'max_fires_reached' maps to its camelCase i18n key and a distinct color.
  assert.match(detailSource, /max_fires_reached: 'MaxFiresReached'/);
  assert.match(detailSource, /max_fires_reached: 'text-amber-500'/);
});

test('lifecycle i18n keys exist in both language blocks', () => {
  const keys = [
    'scheduledTasksStatusMaxFiresReached',
    'scheduledTasksFormExitCondition',
    'scheduledTasksFormExitConditionHint',
    'scheduledTasksFormExitConditionPlaceholder',
    'scheduledTasksFormMaxFires',
    'scheduledTasksFormMaxFiresHint',
    'scheduledTasksDetailOrigin',
    'scheduledTasksDetailOriginHuman',
    'scheduledTasksDetailOriginAgent',
    'scheduledTasksDetailOriginLegacy',
    'scheduledTasksDetailFireBudget',
    'scheduledTasksDetailFireUnlimited',
    'scheduledTasksDetailExitCondition',
    'scheduledTasksDetailOriginSession',
  ];
  for (const key of keys) {
    const occurrences = i18nSource.split(key).length - 1;
    assert.ok(
      occurrences >= 2,
      `i18n key ${key} must exist in both the zh and en blocks (found ${occurrences})`
    );
  }
});

test('renderer task types carry the lifecycle fields', () => {
  assert.match(typesSource, /export type TaskOrigin = 'human' \| 'agent' \| null/);
  assert.match(typesSource, /exitCondition: string \| null/);
  assert.match(typesSource, /maxFires: number \| null/);
  assert.match(typesSource, /fireCount: number/);
  assert.match(typesSource, /'max_fires_reached'/);
});
