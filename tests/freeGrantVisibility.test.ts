import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveFreeGrantBanner } from '../src/renderer/components/traffic/freeGrantVisibility';

const MB = 1_000_000;
const NOW = 1_790_000_000_000;
const baseCampaign = {
  enabled: true,
  claimed: false,
  claimable: true,
};

test('fresh install: enabled and unclaimed shows the banner regardless of claimable', () => {
  const state = resolveFreeGrantBanner({
    campaign: { ...baseCampaign, claimable: false },
    campaignReady: true,
    hasBalance: true,
    balanceBytes: 500 * MB,
    nowMs: NOW,
  });
  assert.equal(state.visible, true);
  assert.equal(state.repeatBelowThreshold, false);
  assert.equal(state.cooldownUntil, 0);
  assert.equal(state.thresholdBytes, 0);
});

test('one-time campaign, already claimed: banner hidden (repeat off)', () => {
  const state = resolveFreeGrantBanner({
    campaign: { enabled: true, claimed: true, claimable: false },
    campaignReady: true,
    hasBalance: true,
    balanceBytes: 0,
    nowMs: NOW,
  });
  assert.equal(state.visible, false);
});

test('repeat campaign below threshold: banner stays visible even during cooldown', () => {
  const state = resolveFreeGrantBanner({
    campaign: {
      enabled: true,
      claimed: true,
      claimable: false,
      repeatEnabled: true,
      thresholdBytes: 5 * MB,
      nextClaimAt: NOW + 3 * 24 * 3600 * 1000,
    },
    campaignReady: true,
    hasBalance: true,
    balanceBytes: 1 * MB,
    nowMs: NOW,
  });
  assert.equal(state.visible, true);
  assert.equal(state.repeatBelowThreshold, true);
  assert.equal(state.cooldownUntil, NOW + 3 * 24 * 3600 * 1000);
  assert.equal(state.thresholdBytes, 5 * MB);
});

test('repeat campaign below threshold after cooldown: claimable path keeps the banner', () => {
  const state = resolveFreeGrantBanner({
    campaign: {
      enabled: true,
      claimed: true,
      claimable: true,
      repeatEnabled: true,
      thresholdBytes: 5 * MB,
      nextClaimAt: 0,
    },
    campaignReady: true,
    hasBalance: true,
    balanceBytes: 1 * MB,
    nowMs: NOW,
  });
  assert.equal(state.visible, true);
  assert.equal(state.repeatBelowThreshold, true);
  assert.equal(state.cooldownUntil, 0);
});

test('repeat campaign above threshold: banner hidden while cooldown lasts', () => {
  const state = resolveFreeGrantBanner({
    campaign: {
      enabled: true,
      claimed: true,
      claimable: false,
      repeatEnabled: true,
      thresholdBytes: 5 * MB,
      nextClaimAt: NOW + 3600 * 1000,
    },
    campaignReady: true,
    hasBalance: true,
    balanceBytes: 50 * MB,
    nowMs: NOW,
  });
  assert.equal(state.visible, false);
  assert.equal(state.repeatBelowThreshold, false);
  assert.equal(state.cooldownUntil, 0);
});

test('repeat campaign missing threshold: falls back to plain claimable semantics', () => {
  const state = resolveFreeGrantBanner({
    campaign: {
      enabled: true,
      claimed: true,
      claimable: false,
      repeatEnabled: true,
      nextClaimAt: NOW + 3600 * 1000,
    },
    campaignReady: true,
    hasBalance: true,
    balanceBytes: 0,
    nowMs: NOW,
  });
  assert.equal(state.visible, false);
  assert.equal(state.thresholdBytes, 0);
});

test('status fetch failed but account exists: banner stays for a fresh claim', () => {
  const state = resolveFreeGrantBanner({
    campaign: null,
    campaignReady: true,
    hasBalance: true,
    balanceBytes: 0,
    nowMs: NOW,
  });
  assert.equal(state.visible, true);
});

test('status fetch failed and no balance: banner hidden', () => {
  const state = resolveFreeGrantBanner({
    campaign: null,
    campaignReady: true,
    hasBalance: false,
    balanceBytes: 0,
    nowMs: NOW,
  });
  assert.equal(state.visible, false);
});

test('unknown balance never activates the repeat-below-threshold path', () => {
  const state = resolveFreeGrantBanner({
    campaign: {
      enabled: true,
      claimed: true,
      claimable: false,
      repeatEnabled: true,
      thresholdBytes: 5 * MB,
    },
    campaignReady: true,
    hasBalance: false,
    balanceBytes: 0,
    nowMs: NOW,
  });
  assert.equal(state.visible, false);
  assert.equal(state.repeatBelowThreshold, false);
  assert.equal(state.cooldownUntil, 0);
});
