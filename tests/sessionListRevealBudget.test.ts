import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REVEAL_CHUNK_ROWS,
  REVEAL_INITIAL_ROWS,
  REVEAL_THRESHOLD_PX,
  decideRevealStep,
} from '../src/renderer/components/cowork/sessionListRevealBudget';

// The session list mounts only a bounded prefix of its rows (a real sidebar has
// ~900 sessions) and appends another chunk as the user scrolls toward the end.
// The decision is pure, so the boundaries that matter are testable without a
// DOM: when a chunk is due, when the trigger re-arms, and the two geometries
// that must never reveal (a hidden list, and a user parked at the end of a list
// that is already complete — a level trigger there would grow the budget on
// every scroll event until React's update-depth guard fired).

const geometry = (overrides: Partial<Parameters<typeof decideRevealStep>[0]> = {}) => ({
  clientHeight: 600,
  scrollHeight: 3000,
  scrollTop: 0,
  ...overrides,
});

const distanceToEnd = (g: { clientHeight: number; scrollHeight: number; scrollTop: number }) =>
  g.scrollHeight - g.scrollTop - g.clientHeight;

test('the budget is a strict prefix: a screenful on open, then chunks', () => {
  assert.ok(REVEAL_INITIAL_ROWS > 0);
  assert.ok(REVEAL_CHUNK_ROWS > 0);
  assert.ok(REVEAL_THRESHOLD_PX > 0);
  // The first render has to cover more than one screen of the tallest sane
  // sidebar window, otherwise the list would end visibly mid-screen.
  assert.ok(REVEAL_INITIAL_ROWS >= 40, 'the initial prefix covers the first screen');
});

test('far from the end nothing is revealed, and the trigger stays armed', () => {
  const g = geometry({ scrollTop: 0 });
  assert.ok(distanceToEnd(g) > REVEAL_THRESHOLD_PX);
  assert.deepEqual(decideRevealStep(g, true), { reveal: false, armed: true });
});

test('approaching the end reveals exactly one chunk and disarms', () => {
  const g = geometry({ scrollTop: 3000 - 600 - REVEAL_THRESHOLD_PX });
  assert.equal(distanceToEnd(g), REVEAL_THRESHOLD_PX, 'the threshold itself already counts as "near the end"');
  assert.deepEqual(decideRevealStep(g, true), { reveal: true, armed: false });
});

test('a user parked at the end does not grow the budget on every event', () => {
  const parked = geometry({ scrollTop: 3000 - 600 });
  // First probe at the end: one chunk.
  const first = decideRevealStep(parked, true);
  assert.deepEqual(first, { reveal: true, armed: false });
  // Every following probe at the same place (more scroll events, the
  // ResizeObserver re-firing): nothing, until the user moves away again.
  assert.deepEqual(decideRevealStep(parked, first.armed), { reveal: false, armed: false });
  assert.deepEqual(decideRevealStep(parked, false), { reveal: false, armed: false });
});

test('scrolling back up re-arms the trigger for the next approach', () => {
  const away = geometry({ scrollTop: 0 });
  const rearmed = decideRevealStep(away, false);
  assert.deepEqual(rearmed, { reveal: false, armed: true });
  const nearEnd = geometry({ scrollTop: 3000 - 600 - 10 });
  assert.deepEqual(decideRevealStep(nearEnd, rearmed.armed), { reveal: true, armed: false });
});

test('a list that already fits reveals at most one chunk, then stops', () => {
  // The first probe (on mount) may top the budget up once — that is the
  // mechanism that keeps the initial prefix covering the tallest window — but
  // after it the list is stable: every further probe at the same geometry
  // reports nothing. This is what makes the budget terminate instead of growing
  // on every scroll event of a short or fully revealed list.
  const fits = geometry({ scrollHeight: 500, scrollTop: 0 });
  assert.deepEqual(decideRevealStep(fits, true), { reveal: true, armed: false });
  assert.deepEqual(decideRevealStep(fits, false), { reveal: false, armed: false });
});

test('a hidden list (collapsed sidebar) keeps its budget until it has a height', () => {
  const hidden = geometry({ clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
  // Nothing is visible, so there is nothing to trade off; crucially the armed
  // flag is untouched, so the list still reveals as soon as it is shown again.
  assert.deepEqual(decideRevealStep(hidden, true), { reveal: false, armed: true });
  assert.deepEqual(decideRevealStep(hidden, false), { reveal: false, armed: false });
});
