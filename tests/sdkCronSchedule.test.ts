import test from 'node:test';
import assert from 'node:assert/strict';
import {
  specToSdkCron,
  formStateToSpec,
  mirrorToFormState,
  defaultSdkCronFormState,
} from '../src/renderer/components/scheduledTasks/sdkCronSchedule';
import type { SdkCronMirror, SdkCronScheduleSpec } from '../src/renderer/types/scheduledTask';

const baseMeta = { name: 'daily report', prompt: 'write a summary', metabotId: null as number | null };

function makeMirror(over: Partial<SdkCronMirror> = {}): SdkCronMirror {
  return {
    id: 'c1',
    sessionId: 's1',
    name: 'task',
    schedule: '0 9 * * *',
    humanSchedule: null,
    recurring: true,
    durable: true,
    prompt: 'p',
    source: 'stop_hook',
    migratedTaskId: null,
    status: 'active',
    firstSeenAt: '2026-08-09T00:00:00.000Z',
    lastSeenAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    enabled: true,
    scheduleSpec: null,
    disabledAt: null,
    ...over,
  };
}

test('specToSdkCron: daily mode -> recurring cron at HH:MM', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'daily', time: '09:30' },
    baseMeta
  );
  const cron = specToSdkCron(spec);
  assert.equal(cron.expression, '30 9 * * *');
  assert.equal(cron.recurring, true);
});

test('specToSdkCron: weekly mode -> cron with weekday', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'weekly', time: '18:00', weekday: 3 },
    baseMeta
  );
  const cron = specToSdkCron(spec);
  assert.equal(cron.expression, '0 18 * * 3');
  assert.equal(cron.recurring, true);
});

test('specToSdkCron: monthly mode -> cron with day-of-month', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'monthly', time: '00:15', monthDay: 20 },
    baseMeta
  );
  const cron = specToSdkCron(spec);
  assert.equal(cron.expression, '15 0 20 * *');
  assert.equal(cron.recurring, true);
});

test('specToSdkCron: interval minutes -> */N recurring', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'interval', intervalValue: 30, intervalUnit: 'minutes' },
    baseMeta
  );
  const cron = specToSdkCron(spec);
  assert.equal(cron.expression, '*/30 * * * *');
  assert.equal(cron.recurring, true);
});

test('specToSdkCron: interval hours -> 0 */N recurring', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'interval', intervalValue: 6, intervalUnit: 'hours' },
    baseMeta
  );
  assert.equal(specToSdkCron(spec).expression, '0 */6 * * *');
});

test('specToSdkCron: interval days -> 0 0 */N recurring', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'interval', intervalValue: 3, intervalUnit: 'days' },
    baseMeta
  );
  assert.equal(specToSdkCron(spec).expression, '0 0 */3 * *');
});

test('specToSdkCron: once mode -> one-shot cron (recurring=false)', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'once', date: '2026-12-25', time: '10:00' },
    baseMeta
  );
  const cron = specToSdkCron(spec);
  assert.equal(cron.recurring, false);
  assert.equal(cron.expression, '0 10 25 12 *');
});

test('specToSdkCron: once mode with invalid date -> null expression', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'once', date: '', time: '10:00' },
    baseMeta
  );
  assert.equal(specToSdkCron(spec).expression, null);
});

test('specToSdkCron: cron mode passes through 5-field expression', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'cron', cronExpression: '*/15 9-17 * * 1-5' },
    baseMeta
  );
  assert.equal(specToSdkCron(spec).expression, '*/15 9-17 * * 1-5');
});

test('specToSdkCron: cron mode rejects malformed expression (not 5 fields)', () => {
  const spec = formStateToSpec(
    { ...defaultSdkCronFormState(), mode: 'cron', cronExpression: '0 9 * *' },
    baseMeta
  );
  assert.equal(specToSdkCron(spec).expression, null);
});

test('mirrorToFormState: prefers stored scheduleSpec over raw schedule', () => {
  const spec: SdkCronScheduleSpec = {
    mode: 'weekly', date: '', time: '08:00', weekday: 5, monthDay: 1,
    intervalValue: 5, intervalUnit: 'minutes', cronExpression: '',
    prompt: 'p', name: 'n', metabotId: null,
  };
  // Raw schedule says daily 09:00, but spec says weekly Friday 08:00 — spec wins.
  const mirror = makeMirror({ schedule: '0 9 * * *', scheduleSpec: spec });
  const form = mirrorToFormState(mirror);
  assert.equal(form.mode, 'weekly');
  assert.equal(form.weekday, 5);
  assert.equal(form.time, '08:00');
});

test('mirrorToFormState: falls back to parsing raw cron when no spec', () => {
  const mirror = makeMirror({ schedule: '*/10 * * * *', scheduleSpec: null });
  const form = mirrorToFormState(mirror);
  assert.equal(form.mode, 'interval');
  assert.equal(form.intervalUnit, 'minutes');
  assert.equal(form.intervalValue, 10);
});

test('formStateToSpec round-trips name/prompt/metabotId', () => {
  const spec = formStateToSpec(defaultSdkCronFormState(), {
    name: 'my task', prompt: 'do thing', metabotId: 42,
  });
  assert.equal(spec.name, 'my task');
  assert.equal(spec.prompt, 'do thing');
  assert.equal(spec.metabotId, 42);
});
