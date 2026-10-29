import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  A2A_BYE_COOLDOWN_MS_OPTIONS,
  A2A_MAX_INCOMING_TURNS_OPTIONS,
  DEFAULT_A2A_BYE_COOLDOWN_MS,
  DEFAULT_A2A_MAX_INCOMING_TURNS,
  cooldownMinutes,
  fitInside,
} from '../src/mobile/app/a2aLimits';
import {
  A2A_BYE_COOLDOWN_MS_OPTIONS as MAIN_COOLDOWN_OPTIONS,
  A2A_MAX_INCOMING_TURNS_OPTIONS as MAIN_TURNS_OPTIONS,
  DEFAULT_A2A_BYE_COOLDOWN_MS as MAIN_DEFAULT_COOLDOWN,
  DEFAULT_A2A_MAX_INCOMING_TURNS as MAIN_DEFAULT_TURNS,
} from '../src/main/services/a2aChatLimits';

/**
 * Drift guard: the mobile edit form mirrors the main-process A2A limit
 * option sets (the main module can never be imported into the mobile
 * bundle). This test pins the two modules to identical values.
 */
describe('mobile A2A limits mirror the main-process contract', () => {
  it('turn options and default match a2aChatLimits', () => {
    assert.deepEqual(A2A_MAX_INCOMING_TURNS_OPTIONS, MAIN_TURNS_OPTIONS);
    assert.equal(DEFAULT_A2A_MAX_INCOMING_TURNS, MAIN_DEFAULT_TURNS);
  });

  it('cooldown options and default match a2aChatLimits', () => {
    assert.deepEqual(A2A_BYE_COOLDOWN_MS_OPTIONS, MAIN_COOLDOWN_OPTIONS);
    assert.equal(DEFAULT_A2A_BYE_COOLDOWN_MS, MAIN_DEFAULT_COOLDOWN);
  });

  it('cooldownMinutes renders whole minutes', () => {
    assert.equal(cooldownMinutes(60_000), 1);
    assert.equal(cooldownMinutes(300_000), 5);
    assert.equal(cooldownMinutes(3_600_000), 60);
  });
});

describe('fitInside (avatar downscale geometry)', () => {
  it('keeps small images untouched', () => {
    assert.deepEqual(fitInside(128, 96, 256), { width: 128, height: 96 });
    assert.deepEqual(fitInside(256, 256, 256), { width: 256, height: 256 });
  });

  it('scales larger images down to fit, preserving aspect ratio', () => {
    assert.deepEqual(fitInside(1024, 512, 256), { width: 256, height: 128 });
    assert.deepEqual(fitInside(512, 1024, 256), { width: 128, height: 256 });
    assert.deepEqual(fitInside(1000, 1000, 256), { width: 256, height: 256 });
  });

  it('degrades degenerate inputs to a maxEdge square', () => {
    assert.deepEqual(fitInside(0, 100, 256), { width: 256, height: 256 });
    assert.deepEqual(fitInside(Number.NaN, 100, 256), { width: 256, height: 256 });
  });
});
